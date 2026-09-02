import type { OperationExecutionContext } from "./execute-ledgered-operation";
import type { ExportJobRecord } from "./export-job-store";
import type { ExportJobQueue } from "./export-jobs";
import { parseJsonValue, type JsonValue } from "./operation-ledger-schema";

export interface RunExportJobsInput {
	operationId: string;
	limit: number;
}

export interface RunExportJobsResult {
	connected: boolean;
	processed: ExportJobRecord[];
}

export async function executeRunExportJobs(
	queue: Pick<ExportJobQueue, "list" | "runQueued">,
	connected: boolean,
	input: RunExportJobsInput,
	context: OperationExecutionContext,
): Promise<RunExportJobsResult> {
	const candidates = await queue.list({ statuses: ["queued"], limit: input.limit });
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "prepared", {
			connected,
			candidates: candidates.map(({ jobId, storeRevision }) => ({
				jobId,
				storeRevision,
			})),
		}),
	});
	const result = { connected, processed: await queue.runQueued(input.limit) };
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "committed", {
			result: parseJsonValue(result),
		}),
	});
	return result;
}

export async function recoverRunExportJobs(
	queue: Pick<ExportJobQueue, "get">,
	input: RunExportJobsInput,
	context: OperationExecutionContext,
): Promise<RunExportJobsResult | null> {
	const durable = context
		.record()
		.checkpoints.find(
			(candidate) =>
				candidate.checkpointId === input.operationId && candidate.kind === "job",
		);
	if (!durable) return null;
	if (durable.state !== "prepared") {
		return validateCommittedResult(queue, durable.metadata.result);
	}
	const connected = durable.metadata.connected;
	const candidates = durable.metadata.candidates;
	if (typeof connected !== "boolean" || !Array.isArray(candidates)) return null;
	const processed: ExportJobRecord[] = [];
	for (const value of candidates) {
		if (!isCandidate(value)) return null;
		const current = await queue.get(value.jobId);
		if (!current || current.storeRevision < value.storeRevision) return null;
		if (current.storeRevision === value.storeRevision) continue;
		if (current.status === "running") return null;
		processed.push(current);
	}
	return { connected, processed };
}

async function validateCommittedResult(
	queue: Pick<ExportJobQueue, "get">,
	value: JsonValue | undefined,
): Promise<RunExportJobsResult | null> {
	if (!isRecord(value) || typeof value.connected !== "boolean") return null;
	if (!Array.isArray(value.processed)) return null;
	const processed: ExportJobRecord[] = [];
	for (const item of value.processed) {
		if (!isRecord(item) || !isCandidate(item)) return null;
		const current = await queue.get(item.jobId);
		if (!current || current.storeRevision !== item.storeRevision) return null;
		processed.push(item as unknown as ExportJobRecord);
	}
	return { connected: value.connected, processed };
}

function checkpoint(
	operationId: string,
	state: "prepared" | "committed",
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

function isCandidate(
	value: unknown,
): value is { jobId: string; storeRevision: number } {
	return (
		isRecord(value) &&
		typeof value.jobId === "string" &&
		typeof value.storeRevision === "number" &&
		Number.isInteger(value.storeRevision) &&
		value.storeRevision >= 0
	);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
