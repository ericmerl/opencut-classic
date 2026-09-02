import type { OperationExecutionContext } from "./execute-ledgered-operation";
import type { ExportBatchQueue } from "./export-batches";
import type { ExportJobQueue } from "./export-jobs";
import type { ExportProjectInput } from "./export-project";
import type {
	ExportReceiptStore,
	WatermarkInspectionStatus,
} from "./export-receipts";
import type { ExportBatchInput } from "./export-variants";
import type { JsonValue } from "./operation-ledger-schema";

export interface QueueExportOperationInput extends ExportProjectInput {
	jobId: string;
}

export interface QueueBatchOperationInput extends ExportBatchInput {
	operationId: string;
}

export interface CancelJobOperationInput {
	operationId: string;
	jobId: string;
}

export interface CancelBatchOperationInput {
	operationId: string;
	batchId: string;
}

export interface RecordInspectionOperationInput {
	operationId: string;
	inspectionOperationId: string;
	outputSha256: string;
	watermarkStatus: Exclude<WatermarkInspectionStatus, "pending">;
	reviewer?: string;
	notes?: string;
}

export async function executeQueueExport(
	queue: Pick<ExportJobQueue, "enqueue">,
	input: QueueExportOperationInput,
	context: OperationExecutionContext,
) {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "prepared", {
			jobId: input.jobId,
		}),
	});
	const { jobId, ...request } = input;
	const result = await queue.enqueue({ jobId, input: request });
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "committed", {
			jobId,
			status: result.job.status,
			storeRevision: result.job.storeRevision,
		}),
	});
	return result;
}

export async function recoverQueueExport(
	queue: Pick<ExportJobQueue, "enqueue">,
	input: QueueExportOperationInput,
	context: OperationExecutionContext,
) {
	const { jobId, ...request } = input;
	const recovered = await queue.enqueue({ jobId, input: request });
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "verified", {
			jobId,
			status: recovered.job.status,
			storeRevision: recovered.job.storeRevision,
		}),
	});
	return { ...recovered, replayed: true };
}

export async function executeQueueBatch(
	queue: Pick<ExportBatchQueue, "enqueue">,
	input: QueueBatchOperationInput,
	context: OperationExecutionContext,
) {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "prepared", {
			batchId: input.batchId,
		}),
	});
	const { operationId: _operationId, ...request } = input;
	const result = await queue.enqueue(request);
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "committed", {
			batchId: input.batchId,
			status: result.summary.status,
		}),
	});
	return result;
}

export async function recoverQueueBatch(
	queue: Pick<ExportBatchQueue, "enqueue">,
	input: QueueBatchOperationInput,
	context: OperationExecutionContext,
) {
	const { operationId: _operationId, ...request } = input;
	const recovered = await queue.enqueue(request);
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "verified", {
			batchId: input.batchId,
			status: recovered.summary.status,
		}),
	});
	return { ...recovered, replayed: true };
}

export async function executeCancelJob(
	queue: Pick<ExportJobQueue, "cancel">,
	input: CancelJobOperationInput,
	context: OperationExecutionContext,
) {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "prepared", {
			jobId: input.jobId,
		}),
	});
	const job = await queue.cancel(input.jobId);
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "committed", {
			jobId: input.jobId,
			status: job.status,
			storeRevision: job.storeRevision,
		}),
	});
	return job;
}

export async function recoverCancelJob(
	queue: Pick<ExportJobQueue, "get" | "cancel">,
	input: CancelJobOperationInput,
	context: OperationExecutionContext,
) {
	let job = await queue.get(input.jobId);
	if (!job) return null;
	if (job.status === "queued") job = await queue.cancel(input.jobId);
	if (job.status !== "cancelled") return null;
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "verified", {
			jobId: input.jobId,
			status: job.status,
			storeRevision: job.storeRevision,
		}),
	});
	return job;
}

export async function executeCancelBatch(
	queue: Pick<ExportBatchQueue, "cancel">,
	input: CancelBatchOperationInput,
	context: OperationExecutionContext,
) {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "prepared", {
			batchId: input.batchId,
		}),
	});
	const summary = await queue.cancel(input.batchId);
	if (summary) {
		await context.checkpoint({
			checkpoint: checkpoint(input.operationId, "job", "committed", {
				batchId: input.batchId,
				status: summary.status,
			}),
		});
	}
	return summary
		? { status: "found", summary }
		: { status: "not-found", batchId: input.batchId };
}

export async function recoverCancelBatch(
	queue: Pick<ExportBatchQueue, "cancel">,
	input: CancelBatchOperationInput,
	context: OperationExecutionContext,
) {
	const summary = await queue.cancel(input.batchId);
	if (!summary || summary.counts.queued > 0) return null;
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "job", "verified", {
			batchId: input.batchId,
			status: summary.status,
		}),
	});
	return { status: "found", summary };
}

export async function executeRecordInspection(
	store: Pick<ExportReceiptStore, "recordInspection">,
	input: RecordInspectionOperationInput,
	context: OperationExecutionContext,
) {
	await context.checkpoint({
		checkpoint: checkpoint(
			input.inspectionOperationId,
			"filesystem",
			"prepared",
			{ exportOperationId: input.operationId },
		),
	});
	const result = await store.recordInspection({
		operationId: input.operationId,
		outputSha256: input.outputSha256,
		status: input.watermarkStatus,
		reviewer: input.reviewer,
		notes: input.notes,
	});
	await context.checkpoint({
		checkpoint: checkpoint(
			input.inspectionOperationId,
			"filesystem",
			"committed",
			{ exportOperationId: input.operationId },
		),
	});
	return result;
}

export async function recoverRecordInspection(
	store: Pick<ExportReceiptStore, "get" | "recordInspection" | "receiptPath">,
	input: RecordInspectionOperationInput,
	context: OperationExecutionContext,
) {
	let receipt = await store.get(input.operationId);
	if (!receipt) return null;
	if (receipt.inspection.status === "pending") {
		const recorded = await store.recordInspection({
			operationId: input.operationId,
			outputSha256: input.outputSha256,
			status: input.watermarkStatus,
			reviewer: input.reviewer,
			notes: input.notes,
		});
		receipt = recorded.receipt;
	}
	if (
		receipt.inspection.status !== input.watermarkStatus ||
		receipt.inspection.outputSha256 !== input.outputSha256
	)
		return null;
	await context.checkpoint({
		checkpoint: checkpoint(
			input.inspectionOperationId,
			"filesystem",
			"verified",
			{ exportOperationId: input.operationId },
		),
	});
	return { receipt, path: store.receiptPath(input.operationId) };
}

function checkpoint(
	checkpointId: string,
	kind: "job" | "filesystem",
	state: "prepared" | "committed" | "verified",
	metadata: Record<string, JsonValue>,
) {
	return { checkpointId, kind, state, recordedAt: new Date().toISOString(), metadata };
}
