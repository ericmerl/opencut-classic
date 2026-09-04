import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechAnalysisService } from "./speech-analysis";
import { TranscriptStore } from "./transcript-store";
import { makeTranscriptFixture } from "./transcript-test-fixture";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("persistent speech and silence analysis", () => {
	test("derives exact source/timeline ranges with typed parameters and provider provenance", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-speech-analysis-"));
		directories.push(directory);
		const transcripts = new TranscriptStore(join(directory, "transcripts"));
		await transcripts.create(
			makeTranscriptFixture({
				words: [
					{
						text: "one",
						startTicks: 60_000,
						endTicks: 84_000,
						confidence: 0.9,
					},
					{
						text: "two",
						startTicks: 96_000,
						endTicks: 120_000,
						confidence: 0.8,
					},
					{
						text: "three",
						startTicks: 240_000,
						endTicks: 264_000,
						confidence: 0.95,
					},
				],
			}),
		);
		const service = new SpeechAnalysisService(
			transcripts,
			join(directory, "analysis"),
		);
		const result = await service.analyze({
			operationId: "analysis-operation-1",
			analysisId: "analysis-1",
			transcriptId: "transcript-1",
			expectedTranscriptVersion: 1,
			parameters: {
				minimumWordConfidence: 0.85,
				minimumSilenceTicks: 30_000,
				paddingTicks: 6_000,
				channel: "mix",
				rangePolicy: { kind: "source" },
			},
		});
		expect(result.analysis.speechRanges).toHaveLength(2);
		expect(result.analysis.speechRanges[0]).toMatchObject({
			sourceTime: { startTicks: 54_000, endTicks: 90_000 },
			confidence: 0.9,
		});
		expect(
			result.analysis.silenceRanges.map((range) => range.sourceTime),
		).toEqual([
			{ startTicks: 0, endTicks: 54_000 },
			{ startTicks: 90_000, endTicks: 234_000 },
			{ startTicks: 270_000, endTicks: 360_000 },
		]);
		expect(result.analysis.provenance).toMatchObject({
			method: "parakeet-word-activity",
			modelId: "nvidia/parakeet-tdt-0.6b-v2",
		});
		expect(
			(
				await new SpeechAnalysisService(
					transcripts,
					join(directory, "analysis"),
				).analyze({
					operationId: "analysis-operation-1",
					analysisId: "analysis-1",
					transcriptId: "transcript-1",
					expectedTranscriptVersion: 1,
					parameters: result.analysis.parameters,
				})
			).status,
		).toBe("replayed");
	});
});
