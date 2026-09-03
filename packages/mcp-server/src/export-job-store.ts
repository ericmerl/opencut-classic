import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExportProjectInput } from "./export-project";
import {
	JobStore,
	type JobArtifact,
	type JobAttempt,
	type JobDiagnostic,
	type JobRecord,
	type JobRestoreInput,
	type JobState,
	type JsonValue,
} from "./job-store";

/**
 * Public export job statuses. The first five are the pre-#19 contract; the
 * remaining values are additive and surface the unified job states that the
 * legacy vocabulary could not express.
 */
export type ExportJobStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "cancelling"
	| "blocked"
	| "recovery-required";

export const EXPORT_JOB_STATUSES: readonly ExportJobStatus[] = [
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
	"cancelling",
	"blocked",
	"recovery-required",
];

export interface ExportJobExecution {
	jobState: JobState;
	phase: string;
	completed: number;
	total: number | null;
	heartbeatAt: string | null;
	leaseOwner: string | null;
	cancellationRequestedAt: string | null;
	cancellationObservedAt: string | null;
	blockedReason: string | null;
	maximumAttempts: number;
	attemptHistory: JobAttempt[];
	diagnostics: JobDiagnostic[];
	artifacts: JobArtifact[];
}

export interface ExportJobRecord {
	schemaVersion: 1;
	storeRevision: number;
	jobId: string;
	fingerprint: string;
	status: ExportJobStatus;
	createdAt: string;
	updatedAt: string;
	attempts: number;
	lastAttemptAt: string | null;
	completedAt: string | null;
	input: ExportProjectInput;
	result: Record<string, unknown> | null;
	lastError: string | null;
	execution: ExportJobExecution;
}

export interface ExportJobInputEnvelope {
	fingerprint: string;
	export: ExportProjectInput;
}

/**
 * Read facade over the unified job store for export jobs. Writes go through
 * `ExportJobQueue`; this class only projects unified job rows into the public
 * export job record and imports pre-#19 JSON job files on first open.
 */
export class ExportJobStore {
	readonly directory: string;
	private retained: JobStore | null;
	private readonly owned: boolean;
	private imported = new WeakSet<JobStore>();

	/**
	 * Without a shared `JobStore` the facade is stateless: every read opens a
	 * connection, imports any legacy files once, and closes again, so nothing
	 * holds the database file open. A queue or server that runs jobs calls
	 * `retain()` to keep one connection for the fenced writes.
	 */
	constructor(directory: string, jobs?: JobStore) {
		this.directory = resolve(directory);
		this.retained = jobs ?? null;
		this.owned = jobs === undefined;
	}

	/** The retained connection, opened on first use. */
	get jobs(): JobStore {
		return this.retain();
	}

	retain(): JobStore {
		if (!this.retained) this.retained = new JobStore(this.directory);
		return this.retained;
	}

	/** Close the retained connection when this facade owns it. */
	close(): void {
		if (this.owned && this.retained) {
			this.retained.close();
			this.retained = null;
		}
	}

	async initialize(): Promise<void> {
		await this.prepare(this.retain());
	}

	async get(jobId: string): Promise<ExportJobRecord | null> {
		return this.withJobs((jobs) => {
			const record = jobs.get(jobId);
			return record && record.jobType === "export"
				? toExportJobRecord(record)
				: null;
		});
	}

	async list(): Promise<ExportJobRecord[]> {
		return this.withJobs((jobs) =>
			jobs
				.list({ types: ["export"], limit: Number.MAX_SAFE_INTEGER })
				.map(toExportJobRecord),
		);
	}

	/**
	 * Seed a job in a known legacy state. Used by the legacy import and by
	 * tests that reproduce pre-#19 stores.
	 */
	async create(
		record: Omit<ExportJobRecord, "storeRevision" | "execution"> & {
			execution?: undefined;
		},
	): Promise<{ record: ExportJobRecord; replayed: boolean }> {
		return this.withJobs((jobs) => {
			const existing = jobs.get(record.jobId);
			if (existing) {
				if (existing.jobType !== "export") {
					throw new Error("jobId was already used for a different job type");
				}
				const envelope = readEnvelope(existing.input);
				if (envelope.fingerprint !== record.fingerprint) {
					throw new Error("jobId was already used for a different export job");
				}
				return { record: toExportJobRecord(existing), replayed: true };
			}
			const restored = jobs.restore(
				convertLegacyRecord(record as unknown as Record<string, unknown>),
				"seeded as a legacy export job record",
			);
			return { record: toExportJobRecord(restored), replayed: false };
		});
	}

	private async withJobs<T>(run: (jobs: JobStore) => T): Promise<T> {
		if (this.retained) {
			await this.prepare(this.retained);
			return run(this.retained);
		}
		const jobs = new JobStore(this.directory);
		try {
			await this.prepare(jobs);
			return run(jobs);
		} finally {
			jobs.close();
		}
	}

	private async prepare(jobs: JobStore): Promise<void> {
		await jobs.initialize();
		if (this.imported.has(jobs)) return;
		await jobs.importLegacyExportJobs(this.directory, convertLegacyRecord);
		this.imported.add(jobs);
	}
}

export function exportJobSemanticHash(fingerprint: string): string {
	return createHash("sha256").update(fingerprint).digest("hex");
}

export function readEnvelope(input: JsonValue): ExportJobInputEnvelope {
	if (
		!isRecord(input) ||
		typeof input.fingerprint !== "string" ||
		!isRecord(input.export)
	) {
		throw new Error("export job input envelope is malformed");
	}
	return {
		fingerprint: input.fingerprint,
		export: input.export as unknown as ExportProjectInput,
	};
}

export function toExportJobRecord(record: JobRecord): ExportJobRecord {
	const envelope = readEnvelope(record.input);
	const lastAttempt = record.attempts.at(-1) ?? null;
	return {
		schemaVersion: 1,
		storeRevision: record.storeRevision,
		jobId: record.jobId,
		fingerprint: envelope.fingerprint,
		status: exportJobStatus(record.state),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		attempts: record.attempt,
		lastAttemptAt: lastAttempt?.startedAt ?? null,
		completedAt: record.completedAt,
		input: envelope.export,
		result: isRecord(record.result)
			? (record.result as Record<string, unknown>)
			: null,
		lastError: record.lastError,
		execution: {
			jobState: record.state,
			phase: record.progress.phase,
			completed: record.progress.completed,
			total: record.progress.total,
			heartbeatAt: record.heartbeatAt,
			leaseOwner: record.lease?.ownerId ?? null,
			cancellationRequestedAt: record.cancellationRequestedAt,
			cancellationObservedAt: record.cancellationObservedAt,
			blockedReason: record.blockedReason,
			maximumAttempts: record.attemptPolicy.maximumAttempts,
			attemptHistory: record.attempts,
			diagnostics: record.diagnostics,
			artifacts: record.artifacts,
		},
	};
}

export function exportJobStatus(state: JobState): ExportJobStatus {
	switch (state) {
		case "queued":
			return "queued";
		case "starting":
		case "running":
			return "running";
		case "cancelling":
			return "cancelling";
		case "succeeded":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "blocked":
			return "blocked";
		case "recovery-required":
			return "recovery-required";
	}
}

/** Public statuses that select each unified job state for list filters. */
export function jobStatesForExportStatuses(
	statuses: readonly ExportJobStatus[],
): JobState[] {
	const states = new Set<JobState>();
	for (const status of statuses) {
		switch (status) {
			case "queued":
				states.add("queued");
				break;
			case "running":
				states.add("starting");
				states.add("running");
				break;
			case "cancelling":
				states.add("cancelling");
				break;
			case "completed":
				states.add("succeeded");
				break;
			case "failed":
				states.add("failed");
				break;
			case "cancelled":
				states.add("cancelled");
				break;
			case "blocked":
				states.add("blocked");
				break;
			case "recovery-required":
				states.add("recovery-required");
				break;
		}
	}
	return [...states];
}

function convertLegacyRecord(legacy: Record<string, unknown>): JobRestoreInput {
	if (
		typeof legacy.jobId !== "string" ||
		typeof legacy.fingerprint !== "string" ||
		typeof legacy.status !== "string" ||
		typeof legacy.createdAt !== "string" ||
		!isRecord(legacy.input)
	) {
		throw new Error("legacy export job record is incomplete");
	}
	const input = legacy.input as unknown as ExportProjectInput;
	const attemptsCount =
		typeof legacy.attempts === "number" && Number.isSafeInteger(legacy.attempts)
			? legacy.attempts
			: 0;
	const lastAttemptAt =
		typeof legacy.lastAttemptAt === "string" ? legacy.lastAttemptAt : null;
	const completedAt =
		typeof legacy.completedAt === "string" ? legacy.completedAt : null;
	const lastError = typeof legacy.lastError === "string" ? legacy.lastError : null;
	const state = legacyState(legacy.status);
	const attempts: JobAttempt[] = Array.from({ length: attemptsCount }, (_, index) => {
		const last = index === attemptsCount - 1;
		return {
			number: index + 1,
			ownerId: null,
			startedAt: last ? lastAttemptAt : null,
			completedAt: last ? completedAt : null,
			outcome: last
				? state === "succeeded"
					? "succeeded"
					: state === "failed"
						? "failed"
						: state === "cancelled"
							? "cancelled"
							: null
				: "interrupted",
			error: last ? lastError : null,
			resolution: null,
		};
	});
	return {
		jobId: legacy.jobId,
		jobType: "export",
		operationId: input.operationId,
		semanticInputHash: exportJobSemanticHash(legacy.fingerprint),
		capabilitySnapshotHash: input.capabilitySnapshotHash ?? null,
		preconditions: {
			projectId: input.projectId,
			revision: input.expectedRevision,
			contentHash: input.expectedProjectContentHash ?? null,
			writeVersion: input.queuedProjectPersistence?.writeVersion ?? null,
		},
		progressUnits: "phases",
		input: {
			fingerprint: legacy.fingerprint,
			export: input as unknown as JsonValue,
		},
		createdAt: legacy.createdAt,
		state: state === "running" ? "queued" : state,
		attempt: attemptsCount,
		attempts,
		result: isRecord(legacy.result) ? (legacy.result as JsonValue) : null,
		lastError:
			state === "running"
				? "MCP process stopped while the export job was running"
				: lastError,
		updatedAt:
			typeof legacy.updatedAt === "string" ? legacy.updatedAt : legacy.createdAt,
		completedAt,
	};
}

function legacyState(status: string): JobState {
	switch (status) {
		case "queued":
			return "queued";
		case "running":
			return "running";
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "cancelling":
			return "cancelling";
		case "blocked":
			return "blocked";
		case "recovery-required":
			return "recovery-required";
		default:
			throw new Error(`legacy export job status ${status} is unknown`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
