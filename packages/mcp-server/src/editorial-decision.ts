import { createHash, randomBytes } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	readdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import type { PreflightEditOperation } from "./edit-plan-preflight-contract";
import { stableSerialize } from "./matte-generation-data";
import { SpeechAnalysisService, type SpeechAnalysis } from "./speech-analysis";
import { TranscriptStore, type TranscriptRecord } from "./transcript-store";
import { editOperationSchema } from "./tool-schemas";

const identifier = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const range = z
	.object({
		startTicks: z.number().int().nonnegative(),
		endTicks: z.number().int().positive(),
	})
	.strict()
	.refine((value) => value.endTicks > value.startTicks, {
		message: "decision range must have positive duration",
	});

const decisionRangeSchema = z
	.object({
		rangeId: identifier,
		sourceTime: range,
		timelineTime: range,
		wordIds: z.array(identifier).max(100_000),
		analysisRangeId: identifier.nullable(),
	})
	.strict();

const selectionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("word-range"),
			transcriptId: identifier,
			expectedTranscriptVersion: z.number().int().positive(),
			startWordId: identifier,
			endWordId: identifier,
		})
		.strict(),
	z
		.object({
			kind: z.literal("silence-ranges"),
			analysisId: identifier,
			rangeIds: z.array(identifier).min(1).max(10_000),
		})
		.strict(),
]);

export const editorialDecisionSchema = z
	.object({
		schemaVersion: z.literal(1),
		decisionId: identifier,
		operationId: identifier,
		requestFingerprint: digest,
		createdAt: z.string().datetime(),
		projectId: identifier,
		sceneId: identifier,
		baseRevision: z.number().int().nonnegative(),
		baseProjectContentHash: digest,
		trackId: identifier,
		clipId: identifier,
		kind: z.enum(["remove-word-range", "remove-silence"]),
		status: z.literal("proposed"),
		selection: selectionSchema,
		ranges: z.array(decisionRangeSchema).min(1).max(10_000),
		description: z.string().trim().min(1).max(4_096),
		rationale: z.string().trim().min(1).max(4_096),
		constraints: z
			.object({
				ripple: z.literal(true),
				relationshipScope: z.literal("all"),
				providerExecution: z.literal("forbidden"),
			})
			.strict(),
		provenance: z
			.object({
				createdBy: z.literal("opencut-mcp"),
				source: z.enum(["transcript", "speech-analysis"]),
				providerId: identifier,
				modelId: identifier,
				modelRevision: identifier,
			})
			.strict(),
		transcriptBinding: z
			.object({
				transcriptId: identifier,
				version: z.number().int().positive(),
				contentHash: digest,
			})
			.strict(),
		analysisBinding: z
			.object({
				analysisId: identifier,
				contentHash: digest,
			})
			.strict()
			.nullable(),
		parentDecisionId: identifier.nullable(),
		operations: z.array(editOperationSchema).min(1).max(30_000),
		contentHash: z.object({ algorithm: z.literal("SHA-256"), digest }).strict(),
	})
	.strict();

export const editorialDecisionInterchangeSchema = z
	.object({
		format: z.literal("opencut.editorial-decision.v1"),
		exportedAt: z.string().datetime(),
		decision: editorialDecisionSchema,
		contentHash: z.object({ algorithm: z.literal("SHA-256"), digest }).strict(),
	})
	.strict();

export type EditorialDecision = z.infer<typeof editorialDecisionSchema>;
export type EditorialSelection = z.infer<typeof selectionSchema>;

export class EditorialDecisionService {
	readonly directory: string;

	constructor(
		private readonly transcripts: TranscriptStore,
		private readonly analyses: SpeechAnalysisService,
		directory = join(transcripts.directory, "editorial-decisions"),
	) {
		this.directory = resolve(directory);
	}

	async readiness(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
	}

	async create(input: {
		operationId: string;
		decisionId: string;
		projectId: string;
		sceneId: string;
		baseRevision: number;
		baseProjectContentHash: string;
		description: string;
		rationale: string;
		selection: EditorialSelection;
	}): Promise<{ status: "created" | "replayed"; decision: EditorialDecision }> {
		const requestFingerprint = sha256(stableSerialize(input));
		const existing = await this.get(input.decisionId);
		if (existing) {
			if (
				existing.operationId !== input.operationId ||
				existing.requestFingerprint !== requestFingerprint
			) {
				throw new Error("decisionId was already used for a different request");
			}
			return { status: "replayed", decision: existing };
		}
		const resolvedEvidence = await this.resolveSelection(input.selection);
		validateBinding(input, resolvedEvidence.transcript);
		const evidence = {
			...resolvedEvidence,
			transcript: await this.ensureCutMappings(
				input.decisionId,
				resolvedEvidence.transcript,
				resolvedEvidence.ranges,
			),
		};
		const decision = withDecisionHash({
			schemaVersion: 1,
			decisionId: input.decisionId,
			operationId: input.operationId,
			requestFingerprint,
			createdAt: new Date().toISOString(),
			projectId: input.projectId,
			sceneId: input.sceneId,
			baseRevision: input.baseRevision,
			baseProjectContentHash: input.baseProjectContentHash,
			trackId: evidence.transcript.source.trackId,
			clipId: evidence.transcript.source.clipId,
			kind:
				input.selection.kind === "word-range"
					? "remove-word-range"
					: "remove-silence",
			status: "proposed",
			selection: input.selection,
			ranges: evidence.ranges,
			description: input.description,
			rationale: input.rationale,
			constraints: {
				ripple: true,
				relationshipScope: "all",
				providerExecution: "forbidden",
			},
			provenance: {
				createdBy: "opencut-mcp",
				source: evidence.analysis ? "speech-analysis" : "transcript",
				providerId: evidence.transcript.provider.providerId,
				modelId: evidence.transcript.provider.modelId,
				modelRevision: evidence.transcript.provider.modelRevision,
			},
			transcriptBinding: {
				transcriptId: evidence.transcript.transcriptId,
				version: evidence.transcript.version,
				contentHash: evidence.transcript.contentHash.digest,
			},
			analysisBinding: evidence.analysis
				? {
						analysisId: evidence.analysis.analysisId,
						contentHash: evidence.analysis.contentHash.digest,
					}
				: null,
			parentDecisionId: null,
			operations: buildRemovalOperations(
				input.decisionId,
				evidence.transcript,
				evidence.ranges,
			),
		});
		await this.write(decision);
		return { status: "created", decision };
	}

	async get(decisionId: string): Promise<EditorialDecision | null> {
		const path = this.path(decisionId);
		if (!(await stat(path).catch(() => null))) return null;
		const decision = editorialDecisionSchema.parse(
			JSON.parse(await readFile(path, "utf8")),
		);
		if (decision.decisionId !== decisionId) {
			throw new Error("editorial decision identity does not match its path");
		}
		verifyDecisionHash(decision);
		await this.verifyEvidence(decision);
		return decision;
	}

	async require(decisionId: string): Promise<EditorialDecision> {
		const decision = await this.get(decisionId);
		if (!decision)
			throw new Error(`editorial decision not found: ${decisionId}`);
		return decision;
	}

	async list(projectId?: string): Promise<EditorialDecision[]> {
		await this.readiness();
		const results: EditorialDecision[] = [];
		for (const entry of await readdir(this.directory)) {
			if (!entry.endsWith(".json")) continue;
			const parsed = editorialDecisionSchema.parse(
				JSON.parse(await readFile(join(this.directory, entry), "utf8")),
			);
			verifyDecisionHash(parsed);
			if (!projectId || parsed.projectId === projectId) results.push(parsed);
		}
		return results.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
	}

	async diff(input: {
		decisionId: string;
		currentRevision: number;
		currentProjectContentHash: string;
	}): Promise<{
		status: "unchanged" | "project-changed";
		base: { revision: number; projectContentHash: string };
		current: { revision: number; projectContentHash: string };
		operations: PreflightEditOperation[];
	}> {
		const decision = await this.require(input.decisionId);
		return {
			status:
				decision.baseRevision === input.currentRevision &&
				decision.baseProjectContentHash === input.currentProjectContentHash
					? "unchanged"
					: "project-changed",
			base: {
				revision: decision.baseRevision,
				projectContentHash: decision.baseProjectContentHash,
			},
			current: {
				revision: input.currentRevision,
				projectContentHash: input.currentProjectContentHash,
			},
			operations: decision.operations,
		};
	}

	async reapply(input: {
		operationId: string;
		decisionId: string;
		newDecisionId: string;
		currentRevision: number;
		currentProjectContentHash: string;
	}): Promise<{ status: "created" | "replayed"; decision: EditorialDecision }> {
		const source = await this.require(input.decisionId);
		const fingerprint = sha256(stableSerialize(input));
		const existing = await this.get(input.newDecisionId);
		if (existing) {
			if (
				existing.operationId !== input.operationId ||
				existing.requestFingerprint !== fingerprint
			) {
				throw new Error("newDecisionId was already used for another request");
			}
			return { status: "replayed", decision: existing };
		}
		const rebound = withDecisionHash({
			...source,
			decisionId: input.newDecisionId,
			operationId: input.operationId,
			requestFingerprint: fingerprint,
			createdAt: new Date().toISOString(),
			baseRevision: input.currentRevision,
			baseProjectContentHash: input.currentProjectContentHash,
			parentDecisionId: source.decisionId,
			operations: buildRemovalOperations(
				input.newDecisionId,
				await this.transcripts.require(
					source.transcriptBinding.transcriptId,
					source.transcriptBinding.version,
				),
				source.ranges,
			),
		});
		await this.write(rebound);
		return { status: "created", decision: rebound };
	}

	async exportJson(
		decisionId: string,
		outputPath: string,
	): Promise<{
		status: "exported";
		path: string;
		sha256: string;
	}> {
		const decision = await this.require(decisionId);
		const path = resolve(outputPath);
		const exportedAt = new Date().toISOString();
		const unsigned = {
			format: "opencut.editorial-decision.v1" as const,
			exportedAt,
			decision,
		};
		const interchange = editorialDecisionInterchangeSchema.parse({
			...unsigned,
			contentHash: {
				algorithm: "SHA-256",
				digest: sha256(stableSerialize(unsigned)),
			},
		});
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(interchange, null, 2)}\n`, {
			flag: "wx",
		});
		return {
			status: "exported",
			path,
			sha256: sha256(await readFile(path)),
		};
	}

	async importJson(pathInput: string): Promise<{
		status: "imported" | "replayed";
		decision: EditorialDecision;
		lossReport: { lossy: false; droppedFields: [] };
	}> {
		const path = resolve(pathInput);
		const interchange = editorialDecisionInterchangeSchema.parse(
			JSON.parse(await readFile(path, "utf8")),
		);
		const { contentHash, ...unsigned } = interchange;
		if (sha256(stableSerialize(unsigned)) !== contentHash.digest) {
			throw new Error("editorial decision interchange hash mismatch");
		}
		verifyDecisionHash(interchange.decision);
		const existing = await this.get(interchange.decision.decisionId);
		if (existing) {
			if (
				existing.contentHash.digest !== interchange.decision.contentHash.digest
			) {
				throw new Error("imported decision ID conflicts with durable state");
			}
			return {
				status: "replayed",
				decision: existing,
				lossReport: { lossy: false, droppedFields: [] },
			};
		}
		await this.verifyEvidence(interchange.decision);
		await this.write(interchange.decision);
		return {
			status: "imported",
			decision: interchange.decision,
			lossReport: { lossy: false, droppedFields: [] },
		};
	}

	path(decisionId: string): string {
		return join(this.directory, `${sha256(decisionId)}.json`);
	}

	private async resolveSelection(selection: EditorialSelection): Promise<{
		transcript: TranscriptRecord;
		analysis: SpeechAnalysis | null;
		ranges: EditorialDecision["ranges"];
	}> {
		if (selection.kind === "word-range") {
			const transcript = await this.transcripts.require(
				selection.transcriptId,
				selection.expectedTranscriptVersion,
			);
			const start = transcript.words.findIndex(
				(word) => word.wordId === selection.startWordId,
			);
			const end = transcript.words.findIndex(
				(word) => word.wordId === selection.endWordId,
			);
			if (start < 0 || end < start)
				throw new Error("invalid stable word selector");
			const words = transcript.words.slice(start, end + 1);
			const first = words[0]!;
			const last = words.at(-1)!;
			if (!first.timelineTime || !last.timelineTime) {
				throw new Error("selected words are outside the visible source clip");
			}
			return {
				transcript,
				analysis: null,
				ranges: [
					{
						rangeId: stableId(
							selection.transcriptId,
							selection.startWordId,
							selection.endWordId,
						),
						sourceTime: {
							startTicks: first.sourceTime.startTicks,
							endTicks: last.sourceTime.endTicks,
						},
						timelineTime: {
							startTicks: first.timelineTime.startTicks,
							endTicks: last.timelineTime.endTicks,
						},
						wordIds: words.map((word) => word.wordId),
						analysisRangeId: null,
					},
				],
			};
		}
		const analysis = await this.analyses.get(selection.analysisId);
		if (!analysis)
			throw new Error(`speech analysis not found: ${selection.analysisId}`);
		const transcript = await this.transcripts.require(
			analysis.transcriptId,
			analysis.transcriptVersion,
		);
		const requested = new Set(selection.rangeIds);
		const selected = analysis.silenceRanges.filter((item) =>
			requested.has(item.rangeId),
		);
		if (selected.length !== requested.size) {
			throw new Error("one or more silence range selectors are invalid");
		}
		const ranges = selected.map((item) => {
			if (!item.timelineTime) {
				throw new Error(
					`silence range is outside the visible clip: ${item.rangeId}`,
				);
			}
			return {
				rangeId: item.rangeId,
				sourceTime: item.sourceTime,
				timelineTime: item.timelineTime,
				wordIds: item.wordIds,
				analysisRangeId: item.rangeId,
			};
		});
		return { transcript, analysis, ranges };
	}

	private async verifyEvidence(decision: EditorialDecision): Promise<void> {
		const transcript = await this.transcripts.require(
			decision.transcriptBinding.transcriptId,
			decision.transcriptBinding.version,
		);
		if (
			transcript.contentHash.digest !== decision.transcriptBinding.contentHash
		) {
			throw new Error("editorial decision transcript evidence changed");
		}
		if (decision.analysisBinding) {
			const analysis = await this.analyses.get(
				decision.analysisBinding.analysisId,
			);
			if (
				!analysis ||
				analysis.contentHash.digest !== decision.analysisBinding.contentHash
			) {
				throw new Error("editorial decision analysis evidence changed");
			}
		}
	}

	private async ensureCutMappings(
		decisionId: string,
		selectedTranscript: TranscriptRecord,
		ranges: EditorialDecision["ranges"],
	): Promise<TranscriptRecord> {
		const current = await this.transcripts.require(
			selectedTranscript.transcriptId,
		);
		const existing = current.mappings.cuts.filter(
			(mapping) => mapping.decisionId === decisionId,
		);
		if (existing.length > 0) {
			if (existing.length !== ranges.length) {
				throw new Error("decision cut mapping is incomplete");
			}
			return current;
		}
		return this.transcripts.update({
			transcriptId: current.transcriptId,
			expectedVersion: current.version,
			update: (record) => ({
				...record,
				mappings: {
					...record.mappings,
					cuts: [
						...record.mappings.cuts,
						...ranges.map((selected) => ({
							decisionId,
							startWordId: selected.wordIds[0] ?? null,
							endWordId: selected.wordIds.at(-1) ?? null,
							sourceTime: selected.sourceTime,
						})),
					],
				},
			}),
		});
	}

	private async write(decision: EditorialDecision): Promise<void> {
		await this.readiness();
		const path = this.path(decision.decisionId);
		const temporary = join(
			this.directory,
			`.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
		);
		try {
			await writeFile(temporary, `${JSON.stringify(decision, null, 2)}\n`, {
				flag: "wx",
			});
			await link(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}

function validateBinding(
	input: {
		projectId: string;
		sceneId: string;
		baseRevision: number;
		baseProjectContentHash: string;
	},
	transcript: TranscriptRecord,
): void {
	if (
		transcript.projectId !== input.projectId ||
		transcript.sceneId !== input.sceneId
	) {
		throw new Error("selection evidence belongs to another project or scene");
	}
	if (
		transcript.projectRevision !== input.baseRevision ||
		transcript.projectContentHash !== input.baseProjectContentHash
	) {
		throw new Error(
			"decision base does not match the transcript project binding",
		);
	}
}

function buildRemovalOperations(
	decisionId: string,
	transcript: TranscriptRecord,
	ranges: EditorialDecision["ranges"],
): PreflightEditOperation[] {
	const clipStart = transcript.source.clip.timelineStartTicks;
	const clipEnd = clipStart + transcript.source.clip.durationTicks;
	const ordered = [...ranges].sort(
		(left, right) =>
			right.timelineTime.startTicks - left.timelineTime.startTicks,
	);
	for (let index = 1; index < ordered.length; index += 1) {
		if (
			ordered[index - 1]!.timelineTime.startTicks <
			ordered[index]!.timelineTime.endTicks
		) {
			throw new Error("selected removal ranges overlap");
		}
	}
	const operations: PreflightEditOperation[] = [];
	for (const selected of ordered) {
		const start = Math.max(clipStart, selected.timelineTime.startTicks);
		const end = Math.min(clipEnd, selected.timelineTime.endTicks);
		if (end <= start)
			throw new Error("selected removal range is outside the clip");
		if (start === clipStart && end === clipEnd) {
			operations.push({
				kind: "delete",
				trackId: transcript.source.trackId,
				elementId: transcript.source.clipId,
				ripple: true,
				relationshipScope: "all",
			});
			continue;
		}
		if (start === clipStart) {
			operations.push({
				kind: "split",
				trackId: transcript.source.trackId,
				elementId: transcript.source.clipId,
				splitTime: end,
				rightElementId: stableId(decisionId, selected.rangeId, "after"),
				retainSide: "right",
				ripple: true,
			});
			continue;
		}
		const middleId = stableId(decisionId, selected.rangeId, "middle");
		operations.push({
			kind: "split",
			trackId: transcript.source.trackId,
			elementId: transcript.source.clipId,
			splitTime: start,
			rightElementId: middleId,
			retainSide: "both",
			ripple: false,
		});
		if (end < clipEnd) {
			operations.push({
				kind: "split",
				trackId: transcript.source.trackId,
				elementId: middleId,
				splitTime: end,
				rightElementId: stableId(decisionId, selected.rangeId, "after"),
				retainSide: "both",
				ripple: false,
			});
		}
		operations.push({
			kind: "delete",
			trackId: transcript.source.trackId,
			elementId: middleId,
			ripple: true,
			relationshipScope: "all",
		});
	}
	return operations;
}

function withDecisionHash(
	decision: Omit<EditorialDecision, "contentHash">,
): EditorialDecision {
	return editorialDecisionSchema.parse({
		...decision,
		contentHash: {
			algorithm: "SHA-256",
			digest: sha256(stableSerialize(decision)),
		},
	});
}

function verifyDecisionHash(decision: EditorialDecision): void {
	const { contentHash, ...unsigned } = decision;
	if (sha256(stableSerialize(unsigned)) !== contentHash.digest) {
		throw new Error("editorial decision content hash mismatch");
	}
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableId(...parts: string[]): string {
	return `decision:${sha256(parts.join("\u0000")).slice(0, 32)}`;
}
