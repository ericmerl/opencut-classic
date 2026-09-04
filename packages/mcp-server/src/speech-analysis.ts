import { createHash, randomBytes } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import * as z from "zod/v4";
import { stableSerialize } from "./matte-generation-data";
import { TranscriptStore, type TranscriptRecord } from "./transcript-store";

const rangeSchema = z
	.object({
		startTicks: z.number().int().nonnegative(),
		endTicks: z.number().int().positive(),
	})
	.strict()
	.refine((value) => value.endTicks > value.startTicks, {
		message: "analysis range must have positive duration",
	});

const activityRangeSchema = z
	.object({
		rangeId: z.string().trim().min(1),
		kind: z.enum(["speech", "silence"]),
		sourceTime: rangeSchema,
		timelineTime: rangeSchema.nullable(),
		confidence: z.number().min(0).max(1).nullable(),
		wordIds: z.array(z.string().trim().min(1)).max(100_000),
	})
	.strict();

export const speechAnalysisSchema = z
	.object({
		schemaVersion: z.literal(1),
		analysisId: z.string().trim().min(1),
		operationId: z.string().trim().min(1),
		requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
		createdAt: z.string().datetime(),
		transcriptId: z.string().trim().min(1),
		transcriptVersion: z.number().int().positive(),
		transcriptContentHash: z.string().regex(/^[a-f0-9]{64}$/),
		projectId: z.string().trim().min(1),
		sceneId: z.string().trim().min(1),
		sourceAssetId: z.string().trim().min(1),
		sourceClipId: z.string().trim().min(1),
		parameters: z
			.object({
				minimumWordConfidence: z.number().min(0).max(1),
				minimumSilenceTicks: z.number().int().positive(),
				paddingTicks: z.number().int().nonnegative(),
				channel: z.literal("mix"),
				rangePolicy: z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("source") }).strict(),
					z.object({ kind: z.literal("visible-clip") }).strict(),
					z
						.object({
							kind: z.literal("explicit"),
							startTicks: z.number().int().nonnegative(),
							endTicks: z.number().int().positive(),
						})
						.strict(),
				]),
			})
			.strict(),
		provenance: z
			.object({
				method: z.literal("parakeet-word-activity"),
				providerId: z.string().trim().min(1),
				providerVersion: z.string().trim().min(1),
				modelId: z.string().trim().min(1),
				modelRevision: z.string().trim().min(1),
				modelArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
		speechRanges: z.array(activityRangeSchema).max(100_000),
		silenceRanges: z.array(activityRangeSchema).max(100_000),
		contentHash: z
			.object({
				algorithm: z.literal("SHA-256"),
				digest: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
	})
	.strict();

export type SpeechAnalysis = z.infer<typeof speechAnalysisSchema>;
export type SpeechAnalysisParameters = SpeechAnalysis["parameters"];

export class SpeechAnalysisService {
	readonly directory: string;

	constructor(
		private transcripts: TranscriptStore,
		directory = join(transcripts.directory, "speech-analysis"),
	) {
		this.directory = resolve(directory);
	}

	async analyze({
		operationId,
		analysisId,
		transcriptId,
		expectedTranscriptVersion,
		parameters,
	}: {
		operationId: string;
		analysisId: string;
		transcriptId: string;
		expectedTranscriptVersion: number;
		parameters: SpeechAnalysisParameters;
	}): Promise<{ status: "analyzed" | "replayed"; analysis: SpeechAnalysis }> {
		const fingerprint = sha256(
			stableSerialize({
				operationId,
				analysisId,
				transcriptId,
				expectedTranscriptVersion,
				parameters,
			}),
		);
		const existing = await this.get(analysisId);
		if (existing) {
			if (
				existing.operationId !== operationId ||
				existing.requestFingerprint !== fingerprint
			) {
				throw new Error("analysisId was already used for a different request");
			}
			return { status: "replayed", analysis: existing };
		}
		const transcript = await this.transcripts.require(transcriptId);
		if (transcript.version !== expectedTranscriptVersion) {
			throw new Error(
				`transcript version conflict: expected ${expectedTranscriptVersion}, actual ${transcript.version}`,
			);
		}
		const analysis = withAnalysisHash(
			buildAnalysis({
				operationId,
				analysisId,
				fingerprint,
				transcript,
				parameters,
			}),
		);
		await this.write(analysis);
		return { status: "analyzed", analysis };
	}

	async get(analysisId: string): Promise<SpeechAnalysis | null> {
		const path = this.path(analysisId);
		if (!(await stat(path).catch(() => null))) return null;
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new Error(`durable speech analysis is invalid: ${path}`);
		}
		const analysis = speechAnalysisSchema.parse(raw);
		if (analysis.analysisId !== analysisId) {
			throw new Error("speech analysis identity does not match its path");
		}
		verifyAnalysisHash(analysis);
		const transcript = await this.transcripts.require(
			analysis.transcriptId,
			analysis.transcriptVersion,
		);
		if (transcript.contentHash.digest !== analysis.transcriptContentHash) {
			throw new Error("speech analysis transcript evidence changed");
		}
		return analysis;
	}

	path(analysisId: string): string {
		return join(this.directory, `${sha256(analysisId)}.json`);
	}

	private async write(analysis: SpeechAnalysis): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const path = this.path(analysis.analysisId);
		const temporary = join(
			this.directory,
			`.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
		);
		try {
			await writeFile(temporary, `${JSON.stringify(analysis, null, 2)}\n`, {
				flag: "wx",
			});
			await link(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}

function buildAnalysis({
	operationId,
	analysisId,
	fingerprint,
	transcript,
	parameters,
}: {
	operationId: string;
	analysisId: string;
	fingerprint: string;
	transcript: TranscriptRecord;
	parameters: SpeechAnalysisParameters;
}): Omit<SpeechAnalysis, "contentHash"> {
	const analysisBounds = resolveBounds(transcript, parameters.rangePolicy);
	const eligible = transcript.words.filter(
		(word) =>
			word.sourceTime.endTicks > analysisBounds.startTicks &&
			word.sourceTime.startTicks < analysisBounds.endTicks &&
			(word.confidence === null ||
				word.confidence >= parameters.minimumWordConfidence),
	);
	const speech = mergeSpeechRanges(
		eligible.map((word) => ({
			startTicks: Math.max(
				analysisBounds.startTicks,
				word.sourceTime.startTicks - parameters.paddingTicks,
			),
			endTicks: Math.min(
				analysisBounds.endTicks,
				word.sourceTime.endTicks + parameters.paddingTicks,
			),
			word,
		})),
	);
	const speechRanges: SpeechAnalysis["speechRanges"] = speech.map(
		(range, index) => ({
			rangeId: stableRangeId(analysisId, "speech", index, range),
			kind: "speech",
			sourceTime: {
				startTicks: range.startTicks,
				endTicks: range.endTicks,
			},
			timelineTime: mapSourceRangeToTimeline(transcript, range),
			confidence: averageConfidence(range.words),
			wordIds: range.words.map((word) => word.wordId),
		}),
	);
	const silenceRanges: SpeechAnalysis["silenceRanges"] = complementRanges(
		analysisBounds,
		speech,
	)
		.filter(
			(range) =>
				range.endTicks - range.startTicks >= parameters.minimumSilenceTicks,
		)
		.map((range, index) => ({
			rangeId: stableRangeId(analysisId, "silence", index, range),
			kind: "silence",
			sourceTime: range,
			timelineTime: mapSourceRangeToTimeline(transcript, range),
			confidence: null,
			wordIds: [],
		}));
	return {
		schemaVersion: 1,
		analysisId,
		operationId,
		requestFingerprint: fingerprint,
		createdAt: new Date().toISOString(),
		transcriptId: transcript.transcriptId,
		transcriptVersion: transcript.version,
		transcriptContentHash: transcript.contentHash.digest,
		projectId: transcript.projectId,
		sceneId: transcript.sceneId,
		sourceAssetId: transcript.source.assetId,
		sourceClipId: transcript.source.clipId,
		parameters,
		provenance: {
			method: "parakeet-word-activity",
			providerId: transcript.provider.providerId,
			providerVersion: transcript.provider.providerVersion,
			modelId: transcript.provider.modelId,
			modelRevision: transcript.provider.modelRevision,
			modelArtifactSha256: transcript.provider.modelArtifact.sha256,
		},
		speechRanges,
		silenceRanges,
	};
}

function resolveBounds(
	transcript: TranscriptRecord,
	policy: SpeechAnalysisParameters["rangePolicy"],
): { startTicks: number; endTicks: number } {
	if (policy.kind === "source") {
		return { startTicks: 0, endTicks: transcript.source.durationTicks };
	}
	if (policy.kind === "visible-clip") {
		return {
			startTicks: transcript.source.clip.trimStartTicks,
			endTicks:
				transcript.source.clip.trimStartTicks +
				Math.round(
					transcript.source.clip.durationTicks *
						transcript.source.clip.retimeRate,
				),
		};
	}
	if (policy.endTicks <= policy.startTicks) {
		throw new Error("explicit analysis range must have positive duration");
	}
	if (policy.endTicks > transcript.source.durationTicks) {
		throw new Error("explicit analysis range exceeds source duration");
	}
	return { startTicks: policy.startTicks, endTicks: policy.endTicks };
}

function mergeSpeechRanges(
	values: Array<{
		startTicks: number;
		endTicks: number;
		word: TranscriptRecord["words"][number];
	}>,
): Array<{
	startTicks: number;
	endTicks: number;
	words: TranscriptRecord["words"];
}> {
	const merged: Array<{
		startTicks: number;
		endTicks: number;
		words: TranscriptRecord["words"];
	}> = [];
	for (const value of values) {
		const previous = merged.at(-1);
		if (previous && value.startTicks <= previous.endTicks) {
			previous.endTicks = Math.max(previous.endTicks, value.endTicks);
			previous.words.push(value.word);
		} else {
			merged.push({
				startTicks: value.startTicks,
				endTicks: value.endTicks,
				words: [value.word],
			});
		}
	}
	return merged;
}

function complementRanges(
	bounds: { startTicks: number; endTicks: number },
	speech: Array<{ startTicks: number; endTicks: number }>,
): Array<{ startTicks: number; endTicks: number }> {
	const ranges: Array<{ startTicks: number; endTicks: number }> = [];
	let cursor = bounds.startTicks;
	for (const range of speech) {
		if (range.startTicks > cursor) {
			ranges.push({ startTicks: cursor, endTicks: range.startTicks });
		}
		cursor = Math.max(cursor, range.endTicks);
	}
	if (cursor < bounds.endTicks) {
		ranges.push({ startTicks: cursor, endTicks: bounds.endTicks });
	}
	return ranges;
}

function mapSourceRangeToTimeline(
	transcript: TranscriptRecord,
	range: { startTicks: number; endTicks: number },
): { startTicks: number; endTicks: number } | null {
	const clip = transcript.source.clip;
	const visibleEnd =
		clip.trimStartTicks + Math.round(clip.durationTicks * clip.retimeRate);
	const start = Math.max(range.startTicks, clip.trimStartTicks);
	const end = Math.min(range.endTicks, visibleEnd);
	if (end <= start) return null;
	return {
		startTicks:
			clip.timelineStartTicks +
			Math.round((start - clip.trimStartTicks) / clip.retimeRate),
		endTicks:
			clip.timelineStartTicks +
			Math.round((end - clip.trimStartTicks) / clip.retimeRate),
	};
}

function averageConfidence(words: TranscriptRecord["words"]): number | null {
	const values = words
		.map((word) => word.confidence)
		.filter((value): value is number => value !== null);
	return values.length
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: null;
}

function stableRangeId(
	analysisId: string,
	kind: "speech" | "silence",
	index: number,
	range: { startTicks: number; endTicks: number },
): string {
	return `${kind}-${sha256(stableSerialize([analysisId, index, range])).slice(0, 20)}`;
}

function withAnalysisHash(
	analysis: Omit<SpeechAnalysis, "contentHash">,
): SpeechAnalysis {
	return speechAnalysisSchema.parse({
		...analysis,
		contentHash: {
			algorithm: "SHA-256",
			digest: sha256(stableSerialize(analysis)),
		},
	});
}

function verifyAnalysisHash(analysis: SpeechAnalysis): void {
	const { contentHash, ...projection } = analysis;
	if (contentHash.digest !== sha256(stableSerialize(projection))) {
		throw new Error(
			`speech analysis content hash mismatch: ${analysis.analysisId}`,
		);
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
