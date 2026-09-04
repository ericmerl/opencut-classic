import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EditorialDecisionService } from "./editorial-decision";
import { SpeechAnalysisService } from "./speech-analysis";
import { makeTranscriptFixture } from "./transcript-test-fixture";
import { TranscriptStore } from "./transcript-store";

describe("durable editorial decisions", () => {
	test("turns a stable word selector into a preflightable atomic cut plan", async () => {
		const fixture = await setup();
		const result = await fixture.decisions.create({
			operationId: "op:decision:words",
			decisionId: "decision:words",
			projectId: fixture.transcript.projectId,
			sceneId: fixture.transcript.sceneId,
			baseRevision: fixture.transcript.projectRevision,
			baseProjectContentHash: fixture.transcript.projectContentHash,
			description: "Remove two",
			rationale: "Editorial word removal",
			selection: {
				kind: "word-range",
				transcriptId: fixture.transcript.transcriptId,
				expectedTranscriptVersion: 1,
				startWordId: fixture.transcript.words[1]!.wordId,
				endWordId: fixture.transcript.words[1]!.wordId,
			},
		});

		expect(result.status).toBe("created");
		expect(result.decision).toMatchObject({
			status: "proposed",
			provenance: {
				createdBy: "opencut-mcp",
				source: "transcript",
				providerId: "nvidia-parakeet-local",
			},
		});
		expect(
			result.decision.operations.map((operation) => operation.kind),
		).toEqual(["split", "split", "delete"]);
		expect(result.decision.operations[2]).toMatchObject({
			kind: "delete",
			ripple: true,
			relationshipScope: "all",
		});
		expect(
			(await fixture.transcripts.require(fixture.transcript.transcriptId))
				.mappings.cuts,
		).toEqual([
			expect.objectContaining({
				decisionId: "decision:words",
				startWordId: fixture.transcript.words[1]!.wordId,
				endWordId: fixture.transcript.words[1]!.wordId,
			}),
		]);
		expect(
			(await fixture.decisions.require("decision:words")).contentHash.digest,
		).toBe(result.decision.contentHash.digest);
	});

	test("selects analyzed silence, diffs, reapplies, and round-trips v1 JSON", async () => {
		const fixture = await setup();
		const analyzed = await fixture.analyses.analyze({
			operationId: "op:analysis",
			analysisId: "analysis:one",
			transcriptId: fixture.transcript.transcriptId,
			expectedTranscriptVersion: 1,
			parameters: {
				minimumWordConfidence: 0.85,
				minimumSilenceTicks: 1,
				paddingTicks: 0,
				channel: "mix",
				rangePolicy: { kind: "visible-clip" },
			},
		});
		const silence = analyzed.analysis.silenceRanges[1]!;
		const created = await fixture.decisions.create({
			operationId: "op:decision:silence",
			decisionId: "decision:silence",
			projectId: fixture.transcript.projectId,
			sceneId: fixture.transcript.sceneId,
			baseRevision: fixture.transcript.projectRevision,
			baseProjectContentHash: fixture.transcript.projectContentHash,
			description: "Remove selected silence",
			rationale: "Tighten pacing",
			selection: {
				kind: "silence-ranges",
				analysisId: analyzed.analysis.analysisId,
				rangeIds: [silence.rangeId],
			},
		});
		expect(
			await fixture.decisions.diff({
				decisionId: created.decision.decisionId,
				currentRevision: 8,
				currentProjectContentHash: "8".repeat(64),
			}),
		).toMatchObject({ status: "project-changed" });

		const reapplied = await fixture.decisions.reapply({
			operationId: "op:reapply",
			decisionId: created.decision.decisionId,
			newDecisionId: "decision:silence:reapplied",
			currentRevision: 8,
			currentProjectContentHash: "8".repeat(64),
		});
		expect(reapplied.decision.parentDecisionId).toBe(
			created.decision.decisionId,
		);

		const exportPath = join(fixture.root, "decision.json");
		const exported = await fixture.decisions.exportJson(
			created.decision.decisionId,
			exportPath,
		);
		expect(exported.sha256).toHaveLength(64);
		expect(JSON.parse(await readFile(exportPath, "utf8")).format).toBe(
			"opencut.editorial-decision.v1",
		);

		// Re-importing exact interchange is deterministic and lossless.
		const imported = await fixture.decisions.importJson(exportPath);
		expect(imported.status).toBe("replayed");
		expect(imported.lossReport.lossy).toBeFalse();
	});
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "opencut-decisions-"));
	const transcripts = new TranscriptStore(join(root, "transcripts"));
	const transcript = (
		await transcripts.create(
			makeTranscriptFixture({
				words: [
					{
						text: "one",
						startTicks: 60_000,
						endTicks: 84_000,
						confidence: 0.99,
					},
					{
						text: "two",
						startTicks: 120_000,
						endTicks: 144_000,
						confidence: 0.8,
					},
					{
						text: "three",
						startTicks: 180_000,
						endTicks: 204_000,
						confidence: 0.98,
					},
				],
			}),
		)
	).transcript;
	const analyses = new SpeechAnalysisService(
		transcripts,
		join(root, "analysis"),
	);
	const decisions = new EditorialDecisionService(
		transcripts,
		analyses,
		join(root, "decisions"),
	);
	return { root, transcript, transcripts, analyses, decisions };
}
