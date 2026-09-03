import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	ExportJobStore,
	exportJobSemanticHash,
	jobStatesForExportStatuses,
	readEnvelope,
	toExportJobRecord,
	type ExportJobRecord,
	type ExportJobStatus,
} from "./export-job-store";
import {
	type ExportProjectBridge,
	type ExportProjectInput,
	type QueuedProjectPersistence,
} from "./export-project";
import type { BridgeConnectionIdentity } from "./editor-bridge";
import {
	JOB_HEARTBEAT_INTERVAL_MS,
	JobStoreError,
	jobOwnerId,
	type JobArtifact,
	type JobClaim,
	type JobRecord,
	type JobReconciliationOutcome,
	type JsonValue,
} from "./job-store";
import { stableSerialize } from "./matte-generation-data";

export interface PersistentExportJobBridge extends ExportProjectBridge {
	getStatus(): {
		connected: boolean;
		connectionIdentity?: BridgeConnectionIdentity | null;
	};
	onConnectionChange(listener: (connected: boolean) => void): () => void;
}

/** Execution hooks the job runner hands to the export service. */
export interface ExportExecutionOptions {
	/** Polled by the export ticket status endpoint and the renderer. */
	cancellationRequested?: () => boolean;
	onPhase?: (phase: string) => void;
}

export interface PersistentExportProjectService {
	export(
		input: ExportProjectInput,
		options?: ExportExecutionOptions,
	): Promise<Record<string, unknown>>;
}

export interface ExportJobReceiptSource {
	get(operationId: string): Promise<{ result: Record<string, unknown> } | null>;
}

export interface ExportJobQueueOptions {
	autoRun?: boolean;
	ensureEditor?: (projectId: string) => Promise<unknown>;
	capabilitySnapshotHash?: () => Promise<string>;
	/** Lets restart reconciliation terminalize jobs whose receipt was written. */
	receipts?: ExportJobReceiptSource;
	ownerId?: string;
	maximumAttempts?: number;
}

export const EXPORT_CANCELLATION_POLICY = {
	observationBound:
		"renderer polls the export ticket status every 250 ms and the queue records observation on the next heartbeat",
	partialArtifacts:
		"a cancelled render never uploads, so no output file is written; an interrupted upload leaves nothing at the destination because the transfer commits atomically",
	interruptedRuns:
		"an export whose receipt was written is terminalized as succeeded without rerendering; an output file without a receipt is retained and the job enters recovery-required; otherwise the attempt is recorded as interrupted and the job is requeued within its attempt policy",
} as const;

export class ExportJobQueue {
	readonly ownerId: string;
	private draining: Promise<ExportJobRecord[]> | null = null;
	private stopped = false;
	private readonly unsubscribe: () => void;

	constructor(
		private bridge: PersistentExportJobBridge,
		private exports: PersistentExportProjectService,
		readonly store: ExportJobStore,
		private options: ExportJobQueueOptions = {},
	) {
		this.ownerId = options.ownerId ?? jobOwnerId();
		// The queue performs fenced writes, so it keeps one store connection
		// open for its lifetime and releases it in `stop()`.
		store.retain();
		this.unsubscribe = bridge.onConnectionChange((connected) => {
			if (connected) this.schedule();
		});
		this.schedule();
	}

	static storeForReceiptDirectory(receiptDirectory: string): ExportJobStore {
		return new ExportJobStore(join(receiptDirectory, "jobs"));
	}

	async enqueue({
		jobId,
		input,
	}: {
		jobId: string;
		input: ExportProjectInput;
	}): Promise<{ job: ExportJobRecord; replayed: boolean }> {
		if (
			input.bridgeProtocolVersion === 2 &&
			!input.expectedProjectContentHash
		) {
			throw new Error(
				"production protocol v2 export jobs require expectedProjectContentHash",
			);
		}
		await this.store.initialize();
		const fingerprint = exportJobFingerprint(input);
		const existing = this.store.jobs.get(jobId);
		if (existing) {
			if (existing.jobType !== "export") {
				throw new Error("jobId was already used for a different job type");
			}
			const envelope = readEnvelope(existing.input);
			const existingFingerprint = exportJobFingerprint(envelope.export);
			const isRecognizedStoredFingerprint =
				envelope.fingerprint === existingFingerprint ||
				envelope.fingerprint === legacyExportJobFingerprint(envelope.export);
			if (!isRecognizedStoredFingerprint || existingFingerprint !== fingerprint) {
				throw new Error("jobId was already used for a different export job");
			}
			if (
				envelope.export.bridgeProtocolVersion === 2 &&
				envelope.export.queuedProjectPersistence === undefined &&
				existing.state === "queued"
			) {
				const migrated = await this.prepareQueuedJob(existing, input);
				return { job: toExportJobRecord(migrated), replayed: true };
			}
			return { job: toExportJobRecord(existing), replayed: true };
		}
		const capabilitySnapshotHash =
			input.capabilitySnapshotHash ??
			(await this.options.capabilitySnapshotHash?.());
		const inputWithCapabilities = capabilitySnapshotHash
			? { ...input, capabilitySnapshotHash }
			: input;
		const persistedInput =
			input.bridgeProtocolVersion === 2
				? {
						...inputWithCapabilities,
						queuedProjectPersistence: await captureQueuedProjectPersistence(
							this.bridge,
							inputWithCapabilities,
							jobId,
						),
					}
				: inputWithCapabilities;
		const created = this.store.jobs.submit({
			jobId,
			jobType: "export",
			operationId: input.operationId,
			semanticInputHash: exportJobSemanticHash(fingerprint),
			capabilitySnapshotHash: capabilitySnapshotHash ?? null,
			preconditions: {
				projectId: input.projectId,
				revision: input.expectedRevision,
				contentHash: input.expectedProjectContentHash ?? null,
				writeVersion:
					persistedInput.queuedProjectPersistence?.writeVersion ?? null,
			},
			rendererPolicy: { renderer: "opencut-web-renderer", container: input.format },
			attemptPolicy: {
				maximumAttempts: this.options.maximumAttempts ?? 3,
				retryableErrorClasses: ["editor-disconnected"],
				boundedBackoffMs: 0,
			},
			progressUnits: "phases",
			input: {
				fingerprint,
				export: persistedInput as unknown as JsonValue,
			},
		});
		this.schedule();
		return { job: toExportJobRecord(created.record), replayed: created.replayed };
	}

	async get(jobId: string): Promise<ExportJobRecord | null> {
		return this.store.get(jobId);
	}

	async list({
		statuses,
		limit,
	}: {
		statuses?: ExportJobStatus[];
		limit: number;
	}): Promise<ExportJobRecord[]> {
		await this.store.initialize();
		return this.store.jobs
			.list({
				types: ["export"],
				...(statuses?.length
					? { states: jobStatesForExportStatuses(statuses) }
					: {}),
				limit,
			})
			.map(toExportJobRecord);
	}

	/**
	 * Cancel a queued or running export. A running render observes the signal
	 * through the export ticket status endpoint; the job reports `cancelling`
	 * until the renderer confirms it stopped.
	 */
	async cancel(jobId: string): Promise<ExportJobRecord> {
		await this.store.initialize();
		return toExportJobRecord(
			this.requireExport(jobId, () =>
				this.store.jobs.cancel(jobId, "cancellation requested through MCP"),
			),
		);
	}

	async retry(
		jobId: string,
		options: { reason: string; operationId: string | null },
	): Promise<ExportJobRecord> {
		await this.store.initialize();
		const job = toExportJobRecord(
			this.requireExport(jobId, () => this.store.jobs.retry(jobId, options)),
		);
		this.schedule();
		return job;
	}

	/**
	 * Resolve a job in `recovery-required`. Rerunning quarantines any output
	 * file left by the interrupted attempt so the new attempt cannot collide
	 * with the destination path.
	 */
	async resolve(
		jobId: string,
		resolution: {
			kind: "rerun-as-new-attempt" | "mark-failed";
			reason: string;
			operationId: string | null;
		},
	): Promise<ExportJobRecord> {
		await this.store.initialize();
		const current = this.store.jobs.get(jobId);
		if (!current || current.jobType !== "export") {
			throw new Error(`export job not found: ${jobId}`);
		}
		const artifacts: JobArtifact[] = [];
		if (resolution.kind === "rerun-as-new-attempt") {
			const outputPath = readEnvelope(current.input).export.outputPath;
			const info = await stat(outputPath).catch(() => null);
			if (info?.isFile()) {
				const quarantinePath = `${outputPath}.attempt${current.attempt}.partial`;
				await rename(outputPath, quarantinePath);
				artifacts.push({
					kind: "export-output",
					path: quarantinePath,
					sha256: await hashFile(quarantinePath),
					bytes: info.size,
					disposition: "quarantined",
					recordedAt: new Date().toISOString(),
				});
			}
		}
		const job = toExportJobRecord(
			this.store.jobs.resolve(jobId, { ...resolution, artifacts }),
		);
		if (resolution.kind === "rerun-as-new-attempt") this.schedule();
		return job;
	}

	async runQueued(
		limit = Number.POSITIVE_INFINITY,
	): Promise<ExportJobRecord[]> {
		if (this.draining) return this.draining;
		this.draining = this.runWithEditor(limit).finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	/** Reconcile jobs whose owner died before requeueing or recovering them. */
	async reconcileInterrupted(): Promise<ExportJobRecord[]> {
		await this.store.initialize();
		const reconciled = await this.store.jobs.reconcileInterrupted({
			reconcile: (record) => this.reconcileExportJob(record),
		});
		return reconciled
			.filter((record) => record.jobType === "export")
			.map(toExportJobRecord);
	}

	stop(): void {
		this.stopped = true;
		this.unsubscribe();
		this.store.close();
	}

	private schedule(): void {
		if (this.stopped || this.options.autoRun === false) return;
		queueMicrotask(() => void this.runQueued().catch(() => undefined));
	}

	private async runWithEditor(limit: number): Promise<ExportJobRecord[]> {
		await this.reconcileInterrupted();
		if (!this.bridge.getStatus().connected) {
			const candidate = this.store.jobs.nextQueued(["export"]);
			if (!candidate || !this.options.ensureEditor) return [];
			try {
				await this.options.ensureEditor(
					readEnvelope(candidate.input).export.projectId,
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "managed editor worker failed to connect";
				this.store.jobs.block(candidate.jobId, message);
				this.store.jobs.unblock(candidate.jobId);
				throw error;
			}
		}
		if (!this.bridge.getStatus().connected) return [];
		return this.drain(limit);
	}

	private async drain(limit: number): Promise<ExportJobRecord[]> {
		const processed: ExportJobRecord[] = [];
		const seen = new Set<string>();
		while (processed.length < limit) {
			if (this.stopped || !this.bridge.getStatus().connected) break;
			const queued = this.store.jobs.nextQueued(["export"]);
			if (!queued || seen.has(queued.jobId)) break;
			seen.add(queued.jobId);
			processed.push(await this.run(queued));
		}
		return processed;
	}

	private async run(queued: JobRecord): Promise<ExportJobRecord> {
		let prepared: JobRecord;
		try {
			prepared = await this.prepareQueuedJob(queued);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "export job failed";
			if (isConnectionFailure(message)) {
				return toExportJobRecord(this.store.jobs.get(queued.jobId)!);
			}
			const claim = this.store.jobs.claim(queued.jobId, this.ownerId);
			if (!claim) return toExportJobRecord(this.store.jobs.require(queued.jobId));
			return toExportJobRecord(
				this.store.jobs.fail(queued.jobId, claim, {
					error: message,
					errorClass: "queue-preparation-failed",
				}),
			);
		}
		if (prepared.state !== "queued") return toExportJobRecord(prepared);
		const claim = this.store.jobs.claim(prepared.jobId, this.ownerId);
		if (!claim) return toExportJobRecord(this.store.jobs.require(prepared.jobId));
		const jobId = claim.record.jobId;
		const attempt = claim.record.attempt;
		const heartbeat = setInterval(() => {
			try {
				this.store.jobs.heartbeat(jobId, claim);
			} catch {
				// A rejected fence means another owner reconciled the job away.
			}
		}, JOB_HEARTBEAT_INTERVAL_MS);
		try {
			this.store.jobs.start(jobId, claim, {
				phase: "opening-project",
				total: 4,
				completed: 0,
			});
			if (claim.record.cancellationRequestedAt) {
				return toExportJobRecord(
					this.store.jobs.confirmCancelled(jobId, claim, {
						reason: "cancelled before the render started",
					}),
				);
			}
			const envelope = readEnvelope(claim.record.input);
			const executionInput = bindJobToConnectedEditor(
				envelope.export,
				this.bridge,
			);
			const executionIdentity = executionInput.expectedConnectionIdentity;
			const opened = await this.bridge.request(
				"open_project",
				{
					operationId: `export-job:${jobId}:open:${attempt}`,
					projectId: envelope.export.projectId,
					...(executionInput.bridgeProtocolVersion === 2
						? {
								bridgeProtocolVersion: 2 as const,
								expectedConnectionIdentity: executionIdentity,
							}
						: {}),
				},
				undefined,
				executionIdentity,
			);
			if (!isProjectOpened(opened)) {
				return toExportJobRecord(
					this.store.jobs.fail(jobId, claim, {
						error: resultReason(opened),
						errorClass: "project-open-failed",
					}),
				);
			}
			const observedInput = bindJobToObservedProject(executionInput, opened);
			this.store.jobs.heartbeat(jobId, claim, {
				progress: { phase: "verifying-persistence", completed: 1 },
			});
			if (observedInput.bridgeProtocolVersion === 2) {
				await verifyQueuedProjectPersistence(
					this.bridge,
					observedInput,
					jobId,
					attempt,
				);
			}
			if (this.cancellationRequested(jobId)) {
				return toExportJobRecord(
					this.store.jobs.confirmCancelled(jobId, claim, {
						reason: "cancelled before the render started",
					}),
				);
			}
			this.store.jobs.heartbeat(jobId, claim, {
				progress: { phase: "rendering", completed: 2 },
			});
			const result = await this.exports.export(observedInput, {
				cancellationRequested: () => this.cancellationRequested(jobId),
				onPhase: (phase) => {
					try {
						this.store.jobs.heartbeat(jobId, claim, {
							progress: { phase, completed: phase === "validating" ? 3 : 2 },
						});
					} catch {
						// The heartbeat is advisory; the fence governs the outcome.
					}
				},
			});
			const status = result.status;
			if (status === "exported" || status === "replayed") {
				return toExportJobRecord(
					this.store.jobs.succeed(jobId, claim, {
						result: result as JsonValue,
						artifacts: outputArtifact(result),
					}),
				);
			}
			const reason = resultReason(result);
			if (this.cancellationRequested(jobId) && isCancellationReason(reason)) {
				return toExportJobRecord(
					this.store.jobs.confirmCancelled(jobId, claim, {
						reason: "renderer stopped after observing the cancellation request",
					}),
				);
			}
			return toExportJobRecord(
				this.store.jobs.fail(jobId, claim, {
					error: reason,
					errorClass: "export-rejected",
				}),
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "export job failed";
			if (isConnectionFailure(message)) {
				return toExportJobRecord(this.store.jobs.release(jobId, claim, message));
			}
			return toExportJobRecord(
				this.store.jobs.fail(jobId, claim, {
					error: message,
					errorClass: "export-failed",
				}),
			);
		} finally {
			clearInterval(heartbeat);
		}
	}

	private cancellationRequested(jobId: string): boolean {
		return this.store.jobs.get(jobId)?.cancellationRequestedAt != null;
	}

	private async reconcileExportJob(
		record: JobRecord,
	): Promise<JobReconciliationOutcome> {
		if (record.jobType !== "export") {
			return {
				kind: "recovery-required",
				code: "unknown-outcome",
				detail: `owner of ${record.jobType} job died before publishing an outcome`,
			};
		}
		const envelope = readEnvelope(record.input);
		const receipt = await this.options.receipts
			?.get(envelope.export.operationId)
			.catch(() => null);
		if (receipt) {
			return {
				kind: "succeeded",
				result: receipt.result as JsonValue,
				artifacts: outputArtifact(receipt.result),
			};
		}
		const info = await stat(envelope.export.outputPath).catch(() => null);
		if (info?.isFile()) {
			return {
				kind: "recovery-required",
				code: "partial-artifact",
				detail: `an output file exists at ${envelope.export.outputPath} but no export receipt was written; rerun quarantines it or mark the job failed`,
				artifacts: [
					{
						kind: "export-output",
						path: envelope.export.outputPath,
						sha256: await hashFile(envelope.export.outputPath).catch(() => null),
						bytes: info.size,
						disposition: "partial-retained",
						recordedAt: new Date().toISOString(),
					},
				],
			};
		}
		return {
			kind: "requeue",
			reason: "MCP process stopped while the export job was running",
		};
	}

	private async prepareQueuedJob(
		job: JobRecord,
		replayInput?: ExportProjectInput,
	): Promise<JobRecord> {
		const envelope = readEnvelope(job.input);
		if (
			job.state !== "queued" ||
			envelope.export.bridgeProtocolVersion !== 2 ||
			envelope.export.queuedProjectPersistence !== undefined
		) {
			return job;
		}
		const captureInput =
			replayInput ?? bindJobToConnectedEditor(envelope.export, this.bridge);
		const queuedProjectPersistence = await captureQueuedProjectPersistence(
			this.bridge,
			captureInput,
			job.jobId,
		);
		return this.store.jobs.amendInput(job.jobId, (input) => {
			const current = readEnvelope(input);
			if (current.export.queuedProjectPersistence !== undefined) return input;
			return {
				fingerprint: current.fingerprint,
				export: {
					...current.export,
					queuedProjectPersistence,
				} as unknown as JsonValue,
			};
		});
	}

	private requireExport(jobId: string, run: () => JobRecord): JobRecord {
		const current = this.store.jobs.get(jobId);
		if (!current || current.jobType !== "export") {
			throw new Error(`export job not found: ${jobId}`);
		}
		try {
			return run();
		} catch (error) {
			if (error instanceof JobStoreError) throw new Error(error.message);
			throw error;
		}
	}
}

async function captureQueuedProjectPersistence(
	bridge: PersistentExportJobBridge,
	input: ExportProjectInput,
	jobId: string,
): Promise<QueuedProjectPersistence> {
	const expectedIdentity = input.expectedConnectionIdentity;
	if (!expectedIdentity) {
		throw new Error("bridge protocol v2 requires durable job affinity");
	}
	const result = await bridge.request(
		"save_project",
		{
			projectId: input.projectId,
			operationId: [
				"export-job",
				jobId,
				"queue-save-barrier",
				expectedIdentity.serverInstanceId,
				expectedIdentity.editorSessionId,
				expectedIdentity.connectionGeneration,
			].join(":"),
			expectedRevision: input.expectedRevision,
			expectedContentHash: input.expectedProjectContentHash,
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: expectedIdentity,
		},
		5 * 60_000,
		expectedIdentity,
	);
	return readVerifiedProjectPersistence(
		result,
		input.expectedProjectContentHash!,
		"queue-time",
	);
}

async function verifyQueuedProjectPersistence(
	bridge: PersistentExportJobBridge,
	input: ExportProjectInput,
	jobId: string,
	attempt: number,
): Promise<void> {
	const queued = input.queuedProjectPersistence;
	const expectedIdentity = input.expectedConnectionIdentity;
	if (!isQueuedProjectPersistence(queued) || !expectedIdentity) {
		throw new Error(
			"durable v2 export job lacks verified queue-time persistence",
		);
	}
	const result = await bridge.request(
		"save_project",
		{
			projectId: input.projectId,
			operationId: `export-job:${jobId}:rebind-save-barrier:${attempt}`,
			expectedRevision: input.expectedRevision,
			expectedContentHash: queued.contentHash,
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: expectedIdentity,
		},
		5 * 60_000,
		expectedIdentity,
	);
	const observed = readVerifiedProjectPersistence(
		result,
		queued.contentHash,
		"rebind",
	);
	if (
		observed.contentHashProjectionVersion !==
		queued.contentHashProjectionVersion
	) {
		throw new Error(
			"queued export project projection version no longer matches persisted state",
		);
	}
	if (observed.writeVersion !== queued.writeVersion) {
		throw new Error(
			"queued export project write version no longer matches persisted state",
		);
	}
}

function isQueuedProjectPersistence(
	value: unknown,
): value is QueuedProjectPersistence {
	return (
		isRecord(value) &&
		typeof value.contentHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.contentHash) &&
		(value.contentHashProjectionVersion === 1 ||
			value.contentHashProjectionVersion === 2) &&
		typeof value.writeVersion === "number" &&
		Number.isSafeInteger(value.writeVersion) &&
		value.writeVersion > 0
	);
}

function readVerifiedProjectPersistence(
	value: unknown,
	expectedContentHash: string,
	phase: "queue-time" | "rebind",
): QueuedProjectPersistence {
	if (
		!isRecord(value) ||
		(value.status !== "saved" && value.status !== "replayed") ||
		value.reloadVerified !== true ||
		typeof value.contentHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.contentHash) ||
		value.contentHash !== expectedContentHash ||
		(value.contentHashProjectionVersion !== 1 &&
			value.contentHashProjectionVersion !== 2) ||
		typeof value.writeVersion !== "number" ||
		!Number.isSafeInteger(value.writeVersion) ||
		value.writeVersion <= 0
	) {
		throw new Error(
			`queued export ${phase} persisted-state verification failed`,
		);
	}
	return {
		contentHash: value.contentHash,
		contentHashProjectionVersion: value.contentHashProjectionVersion,
		writeVersion: value.writeVersion,
	};
}

export function exportJobFingerprint(input: ExportProjectInput): string {
	const {
		expectedConnectionIdentity,
		requestConnectionIdentity,
		queuedProjectPersistence: _queuedProjectPersistence,
		capabilitySnapshotHash: _capabilitySnapshotHash,
		...semanticInput
	} = input;
	const durableIdentity =
		requestConnectionIdentity ?? expectedConnectionIdentity;
	return stableSerialize({
		...semanticInput,
		...(durableIdentity
			? { durableEditorInstanceId: durableIdentity.editorInstanceId }
			: {}),
	});
}

function legacyExportJobFingerprint(input: ExportProjectInput): string {
	const {
		queuedProjectPersistence: _queuedProjectPersistence,
		capabilitySnapshotHash: _capabilitySnapshotHash,
		...legacyInput
	} = input;
	return stableSerialize(legacyInput);
}

function bindJobToConnectedEditor(
	input: ExportProjectInput,
	bridge: PersistentExportJobBridge,
): ExportProjectInput {
	if (input.bridgeProtocolVersion !== 2) return input;
	const queuedIdentity =
		input.requestConnectionIdentity ?? input.expectedConnectionIdentity;
	if (!queuedIdentity) {
		throw new Error("bridge protocol v2 requires durable job affinity");
	}
	const currentIdentity = bridge.getStatus().connectionIdentity;
	if (!currentIdentity) {
		throw new Error("No authenticated OpenCut editor is connected");
	}
	if (currentIdentity.editorInstanceId !== queuedIdentity.editorInstanceId) {
		throw new Error(
			"STALE_CONNECTION: queued export belongs to a different editor affinity",
		);
	}
	return {
		...input,
		expectedConnectionIdentity: currentIdentity,
		requestConnectionIdentity: queuedIdentity,
	};
}

function isProjectOpened(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) &&
		(value.status === "opened" || value.status === "replayed")
	);
}

function bindJobToObservedProject(
	input: ExportProjectInput,
	opened: Record<string, unknown>,
): ExportProjectInput {
	if (input.bridgeProtocolVersion !== 2) return input;
	const expectedHash = input.expectedProjectContentHash;
	const revision = opened.revision;
	const snapshot = isRecord(opened.snapshot) ? opened.snapshot : opened;
	const identity = snapshot.contentIdentity;
	if (
		!expectedHash ||
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 0 ||
		!isRecord(identity) ||
		identity.status !== "hashed" ||
		!isRecord(identity.hash) ||
		identity.hash.projection !== "opencut-project-content" ||
		(identity.hash.projectionVersion !== 1 &&
			identity.hash.projectionVersion !== 2) ||
		identity.hash.algorithm !== "SHA-256" ||
		identity.hash.digest !== expectedHash
	) {
		throw new Error(
			"queued export project content no longer matches its pinned hash",
		);
	}
	return { ...input, expectedRevision: revision };
}

function outputArtifact(result: Record<string, unknown>): JobArtifact[] {
	if (
		typeof result.outputPath !== "string" ||
		typeof result.sha256 !== "string"
	) {
		return [];
	}
	return [
		{
			kind: "export-output",
			path: result.outputPath,
			sha256: result.sha256,
			bytes: typeof result.bytesWritten === "number" ? result.bytesWritten : null,
			disposition: "final",
			recordedAt: new Date().toISOString(),
		},
	];
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function resultReason(value: unknown): string {
	if (isRecord(value) && typeof value.reason === "string") return value.reason;
	if (isRecord(value) && typeof value.status === "string") {
		return `export job finished with status ${value.status}`;
	}
	return "export job returned an invalid result";
}

function isCancellationReason(reason: string): boolean {
	return /cancel/i.test(reason);
}

function isConnectionFailure(message: string): boolean {
	return (
		message.includes("No authenticated OpenCut editor") ||
		message.includes("OpenCut editor disconnected")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type { ExportJobRecord, ExportJobStatus, JobClaim };
