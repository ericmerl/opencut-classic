import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stableSerialize } from "./matte-generation-data";

export const JOB_DATABASE = "jobs.sqlite";
export const JOB_SCHEMA_VERSION = 1;
export const JOB_RECORD_SCHEMA_VERSION = 1 as const;

/** Heartbeats older than this mark an owner as dead even when its PID exists. */
export const JOB_HEARTBEAT_STALE_MS = 45_000;
/** Runners renew the lease and heartbeat on this cadence. */
export const JOB_HEARTBEAT_INTERVAL_MS = 5_000;
/** Lease length granted on claim and on every heartbeat renewal. */
export const JOB_LEASE_MS = 2 * 60_000;

export type JobType =
	| "export"
	| "preview-range"
	| "comparison"
	| "transcription"
	| "provider"
	| "qc"
	| "packaging";

export type JobState =
	| "queued"
	| "starting"
	| "running"
	| "cancelling"
	| "cancelled"
	| "succeeded"
	| "failed"
	| "blocked"
	| "recovery-required";

export type JobPriority = "low" | "normal" | "high";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface JobPreconditions {
	projectId: string | null;
	sceneId: string | null;
	revision: number | null;
	contentHash: string | null;
	writeVersion: number | null;
	saveReceiptId: string | null;
}

export interface JobAttemptPolicy {
	maximumAttempts: number;
	retryableErrorClasses: string[];
	boundedBackoffMs: number;
}

export interface JobProgress {
	units: string;
	phase: string;
	completed: number;
	total: number | null;
	etaConfidence: "unavailable" | "low" | "medium" | "high";
}

export interface JobLease {
	ownerId: string;
	fencingToken: string;
	expiresAt: string;
}

export type JobAttemptOutcome =
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "unknown";

export interface JobAttemptResolution {
	kind: "rerun-as-new-attempt" | "mark-failed" | "retry";
	at: string;
	reason: string;
	operationId: string | null;
}

export interface JobAttempt {
	number: number;
	ownerId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	outcome: JobAttemptOutcome | null;
	error: string | null;
	resolution: JobAttemptResolution | null;
}

export interface JobCheckpoint {
	name: string;
	at: string;
	completed: number;
	total: number | null;
	metadata: JsonValue | null;
}

export interface JobLog {
	level: "info" | "warn" | "error";
	at: string;
	message: string;
}

export interface JobDiagnostic {
	code: string;
	at: string;
	detail: string;
}

export interface JobArtifact {
	kind: string;
	path: string | null;
	sha256: string | null;
	bytes: number | null;
	disposition: "final" | "partial-retained" | "quarantined" | "deleted";
	recordedAt: string;
}

export interface JobRecord {
	schemaVersion: typeof JOB_RECORD_SCHEMA_VERSION;
	storeRevision: number;
	jobId: string;
	jobType: JobType;
	jobSchemaVersion: number;
	operationId: string;
	semanticInputHash: string;
	capabilitySnapshotHash: string | null;
	preconditions: JobPreconditions;
	providerPolicy: JsonValue | null;
	rendererPolicy: JsonValue | null;
	priority: JobPriority;
	resourceClass: string;
	concurrencyGroup: string;
	scheduledFor: string | null;
	attemptPolicy: JobAttemptPolicy;
	state: JobState;
	attempt: number;
	attempts: JobAttempt[];
	progress: JobProgress;
	heartbeatAt: string | null;
	lease: JobLease | null;
	cancellationRequestedAt: string | null;
	cancellationObservedAt: string | null;
	blockedReason: string | null;
	checkpoints: JobCheckpoint[];
	logs: JobLog[];
	diagnostics: JobDiagnostic[];
	artifacts: JobArtifact[];
	provenance: JsonValue | null;
	attachmentTransaction: JsonValue | null;
	input: JsonValue;
	result: JsonValue | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	checksum: string;
}

export interface JobSubmission {
	jobId: string;
	jobType: JobType;
	jobSchemaVersion?: number;
	operationId: string;
	semanticInputHash: string;
	capabilitySnapshotHash?: string | null;
	preconditions?: Partial<JobPreconditions>;
	providerPolicy?: JsonValue | null;
	rendererPolicy?: JsonValue | null;
	priority?: JobPriority;
	resourceClass?: string;
	concurrencyGroup?: string;
	scheduledFor?: string | null;
	attemptPolicy?: Partial<JobAttemptPolicy>;
	progressUnits?: string;
	input: JsonValue;
	createdAt?: string;
}

export interface JobRestoreInput extends JobSubmission {
	state: JobState;
	attempt: number;
	attempts: JobAttempt[];
	result: JsonValue | null;
	lastError: string | null;
	updatedAt: string;
	completedAt: string | null;
}

export interface JobClaim {
	record: JobRecord;
	ownerId: string;
	fencingToken: string;
}

export interface JobFence {
	ownerId: string;
	fencingToken: string;
}

export type JobReconciliationOutcome =
	| { kind: "succeeded"; result: JsonValue; artifacts?: JobArtifact[] }
	| { kind: "requeue"; reason: string }
	| {
			kind: "recovery-required";
			code: string;
			detail: string;
			artifacts?: JobArtifact[];
	  }
	| { kind: "failed"; error: string; artifacts?: JobArtifact[] }
	| { kind: "cancelled"; reason: string };

export interface JobListFilter {
	types?: JobType[];
	states?: JobState[];
	projectId?: string;
	limit: number;
}

export interface JobQueueSummary {
	depth: number;
	running: JobRecord | null;
	counts: Record<JobState, number>;
	byType: Record<JobType, { queued: number; active: number }>;
	recoveryRequired: string[];
}

export class JobStoreError extends Error {
	constructor(
		readonly code:
			| "JOB_NOT_FOUND"
			| "JOB_IDENTITY_REUSED"
			| "JOB_ILLEGAL_TRANSITION"
			| "JOB_FENCE_REJECTED"
			| "JOB_STALE_REVISION"
			| "JOB_ATTEMPTS_EXHAUSTED"
			| "JOB_SCHEMA_UNSUPPORTED"
			| "JOB_CHECKSUM_MISMATCH",
		message: string,
	) {
		super(message);
		this.name = "JobStoreError";
	}
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

const ACTIVE_STATES: ReadonlySet<JobState> = new Set([
	"starting",
	"running",
	"cancelling",
]);

const LEGAL_TRANSITIONS: Record<JobState, ReadonlySet<JobState>> = {
	queued: new Set(["starting", "cancelled", "blocked", "failed"]),
	starting: new Set([
		"running",
		"queued",
		"failed",
		"cancelled",
		"recovery-required",
	]),
	running: new Set([
		"cancelling",
		"succeeded",
		"failed",
		"cancelled",
		"queued",
		"recovery-required",
	]),
	cancelling: new Set(["cancelled", "succeeded", "failed", "recovery-required"]),
	blocked: new Set(["queued", "cancelled", "failed"]),
	"recovery-required": new Set(["queued", "failed", "cancelled"]),
	failed: new Set(["queued"]),
	succeeded: new Set([]),
	cancelled: new Set([]),
};

export function isTerminalJobState(state: JobState): boolean {
	return TERMINAL_STATES.has(state);
}

export function isActiveJobState(state: JobState): boolean {
	return ACTIVE_STATES.has(state);
}

export function jobOwnerId(): string {
	return `opencut-mcp:${process.pid}:${randomUUID()}`;
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		return code !== "ESRCH";
	}
}

/**
 * An owner is live when its process exists and its heartbeat is fresh. A live
 * PID with a stale heartbeat is treated as dead: either the process hung or the
 * PID was reused by an unrelated process, and neither can be trusted with the
 * lease. An expired lease with a fresh heartbeat is a slow observer, not a
 * dead worker, and is left alone.
 */
export function jobOwnerIsLive(
	record: Pick<JobRecord, "lease" | "heartbeatAt">,
	now = Date.now(),
	isAlive: (pid: number) => boolean = processIsAlive,
): boolean {
	if (!record.lease) return false;
	const match = /^opencut-mcp:(\d+):[A-Za-z0-9-]+$/.exec(record.lease.ownerId);
	const pid = match ? Number(match[1]) : NaN;
	if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) return false;
	const heartbeat = record.heartbeatAt ? Date.parse(record.heartbeatAt) : NaN;
	if (!Number.isFinite(heartbeat)) return false;
	return now - heartbeat < JOB_HEARTBEAT_STALE_MS;
}

interface JobRow {
	job_id: string;
	store_revision: number;
	record_json: string;
}

export class JobStore {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;
	private initializing: Promise<void> | null = null;

	constructor(directory: string) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, JOB_DATABASE);
	}

	async initialize(): Promise<void> {
		if (this.database) return;
		if (!this.initializing) {
			this.initializing = this.open().finally(() => {
				this.initializing = null;
			});
		}
		await this.initializing;
	}

	close(): void {
		this.database?.close();
		this.database = null;
	}

	private async open(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const database = new Database(this.databasePath, {
			create: true,
			strict: true,
		});
		try {
			database.exec("PRAGMA busy_timeout=10000");
			database.exec("PRAGMA foreign_keys=ON");
			const journal = database
				.query("PRAGMA journal_mode=WAL")
				.get() as Record<string, unknown>;
			if (String(Object.values(journal)[0]).toLowerCase() !== "wal") {
				throw new Error("job store SQLite WAL is unavailable");
			}
			database.exec("PRAGMA synchronous=FULL");
			database.exec("BEGIN IMMEDIATE");
			try {
				initializeSchema(database);
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			const check = database.query("PRAGMA quick_check").get() as Record<
				string,
				unknown
			>;
			if (String(Object.values(check)[0]) !== "ok") {
				throw new Error("job store SQLite integrity check failed");
			}
			for (const row of database
				.query("SELECT job_id, store_revision, record_json FROM jobs")
				.all() as JobRow[]) {
				parseRow(row);
			}
		} catch (error) {
			database.close();
			throw error;
		}
		this.database = database;
	}

	/**
	 * Import append-versioned JSON export jobs written by the pre-#19 store.
	 * Each job is imported once; later calls are no-ops for imported ids.
	 */
	async importLegacyExportJobs(
		directory: string,
		convert: (legacy: Record<string, unknown>) => JobRestoreInput,
	): Promise<number> {
		await this.initialize();
		const names = await readdir(directory).catch(() => [] as string[]);
		const latest = new Map<string, string>();
		for (const name of names.sort()) {
			const match = /^([a-f0-9]{64})\.(\d{12})\.json$/.exec(name);
			if (match) latest.set(match[1]!, name);
		}
		let imported = 0;
		for (const name of latest.values()) {
			const legacy = JSON.parse(await readFile(join(directory, name), "utf8"));
			if (!isRecord(legacy) || typeof legacy.jobId !== "string") continue;
			if (this.get(legacy.jobId)) continue;
			this.restore(
				convert(legacy),
				`imported from legacy export job store file ${name}`,
			);
			imported += 1;
		}
		return imported;
	}

	/**
	 * Insert a job in a known state without running its transitions, for
	 * importing records that another store already carried to that state.
	 */
	restore(
		converted: JobRestoreInput,
		note = "restored from an external record",
	): JobRecord {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			if (this.get(converted.jobId)) {
				throw new JobStoreError(
					"JOB_IDENTITY_REUSED",
					`job ${converted.jobId} already exists`,
				);
			}
			const record = buildRecord(converted);
			this.insert({
				...record,
				state: converted.state,
				attempt: converted.attempt,
				attempts: converted.attempts,
				result: converted.result,
				lastError: converted.lastError,
				updatedAt: converted.updatedAt,
				completedAt: converted.completedAt,
				startedAt: converted.attempts.at(-1)?.startedAt ?? null,
				progress: {
					...record.progress,
					phase: converted.state === "succeeded" ? "complete" : converted.state,
				},
				logs: [{ level: "info", at: new Date().toISOString(), message: note }],
			});
			database.exec("COMMIT");
			return this.require(converted.jobId);
		} catch (error) {
			rollback(database);
			throw error;
		}
	}

	submit(input: JobSubmission): { record: JobRecord; replayed: boolean } {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.get(input.jobId);
			if (existing) {
				if (
					existing.semanticInputHash !== input.semanticInputHash ||
					existing.jobType !== input.jobType
				) {
					throw new JobStoreError(
						"JOB_IDENTITY_REUSED",
						`jobId ${input.jobId} was already used for a different ${existing.jobType} job`,
					);
				}
				database.exec("COMMIT");
				return { record: existing, replayed: true };
			}
			const record = buildRecord(input);
			this.insert(record);
			database.exec("COMMIT");
			return { record: this.require(input.jobId), replayed: false };
		} catch (error) {
			rollback(database);
			throw error;
		}
	}

	get(jobId: string): JobRecord | null {
		const row = this.requireDatabase()
			.query("SELECT job_id, store_revision, record_json FROM jobs WHERE job_id = ?")
			.get(jobId) as JobRow | null;
		return row ? parseRow(row) : null;
	}

	require(jobId: string): JobRecord {
		const record = this.get(jobId);
		if (!record) {
			throw new JobStoreError("JOB_NOT_FOUND", `job not found: ${jobId}`);
		}
		return record;
	}

	list(filter: JobListFilter): JobRecord[] {
		const clauses: string[] = [];
		const values: Array<string | number> = [];
		if (filter.types?.length) {
			clauses.push(`job_type IN (${filter.types.map(() => "?").join(",")})`);
			values.push(...filter.types);
		}
		if (filter.states?.length) {
			clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
			values.push(...filter.states);
		}
		if (filter.projectId) {
			clauses.push("project_id = ?");
			values.push(filter.projectId);
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.requireDatabase()
			.query(
				`SELECT job_id, store_revision, record_json FROM jobs ${where}
				 ORDER BY created_at DESC, job_id DESC LIMIT ?`,
			)
			.all(...values, filter.limit) as JobRow[];
		return rows.map(parseRow);
	}

	/** Queued jobs in run order: priority, then schedule, then age. */
	nextQueued(types?: JobType[]): JobRecord | null {
		const now = new Date().toISOString();
		const typeClause = types?.length
			? `AND job_type IN (${types.map(() => "?").join(",")})`
			: "";
		const row = this.requireDatabase()
			.query(
				`SELECT job_id, store_revision, record_json FROM jobs
				 WHERE state = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= ?)
				 ${typeClause}
				 ORDER BY priority_rank DESC, created_at ASC, job_id ASC LIMIT 1`,
			)
			.get(now, ...(types ?? [])) as JobRow | null;
		return row ? parseRow(row) : null;
	}

	summary(): JobQueueSummary {
		const counts = emptyStateCounts();
		const byType = emptyTypeCounts();
		for (const row of this.requireDatabase()
			.query("SELECT job_type, state, COUNT(*) AS count FROM jobs GROUP BY job_type, state")
			.all() as Array<{ job_type: JobType; state: JobState; count: number }>) {
			counts[row.state] += row.count;
			if (row.state === "queued") byType[row.job_type].queued += row.count;
			if (ACTIVE_STATES.has(row.state)) byType[row.job_type].active += row.count;
		}
		const running = this.list({
			states: ["starting", "running", "cancelling"],
			limit: 1,
		})[0];
		const recoveryRequired = (
			this.requireDatabase()
				.query(
					"SELECT job_id FROM jobs WHERE state = 'recovery-required' ORDER BY created_at ASC",
				)
				.all() as Array<{ job_id: string }>
		).map((row) => row.job_id);
		return {
			depth: counts.queued,
			running: running ?? null,
			counts,
			byType,
			recoveryRequired,
		};
	}

	/**
	 * Claim a queued job for execution. The claim is the only path from
	 * `queued` to `starting`; it records the attempt and grants the lease.
	 */
	claim(
		jobId: string,
		ownerId: string,
		options: { leaseMs?: number; now?: string } = {},
	): JobClaim | null {
		const fencingToken = randomUUID();
		const now = options.now ?? new Date().toISOString();
		const expiresAt = new Date(
			Date.parse(now) + (options.leaseMs ?? JOB_LEASE_MS),
		).toISOString();
		const updated = this.transition(jobId, (current) => {
			if (current.state !== "queued") return null;
			const attempt = current.attempt + 1;
			return {
				...current,
				state: "starting",
				attempt,
				attempts: [
					...current.attempts,
					{
						number: attempt,
						ownerId,
						startedAt: now,
						completedAt: null,
						outcome: null,
						error: null,
						resolution: null,
					},
				],
				lease: { ownerId, fencingToken, expiresAt },
				heartbeatAt: now,
				startedAt: current.startedAt ?? now,
				lastError: null,
				logs: appendLog(current, "info", `attempt ${attempt} claimed by ${ownerId}`, now),
			};
		});
		return updated ? { record: updated, ownerId, fencingToken } : null;
	}

	start(jobId: string, fence: JobFence, progress?: Partial<JobProgress>): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (current.state !== "starting") {
				throw illegal(current, "running");
			}
			const now = new Date().toISOString();
			return {
				...current,
				state: current.cancellationRequestedAt ? "cancelling" : "running",
				progress: { ...current.progress, ...progress },
				heartbeatAt: now,
				lease: renewLease(current.lease!, now),
			};
		});
	}

	heartbeat(
		jobId: string,
		fence: JobFence,
		update: {
			progress?: Partial<JobProgress>;
			checkpoint?: Omit<JobCheckpoint, "at">;
			log?: Omit<JobLog, "at">;
		} = {},
	): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (!ACTIVE_STATES.has(current.state)) throw illegal(current, current.state);
			const now = new Date().toISOString();
			return {
				...current,
				progress: { ...current.progress, ...update.progress },
				heartbeatAt: now,
				lease: renewLease(current.lease!, now),
				checkpoints: update.checkpoint
					? [...current.checkpoints, { ...update.checkpoint, at: now }]
					: current.checkpoints,
				logs: update.log
					? appendLog(current, update.log.level, update.log.message, now)
					: current.logs,
				cancellationObservedAt:
					current.cancellationRequestedAt && !current.cancellationObservedAt
						? now
						: current.cancellationObservedAt,
			};
		});
	}

	/** Record that the runner observed the cancellation signal. */
	observeCancellation(jobId: string, fence: JobFence): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (!current.cancellationRequestedAt) return current;
			const now = new Date().toISOString();
			return {
				...current,
				state: current.state === "running" ? "cancelling" : current.state,
				cancellationObservedAt: current.cancellationObservedAt ?? now,
				heartbeatAt: now,
			};
		});
	}

	succeed(
		jobId: string,
		fence: JobFence,
		outcome: {
			result: JsonValue;
			artifacts?: JobArtifact[];
			provenance?: JsonValue | null;
			attachmentTransaction?: JsonValue | null;
		},
	): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (!ACTIVE_STATES.has(current.state)) throw illegal(current, "succeeded");
			const now = new Date().toISOString();
			return finishAttempt(
				{
					...current,
					state: "succeeded",
					result: outcome.result,
					artifacts: [...current.artifacts, ...(outcome.artifacts ?? [])],
					provenance: outcome.provenance ?? current.provenance,
					attachmentTransaction:
						outcome.attachmentTransaction ?? current.attachmentTransaction,
					progress: {
						...current.progress,
						phase: "complete",
						completed: current.progress.total ?? current.progress.completed,
					},
					lastError: null,
				},
				"succeeded",
				null,
				now,
			);
		});
	}

	fail(
		jobId: string,
		fence: JobFence,
		outcome: {
			error: string;
			errorClass?: string;
			artifacts?: JobArtifact[];
			diagnostics?: Array<Omit<JobDiagnostic, "at">>;
		},
	): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (!ACTIVE_STATES.has(current.state)) throw illegal(current, "failed");
			const now = new Date().toISOString();
			return finishAttempt(
				{
					...current,
					state: "failed",
					lastError: outcome.error,
					artifacts: [...current.artifacts, ...(outcome.artifacts ?? [])],
					diagnostics: [
						...current.diagnostics,
						...(outcome.diagnostics ?? []).map((entry) => ({ ...entry, at: now })),
						...(outcome.errorClass
							? [{ code: outcome.errorClass, at: now, detail: outcome.error }]
							: []),
					],
				},
				"failed",
				outcome.error,
				now,
			);
		});
	}

	/** The runner confirms it stopped after observing a cancellation request. */
	confirmCancelled(
		jobId: string,
		fence: JobFence,
		outcome: { reason: string; artifacts?: JobArtifact[] },
	): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (!ACTIVE_STATES.has(current.state)) throw illegal(current, "cancelled");
			const now = new Date().toISOString();
			return finishAttempt(
				{
					...current,
					state: "cancelled",
					cancellationObservedAt: current.cancellationObservedAt ?? now,
					artifacts: [...current.artifacts, ...(outcome.artifacts ?? [])],
					lastError: outcome.reason,
				},
				"cancelled",
				outcome.reason,
				now,
			);
		});
	}

	/**
	 * The runner gives the job back to the queue for a later attempt, for
	 * example because the editor disconnected before the render started.
	 */
	release(jobId: string, fence: JobFence, reason: string): JobRecord {
		return this.fenced(jobId, fence, (current) => {
			if (!ACTIVE_STATES.has(current.state)) throw illegal(current, "queued");
			const now = new Date().toISOString();
			if (current.cancellationRequestedAt) {
				return finishAttempt(
					{ ...current, state: "cancelled", lastError: reason },
					"cancelled",
					reason,
					now,
				);
			}
			return finishAttempt(
				{ ...current, state: "queued", lastError: reason },
				"interrupted",
				reason,
				now,
			);
		});
	}

	/**
	 * Request cancellation. Queued jobs cancel immediately; active jobs move to
	 * `cancelling` and the runner confirms once the renderer or provider has
	 * stopped. Terminal jobs are unchanged, so the request is idempotent.
	 */
	cancel(jobId: string, reason: string): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (TERMINAL_STATES.has(current.state)) return current;
			const now = new Date().toISOString();
			if (current.cancellationRequestedAt) return current;
			if (
				current.state === "queued" ||
				current.state === "blocked" ||
				current.state === "recovery-required"
			) {
				return finishAttempt(
					{
						...current,
						state: "cancelled",
						cancellationRequestedAt: now,
						cancellationObservedAt: now,
						lastError: reason,
					},
					"cancelled",
					reason,
					now,
				);
			}
			return {
				...current,
				state: current.state === "running" ? "cancelling" : current.state,
				cancellationRequestedAt: now,
				logs: appendLog(current, "info", `cancellation requested: ${reason}`, now),
			};
		});
		return updated ?? this.require(jobId);
	}

	/** Explicit retry of a failed job as a new attempt within its policy. */
	retry(jobId: string, options: { reason: string; operationId: string | null }): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (current.state !== "failed") throw illegal(current, "queued");
			if (current.attempt >= current.attemptPolicy.maximumAttempts) {
				throw new JobStoreError(
					"JOB_ATTEMPTS_EXHAUSTED",
					`job ${jobId} already used ${current.attempt} of ${current.attemptPolicy.maximumAttempts} attempts`,
				);
			}
			const now = new Date().toISOString();
			return {
				...current,
				state: "queued",
				lastError: null,
				completedAt: null,
				lease: null,
				attempts: resolveLastAttempt(current, {
					kind: "retry",
					at: now,
					reason: options.reason,
					operationId: options.operationId,
				}),
				logs: appendLog(current, "info", `retry requested: ${options.reason}`, now),
			};
		});
		return updated ?? this.require(jobId);
	}

	/**
	 * Resolve an uncertain outcome. `rerun-as-new-attempt` returns the job to
	 * the queue and preserves the original attempt; `mark-failed` terminalizes
	 * it. Both keep the same job identity.
	 */
	resolve(
		jobId: string,
		resolution: {
			kind: "rerun-as-new-attempt" | "mark-failed";
			reason: string;
			operationId: string | null;
			artifacts?: JobArtifact[];
		},
	): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (current.state !== "recovery-required" && current.state !== "blocked") {
				throw illegal(current, resolution.kind === "mark-failed" ? "failed" : "queued");
			}
			const now = new Date().toISOString();
			const attempts = resolveLastAttempt(current, {
				kind: resolution.kind,
				at: now,
				reason: resolution.reason,
				operationId: resolution.operationId,
			});
			const artifacts = [...current.artifacts, ...(resolution.artifacts ?? [])];
			if (resolution.kind === "mark-failed") {
				return {
					...current,
					state: "failed",
					attempts,
					artifacts,
					lease: null,
					completedAt: now,
					lastError: resolution.reason,
					logs: appendLog(current, "info", `marked failed: ${resolution.reason}`, now),
				};
			}
			return {
				...current,
				state: "queued",
				attempts,
				artifacts,
				lease: null,
				completedAt: null,
				blockedReason: null,
				lastError: null,
				logs: appendLog(current, "info", `rerun as new attempt: ${resolution.reason}`, now),
			};
		});
		return updated ?? this.require(jobId);
	}

	/**
	 * Amend the stored input of a job that has not started. The semantic input
	 * hash is fixed at submission, so this only carries non-semantic
	 * enrichment such as queue-time persistence evidence.
	 */
	amendInput(
		jobId: string,
		change: (input: JsonValue) => JsonValue,
	): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (current.state !== "queued" && current.state !== "blocked") {
				return current;
			}
			const input = change(current.input);
			if (stableSerialize(input) === stableSerialize(current.input)) {
				return current;
			}
			return { ...current, input };
		});
		return updated ?? this.require(jobId);
	}

	block(jobId: string, reason: string): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (current.state !== "queued") throw illegal(current, "blocked");
			const now = new Date().toISOString();
			return {
				...current,
				state: "blocked",
				blockedReason: reason,
				logs: appendLog(current, "warn", `blocked: ${reason}`, now),
			};
		});
		return updated ?? this.require(jobId);
	}

	unblock(jobId: string): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (current.state !== "blocked") throw illegal(current, "queued");
			return { ...current, state: "queued", blockedReason: null };
		});
		return updated ?? this.require(jobId);
	}

	/**
	 * Reconcile jobs whose owner is dead. The caller supplies per-type
	 * reconcilers that inspect partial artifacts before the job is requeued;
	 * without one the job enters `recovery-required`.
	 */
	async reconcileInterrupted(options: {
		reconcile: (record: JobRecord) => Promise<JobReconciliationOutcome>;
		isAlive?: (pid: number) => boolean;
		now?: number;
	}): Promise<JobRecord[]> {
		const reconciled: JobRecord[] = [];
		for (const record of this.list({
			states: ["starting", "running", "cancelling"],
			limit: Number.MAX_SAFE_INTEGER,
		})) {
			if (jobOwnerIsLive(record, options.now, options.isAlive)) continue;
			const outcome = await options.reconcile(record);
			const updated = this.transition(record.jobId, (current) => {
				if (current.storeRevision !== record.storeRevision) return null;
				if (!ACTIVE_STATES.has(current.state)) return null;
				return applyReconciliation(current, outcome);
			});
			if (updated) reconciled.push(updated);
		}
		return reconciled;
	}

	/** Compare-and-set mutation used by every transition. */
	private transition(
		jobId: string,
		change: (current: JobRecord) => JobRecord | null,
	): JobRecord | null {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.get(jobId);
			if (!current) {
				throw new JobStoreError("JOB_NOT_FOUND", `job not found: ${jobId}`);
			}
			const next = change(current);
			if (next === null || next === current) {
				database.exec("COMMIT");
				return next === null ? null : current;
			}
			assertLegal(current, next);
			const written = this.write(next, current.storeRevision);
			database.exec("COMMIT");
			return written;
		} catch (error) {
			rollback(database);
			throw error;
		}
	}

	private fenced(
		jobId: string,
		fence: JobFence,
		change: (current: JobRecord) => JobRecord,
	): JobRecord {
		const updated = this.transition(jobId, (current) => {
			if (
				!current.lease ||
				current.lease.ownerId !== fence.ownerId ||
				current.lease.fencingToken !== fence.fencingToken
			) {
				throw new JobStoreError(
					"JOB_FENCE_REJECTED",
					`job ${jobId} lease is not held by ${fence.ownerId}`,
				);
			}
			return change(current);
		});
		return updated ?? this.require(jobId);
	}

	private insert(record: JobRecord): void {
		const stamped = stamp(record);
		this.requireDatabase()
			.query(
				`INSERT INTO jobs (
					job_id, job_type, operation_id, project_id, state, priority_rank,
					concurrency_group, scheduled_for, store_revision, lease_owner,
					lease_expires_at, heartbeat_at, created_at, updated_at, checksum, record_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				stamped.jobId,
				stamped.jobType,
				stamped.operationId,
				stamped.preconditions.projectId,
				stamped.state,
				priorityRank(stamped.priority),
				stamped.concurrencyGroup,
				stamped.scheduledFor,
				stamped.storeRevision,
				stamped.lease?.ownerId ?? null,
				stamped.lease?.expiresAt ?? null,
				stamped.heartbeatAt,
				stamped.createdAt,
				stamped.updatedAt,
				stamped.checksum,
				JSON.stringify(stamped),
			);
		this.appendHistory(stamped, "created");
	}

	private write(next: JobRecord, expectedRevision: number): JobRecord {
		const stamped = stamp({
			...next,
			storeRevision: expectedRevision + 1,
			updatedAt: new Date().toISOString(),
		});
		const changes = this.requireDatabase()
			.query(
				`UPDATE jobs SET
					state = ?, priority_rank = ?, scheduled_for = ?, store_revision = ?,
					lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?,
					checksum = ?, record_json = ?
				 WHERE job_id = ? AND store_revision = ?`,
			)
			.run(
				stamped.state,
				priorityRank(stamped.priority),
				stamped.scheduledFor,
				stamped.storeRevision,
				stamped.lease?.ownerId ?? null,
				stamped.lease?.expiresAt ?? null,
				stamped.heartbeatAt,
				stamped.updatedAt,
				stamped.checksum,
				JSON.stringify(stamped),
				stamped.jobId,
				expectedRevision,
			).changes;
		if (changes !== 1) {
			throw new JobStoreError(
				"JOB_STALE_REVISION",
				`job ${next.jobId} changed underneath revision ${expectedRevision}`,
			);
		}
		this.appendHistory(stamped, "updated");
		return stamped;
	}

	private appendHistory(record: JobRecord, event: "created" | "updated"): void {
		this.requireDatabase()
			.query(
				`INSERT INTO job_history (job_id, store_revision, recorded_at, event, state, attempt, checksum)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.jobId,
				record.storeRevision,
				record.updatedAt,
				event,
				record.state,
				record.attempt,
				record.checksum,
			);
	}

	history(jobId: string): Array<{
		storeRevision: number;
		recordedAt: string;
		event: "created" | "updated";
		state: JobState;
		attempt: number;
		checksum: string;
	}> {
		return (
			this.requireDatabase()
				.query(
					`SELECT store_revision, recorded_at, event, state, attempt, checksum
					 FROM job_history WHERE job_id = ? ORDER BY store_revision ASC`,
				)
				.all(jobId) as Array<{
				store_revision: number;
				recorded_at: string;
				event: "created" | "updated";
				state: JobState;
				attempt: number;
				checksum: string;
			}>
		).map((row) => ({
			storeRevision: row.store_revision,
			recordedAt: row.recorded_at,
			event: row.event,
			state: row.state,
			attempt: row.attempt,
			checksum: row.checksum,
		}));
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("job store is not initialized");
		return this.database;
	}
}

function initializeSchema(database: Database): void {
	database.exec(`CREATE TABLE IF NOT EXISTS job_store_metadata (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`);
	const version = database
		.query("SELECT value FROM job_store_metadata WHERE key = 'schema_version'")
		.get() as { value: string } | null;
	if (version && version.value !== String(JOB_SCHEMA_VERSION)) {
		throw new JobStoreError(
			"JOB_SCHEMA_UNSUPPORTED",
			`unsupported job store schema ${version.value}; no automatic migration is available`,
		);
	}
	database
		.query(
			"INSERT OR IGNORE INTO job_store_metadata (key, value) VALUES ('schema_version', ?)",
		)
		.run(String(JOB_SCHEMA_VERSION));
	database.exec(`CREATE TABLE IF NOT EXISTS jobs (
		job_id TEXT PRIMARY KEY,
		job_type TEXT NOT NULL,
		operation_id TEXT NOT NULL,
		project_id TEXT,
		state TEXT NOT NULL CHECK (state IN (
			'queued','starting','running','cancelling','cancelled',
			'succeeded','failed','blocked','recovery-required'
		)),
		priority_rank INTEGER NOT NULL,
		concurrency_group TEXT NOT NULL,
		scheduled_for TEXT,
		store_revision INTEGER NOT NULL CHECK (store_revision >= 0),
		lease_owner TEXT,
		lease_expires_at TEXT,
		heartbeat_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		checksum TEXT NOT NULL,
		record_json TEXT NOT NULL
	)`);
	database.exec(
		"CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs (state, created_at)",
	);
	database.exec(
		"CREATE INDEX IF NOT EXISTS jobs_type_state ON jobs (job_type, state)",
	);
	database.exec(`CREATE TABLE IF NOT EXISTS job_history (
		job_id TEXT NOT NULL REFERENCES jobs (job_id),
		store_revision INTEGER NOT NULL,
		recorded_at TEXT NOT NULL,
		event TEXT NOT NULL CHECK (event IN ('created','updated')),
		state TEXT NOT NULL,
		attempt INTEGER NOT NULL,
		checksum TEXT NOT NULL,
		PRIMARY KEY (job_id, store_revision)
	)`);
	database.exec(`CREATE TRIGGER IF NOT EXISTS jobs_identity_immutable
		BEFORE UPDATE ON jobs
		WHEN OLD.job_id != NEW.job_id
			OR OLD.job_type != NEW.job_type
			OR OLD.operation_id != NEW.operation_id
			OR OLD.created_at != NEW.created_at
			OR NEW.store_revision != OLD.store_revision + 1
		BEGIN SELECT RAISE(ABORT, 'job identity is immutable'); END`);
	database.exec(`CREATE TRIGGER IF NOT EXISTS jobs_terminal_immutable
		BEFORE UPDATE ON jobs
		WHEN OLD.state IN ('succeeded','cancelled')
		BEGIN SELECT RAISE(ABORT, 'terminal job outcome is immutable'); END`);
	database.exec(`CREATE TRIGGER IF NOT EXISTS job_history_append_only
		BEFORE DELETE ON job_history
		BEGIN SELECT RAISE(ABORT, 'job history is append-only'); END`);
}

function buildRecord(input: JobSubmission): JobRecord {
	if (!input.jobId || !input.operationId) {
		throw new Error("job id and operation id are required");
	}
	if (!/^[a-f0-9]{64}$/.test(input.semanticInputHash)) {
		throw new Error("job semantic input hash must be lowercase SHA-256");
	}
	const now = input.createdAt ?? new Date().toISOString();
	const attemptPolicy: JobAttemptPolicy = {
		maximumAttempts: input.attemptPolicy?.maximumAttempts ?? 3,
		retryableErrorClasses: input.attemptPolicy?.retryableErrorClasses ?? [
			"editor-disconnected",
		],
		boundedBackoffMs: input.attemptPolicy?.boundedBackoffMs ?? 0,
	};
	if (
		!Number.isSafeInteger(attemptPolicy.maximumAttempts) ||
		attemptPolicy.maximumAttempts < 1
	) {
		throw new Error("job maximum attempts must be a positive integer");
	}
	return stamp({
		schemaVersion: JOB_RECORD_SCHEMA_VERSION,
		storeRevision: 0,
		jobId: input.jobId,
		jobType: input.jobType,
		jobSchemaVersion: input.jobSchemaVersion ?? 1,
		operationId: input.operationId,
		semanticInputHash: input.semanticInputHash,
		capabilitySnapshotHash: input.capabilitySnapshotHash ?? null,
		preconditions: {
			projectId: input.preconditions?.projectId ?? null,
			sceneId: input.preconditions?.sceneId ?? null,
			revision: input.preconditions?.revision ?? null,
			contentHash: input.preconditions?.contentHash ?? null,
			writeVersion: input.preconditions?.writeVersion ?? null,
			saveReceiptId: input.preconditions?.saveReceiptId ?? null,
		},
		providerPolicy: input.providerPolicy ?? null,
		rendererPolicy: input.rendererPolicy ?? null,
		priority: input.priority ?? "normal",
		resourceClass: input.resourceClass ?? "local-compositor",
		concurrencyGroup: input.concurrencyGroup ?? "opencut-compositor",
		scheduledFor: input.scheduledFor ?? null,
		attemptPolicy,
		state: "queued",
		attempt: 0,
		attempts: [],
		progress: {
			units: input.progressUnits ?? "steps",
			phase: "queued",
			completed: 0,
			total: null,
			etaConfidence: "unavailable",
		},
		heartbeatAt: null,
		lease: null,
		cancellationRequestedAt: null,
		cancellationObservedAt: null,
		blockedReason: null,
		checkpoints: [],
		logs: [],
		diagnostics: [],
		artifacts: [],
		provenance: null,
		attachmentTransaction: null,
		input: input.input,
		result: null,
		lastError: null,
		createdAt: now,
		updatedAt: now,
		startedAt: null,
		completedAt: null,
		checksum: "",
	});
}

function applyReconciliation(
	current: JobRecord,
	outcome: JobReconciliationOutcome,
): JobRecord {
	const now = new Date().toISOString();
	const base = {
		...current,
		logs: appendLog(
			current,
			"warn",
			`owner ${current.lease?.ownerId ?? "unknown"} died; reconciled as ${outcome.kind}`,
			now,
		),
	};
	switch (outcome.kind) {
		case "succeeded":
			return finishAttempt(
				{
					...base,
					state: "succeeded",
					result: outcome.result,
					artifacts: [...current.artifacts, ...(outcome.artifacts ?? [])],
					progress: { ...current.progress, phase: "complete" },
					lastError: null,
				},
				"succeeded",
				null,
				now,
			);
		case "failed":
			return finishAttempt(
				{
					...base,
					state: "failed",
					lastError: outcome.error,
					artifacts: [...current.artifacts, ...(outcome.artifacts ?? [])],
				},
				"failed",
				outcome.error,
				now,
			);
		case "cancelled":
			return finishAttempt(
				{
					...base,
					state: "cancelled",
					cancellationObservedAt: current.cancellationObservedAt ?? now,
					lastError: outcome.reason,
				},
				"cancelled",
				outcome.reason,
				now,
			);
		case "requeue": {
			if (current.cancellationRequestedAt) {
				return finishAttempt(
					{ ...base, state: "cancelled", lastError: outcome.reason },
					"cancelled",
					outcome.reason,
					now,
				);
			}
			if (current.attempt >= current.attemptPolicy.maximumAttempts) {
				const error = `${outcome.reason}; attempt policy exhausted after ${current.attempt} attempts`;
				return finishAttempt(
					{ ...base, state: "failed", lastError: error },
					"failed",
					error,
					now,
				);
			}
			return finishAttempt(
				{ ...base, state: "queued", lastError: outcome.reason },
				"interrupted",
				outcome.reason,
				now,
			);
		}
		case "recovery-required":
			return finishAttempt(
				{
					...base,
					state: "recovery-required",
					lastError: outcome.detail,
					artifacts: [...current.artifacts, ...(outcome.artifacts ?? [])],
					diagnostics: [
						...current.diagnostics,
						{ code: outcome.code, at: now, detail: outcome.detail },
					],
				},
				"unknown",
				outcome.detail,
				now,
			);
	}
}

function finishAttempt(
	record: JobRecord,
	outcome: JobAttemptOutcome,
	error: string | null,
	now: string,
): JobRecord {
	const attempts = record.attempts.map((attempt, index) =>
		index === record.attempts.length - 1 && attempt.completedAt === null
			? { ...attempt, completedAt: now, outcome, error }
			: attempt,
	);
	const terminal = TERMINAL_STATES.has(record.state);
	return {
		...record,
		attempts,
		lease: null,
		completedAt: terminal ? now : null,
	};
}

function resolveLastAttempt(
	record: JobRecord,
	resolution: JobAttemptResolution,
): JobAttempt[] {
	return record.attempts.map((attempt, index) =>
		index === record.attempts.length - 1
			? { ...attempt, resolution }
			: attempt,
	);
}

function renewLease(lease: JobLease, now: string): JobLease {
	return {
		...lease,
		expiresAt: new Date(Date.parse(now) + JOB_LEASE_MS).toISOString(),
	};
}

function appendLog(
	record: JobRecord,
	level: JobLog["level"],
	message: string,
	at: string,
): JobLog[] {
	const logs = [...record.logs, { level, at, message }];
	return logs.length > 200 ? logs.slice(logs.length - 200) : logs;
}

function assertLegal(current: JobRecord, next: JobRecord): void {
	if (current.state === next.state) return;
	if (!LEGAL_TRANSITIONS[current.state].has(next.state)) {
		throw illegal(current, next.state);
	}
}

function illegal(current: JobRecord, target: JobState): JobStoreError {
	return new JobStoreError(
		"JOB_ILLEGAL_TRANSITION",
		`job ${current.jobId} cannot move from ${current.state} to ${target}`,
	);
}

function priorityRank(priority: JobPriority): number {
	return priority === "high" ? 2 : priority === "normal" ? 1 : 0;
}

function stamp(record: JobRecord): JobRecord {
	const { checksum: _checksum, ...rest } = record;
	const checksum = createHash("sha256")
		.update(stableSerialize({ ...rest, checksum: null }))
		.digest("hex");
	return { ...rest, checksum };
}

function parseRow(row: JobRow): JobRecord {
	const parsed = JSON.parse(row.record_json) as JobRecord;
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== JOB_RECORD_SCHEMA_VERSION ||
		parsed.jobId !== row.job_id ||
		parsed.storeRevision !== row.store_revision ||
		typeof parsed.checksum !== "string"
	) {
		throw new JobStoreError(
			"JOB_CHECKSUM_MISMATCH",
			`job ${row.job_id} record is malformed`,
		);
	}
	if (stamp(parsed).checksum !== parsed.checksum) {
		throw new JobStoreError(
			"JOB_CHECKSUM_MISMATCH",
			`job ${row.job_id} checksum does not match its record`,
		);
	}
	return parsed;
}

function emptyStateCounts(): Record<JobState, number> {
	return {
		queued: 0,
		starting: 0,
		running: 0,
		cancelling: 0,
		cancelled: 0,
		succeeded: 0,
		failed: 0,
		blocked: 0,
		"recovery-required": 0,
	};
}

function emptyTypeCounts(): Record<JobType, { queued: number; active: number }> {
	return {
		export: { queued: 0, active: 0 },
		"preview-range": { queued: 0, active: 0 },
		comparison: { queued: 0, active: 0 },
		transcription: { queued: 0, active: 0 },
		provider: { queued: 0, active: 0 },
		qc: { queued: 0, active: 0 },
		packaging: { queued: 0, active: 0 },
	};
}

function rollback(database: Database): void {
	try {
		database.exec("ROLLBACK");
	} catch {
		// The transaction may already have committed.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
