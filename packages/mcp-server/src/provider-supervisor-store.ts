import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	JOB_LEASE_MS,
	JobStore,
	JobStoreError,
	type JobFence,
	type JobRecord,
	type JobState,
	type JsonValue,
} from "./job-store";
import { stableSerialize } from "./matte-generation-data";

/** Kept for callers that still resolve the pre-#19 per-provider database name. */
export const PROVIDER_SUPERVISOR_DATABASE = "jobs.sqlite";

export type ProviderSupervisorKind =
	| "audio-cleaner-command"
	| "matte-producer-command"
	| "subject-tracker-command";

/**
 * Public provider states. `unknown` is the projection of the unified
 * `recovery-required` state: the supervisor died before publishing an
 * outcome and the job waits for `rerun-as-new-attempt` or `mark-failed`.
 */
export type ProviderSupervisorState =
	| "queued"
	| "started"
	| "succeeded"
	| "failed"
	| "unknown";

export interface ProviderSupervisorSubmission {
	provider: ProviderSupervisorKind;
	operationId: string;
	semanticFingerprint: string;
	command: string;
	args: string[];
	request: unknown;
	timeoutMs: number;
}

export interface ProviderSupervisorProvenance {
	provider: ProviderSupervisorKind;
	providerProtocolVersion: 1;
	supervisorProtocolVersion: 2;
	modelId: string;
	modelVersion: string;
	artifactSha256: string | null;
	artifactBytes: number | null;
}

export interface ProviderSupervisorRecord {
	jobId: string;
	provider: ProviderSupervisorKind;
	operationId: string;
	semanticFingerprint: string;
	state: ProviderSupervisorState;
	jobState: JobState;
	attempt: number;
	command: string;
	args: string[];
	request: unknown;
	timeoutMs: number;
	supervisorPid: number | null;
	supervisorNonce: string | null;
	result: unknown | null;
	provenance: ProviderSupervisorProvenance | null;
	diagnostics: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
}

export class ProviderSupervisorReuseError extends Error {
	readonly code = "PROVIDER_OPERATION_REUSED";
	constructor(provider: string, operationId: string) {
		super(
			`${provider} operation ${operationId} was reused with different semantic input`,
		);
		this.name = "ProviderSupervisorReuseError";
	}
}

export function providerJobId(
	provider: ProviderSupervisorKind,
	operationId: string,
): string {
	return `provider:${provider}:${operationId}`;
}

/**
 * Provider jobs in the unified job store. Every provider shares one database
 * with export, preview, and comparison jobs; this facade only adds the
 * provider-specific projection and the worker fence helpers.
 */
export class ProviderSupervisorStore {
	readonly directory: string;
	readonly databasePath: string;
	readonly jobs: JobStore;

	constructor(directory: string, jobs?: JobStore) {
		this.directory = resolve(directory);
		this.jobs = jobs ?? new JobStore(this.directory);
		this.databasePath = this.jobs.databasePath;
	}

	async initialize(): Promise<void> {
		await this.jobs.initialize();
	}

	close(): void {
		this.jobs.close();
	}

	claim(input: ProviderSupervisorSubmission): ProviderSupervisorRecord {
		validateSubmission(input);
		const jobId = providerJobId(input.provider, input.operationId);
		try {
			const { record } = this.jobs.submit({
				jobId,
				jobType: "provider",
				operationId: input.operationId,
				semanticInputHash: input.semanticFingerprint,
				providerPolicy: {
					provider: input.provider,
					command: input.command,
					args: input.args,
					timeoutMs: input.timeoutMs,
				},
				resourceClass: "external-provider",
				concurrencyGroup: `provider:${input.provider}`,
				attemptPolicy: {
					maximumAttempts: 3,
					retryableErrorClasses: ["provider-timeout"],
					boundedBackoffMs: 0,
				},
				progressUnits: "provider-steps",
				input: {
					provider: input.provider,
					operationId: input.operationId,
					command: input.command,
					args: input.args,
					request: input.request as JsonValue,
					timeoutMs: input.timeoutMs,
				},
			});
			return toProviderRecord(record);
		} catch (error) {
			if (error instanceof JobStoreError && error.code === "JOB_IDENTITY_REUSED") {
				throw new ProviderSupervisorReuseError(input.provider, input.operationId);
			}
			throw error;
		}
	}

	read(
		provider: ProviderSupervisorKind,
		operationId: string,
	): ProviderSupervisorRecord | null {
		const record = this.jobs.get(providerJobId(provider, operationId));
		return record && record.jobType === "provider"
			? toProviderRecord(record)
			: null;
	}

	/** Worker-side claim: `queued` to `running` under a fresh lease. */
	acquire(
		jobId: string,
		supervisorPid: number,
		supervisorNonce: string,
	): { record: ProviderSupervisorRecord; fence: JobFence } | null {
		const claim = this.jobs.claim(
			jobId,
			`opencut-mcp:${supervisorPid}:${supervisorNonce}`,
			{ leaseMs: JOB_LEASE_MS },
		);
		if (!claim) return null;
		const fence = { ownerId: claim.ownerId, fencingToken: claim.fencingToken };
		const started = this.jobs.start(jobId, fence, {
			phase: "invoking-provider",
			total: 2,
			completed: 0,
		});
		return { record: toProviderRecord(started), fence };
	}

	heartbeat(jobId: string, fence: JobFence, phase?: string): void {
		this.jobs.heartbeat(jobId, fence, phase ? { progress: { phase } } : {});
	}

	complete(
		jobId: string,
		fence: JobFence,
		result: unknown,
		provenance: ProviderSupervisorProvenance,
	): ProviderSupervisorRecord {
		return toProviderRecord(
			this.jobs.succeed(jobId, fence, {
				result: result as JsonValue,
				provenance: provenance as unknown as JsonValue,
				artifacts: provenance.artifactSha256
					? [
							{
								kind: "provider-artifact",
								path: null,
								sha256: provenance.artifactSha256,
								bytes: provenance.artifactBytes,
								disposition: "final",
								recordedAt: new Date().toISOString(),
							},
						]
					: [],
			}),
		);
	}

	fail(
		jobId: string,
		fence: JobFence,
		diagnostics: string,
		errorClass = "provider-failed",
	): ProviderSupervisorRecord {
		return toProviderRecord(
			this.jobs.fail(jobId, fence, { error: diagnostics, errorClass }),
		);
	}

	/**
	 * Move provider jobs whose supervisor died into `recovery-required`. The
	 * provider outcome is unknown, so the invocation is never repeated
	 * implicitly; a typed resolution decides.
	 */
	async reconcileDeadSupervisors(): Promise<ProviderSupervisorRecord[]> {
		const reconciled = await this.jobs.reconcileInterrupted({
			reconcile: async (record) => ({
				kind: "recovery-required",
				code: "provider-outcome-unknown",
				detail:
					"provider supervisor exited before durable terminal publication; the provider invocation will not be repeated until the job is rerun as a new attempt or marked failed",
			}),
		});
		return reconciled
			.filter((record) => record.jobType === "provider")
			.map(toProviderRecord);
	}

	resolve(
		jobId: string,
		resolution: {
			kind: "rerun-as-new-attempt" | "mark-failed";
			reason: string;
			operationId: string | null;
		},
	): ProviderSupervisorRecord {
		return toProviderRecord(this.jobs.resolve(jobId, resolution));
	}
}

export function providerSupervisorFingerprint(semanticInput: unknown): string {
	assertJsonValue(semanticInput, "semanticInput");
	return createHash("sha256")
		.update(stableSerialize(semanticInput))
		.digest("hex");
}

export function toProviderRecord(record: JobRecord): ProviderSupervisorRecord {
	const input = record.input as {
		provider: ProviderSupervisorKind;
		operationId: string;
		command: string;
		args: string[];
		request: unknown;
		timeoutMs: number;
	};
	const owner = /^opencut-mcp:(\d+):([A-Za-z0-9-]+)$/.exec(
		record.lease?.ownerId ?? record.attempts.at(-1)?.ownerId ?? "",
	);
	const lastAttempt = record.attempts.at(-1) ?? null;
	return {
		jobId: record.jobId,
		provider: input.provider,
		operationId: input.operationId,
		semanticFingerprint: record.semanticInputHash,
		state: providerState(record.state),
		jobState: record.state,
		attempt: record.attempt,
		command: input.command,
		args: input.args,
		request: input.request,
		timeoutMs: input.timeoutMs,
		supervisorPid: owner ? Number(owner[1]) : null,
		supervisorNonce: owner ? owner[2]! : null,
		result: record.result,
		provenance: record.provenance as ProviderSupervisorProvenance | null,
		diagnostics: record.lastError,
		createdAt: record.createdAt,
		startedAt: lastAttempt?.startedAt ?? record.startedAt,
		completedAt: record.completedAt,
	};
}

export function providerState(state: JobState): ProviderSupervisorState {
	switch (state) {
		case "queued":
		case "blocked":
			return "queued";
		case "starting":
		case "running":
		case "cancelling":
			return "started";
		case "succeeded":
			return "succeeded";
		case "failed":
		case "cancelled":
			return "failed";
		case "recovery-required":
			return "unknown";
	}
}

function validateSubmission(input: ProviderSupervisorSubmission): void {
	if (!input.operationId || !input.semanticFingerprint || !input.command) {
		throw new Error("provider, operation ID, fingerprint, and command are required");
	}
	if (!/^[a-f0-9]{64}$/.test(input.semanticFingerprint)) {
		throw new Error("provider semantic fingerprint must be lowercase SHA-256");
	}
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
		throw new Error("provider timeout must be a positive safe integer");
	}
	assertJsonValue(input.request, "request");
}

function assertJsonValue(value: unknown, path: string): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			assertJsonValue(child, `${path}.${key}`);
		}
		return;
	}
	throw new Error(`${path} is outside the strict JSON domain`);
}
