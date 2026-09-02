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
		private createProducer: () => MatteProducer = commandMatteProducerFromEnvironment,
	) {}

	async generate(input: GenerateMatteInput): Promise<Record<string, unknown>> {
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
		const clip = findProjectClip({ snapshot, input });
		const producer = this.createProducer();
		const jobDirectory = await mkdtemp(join(tmpdir(), "opencut-matte-job-"));
		const outputDirectory = join(jobDirectory, "output");
		await mkdir(outputDirectory);

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
			const attachment = asAttachmentResult(
				await this.bridge.request(
					"attach_matte",
					{
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
			await rm(jobDirectory, { recursive: true, force: true });
		}
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
