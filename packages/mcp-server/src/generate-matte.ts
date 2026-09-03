import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	asAttachmentResult,
	asProjectSnapshot,
	asTransferResult,
	findProjectClip,
	sanitizeFileName,
	stableSerialize,
	withProjectEnvelope,
} from "./matte-generation-data";
import {
	commandMatteProducerFromEnvironment,
	hashSourceFile,
	type MatteProducerJob,
	type MatteProducerResult,
} from "./matte-producer";
import type { BridgeConnectionIdentity } from "./editor-bridge";
import type { CompositeOperationObserver } from "./composite-operation-observer";

export interface GenerateMatteInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	projectId: string;
	operationId: string;
	expectedRevision: number;
	trackId: string;
	elementId: string;
	modelId?: string;
	modelVersion?: string;
	options: Record<string, string | number | boolean | null>;
	timeoutSeconds: number;
}

function bridgeProtocolContext(input: GenerateMatteInput) {
	return {
		...(input.bridgeProtocolVersion !== undefined
			? { bridgeProtocolVersion: input.bridgeProtocolVersion }
			: {}),
		...(input.expectedConnectionIdentity
			? { expectedConnectionIdentity: input.expectedConnectionIdentity }
			: {}),
	};
}

interface MatteProducer {
	produce(
		job: MatteProducerJob,
		timeoutMs: number,
	): Promise<MatteProducerResult>;
}

export interface MatteGenerationBridge {
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

export class MatteGenerationService {
	private completed = new Map<
		string,
		{ fingerprint: string; result: Record<string, unknown> }
	>();

	constructor(
		private bridge: MatteGenerationBridge,
		private createProducer?: () => MatteProducer,
		private durableArtifactRoot?: string,
		private jobStoreDirectory?: string,
	) {}

	async generate(
		input: GenerateMatteInput,
		observe?: CompositeOperationObserver,
	): Promise<Record<string, unknown>> {
		const expectedIdentity = expectedV2Identity(input);
		const fingerprint = stableSerialize(input);
		const prior = this.completed.get(input.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for a different matte generation",
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
		const clip = findProjectClip({ snapshot, input });
		const producer = this.createProducer
			? this.createProducer()
			: commandMatteProducerFromEnvironment(
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
				"opencut-matte-job-",
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
				provider: "matte-producer-command",
				modelId: input.modelId,
				modelVersion: input.modelVersion,
			});
			const producerResult = await producer.produce(
				{
					protocolVersion: 1,
					operationId: input.operationId,
					source: {
						path: sourcePath,
						name: transfer.name,
						mimeType: transfer.mimeType,
						contentHash: sourceContentHash,
						sourceFingerprint: transfer.sourceFingerprint,
						width: clip.width,
						height: clip.height,
						duration: clip.duration,
						fps: clip.fps,
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
			const matteTicket = await this.bridge.mediaTickets.create(
				producerResult.artifactPath,
			);
			preserveJobDirectory = true;
			await observe?.({
				state: "committed",
				provider: "matte-producer-command",
				modelId: producerResult.modelId,
				modelVersion: producerResult.modelVersion,
				artifact: {
					sha256: matteTicket.contentHash,
					mimeType: matteTicket.mimeType,
					path: producerResult.artifactPath,
				},
				metadata: {
					warnings: producerResult.warnings,
					channel: producerResult.channel,
				},
			});
			const attachment = asAttachmentResult(
				await this.bridge.request(
					"attach_matte",
					{
						...bridgeProtocolContext(input),
						projectId: input.projectId,
						operationId: input.operationId,
						expectedRevision: input.expectedRevision,
						trackId: input.trackId,
						elementId: input.elementId,
						url: matteTicket.url,
						name: matteTicket.name,
						mimeType: matteTicket.mimeType,
						artifactHash: matteTicket.contentHash,
						artifactFingerprint: matteTicket.sourceFingerprint,
						channel: producerResult.channel,
						modelId: producerResult.modelId,
						modelVersion: producerResult.modelVersion,
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
						producer: {
							type: "command",
							modelId: producerResult.modelId,
							modelVersion: producerResult.modelVersion,
							warnings: producerResult.warnings,
						},
					},
					snapshot,
					input.projectId,
				);
			}
			await observe?.({
				state: "verified",
				provider: "matte-producer-command",
				modelId: producerResult.modelId,
				modelVersion: producerResult.modelVersion,
				artifact: {
					sha256: matteTicket.contentHash,
					mimeType: matteTicket.mimeType,
					path: producerResult.artifactPath,
				},
			});
			preserveJobDirectory = Boolean(this.durableArtifactRoot);

			const result = {
				...attachment,
				status: "generated-and-attached",
				source: {
					mediaId: transfer.mediaId,
					contentHash: sourceContentHash,
					sourceFingerprint: transfer.sourceFingerprint,
					bytesTransferred: transfer.bytesTransferred,
				},
				producer: {
					type: "command",
					modelId: producerResult.modelId,
					modelVersion: producerResult.modelVersion,
					warnings: producerResult.warnings,
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
		input: GenerateMatteInput,
		artifact: {
			path: string;
			sha256: string;
			modelId: string;
			modelVersion: string;
			channel: "alpha" | "red";
		},
		observe?: CompositeOperationObserver,
	): Promise<Record<string, unknown>> {
		const ticket = await this.bridge.mediaTickets.create(artifact.path);
		if (ticket.contentHash !== artifact.sha256) {
			throw new Error("retained matte artifact hash changed");
		}
		const attachment = asAttachmentResult(
			await this.bridge.request(
				"attach_matte",
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
					channel: artifact.channel,
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
			provider: "matte-producer-command",
			modelId: artifact.modelId,
			modelVersion: artifact.modelVersion,
			artifact: {
				path: artifact.path,
				sha256: artifact.sha256,
				mimeType: ticket.mimeType,
			},
			metadata: { channel: artifact.channel },
		});
		return {
			...attachment,
			status: "generated-and-attached",
			recoveredProviderArtifact: true,
			producer: {
				type: "command",
				modelId: artifact.modelId,
				modelVersion: artifact.modelVersion,
				warnings: [],
			},
		};
	}
}

function expectedV2Identity(
	input: GenerateMatteInput,
): BridgeConnectionIdentity | undefined {
	if (input.bridgeProtocolVersion !== 2) return undefined;
	if (!input.expectedConnectionIdentity) {
		throw new Error("bridge protocol v2 requires expectedConnectionIdentity");
	}
	return input.expectedConnectionIdentity;
}
