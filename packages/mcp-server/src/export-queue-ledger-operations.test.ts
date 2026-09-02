import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationExecutionContext } from "./execute-ledgered-operation";
import { ExportBatchStore } from "./export-batch-store";
import { ExportBatchQueue } from "./export-batches";
import { ExportJobStore } from "./export-job-store";
import { ExportJobQueue, type PersistentExportJobBridge } from "./export-jobs";
import type { ExportReceiptRecord } from "./export-receipts";
import {
	executeCancelBatch,
	executeCancelJob,
	executeQueueBatch,
	executeQueueExport,
	executeRecordInspection,
	recoverCancelBatch,
	recoverCancelJob,
	recoverQueueBatch,
	recoverQueueExport,
	recoverRecordInspection,
} from "./export-queue-ledger-operations";
import type { OperationCheckpoint, OperationLedgerRecord } from "./operation-ledger";

describe("export queue durable operation recovery", () => {
	let directory: string;
	let jobs: ExportJobQueue;
	let batches: ExportBatchQueue;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-queue-recovery-"));
		jobs = makeJobs(directory);
		batches = new ExportBatchQueue(
			jobs,
			new ExportBatchStore(join(directory, "batches")),
		);
	});

	afterEach(async () => {
		jobs.stop();
		await rm(directory, { recursive: true, force: true });
	});

	test("recovers queue publication without creating a second job", async () => {
		const input = queueInput(directory, "job-1", "queue-1");
		const context = fixtureContext();
		await expect(executeQueueExport(jobs, input, context)).rejects.toThrow(
			"simulated response loss",
		);
		const recovered = await recoverQueueExport(jobs, input, context);

		expect(recovered).toMatchObject({ replayed: true, job: { jobId: "job-1" } });
		expect(await new ExportJobStore(join(directory, "jobs")).list()).toHaveLength(1);
	});

	test("recovers a batch without duplicating its variant jobs", async () => {
		const input = {
			operationId: "queue-batch-1",
			batchId: "batch-1",
			projectId: "project-1",
			expectedRevision: 1,
			variants: [
				{
					variantId: "vertical",
					preset: "tiktok_9_16" as const,
					outputPath: join(directory, "vertical.mp4"),
				},
				{
					variantId: "square",
					preset: "instagram_square_1_1" as const,
					outputPath: join(directory, "square.mp4"),
				},
			],
		};
		const context = fixtureContext();
		await expect(executeQueueBatch(batches, input, context)).rejects.toThrow(
			"simulated response loss",
		);
		const recovered = await recoverQueueBatch(batches, input, context);

		expect(recovered).toMatchObject({ replayed: true });
		expect(await new ExportJobStore(join(directory, "jobs")).list()).toHaveLength(2);
	});

	test("recovers job and batch cancellation without duplicate state changes", async () => {
		await jobs.enqueue({
			jobId: "cancel-one",
			input: exportInput(directory, "cancel-one", "export-cancel-one"),
		});
		const jobContext = fixtureContext();
		await expect(
			executeCancelJob(
				jobs,
				{ operationId: "cancel-op", jobId: "cancel-one" },
				jobContext,
			),
		).rejects.toThrow("simulated response loss");
		const job = await recoverCancelJob(
			jobs,
			{ operationId: "cancel-op", jobId: "cancel-one" },
			jobContext,
		);
		expect(job).toMatchObject({ status: "cancelled", storeRevision: 1 });

		const batchInput = {
			operationId: "cancel-batch-queue",
			batchId: "cancel-batch",
			projectId: "project-1",
			expectedRevision: 1,
			variants: [
				{
					variantId: "one",
					preset: "tiktok_9_16" as const,
					outputPath: join(directory, "cancel-batch.mp4"),
				},
			],
		};
		await recoverQueueBatch(batches, batchInput, fixtureContext(false));
		const batchContext = fixtureContext();
		await expect(
			executeCancelBatch(
				batches,
				{ operationId: "cancel-batch-op", batchId: "cancel-batch" },
				batchContext,
			),
		).rejects.toThrow("simulated response loss");
		const batch = await recoverCancelBatch(
			batches,
			{ operationId: "cancel-batch-op", batchId: "cancel-batch" },
			batchContext,
		);
		expect(batch).toMatchObject({ status: "found", summary: { status: "cancelled" } });
	});

	test("recovers an inspection response without writing it twice", async () => {
		let calls = 0;
		let receipt = receiptFixture("pending");
		const store = {
			get: async () => receipt,
			receiptPath: () => join(directory, "receipt.json"),
			recordInspection: async () => {
				calls += 1;
				receipt = receiptFixture("verified-clean");
				return { receipt, path: join(directory, "inspection.json") };
			},
		};
		const input = {
			operationId: "export-1",
			inspectionOperationId: "inspection-1",
			outputSha256: "a".repeat(64),
			watermarkStatus: "verified-clean" as const,
		};
		const context = fixtureContext();
		await expect(executeRecordInspection(store, input, context)).rejects.toThrow(
			"simulated response loss",
		);
		const recovered = await recoverRecordInspection(store, input, context);

		expect(recovered).toMatchObject({ receipt: { inspection: { status: "verified-clean" } } });
		expect(calls).toBe(1);
	});
});

function fixtureContext(failCommitted = true): OperationExecutionContext {
	const checkpoints: OperationCheckpoint[] = [];
	return {
		record: () => ({ checkpoints }) as unknown as OperationLedgerRecord,
		checkpoint: async ({ checkpoint }) => {
			if (checkpoint.state === "committed" && failCommitted) {
				throw new Error("simulated response loss");
			}
			const index = checkpoints.findIndex(
				(value) => value.checkpointId === checkpoint.checkpointId,
			);
			if (index < 0) checkpoints.push(checkpoint);
			else checkpoints.splice(index, 1, checkpoint);
			return { checkpoints } as unknown as OperationLedgerRecord;
		},
	};
}

function makeJobs(directory: string) {
	return new ExportJobQueue(
		fakeBridge(),
		{ export: async () => ({ status: "exported" }) },
		new ExportJobStore(join(directory, "jobs")),
		{ autoRun: false },
	);
}

function queueInput(directory: string, jobId: string, operationId: string) {
	return { jobId, ...exportInput(directory, jobId, operationId) };
}

function exportInput(directory: string, jobId: string, operationId: string) {
	return {
		projectId: "project-1",
		operationId,
		expectedRevision: 1,
		outputPath: join(directory, `${jobId}.mp4`),
		format: "mp4" as const,
		quality: "high" as const,
		includeAudio: true,
	};
}

function fakeBridge(): PersistentExportJobBridge {
	return {
		getStatus: () => ({ connected: false }),
		onConnectionChange: () => () => undefined,
		request: async () => ({}),
		exportTickets: {
			create: async (path) => ({ url: "http://fixture", outputPath: path }),
		},
	};
}

function receiptFixture(
	status: ExportReceiptRecord["inspection"]["status"],
): ExportReceiptRecord {
	return {
		schemaVersion: 1,
		operationId: "export-1",
		fingerprint: "fixture",
		createdAt: "2026-09-02T00:00:00.000Z",
		result: {},
		inspection: {
			status,
			outputSha256: "a".repeat(64),
			reviewer: null,
			notes: null,
			inspectedAt: status === "pending" ? null : "2026-09-02T00:00:01.000Z",
		},
	};
}
