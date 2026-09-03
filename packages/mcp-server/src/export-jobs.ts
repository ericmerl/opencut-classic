import { join } from "node:path";
import {
	ExportJobStore,
	type ExportJobRecord,
	type ExportJobStatus,
} from "./export-job-store";
import {
	type ExportProjectBridge,
	type ExportProjectInput,
	type QueuedProjectPersistence,
} from "./export-project";
import type { BridgeConnectionIdentity } from "./editor-bridge";
import { stableSerialize } from "./matte-generation-data";

export interface PersistentExportJobBridge extends ExportProjectBridge {
	getStatus(): {
		connected: boolean;
		connectionIdentity?: BridgeConnectionIdentity | null;
	};
	onConnectionChange(listener: (connected: boolean) => void): () => void;
}

export interface PersistentExportProjectService {
	export(input: ExportProjectInput): Promise<Record<string, unknown>>;
}

export class ExportJobQueue {
	private draining: Promise<ExportJobRecord[]> | null = null;
	private stopped = false;
	private readonly unsubscribe: () => void;

	constructor(
		private bridge: PersistentExportJobBridge,
		private exports: PersistentExportProjectService,
		readonly store: ExportJobStore,
		private options: {
			autoRun?: boolean;
			ensureEditor?: (projectId: string) => Promise<unknown>;
			capabilitySnapshotHash?: () => Promise<string>;
		} = {},
	) {
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
		const fingerprint = exportJobFingerprint(input);
		const existing = await this.store.get(jobId);
		if (existing) {
			const existingFingerprint = exportJobFingerprint(existing.input);
			const isRecognizedStoredFingerprint =
				existing.fingerprint === existingFingerprint ||
				existing.fingerprint === legacyExportJobFingerprint(existing.input);
			if (
				!isRecognizedStoredFingerprint ||
				existingFingerprint !== fingerprint
			) {
				throw new Error("jobId was already used for a different export job");
			}
			if (
				existing.input.bridgeProtocolVersion === 2 &&
				existing.input.queuedProjectPersistence === undefined &&
				existing.status === "queued"
			) {
				const migrated = await this.prepareQueuedJob(existing, input);
				return { job: migrated, replayed: true };
			}
			return { job: existing, replayed: true };
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
		const timestamp = new Date().toISOString();
		const created = await this.store.create({
			schemaVersion: 1,
			jobId,
			fingerprint,
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
			attempts: 0,
			lastAttemptAt: null,
			completedAt: null,
			input: persistedInput,
			result: null,
			lastError: null,
		});
		this.schedule();
		return { job: created.record, replayed: created.replayed };
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
		const records = await this.store.list();
		const selected = statuses?.length
			? records.filter((record) => statuses.includes(record.status))
			: records;
		return selected.slice(0, limit);
	}

	async cancel(jobId: string): Promise<ExportJobRecord> {
		return this.store.update(jobId, (current) => {
			if (current.status !== "queued") {
				throw new Error(
					`only queued export jobs can be cancelled; current status is ${current.status}`,
				);
			}
			return {
				...current,
				status: "cancelled",
				completedAt: new Date().toISOString(),
			};
		});
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

	stop(): void {
		this.stopped = true;
		this.unsubscribe();
	}

	private schedule(): void {
		if (this.stopped || this.options.autoRun === false) return;
		queueMicrotask(() => void this.runQueued().catch(() => undefined));
	}

	private async runWithEditor(limit: number): Promise<ExportJobRecord[]> {
		await this.store.recoverInterrupted();
		if (!this.bridge.getStatus().connected) {
			const candidate = (await this.store.list())
				.filter((record) => record.status === "queued")
				.sort((left, right) =>
					left.createdAt.localeCompare(right.createdAt),
				)[0];
			if (!candidate || !this.options.ensureEditor) return [];
			try {
				await this.options.ensureEditor(candidate.input.projectId);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "managed editor worker failed to connect";
				await this.store.update(candidate.jobId, (current) =>
					current.status === "queued"
						? { ...current, lastError: message }
						: current,
				);
				throw error;
			}
		}
		if (!this.bridge.getStatus().connected) return [];
		return this.drain(limit);
	}

	private async drain(limit: number): Promise<ExportJobRecord[]> {
		if (this.stopped || !this.bridge.getStatus().connected) return [];
		const queued = (await this.store.list())
			.filter((record) => record.status === "queued")
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.slice(0, limit);
		const processed: ExportJobRecord[] = [];
		for (const job of queued) {
			if (this.stopped || !this.bridge.getStatus().connected) break;
			processed.push(await this.run(job));
		}
		return processed;
	}

	private async run(job: ExportJobRecord): Promise<ExportJobRecord> {
		let prepared: ExportJobRecord;
		try {
			prepared = await this.prepareQueuedJob(job);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "export job failed";
			if (isConnectionFailure(message)) {
				return this.store.update(job.jobId, (current) => ({
					...current,
					status: "queued",
					lastError: message,
				}));
			}
			return this.finish(job.jobId, "failed", null, message);
		}
		if (prepared.status !== "queued") return prepared;
		const attempt = prepared.attempts + 1;
		const running = await this.store.update(prepared.jobId, (current) => {
			if (current.status !== "queued") return current;
			return {
				...current,
				status: "running",
				attempts: attempt,
				lastAttemptAt: new Date().toISOString(),
				lastError: null,
			};
		});
		if (running.status !== "running") return running;

		try {
			const executionInput = bindJobToConnectedEditor(
				running.input,
				this.bridge,
			);
			const executionIdentity = executionInput.expectedConnectionIdentity;
			const opened = await this.bridge.request(
				"open_project",
				{
					operationId: `export-job:${running.jobId}:open:${attempt}`,
					projectId: running.input.projectId,
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
				return this.finish(
					running.jobId,
					"failed",
					isRecord(opened) ? opened : null,
					resultReason(opened),
				);
			}
			const observedInput = bindJobToObservedProject(executionInput, opened);
			if (observedInput.bridgeProtocolVersion === 2) {
				await verifyQueuedProjectPersistence(
					this.bridge,
					observedInput,
					job.jobId,
					attempt,
				);
			}
			const result = await this.exports.export(observedInput);
			const status = result.status;
			if (status === "exported" || status === "replayed") {
				return this.finish(job.jobId, "completed", result, null);
			}
			return this.finish(job.jobId, "failed", result, resultReason(result));
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "export job failed";
			if (isConnectionFailure(message)) {
				return this.store.update(job.jobId, (current) => ({
					...current,
					status: "queued",
					lastError: message,
				}));
			}
			return this.finish(job.jobId, "failed", null, message);
		}
	}

	private async prepareQueuedJob(
		job: ExportJobRecord,
		replayInput?: ExportProjectInput,
	): Promise<ExportJobRecord> {
		if (
			job.status !== "queued" ||
			job.input.bridgeProtocolVersion !== 2 ||
			job.input.queuedProjectPersistence !== undefined
		) {
			return job;
		}
		const captureInput =
			replayInput ?? bindJobToConnectedEditor(job.input, this.bridge);
		const queuedProjectPersistence = await captureQueuedProjectPersistence(
			this.bridge,
			captureInput,
			job.jobId,
		);
		return this.store.update(job.jobId, (current) => ({
			...current,
			input:
				current.status === "queued" &&
				current.input.queuedProjectPersistence === undefined
					? { ...current.input, queuedProjectPersistence }
					: current.input,
		}));
	}

	private finish(
		jobId: string,
		status: "completed" | "failed",
		result: Record<string, unknown> | null,
		lastError: string | null,
	): Promise<ExportJobRecord> {
		return this.store.update(jobId, (current) => ({
			...current,
			status,
			result,
			lastError,
			completedAt: new Date().toISOString(),
		}));
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

function exportJobFingerprint(input: ExportProjectInput): string {
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

function resultReason(value: unknown): string {
	if (isRecord(value) && typeof value.reason === "string") return value.reason;
	if (isRecord(value) && typeof value.status === "string") {
		return `export job finished with status ${value.status}`;
	}
	return "export job returned an invalid result";
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
