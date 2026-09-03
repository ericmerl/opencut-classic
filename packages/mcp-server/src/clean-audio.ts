import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commandAudioCleanerFromEnvironment,
	type AudioCleanerJob,
	type AudioCleanerResult,
} from "./audio-cleaner";
import {
	asProjectSnapshot,
	asTransferResult,
	sanitizeFileName,
	stableSerialize,
	withProjectEnvelope,
} from "./matte-generation-data";
import { hashSourceFile } from "./matte-producer";
import type { BridgeConnectionIdentity } from "./editor-bridge";
import type { CompositeOperationObserver } from "./composite-operation-observer";

export interface CleanAudioInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	projectId: string;
	operationId: string;
	expectedRevision: number;
	trackId: string;
	elementId: string;
	noiseReduction: number;
	deReverb: number;
	deEss: number;
	highPassHz: number;
	normalize: boolean;
	modelId?: string;
	modelVersion?: string;
	options: Record<string, string | number | boolean | null>;
	timeoutSeconds: number;
}

function bridgeProtocolContext(input: CleanAudioInput) {
	return {
		...(input.bridgeProtocolVersion !== undefined
			? { bridgeProtocolVersion: input.bridgeProtocolVersion }
			: {}),
		...(input.expectedConnectionIdentity
			? { expectedConnectionIdentity: input.expectedConnectionIdentity }
			: {}),
	};
}

interface AudioCleaner {
	clean(job: AudioCleanerJob, timeoutMs: number): Promise<AudioCleanerResult>;
}

export interface AudioCleanupBridge {
	request(
		method: string,
		params: unknown,
		timeoutMs?: number,
		expectedIdentity?: BridgeConnectionIdentity,
	): Promise<unknown>;
	sourceTickets: {
		create(path: string): Promise<{ url: string; outputPath: string }>;
	};
	mediaTickets: {
		create(path: string): Promise<{
			url: string;
			name: string;
			mimeType: string;
			size: number;
			sourceFingerprint: string;
			contentHash: string;
		}>;
	};
}

interface AudioProjectClip {
	mediaId: string;
	name: string;
	durationSeconds: number;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	retimeRate: number;
	maintainPitch: boolean;
}

export class AudioCleanupService {
	private completed = new Map<
		string,
		{ fingerprint: string; result: Record<string, unknown> }
	>();

	constructor(
		private bridge: AudioCleanupBridge,
		private createCleaner?: () => AudioCleaner,
		private durableArtifactRoot?: string,
		private jobStoreDirectory?: string,
	) {}

	async clean(
		input: CleanAudioInput,
		observe?: CompositeOperationObserver,
	): Promise<Record<string, unknown>> {
		const expectedIdentity = expectedV2Identity(input);
		const fingerprint = stableSerialize(input);
		const prior = this.completed.get(input.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for a different audio cleanup",
				);
			}
			return { ...prior.result, status: "replayed" };
		}

		const snapshot = asProjectSnapshot(
			await this.bridge.request(
				"read_project",
				bridgeProtocolContext(input),
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

		const clip = findAudioProjectClip({ snapshot, input });
		const cleaner = this.createCleaner
			? this.createCleaner()
			: commandAudioCleanerFromEnvironment(
					this.jobStoreDirectory ??
						(this.durableArtifactRoot
							? join(this.durableArtifactRoot, "provider-results")
							: undefined),
				);
		if (this.durableArtifactRoot) {
			await mkdir(this.durableArtifactRoot, { recursive: true });
		}
		const jobDirectory = await mkdtemp(
			join(
				this.durableArtifactRoot ?? tmpdir(),
				"opencut-audio-job-",
			),
		);
		const outputDirectory = join(jobDirectory, "output");
		await mkdir(outputDirectory);
		let preserveJobDirectory = false;

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
						...bridgeProtocolContext(input),
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
			await observe?.({
				state: "prepared",
				provider: "audio-cleaner-command",
				modelId: input.modelId,
				modelVersion: input.modelVersion,
			});
			const cleanerResult = await cleaner.clean(
				{
					protocolVersion: 1,
					operationId: input.operationId,
					timebase: { ticksPerSecond: 120_000 },
					source: {
						path: sourcePath,
						name: transfer.name,
						mimeType: transfer.mimeType,
						contentHash: sourceContentHash,
						sourceFingerprint: transfer.sourceFingerprint,
						durationSeconds: clip.durationSeconds,
					},
					clip: {
						startTime: clip.startTime,
						duration: clip.duration,
						trimStart: clip.trimStart,
						trimEnd: clip.trimEnd,
						retimeRate: clip.retimeRate,
						maintainPitch: clip.maintainPitch,
					},
					cleanup: {
						noiseReduction: input.noiseReduction,
						deReverb: input.deReverb,
						deEss: input.deEss,
						highPassHz: input.highPassHz,
						normalize: input.normalize,
					},
					outputDirectory,
					...(input.modelId || input.modelVersion
						? {
								requestedModel: {
									...(input.modelId ? { id: input.modelId } : {}),
									...(input.modelVersion
										? { version: input.modelVersion }
										: {}),
								},
							}
						: {}),
					options: input.options,
				},
				input.timeoutSeconds * 1000,
			);
			const artifactTicket = await this.bridge.mediaTickets.create(
				cleanerResult.artifactPath,
			);
			preserveJobDirectory = true;
			await observe?.({
				state: "committed",
				provider: "audio-cleaner-command",
				modelId: cleanerResult.modelId,
				modelVersion: cleanerResult.modelVersion,
				artifact: {
					sha256: artifactTicket.contentHash,
					mimeType: artifactTicket.mimeType,
					path: cleanerResult.artifactPath,
				},
				metadata: { warnings: cleanerResult.warnings },
			});
			const attachment = asAttachmentResult(
				await this.bridge.request(
					"attach_clean_audio",
					{
						...bridgeProtocolContext(input),
						projectId: input.projectId,
						operationId: input.operationId,
						expectedRevision: input.expectedRevision,
						trackId: input.trackId,
						elementId: input.elementId,
						url: artifactTicket.url,
						name: artifactTicket.name,
						mimeType: artifactTicket.mimeType,
						artifactHash: artifactTicket.contentHash,
						artifactFingerprint: artifactTicket.sourceFingerprint,
						modelId: cleanerResult.modelId,
						modelVersion: cleanerResult.modelVersion,
					},
					10 * 60_000,
					expectedIdentity,
				),
			);
			if (attachment.status !== "applied" && attachment.status !== "replayed") {
				return withProjectEnvelope(
					{
						...attachment,
						source: {
							mediaId: transfer.mediaId,
							contentHash: sourceContentHash,
							sourceFingerprint: transfer.sourceFingerprint,
							bytesTransferred: transfer.bytesTransferred,
						},
						cleaner: {
							type: "command",
							modelId: cleanerResult.modelId,
							modelVersion: cleanerResult.modelVersion,
							warnings: cleanerResult.warnings,
						},
					},
					snapshot,
					input.projectId,
				);
			}
			await observe?.({
				state: "verified",
				provider: "audio-cleaner-command",
				modelId: cleanerResult.modelId,
				modelVersion: cleanerResult.modelVersion,
				artifact: {
					sha256: artifactTicket.contentHash,
					mimeType: artifactTicket.mimeType,
					path: cleanerResult.artifactPath,
				},
			});
			preserveJobDirectory = Boolean(this.durableArtifactRoot);

			const result = {
				...attachment,
				status: "cleaned-and-attached",
				source: {
					mediaId: transfer.mediaId,
					contentHash: sourceContentHash,
					sourceFingerprint: transfer.sourceFingerprint,
					bytesTransferred: transfer.bytesTransferred,
				},
				cleaner: {
					type: "command",
					modelId: cleanerResult.modelId,
					modelVersion: cleanerResult.modelVersion,
					warnings: cleanerResult.warnings,
				},
			};
			this.completed.set(input.operationId, { fingerprint, result });
			return withProjectEnvelope(result, snapshot, input.projectId);
		} finally {
			if (!preserveJobDirectory) {
				await rm(jobDirectory, { recursive: true, force: true });
			}
		}
	}

	async attachRecovered(
		input: CleanAudioInput,
		artifact: {
			path: string;
			sha256: string;
			modelId: string;
			modelVersion: string;
		},
		observe?: CompositeOperationObserver,
	): Promise<Record<string, unknown>> {
		const ticket = await this.bridge.mediaTickets.create(artifact.path);
		if (ticket.contentHash !== artifact.sha256) {
			throw new Error("retained cleaned-audio artifact hash changed");
		}
		const attachment = asAttachmentResult(
			await this.bridge.request(
				"attach_clean_audio",
				{
					...bridgeProtocolContext(input),
					projectId: input.projectId,
					operationId: input.operationId,
					expectedRevision: input.expectedRevision,
					trackId: input.trackId,
					elementId: input.elementId,
					url: ticket.url,
					name: ticket.name,
					mimeType: ticket.mimeType,
					artifactHash: ticket.contentHash,
					artifactFingerprint: ticket.sourceFingerprint,
					modelId: artifact.modelId,
					modelVersion: artifact.modelVersion,
				},
				10 * 60_000,
				expectedV2Identity(input),
			),
		);
		if (attachment.status !== "applied" && attachment.status !== "replayed") {
			return attachment;
		}
		await observe?.({
			state: "verified",
			provider: "audio-cleaner-command",
			modelId: artifact.modelId,
			modelVersion: artifact.modelVersion,
			artifact: {
				path: artifact.path,
				sha256: artifact.sha256,
				mimeType: ticket.mimeType,
			},
		});
		return {
			...attachment,
			status: "cleaned-and-attached",
			recoveredProviderArtifact: true,
			cleaner: {
				type: "command",
				modelId: artifact.modelId,
				modelVersion: artifact.modelVersion,
				warnings: [],
			},
		};
	}
}

function expectedV2Identity(
	input: CleanAudioInput,
): BridgeConnectionIdentity | undefined {
	if (input.bridgeProtocolVersion !== 2) return undefined;
	if (!input.expectedConnectionIdentity) {
		throw new Error("bridge protocol v2 requires expectedConnectionIdentity");
	}
	return input.expectedConnectionIdentity;
}

function findAudioProjectClip({
	snapshot,
	input,
}: {
	snapshot: ReturnType<typeof asProjectSnapshot>;
	input: CleanAudioInput;
}): AudioProjectClip {
	const element = snapshot.elements.find(
		(value) =>
			isRecord(value) &&
			value.trackId === input.trackId &&
			value.elementId === input.elementId,
	);
	if (!isRecord(element))
		throw new Error(`element not found: ${input.elementId}`);
	if (
		(element.type !== "audio" && element.type !== "video") ||
		typeof element.mediaId !== "string"
	) {
		throw new Error(
			"audio cleanup requires an uploaded audio or video element",
		);
	}
	if (element.type === "video" && element.sourceAudioSeparated === true) {
		throw new Error(
			"video source audio is separated; clean its separated audio element",
		);
	}
	const asset = snapshot.mediaAssets.find(
		(value) => isRecord(value) && value.assetId === element.mediaId,
	);
	if (!isRecord(asset))
		throw new Error(`source media not found: ${element.mediaId}`);
	if (
		(asset.type !== "audio" && asset.type !== "video") ||
		typeof asset.name !== "string" ||
		typeof asset.duration !== "number"
	) {
		throw new Error("source audio metadata is incomplete");
	}
	for (const key of [
		"startTime",
		"duration",
		"trimStart",
		"trimEnd",
	] as const) {
		if (typeof element[key] !== "number") {
			throw new Error(`source clip ${key} is unavailable`);
		}
	}
	const retime = isRecord(element.retime) ? element.retime : null;
	return {
		mediaId: element.mediaId,
		name: asset.name,
		durationSeconds: asset.duration,
		startTime: element.startTime as number,
		duration: element.duration as number,
		trimStart: element.trimStart as number,
		trimEnd: element.trimEnd as number,
		retimeRate: typeof retime?.rate === "number" ? retime.rate : 1,
		maintainPitch:
			typeof retime?.maintainPitch === "boolean" ? retime.maintainPitch : true,
	};
}

function asAttachmentResult(
	value: unknown,
): Record<string, unknown> & { status: string } {
	if (!isRecord(value) || typeof value.status !== "string") {
		throw new Error("Editor returned an invalid audio attachment result");
	}
	return value as ReturnType<typeof asAttachmentResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
