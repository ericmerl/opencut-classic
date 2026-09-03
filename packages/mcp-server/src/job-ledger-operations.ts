import type { OperationExecutionContext } from "./execute-ledgered-operation";
import type { JobService, JobResolution } from "./job-service";
import type { JobRecord } from "./job-store";
import type { JsonValue } from "./operation-ledger-schema";

export interface CancelJobOperationInput {
	operationId: string;
	jobId: string;
	reason?: string;
}

export interface RetryJobOperationInput {
	operationId: string;
	jobId: string;
	reason?: string;
}

export interface ResolveJobOperationInput {
	operationId: string;
	jobId: string;
	resolution: JobResolution["kind"];
	reason?: string;
}

export interface JobOperationResult {
	status: "found";
	job: JobRecord;
}

export async function executeCancelJob(
	jobs: Pick<JobService, "cancel">,
	input: CancelJobOperationInput,
	context: OperationExecutionContext,
): Promise<JobOperationResult> {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "prepared", { jobId: input.jobId }),
	});
	const job = await jobs.cancel(
		input.jobId,
		input.reason ?? `cancelled by operation ${input.operationId}`,
	);
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "committed", {
			jobId: input.jobId,
			state: job.state,
			storeRevision: job.storeRevision,
		}),
	});
	return { status: "found", job };
}

export async function recoverCancelJob(
	jobs: Pick<JobService, "get" | "cancel">,
	input: CancelJobOperationInput,
	context: OperationExecutionContext,
): Promise<JobOperationResult | null> {
	let job = await jobs.get(input.jobId);
	if (!job) return null;
	if (!job.cancellationRequestedAt && job.state !== "cancelled") {
		job = await jobs.cancel(
			input.jobId,
			input.reason ?? `cancelled by operation ${input.operationId}`,
		);
	}
	if (!job.cancellationRequestedAt && job.state !== "cancelled") return null;
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "verified", {
			jobId: input.jobId,
			state: job.state,
			storeRevision: job.storeRevision,
		}),
	});
	return { status: "found", job };
}

export async function executeRetryJob(
	jobs: Pick<JobService, "retry">,
	input: RetryJobOperationInput,
	context: OperationExecutionContext,
): Promise<JobOperationResult> {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "prepared", { jobId: input.jobId }),
	});
	const job = await jobs.retry(input.jobId, {
		reason: input.reason ?? `retried by operation ${input.operationId}`,
		operationId: input.operationId,
	});
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "committed", {
			jobId: input.jobId,
			state: job.state,
			attempt: job.attempt,
			storeRevision: job.storeRevision,
		}),
	});
	return { status: "found", job };
}

export async function recoverRetryJob(
	jobs: Pick<JobService, "get">,
	input: RetryJobOperationInput,
	context: OperationExecutionContext,
): Promise<JobOperationResult | null> {
	const job = await jobs.get(input.jobId);
	if (!job) return null;
	const resolved = job.attempts.some(
		(attempt) =>
			attempt.resolution?.kind === "retry" &&
			attempt.resolution.operationId === input.operationId,
	);
	if (!resolved) return null;
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "verified", {
			jobId: input.jobId,
			state: job.state,
			storeRevision: job.storeRevision,
		}),
	});
	return { status: "found", job };
}

export async function executeResolveJob(
	jobs: Pick<JobService, "resolve">,
	input: ResolveJobOperationInput,
	context: OperationExecutionContext,
): Promise<JobOperationResult> {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "prepared", {
			jobId: input.jobId,
			resolution: input.resolution,
		}),
	});
	const job = await jobs.resolve(input.jobId, {
		kind: input.resolution,
		reason: input.reason ?? `resolved by operation ${input.operationId}`,
		operationId: input.operationId,
	});
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "committed", {
			jobId: input.jobId,
			state: job.state,
			storeRevision: job.storeRevision,
		}),
	});
	return { status: "found", job };
}

export async function recoverResolveJob(
	jobs: Pick<JobService, "get">,
	input: ResolveJobOperationInput,
	context: OperationExecutionContext,
): Promise<JobOperationResult | null> {
	const job = await jobs.get(input.jobId);
	if (!job) return null;
	const resolved = job.attempts.some(
		(attempt) =>
			attempt.resolution?.kind === input.resolution &&
			attempt.resolution.operationId === input.operationId,
	);
	if (!resolved) return null;
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "verified", {
			jobId: input.jobId,
			state: job.state,
			storeRevision: job.storeRevision,
		}),
	});
	return { status: "found", job };
}

function checkpoint(
	operationId: string,
	state: "prepared" | "committed" | "verified",
	metadata: Record<string, JsonValue>,
) {
	return {
		checkpointId: operationId,
		kind: "job" as const,
		state,
		recordedAt: new Date().toISOString(),
		metadata,
	};
}
