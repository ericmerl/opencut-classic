import { join } from "node:path";
import {
	ExportJobStore,
	type ExportJobRecord,
	type ExportJobStatus,
} from "./export-job-store";
import {
	type ExportProjectBridge,
	type ExportProjectInput,
} from "./export-project";
import { stableSerialize } from "./matte-generation-data";

export interface PersistentExportJobBridge extends ExportProjectBridge {
	getStatus(): { connected: boolean };
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
		private options: { autoRun?: boolean } = {},
	) {
		this.unsubscribe = bridge.onConnectionChange((connected) => {
			if (connected) this.schedule();
		});
		if (bridge.getStatus().connected) this.schedule();
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
		const timestamp = new Date().toISOString();
		const created = await this.store.create({
			schemaVersion: 1,
			jobId,
			fingerprint: stableSerialize(input),
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
			attempts: 0,
			lastAttemptAt: null,
			completedAt: null,
			input,
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
		this.draining = this.drain(limit).finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	stop(): void {
		this.stopped = true;
		this.unsubscribe();
	}

	private schedule(): void {
		if (
			this.stopped ||
			this.options.autoRun === false ||
			!this.bridge.getStatus().connected
		) {
			return;
		}
		queueMicrotask(() => void this.runQueued().catch(() => undefined));
	}

	private async drain(limit: number): Promise<ExportJobRecord[]> {
		if (this.stopped || !this.bridge.getStatus().connected) return [];
		await this.store.recoverInterrupted();
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
		const attempt = job.attempts + 1;
		const running = await this.store.update(job.jobId, (current) => {
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
			const opened = await this.bridge.request("open_project", {
				operationId: `export-job:${job.jobId}:open:${attempt}`,
				projectId: job.input.projectId,
			});
			if (!isProjectOpened(opened)) {
				return this.finish(
					job.jobId,
					"failed",
					isRecord(opened) ? opened : null,
					resultReason(opened),
				);
			}
			const result = await this.exports.export(job.input);
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

function isProjectOpened(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) &&
		(value.status === "opened" || value.status === "replayed")
	);
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
