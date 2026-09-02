import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	asProjectSnapshot,
	asTransferResult,
	sanitizeFileName,
	stableSerialize,
	withProjectEnvelope,
} from "./matte-generation-data";
import { hashSourceFile } from "./matte-producer";
import {
	commandSubjectTrackerFromEnvironment,
	type NormalizedTrackingBox,
	type SubjectTrackerJob,
	type SubjectTrackerResult,
	type SubjectTrackingSample,
} from "./subject-tracker";
import type { BridgeConnectionIdentity } from "./editor-bridge";

const TICKS_PER_SECOND = 120_000;

export interface TrackSubjectInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	projectId: string;
	operationId: string;
	expectedRevision: number;
	trackId: string;
	elementId: string;
	trackingMode: "focal-point" | "crop";
	subjectPrompt?: string;
	initialBox?: NormalizedTrackingBox;
	sampleIntervalTicks: number;
	maxSamples: number;
	minConfidence: number;
	smoothing: number;
	padding: number;
	modelId?: string;
	modelVersion?: string;
	options: Record<string, string | number | boolean | null>;
	timeoutSeconds: number;
}

interface SubjectTracker {
	track(
		job: SubjectTrackerJob,
		timeoutMs: number,
	): Promise<SubjectTrackerResult>;
}

export interface SubjectTrackingBridge {
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

interface TrackingClip {
	mediaId: string;
	name: string;
	width: number;
	height: number;
	sourceDurationTicks: number;
	fps: number | null;
	duration: number;
	trimStart: number;
	trimEnd: number;
	retimeRate: number;
}

interface TrackingKeyframeOperation {
	kind: "upsert_keyframe";
	trackId: string;
	elementId: string;
	propertyPath: string;
	time: number;
	value: number;
	interpolation: "linear";
	keyframeId: string;
}

type ReframeOperation =
	| {
			kind: "set_reframe";
			trackId: string;
			elementId: string;
			mode: "cover";
	  }
	| TrackingKeyframeOperation;

export class SubjectTrackingService {
	private completed = new Map<
		string,
		{ fingerprint: string; result: Record<string, unknown> }
	>();

	constructor(
		private bridge: SubjectTrackingBridge,
		private createTracker: () => SubjectTracker = commandSubjectTrackerFromEnvironment,
	) {}

	async track(input: TrackSubjectInput): Promise<Record<string, unknown>> {
		const expectedIdentity = expectedV2Identity(input);
		const fingerprint = stableSerialize(input);
		const prior = this.completed.get(input.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for different subject tracking",
				);
			}
			return { ...prior.result, status: "replayed" };
		}

		const snapshot = asProjectSnapshot(
			await this.bridge.request(
				"read_project",
				{},
				undefined,
				expectedIdentity,
			),
		);
		if (snapshot.projectId !== input.projectId) {
			return withProjectEnvelope(
				{
					status: "rejected",
					operationId: input.operationId,
					activeProjectId: snapshot.projectId,
					reason: `active project is ${snapshot.projectId}`,
				},
				snapshot,
				input.projectId,
			);
		}
		if (snapshot.revision !== input.expectedRevision) {
			return withProjectEnvelope(
				{
					status: "conflict",
					operationId: input.operationId,
					expectedRevision: input.expectedRevision,
					actualRevision: snapshot.revision,
				},
				snapshot,
				input.projectId,
			);
		}

		const clip = findTrackingClip({ snapshot, input });
		const tracker = this.createTracker();
		const jobDirectory = await mkdtemp(join(tmpdir(), "opencut-track-job-"));
		try {
			const sourcePath = join(
				jobDirectory,
				`source-${sanitizeFileName(clip.name)}`,
			);
			const sourceTicket = await this.bridge.sourceTickets.create(sourcePath);
			const transfer = asTransferResult(
				await this.bridge.request(
					"transfer_source_media",
					{
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
				return withProjectEnvelope(transfer, snapshot, input.projectId);
			}

			const sourceContentHash = await hashSourceFile(sourcePath);
			const trackerResult = await tracker.track(
				buildTrackerJob({
					input,
					clip,
					sourcePath,
					sourceContentHash,
					transfer,
				}),
				input.timeoutSeconds * 1000,
			);
			const operations = buildTrackingEditOperations({
				input,
				clip,
				samples: trackerResult.samples,
			});
			if (operations.length === 1) {
				return withProjectEnvelope(
					{
						status: "rejected",
						operationId: input.operationId,
						reason: "tracker returned no visible samples above minConfidence",
						source: {
							mediaId: transfer.mediaId,
							contentHash: sourceContentHash,
							sourceFingerprint: transfer.sourceFingerprint,
							bytesTransferred: transfer.bytesTransferred,
						},
						tracker: {
							type: "command",
							modelId: trackerResult.modelId,
							modelVersion: trackerResult.modelVersion,
							warnings: trackerResult.warnings,
						},
					},
					snapshot,
					input.projectId,
				);
			}

			const mutation = asMutationResult(
				await this.bridge.request(
					"apply_edit_plan",
					{
						projectId: input.projectId,
						operationId: input.operationId,
						expectedRevision: input.expectedRevision,
						description: `Track subject and apply ${input.trackingMode} reframe`,
						operations,
					},
					10 * 60_000,
					expectedIdentity,
				),
			);
			if (mutation.status !== "applied" && mutation.status !== "replayed") {
				return withProjectEnvelope(
					{
						...mutation,
						source: {
							mediaId: transfer.mediaId,
							contentHash: sourceContentHash,
							sourceFingerprint: transfer.sourceFingerprint,
							bytesTransferred: transfer.bytesTransferred,
						},
						tracker: {
							type: "command",
							modelId: trackerResult.modelId,
							modelVersion: trackerResult.modelVersion,
							warnings: trackerResult.warnings,
						},
					},
					snapshot,
					input.projectId,
				);
			}

			const keyframeCount = operations.length - 1;
			const result = {
				...mutation,
				status: "tracked-and-reframed",
				trackingMode: input.trackingMode,
				keyframeCount,
				sampleCount: keyframeCount / channelsForMode(input.trackingMode).length,
				source: {
					mediaId: transfer.mediaId,
					contentHash: sourceContentHash,
					sourceFingerprint: transfer.sourceFingerprint,
					bytesTransferred: transfer.bytesTransferred,
				},
				tracker: {
					type: "command",
					modelId: trackerResult.modelId,
					modelVersion: trackerResult.modelVersion,
					warnings: trackerResult.warnings,
				},
			};
			this.completed.set(input.operationId, { fingerprint, result });
			return withProjectEnvelope(result, snapshot, input.projectId);
		} finally {
			await rm(jobDirectory, { recursive: true, force: true });
		}
	}
}

function expectedV2Identity(
	input: TrackSubjectInput,
): BridgeConnectionIdentity | undefined {
	if (input.bridgeProtocolVersion !== 2) return undefined;
	if (!input.expectedConnectionIdentity) {
		throw new Error("bridge protocol v2 requires expectedConnectionIdentity");
	}
	return input.expectedConnectionIdentity;
}

export function buildTrackingEditOperations({
	input,
	clip,
	samples,
}: {
	input: TrackSubjectInput;
	clip: Pick<TrackingClip, "duration" | "trimStart" | "retimeRate">;
	samples: SubjectTrackingSample[];
}): ReframeOperation[] {
	const visibleSourceEnd = clip.trimStart + clip.duration * clip.retimeRate;
	const visible = samples
		.filter(
			(sample) =>
				sample.sourceTime >= clip.trimStart &&
				sample.sourceTime <= visibleSourceEnd &&
				(sample.confidence === undefined ||
					sample.confidence >= input.minConfidence),
		)
		.map((sample) => ({
			time: Math.max(
				0,
				Math.min(
					clip.duration,
					Math.round((sample.sourceTime - clip.trimStart) / clip.retimeRate),
				),
			),
			box: sample.box,
		}));
	const deduplicated = deduplicateTimes(
		smoothSamples(visible, input.smoothing),
	);
	const extended = extendToClipEdges(deduplicated, clip.duration);
	const operations: ReframeOperation[] = [
		{
			kind: "set_reframe",
			trackId: input.trackId,
			elementId: input.elementId,
			mode: "cover",
		},
	];
	for (const [index, sample] of extended.entries()) {
		for (const [propertyPath, value] of valuesForSample({
			mode: input.trackingMode,
			box: sample.box,
			padding: input.padding,
		})) {
			operations.push({
				kind: "upsert_keyframe",
				trackId: input.trackId,
				elementId: input.elementId,
				propertyPath,
				time: sample.time,
				value,
				interpolation: "linear",
				keyframeId: `subject-track:${input.operationId}:${propertyPath}:${index}`,
			});
		}
	}
	return operations;
}

function buildTrackerJob({
	input,
	clip,
	sourcePath,
	sourceContentHash,
	transfer,
}: {
	input: TrackSubjectInput;
	clip: TrackingClip;
	sourcePath: string;
	sourceContentHash: string;
	transfer: ReturnType<typeof asTransferResult>;
}): SubjectTrackerJob {
	return {
		protocolVersion: 1,
		operationId: input.operationId,
		timebase: { ticksPerSecond: TICKS_PER_SECOND },
		source: {
			path: sourcePath,
			name: transfer.name,
			mimeType: transfer.mimeType,
			contentHash: sourceContentHash,
			sourceFingerprint: transfer.sourceFingerprint,
			width: clip.width,
			height: clip.height,
			durationTicks: clip.sourceDurationTicks,
			fps: clip.fps,
		},
		clip: {
			trimStart: clip.trimStart,
			trimEnd: clip.trimEnd,
			duration: clip.duration,
			retimeRate: clip.retimeRate,
		},
		sampling: {
			intervalTicks: input.sampleIntervalTicks,
			maxSamples: input.maxSamples,
		},
		...(input.subjectPrompt || input.initialBox
			? {
					subject: {
						...(input.subjectPrompt ? { prompt: input.subjectPrompt } : {}),
						...(input.initialBox ? { initialBox: input.initialBox } : {}),
					},
				}
			: {}),
		...(input.modelId || input.modelVersion
			? {
					requestedModel: {
						...(input.modelId ? { id: input.modelId } : {}),
						...(input.modelVersion ? { version: input.modelVersion } : {}),
					},
				}
			: {}),
		options: input.options,
	};
}

function findTrackingClip({
	snapshot,
	input,
}: {
	snapshot: ReturnType<typeof asProjectSnapshot>;
	input: TrackSubjectInput;
}): TrackingClip {
	const element = snapshot.elements.find(
		(value) =>
			isRecord(value) &&
			value.trackId === input.trackId &&
			value.elementId === input.elementId,
	);
	if (!isRecord(element))
		throw new Error(`element not found: ${input.elementId}`);
	if (element.type !== "video" || typeof element.mediaId !== "string") {
		throw new Error("subject tracking can only be applied to video elements");
	}
	if (
		typeof element.duration !== "number" ||
		typeof element.trimStart !== "number" ||
		typeof element.trimEnd !== "number"
	) {
		throw new Error("video element timing metadata is incomplete");
	}
	const asset = snapshot.mediaAssets.find(
		(value) => isRecord(value) && value.assetId === element.mediaId,
	);
	if (!isRecord(asset))
		throw new Error(`source media not found: ${element.mediaId}`);
	if (
		typeof asset.name !== "string" ||
		typeof asset.width !== "number" ||
		typeof asset.height !== "number" ||
		typeof asset.duration !== "number"
	) {
		throw new Error("source media metadata is incomplete");
	}
	const retime = isRecord(element.retime) ? element.retime : null;
	const retimeRate =
		retime && typeof retime.rate === "number" ? retime.rate : 1;
	if (!Number.isFinite(retimeRate) || retimeRate <= 0) {
		throw new Error("video element retime rate is invalid");
	}
	return {
		mediaId: element.mediaId,
		name: asset.name,
		width: asset.width,
		height: asset.height,
		sourceDurationTicks: Math.round(asset.duration * TICKS_PER_SECOND),
		fps: typeof asset.fps === "number" ? asset.fps : null,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		retimeRate,
	};
}

function smoothSamples(
	samples: Array<{ time: number; box: NormalizedTrackingBox }>,
	smoothing: number,
): Array<{ time: number; box: NormalizedTrackingBox }> {
	if (samples.length < 2 || smoothing <= 0) return samples;
	const weight = 1 - smoothing;
	let previous = samples[0].box;
	return samples.map((sample, index) => {
		if (index === 0) return sample;
		previous = {
			x: previous.x * smoothing + sample.box.x * weight,
			y: previous.y * smoothing + sample.box.y * weight,
			width: previous.width * smoothing + sample.box.width * weight,
			height: previous.height * smoothing + sample.box.height * weight,
		};
		return { ...sample, box: previous };
	});
}

function deduplicateTimes(
	samples: Array<{ time: number; box: NormalizedTrackingBox }>,
): Array<{ time: number; box: NormalizedTrackingBox }> {
	const byTime = new Map<
		number,
		{ time: number; box: NormalizedTrackingBox }
	>();
	for (const sample of samples) byTime.set(sample.time, sample);
	return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function extendToClipEdges(
	samples: Array<{ time: number; box: NormalizedTrackingBox }>,
	duration: number,
): Array<{ time: number; box: NormalizedTrackingBox }> {
	if (samples.length === 0) return [];
	const extended = [...samples];
	if (extended[0].time > 0) {
		extended.unshift({ time: 0, box: extended[0].box });
	}
	const last = extended[extended.length - 1];
	if (last.time < duration) {
		extended.push({ time: duration, box: last.box });
	}
	return extended;
}

function valuesForSample({
	mode,
	box,
	padding,
}: {
	mode: TrackSubjectInput["trackingMode"];
	box: NormalizedTrackingBox;
	padding: number;
}): Array<[string, number]> {
	if (mode === "focal-point") {
		return [
			["reframe.focalX", Math.min(0.999, box.x + box.width / 2)],
			["reframe.focalY", Math.min(0.999, box.y + box.height / 2)],
		];
	}
	const padded = padBox(box, padding);
	return [
		["reframe.cropX", padded.x],
		["reframe.cropY", padded.y],
		["reframe.cropWidth", padded.width],
		["reframe.cropHeight", padded.height],
	];
}

function padBox(
	box: NormalizedTrackingBox,
	padding: number,
): NormalizedTrackingBox {
	const horizontal = box.width * padding;
	const vertical = box.height * padding;
	const x = Math.max(0, box.x - horizontal);
	const y = Math.max(0, box.y - vertical);
	const right = Math.min(1, box.x + box.width + horizontal);
	const bottom = Math.min(1, box.y + box.height + vertical);
	return { x, y, width: right - x, height: bottom - y };
}

function channelsForMode(mode: TrackSubjectInput["trackingMode"]): string[] {
	return mode === "focal-point"
		? ["reframe.focalX", "reframe.focalY"]
		: [
				"reframe.cropX",
				"reframe.cropY",
				"reframe.cropWidth",
				"reframe.cropHeight",
			];
}

function asMutationResult(
	value: unknown,
): Record<string, unknown> & { status: string } {
	if (!isRecord(value) || typeof value.status !== "string") {
		throw new Error("Editor returned an invalid tracking mutation result");
	}
	return value as ReturnType<typeof asMutationResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
