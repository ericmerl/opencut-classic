import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BridgeConnectionIdentity } from "./editor-bridge";
import {
	asProjectSnapshot,
	asTransferResult,
	sanitizeFileName,
	stableSerialize,
} from "./matte-generation-data";
import { hashSourceFile } from "./matte-producer";
import {
	TranscriptStore,
	type TranscriptProvider,
	type TranscriptRecord,
	type TranscriptSegment,
	type TranscriptWord,
} from "./transcript-store";

const TICKS_PER_SECOND = 120_000;

export interface SourceTranscriptInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	projectId: string;
	operationId: string;
	transcriptId: string;
	expectedRevision: number;
	expectedProjectContentHash: string;
	trackId: string;
	elementId: string;
	language: "en";
	terms: string[];
	timeoutSeconds: number;
}

export interface SourceTranscriptionWord {
	text: string;
	startSeconds: number;
	endSeconds: number;
	confidence: number | null;
	speaker: string | null;
}

export interface SourceTranscriptionResult {
	language: string;
	text: string;
	words: SourceTranscriptionWord[];
	provider: TranscriptProvider;
	artifactPath: string;
}

export interface SourceTranscriber {
	transcribe(input: {
		operationId: string;
		sourcePath: string;
		sourceName: string;
		sourceContentHash: string;
		language: "en";
		terms: string[];
		outputDirectory: string;
		timeoutMs: number;
	}): Promise<SourceTranscriptionResult>;
}

export interface TranscriptBridge {
	request(
		method: string,
		params: unknown,
		timeoutMs?: number,
		expectedIdentity?: BridgeConnectionIdentity,
	): Promise<unknown>;
	sourceTickets: {
		create(path: string): Promise<{ url: string; outputPath: string }>;
	};
}

export interface TranscriptSearchResult {
	matchId: string;
	selector: {
		transcriptId: string;
		startWordId: string;
		endWordId: string;
	};
	text: string;
	excerpt: string;
	sourceTime: { startTicks: number; endTicks: number };
	timelineTime: { startTicks: number; endTicks: number } | null;
}

export class TranscriptService {
	readonly artifactDirectory: string;

	constructor(
		private bridge: TranscriptBridge,
		readonly store: TranscriptStore,
		private createTranscriber: () =>
			| SourceTranscriber
			| Promise<SourceTranscriber>,
		artifactDirectory = join(store.directory, "provider-artifacts"),
	) {
		this.artifactDirectory = resolve(artifactDirectory);
	}

	async transcribe(input: SourceTranscriptInput): Promise<{
		status: "transcribed" | "replayed";
		transcript: TranscriptRecord;
	}> {
		const requestFingerprint = sha256(
			stableSerialize(semanticTranscriptionInput(input)),
		);
		const existing = await this.store.get(input.transcriptId);
		if (existing) {
			if (
				existing.operationId !== input.operationId ||
				existing.requestFingerprint !== requestFingerprint
			) {
				throw new Error(
					"transcriptId was already used for a different transcription",
				);
			}
			await verifyTranscriptArtifacts(existing);
			return { status: "replayed", transcript: existing };
		}

		const expectedIdentity = requireV2Identity(input);
		const snapshot = asProjectSnapshot(
			await this.bridge.request(
				"read_project",
				bridgeContext(input),
				30_000,
				expectedIdentity,
			),
		);
		validateSourceSnapshot(snapshot, input);
		const clip = findAudioSource(snapshot, input);
		const workDirectory = await mkdtemp(
			join(tmpdir(), "opencut-transcript-source-"),
		);
		await mkdir(this.artifactDirectory, { recursive: true });
		const outputDirectory = join(
			this.artifactDirectory,
			sha256(input.operationId),
		);
		await mkdir(outputDirectory, { recursive: true });
		try {
			const sourcePath = join(
				workDirectory,
				`source-${sanitizeFileName(clip.name)}`,
			);
			const sourceTicket = await this.bridge.sourceTickets.create(sourcePath);
			const transfer = asTransferResult(
				await this.bridge.request(
					"transfer_source_media",
					{
						...bridgeContext(input),
						projectId: input.projectId,
						expectedRevision: input.expectedRevision,
						trackId: input.trackId,
						elementId: input.elementId,
						url: sourceTicket.url,
					},
					10 * 60_000,
					expectedIdentity,
				),
			);
			if (transfer.status !== "transferred") {
				throw new Error(
					typeof transfer.reason === "string"
						? transfer.reason
						: `source transfer ${transfer.status}`,
				);
			}
			const sourceContentHash = await hashSourceFile(sourcePath);
			const transcriber = await this.createTranscriber();
			const providerResult = await transcriber.transcribe({
				operationId: input.operationId,
				sourcePath,
				sourceName: clip.name,
				sourceContentHash,
				language: input.language,
				terms: input.terms,
				outputDirectory,
				timeoutMs: input.timeoutSeconds * 1_000,
			});
			const providerArtifact = await fileIdentity(providerResult.artifactPath);
			const words = buildWords({
				transcriptId: input.transcriptId,
				providerWords: providerResult.words,
				clip,
			});
			const segments = buildSegments(input.transcriptId, words);
			const created = await this.store.create({
				transcriptId: input.transcriptId,
				operationId: input.operationId,
				requestFingerprint,
				projectId: input.projectId,
				sceneId: requiredString(snapshot.sceneId, "scene ID"),
				projectRevision: input.expectedRevision,
				projectContentHash: input.expectedProjectContentHash,
				source: {
					assetId: clip.mediaId,
					trackId: input.trackId,
					clipId: input.elementId,
					name: clip.name,
					mimeType: transfer.mimeType,
					contentHash: {
						algorithm: "SHA-256",
						digest: sourceContentHash,
					},
					sourceFingerprint: transfer.sourceFingerprint,
					durationTicks: clip.sourceDurationTicks,
					clip: {
						timelineStartTicks: clip.startTime,
						durationTicks: clip.duration,
						trimStartTicks: clip.trimStart,
						trimEndTicks: clip.trimEnd,
						retimeRate: clip.retimeRate,
					},
				},
				language: providerResult.language,
				originalText: providerResult.text,
				text: joinWords(words.map((word) => word.text)),
				segments,
				words,
				correctionHistory: [],
				mappings: { captions: [], cuts: [] },
				provider: providerResult.provider,
				providerArtifact,
			});
			return {
				status: created.status === "created" ? "transcribed" : "replayed",
				transcript: created.transcript,
			};
		} finally {
			await rm(workDirectory, { recursive: true, force: true });
		}
	}

	async get(
		transcriptId: string,
		version?: number,
	): Promise<TranscriptRecord | null> {
		const transcript = await this.store.get(transcriptId, version);
		if (transcript) await verifyTranscriptArtifacts(transcript);
		return transcript;
	}

	async search({
		transcriptId,
		query,
		limit,
		scope = "current",
	}: {
		transcriptId: string;
		query: string;
		limit: number;
		scope?: "current" | "original";
	}): Promise<TranscriptSearchResult[]> {
		const transcript = await this.store.require(transcriptId);
		const needle = tokenize(query);
		if (needle.length === 0)
			throw new Error("transcript search query is empty");
		const values = transcript.words.map((word) =>
			normalize(scope === "original" ? word.originalText : word.text),
		);
		const matches: TranscriptSearchResult[] = [];
		for (let index = 0; index <= values.length - needle.length; index += 1) {
			if (!needle.every((token, offset) => values[index + offset] === token))
				continue;
			const selected = transcript.words.slice(index, index + needle.length);
			const first = selected[0]!;
			const last = selected.at(-1)!;
			const excerpt = transcript.words.slice(
				Math.max(0, index - 4),
				index + needle.length + 4,
			);
			matches.push({
				matchId: stableId("match", transcriptId, first.wordId, last.wordId),
				selector: {
					transcriptId,
					startWordId: first.wordId,
					endWordId: last.wordId,
				},
				text: joinWords(
					selected.map((word) =>
						scope === "original" ? word.originalText : word.text,
					),
				),
				excerpt: joinWords(
					excerpt.map((word) =>
						scope === "original" ? word.originalText : word.text,
					),
				),
				sourceTime: {
					startTicks: first.sourceTime.startTicks,
					endTicks: last.sourceTime.endTicks,
				},
				timelineTime:
					first.timelineTime && last.timelineTime
						? {
								startTicks: first.timelineTime.startTicks,
								endTicks: last.timelineTime.endTicks,
							}
						: null,
			});
			if (matches.length === limit) break;
		}
		return matches;
	}

	async correct({
		transcriptId,
		expectedVersion,
		correctionId,
		policy,
		changes,
	}: {
		transcriptId: string;
		expectedVersion: number;
		correctionId: string;
		policy: "transcript-only" | "propagate-linked-captions";
		changes: Array<{ wordId: string; text: string }>;
	}): Promise<{
		status: "corrected" | "replayed";
		transcript: TranscriptRecord;
		captionOperations: Array<Record<string, unknown>>;
	}> {
		const current = await this.store.require(transcriptId);
		if (changes.length === 0)
			throw new Error("at least one transcript correction is required");
		const requested = new Map(
			changes.map((change) => [change.wordId, change.text.trim()]),
		);
		if (requested.size !== changes.length) {
			throw new Error("transcript correction repeats a word selector");
		}
		if ([...requested.values()].some((text) => !text))
			throw new Error("corrected words cannot be empty");
		const prior = current.correctionHistory.find(
			(item) => item.correctionId === correctionId,
		);
		if (prior) {
			const priorAfter = new Map(
				prior.changes.map((change) => [change.wordId, change.after]),
			);
			if (
				prior.policy !== policy ||
				priorAfter.size !== requested.size ||
				[...requested].some(([wordId, text]) => priorAfter.get(wordId) !== text)
			) {
				throw new Error(
					"correctionId was already used for a different correction",
				);
			}
			return {
				status: "replayed",
				transcript: current,
				captionOperations: prior.generatedCaptionOperations,
			};
		}
		const known = new Set(current.words.map((word) => word.wordId));
		for (const wordId of requested.keys()) {
			if (!known.has(wordId))
				throw new Error(`transcript word not found: ${wordId}`);
		}
		const changedWords = current.words.map((word) =>
			requested.has(word.wordId)
				? { ...word, text: requested.get(word.wordId)! }
				: word,
		);
		const currentById = new Map(
			current.words.map((word) => [word.wordId, word]),
		);
		const actualChanges = changedWords
			.filter((word) => word.text !== currentById.get(word.wordId)!.text)
			.map((word) => ({
				wordId: word.wordId,
				before: currentById.get(word.wordId)!.text,
				after: word.text,
			}));
		if (actualChanges.length === 0)
			throw new Error("transcript correction is a no-op");
		const captionOperations =
			policy === "propagate-linked-captions"
				? buildCaptionCorrectionOperations(current, changedWords)
				: [];
		const now = new Date().toISOString();
		const transcript = await this.store.update({
			transcriptId,
			expectedVersion,
			now,
			update: (record) => {
				const wordsById = new Map(
					changedWords.map((word) => [word.wordId, word]),
				);
				const segments = record.segments.map((segment) => ({
					...segment,
					text: joinWords(
						segment.wordIds.map((wordId) => wordsById.get(wordId)!.text),
					),
				}));
				return {
					...record,
					words: changedWords,
					segments,
					text: joinWords(changedWords.map((word) => word.text)),
					correctionHistory: [
						...record.correctionHistory,
						{
							correctionId,
							appliedAt: now,
							policy,
							changes: actualChanges,
							generatedCaptionOperations: captionOperations,
						},
					],
				};
			},
		});
		return {
			status: "corrected",
			transcript,
			captionOperations,
		};
	}
}

function semanticTranscriptionInput(input: SourceTranscriptInput) {
	const { expectedConnectionIdentity: _identity, ...semantic } = input;
	return semantic;
}

function bridgeContext(input: SourceTranscriptInput) {
	return {
		...(input.bridgeProtocolVersion !== undefined
			? { bridgeProtocolVersion: input.bridgeProtocolVersion }
			: {}),
		...(input.expectedConnectionIdentity
			? { expectedConnectionIdentity: input.expectedConnectionIdentity }
			: {}),
	};
}

function requireV2Identity(
	input: SourceTranscriptInput,
): BridgeConnectionIdentity {
	if (input.bridgeProtocolVersion !== 2 || !input.expectedConnectionIdentity) {
		throw new Error(
			"source transcription requires bridge protocol v2 connection identity",
		);
	}
	return input.expectedConnectionIdentity;
}

function validateSourceSnapshot(
	snapshot: Record<string, unknown>,
	input: SourceTranscriptInput,
): void {
	if (snapshot.projectId !== input.projectId)
		throw new Error(`active project is ${snapshot.projectId}`);
	if (snapshot.revision !== input.expectedRevision) {
		throw new Error(
			`project revision conflict: expected ${input.expectedRevision}, actual ${snapshot.revision}`,
		);
	}
	const identity = isRecord(snapshot.contentIdentity)
		? snapshot.contentIdentity
		: null;
	const hash =
		identity && isRecord(identity.hash) ? identity.hash.digest : null;
	if (
		identity?.status !== "hashed" ||
		hash !== input.expectedProjectContentHash
	) {
		throw new Error("project content hash changed before source transcription");
	}
}

interface AudioSourceClip {
	mediaId: string;
	name: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	retimeRate: number;
	sourceDurationTicks: number;
}

function findAudioSource(
	snapshot: Record<string, unknown>,
	input: SourceTranscriptInput,
): AudioSourceClip {
	const elements = snapshot.elements as unknown[];
	const element = elements.find(
		(value) =>
			isRecord(value) &&
			value.trackId === input.trackId &&
			value.elementId === input.elementId,
	);
	if (
		!isRecord(element) ||
		!new Set(["audio", "video"]).has(String(element.type)) ||
		typeof element.mediaId !== "string"
	) {
		throw new Error(`audio-capable source clip not found: ${input.elementId}`);
	}
	const assets = snapshot.mediaAssets as unknown[];
	const asset = assets.find(
		(value) => isRecord(value) && value.assetId === element.mediaId,
	);
	if (
		!isRecord(asset) ||
		typeof asset.name !== "string" ||
		typeof asset.duration !== "number"
	) {
		throw new Error(`source media metadata is incomplete: ${element.mediaId}`);
	}
	return {
		mediaId: element.mediaId,
		name: asset.name,
		startTime: requiredInteger(element.startTime, "clip start time"),
		duration: requiredPositiveInteger(element.duration, "clip duration"),
		trimStart: requiredInteger(element.trimStart, "clip trim start"),
		trimEnd: requiredInteger(element.trimEnd, "clip trim end"),
		retimeRate:
			isRecord(element.retime) && typeof element.retime.rate === "number"
				? element.retime.rate
				: 1,
		sourceDurationTicks: Math.round(asset.duration * TICKS_PER_SECOND),
	};
}

function buildWords({
	transcriptId,
	providerWords,
	clip,
}: {
	transcriptId: string;
	providerWords: SourceTranscriptionWord[];
	clip: AudioSourceClip;
}): TranscriptWord[] {
	const ordered = providerWords
		.map((word) => ({
			...word,
			text: word.text.trim(),
			startTicks: Math.round(word.startSeconds * TICKS_PER_SECOND),
			endTicks: Math.round(word.endSeconds * TICKS_PER_SECOND),
		}))
		.sort(
			(left, right) =>
				left.startTicks - right.startTicks || left.endTicks - right.endTicks,
		);
	for (const word of ordered) {
		if (!word.text) throw new Error("provider returned an empty word");
		if (
			!Number.isFinite(word.startSeconds) ||
			!Number.isFinite(word.endSeconds) ||
			word.startTicks < 0 ||
			word.endTicks <= word.startTicks ||
			word.endTicks > clip.sourceDurationTicks
		) {
			throw new Error(`provider returned invalid word timing: ${word.text}`);
		}
		if (
			word.confidence !== null &&
			(word.confidence < 0 || word.confidence > 1)
		) {
			throw new Error(
				`provider returned invalid word confidence: ${word.text}`,
			);
		}
	}
	const provisional = groupProviderWords(ordered);
	return ordered.map((word, index) => {
		const segmentIndex = provisional.findIndex((group) =>
			group.includes(index),
		);
		const timelineTime = sourceRangeToTimeline(
			{ startTicks: word.startTicks, endTicks: word.endTicks },
			clip,
		);
		return {
			wordId: stableId(
				"word",
				transcriptId,
				String(index),
				String(word.startTicks),
				String(word.endTicks),
				word.text,
			),
			segmentId: stableId("segment", transcriptId, String(segmentIndex)),
			index,
			originalText: word.text,
			text: word.text,
			sourceTime: {
				startTicks: word.startTicks,
				endTicks: word.endTicks,
			},
			timelineTime,
			speaker: word.speaker,
			confidence: word.confidence,
		};
	});
}

function groupProviderWords(
	words: Array<{ text: string; startTicks: number; endTicks: number }>,
): number[][] {
	const groups: number[][] = [];
	let current: number[] = [];
	for (let index = 0; index < words.length; index += 1) {
		const previous = words[index - 1];
		if (
			current.length &&
			previous &&
			words[index]!.startTicks - previous.endTicks > 0.8 * TICKS_PER_SECOND
		) {
			groups.push(current);
			current = [];
		}
		current.push(index);
		if (current.length >= 10 || /[.!?]$/.test(words[index]!.text)) {
			groups.push(current);
			current = [];
		}
	}
	if (current.length) groups.push(current);
	return groups;
}

function buildSegments(
	transcriptId: string,
	words: TranscriptWord[],
): TranscriptSegment[] {
	const grouped = new Map<string, TranscriptWord[]>();
	for (const word of words) {
		const values = grouped.get(word.segmentId) ?? [];
		values.push(word);
		grouped.set(word.segmentId, values);
	}
	return [...grouped.values()].map((values, index) => {
		const first = values[0]!;
		const last = values.at(-1)!;
		const confidences = values
			.map((word) => word.confidence)
			.filter((value): value is number => value !== null);
		return {
			segmentId: stableId("segment", transcriptId, String(index)),
			index,
			originalText: joinWords(values.map((word) => word.originalText)),
			text: joinWords(values.map((word) => word.text)),
			sourceTime: {
				startTicks: first.sourceTime.startTicks,
				endTicks: last.sourceTime.endTicks,
			},
			timelineTime:
				first.timelineTime && last.timelineTime
					? {
							startTicks: first.timelineTime.startTicks,
							endTicks: last.timelineTime.endTicks,
						}
					: null,
			speaker: values.every((word) => word.speaker === first.speaker)
				? first.speaker
				: null,
			confidence: confidences.length
				? confidences.reduce((sum, value) => sum + value, 0) /
					confidences.length
				: null,
			wordIds: values.map((word) => word.wordId),
		};
	});
}

function sourceRangeToTimeline(
	range: { startTicks: number; endTicks: number },
	clip: AudioSourceClip,
): { startTicks: number; endTicks: number } | null {
	const visibleSourceEnd =
		clip.trimStart + Math.round(clip.duration * clip.retimeRate);
	const start = Math.max(range.startTicks, clip.trimStart);
	const end = Math.min(range.endTicks, visibleSourceEnd);
	if (end <= start) return null;
	return {
		startTicks:
			clip.startTime + Math.round((start - clip.trimStart) / clip.retimeRate),
		endTicks:
			clip.startTime + Math.round((end - clip.trimStart) / clip.retimeRate),
	};
}

function buildCaptionCorrectionOperations(
	transcript: TranscriptRecord,
	words: TranscriptWord[],
): Array<Record<string, unknown>> {
	const wordsById = new Map(
		words.map((word, index) => [word.wordId, { word, index }]),
	);
	return transcript.mappings.captions.map((mapping) => {
		const start = wordsById.get(mapping.startWordId)?.index;
		const end = wordsById.get(mapping.endWordId)?.index;
		if (start === undefined || end === undefined || end < start) {
			throw new Error(`caption mapping is invalid: ${mapping.elementId}`);
		}
		return {
			kind: "update_caption",
			trackId: mapping.trackId,
			elementId: mapping.elementId,
			text: joinWords(words.slice(start, end + 1).map((word) => word.text)),
		};
	});
}

async function verifyTranscriptArtifacts(
	transcript: TranscriptRecord,
): Promise<void> {
	for (const artifact of [
		transcript.providerArtifact,
		transcript.provider.modelArtifact,
	]) {
		const info = await stat(artifact.path).catch(() => null);
		if (
			!info?.isFile() ||
			info.size !== artifact.bytes ||
			(await hashFile(artifact.path)) !== artifact.sha256
		) {
			throw new Error(
				`transcript provenance artifact changed or is missing: ${artifact.path}`,
			);
		}
	}
}

async function fileIdentity(
	path: string,
): Promise<{ path: string; bytes: number; sha256: string }> {
	const absolute = resolve(path);
	const info = await stat(absolute).catch(() => null);
	if (!info?.isFile() || info.size === 0)
		throw new Error(`transcription artifact is missing: ${absolute}`);
	return {
		path: absolute,
		bytes: info.size,
		sha256: await hashFile(absolute),
	};
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/^\W+|\W+$/g, "");
}

function tokenize(value: string): string[] {
	return value.split(/\s+/).map(normalize).filter(Boolean);
}

function joinWords(values: string[]): string {
	return values
		.join(" ")
		.replace(/\s+([,.;:!?%])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function stableId(prefix: string, ...parts: string[]): string {
	return `${prefix}-${sha256(stableSerialize(parts)).slice(0, 20)}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value)
		throw new Error(`${label} is missing`);
	return value;
}

function requiredInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error(`${label} is invalid`);
	return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
	const number = requiredInteger(value, label);
	if (number === 0) throw new Error(`${label} is invalid`);
	return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
