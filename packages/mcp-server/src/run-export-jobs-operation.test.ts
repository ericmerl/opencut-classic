import { describe, expect, test } from "bun:test";
import type { OperationExecutionContext } from "./execute-ledgered-operation";
import type { ExportJobRecord } from "./export-job-store";
import type { OperationCheckpoint, OperationLedgerRecord } from "./operation-ledger";
import {
	executeRunExportJobs,
	recoverRunExportJobs,
} from "./run-export-jobs-operation";

describe("run export jobs durable recovery", () => {
	test("replays a committed exact processed set without draining", async () => {
		const state = fixtureState();
		const queue = fixtureQueue(state);
		const context = fixtureContext();
		const first = await executeRunExportJobs(
			queue,
			true,
			{ operationId: "run-1", limit: 2 },
			context,
		);
		const recovered = await recoverRunExportJobs(
			queue,
			{ operationId: "run-1", limit: 2 },
			context,
		);

		expect(first.processed.map((job) => job.jobId)).toEqual(["job-1", "job-2"]);
		expect(recovered).toEqual(first);
		expect(state.drains).toBe(1);
	});

	test("reconstructs jobs changed after the prepared checkpoint without draining", async () => {
		const state = fixtureState();
		const queue = fixtureQueue(state);
		const context = fixtureContext({ failCommittedCheckpoint: true });
		await expect(
			executeRunExportJobs(
				queue,
				true,
				{ operationId: "run-2", limit: 2 },
				context,
			),
		).rejects.toThrow("simulated response loss");

		const recovered = await recoverRunExportJobs(
			queue,
			{ operationId: "run-2", limit: 2 },
			context,
		);

		expect(recovered?.processed.map((job) => job.jobId)).toEqual([
			"job-1",
			"job-2",
		]);
		expect(state.drains).toBe(1);
	});
});

function fixtureState() {
	return {
		drains: 0,
		jobs: new Map([
			["job-1", job("job-1", 0, "queued")],
			["job-2", job("job-2", 0, "queued")],
		]),
	};
}

function fixtureQueue(state: ReturnType<typeof fixtureState>) {
	return {
		list: async ({ limit }: { statuses?: string[]; limit: number }) =>
			[...state.jobs.values()].slice(0, limit),
		runQueued: async (limit: number) => {
			state.drains += 1;
			const processed = [...state.jobs.values()].slice(0, limit).map((current) =>
				job(current.jobId, current.storeRevision + 2, "completed"),
			);
			for (const current of processed) state.jobs.set(current.jobId, current);
			return processed;
		},
		get: async (jobId: string) => state.jobs.get(jobId) ?? null,
	};
}

function fixtureContext(
	options: { failCommittedCheckpoint?: boolean } = {},
): OperationExecutionContext {
	const checkpoints: OperationCheckpoint[] = [];
	return {
		record: () => ({ checkpoints }) as unknown as OperationLedgerRecord,
		checkpoint: async ({ checkpoint }) => {
			if (checkpoint.state === "committed" && options.failCommittedCheckpoint) {
				throw new Error("simulated response loss");
			}
			const prior = checkpoints.findIndex(
				(value) => value.checkpointId === checkpoint.checkpointId,
			);
			if (prior >= 0) checkpoints.splice(prior, 1, checkpoint);
			else checkpoints.push(checkpoint);
			return { checkpoints } as unknown as OperationLedgerRecord;
		},
	};
}

function job(
	jobId: string,
	storeRevision: number,
	status: ExportJobRecord["status"],
): ExportJobRecord {
	return {
		schemaVersion: 1,
		storeRevision,
		jobId,
		fingerprint: `fingerprint-${jobId}`,
		status,
		createdAt: "2026-09-02T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:00.000Z",
		attempts: status === "queued" ? 0 : 1,
		lastAttemptAt: status === "queued" ? null : "2026-09-02T00:00:01.000Z",
		completedAt: status === "completed" ? "2026-09-02T00:00:02.000Z" : null,
		input: {
			projectId: "project-1",
			operationId: `export-${jobId}`,
			expectedRevision: 1,
			outputPath: `C:/exports/${jobId}.mp4`,
			format: "mp4",
			quality: "high",
			includeAudio: true,
		},
		result: status === "completed" ? { status: "exported" } : null,
		lastError: null,
	};
}
