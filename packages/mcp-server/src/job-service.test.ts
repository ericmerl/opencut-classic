import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineJobMirror } from "./inline-jobs";
import { JobService, JobServiceError } from "./job-service";
import { JobStore, type JobRecord } from "./job-store";

describe("JobService", () => {
	let directory: string;
	let jobs: JobStore;
	let launched: string[];
	let exportCalls: string[];
	let inlineCancels: string[];
	let service: JobService;
	let mirror: InlineJobMirror;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-job-service-"));
		jobs = new JobStore(directory);
		await jobs.initialize();
		launched = [];
		exportCalls = [];
		inlineCancels = [];
		mirror = new InlineJobMirror(jobs);
		service = new JobService({
			jobs,
			exportJobs: {
				cancel: async (jobId) => {
					exportCalls.push(`cancel:${jobId}`);
					jobs.cancel(jobId, "export cancel");
					return {} as never;
				},
				retry: async (jobId, options) => {
					exportCalls.push(`retry:${jobId}`);
					jobs.retry(jobId, options);
					return {} as never;
				},
				resolve: async (jobId, resolution) => {
					exportCalls.push(`resolve:${jobId}:${resolution.kind}`);
					jobs.resolve(jobId, resolution);
					return {} as never;
				},
			},
			providers: {
				initialize: async () => undefined,
				launch: (jobId) => {
					launched.push(jobId);
				},
			},
			mirror,
			cancelInline: {
				"preview-range": async (record) => {
					inlineCancels.push(record.operationId);
				},
			},
		});
	});

	afterEach(async () => {
		jobs.close();
		await rm(directory, { recursive: true, force: true });
	});

	test("dispatches cancellation by job type and stays idempotent", async () => {
		jobs.submit(submission("export-1", "export"));
		jobs.submit(submission("range-1", "preview-range"));
		jobs.submit(submission("provider-1", "provider"));
		expect((await service.cancel("export-1", "x")).state).toBe("cancelled");
		expect(exportCalls).toEqual(["cancel:export-1"]);
		await mirror.start({
			jobId: "range-1",
			jobType: "preview-range",
			operationId: "op-range-1",
			semanticInputHash: "a".repeat(64),
			input: {},
		});
		expect((await service.cancel("range-1", "x")).state).toBe("cancelling");
		expect(inlineCancels).toEqual(["op-range-1"]);
		expect((await service.cancel("provider-1", "x")).state).toBe("cancelled");
		expect((await service.cancel("provider-1", "again")).state).toBe("cancelled");
		await expect(service.cancel("missing", "x")).rejects.toMatchObject({
			code: "JOB_NOT_FOUND",
		});
	});

	test("retries export and provider jobs and rejects inline retries", async () => {
		jobs.submit(submission("export-1", "export"));
		jobs.submit(submission("provider-1", "provider"));
		jobs.submit(submission("range-1", "preview-range"));
		for (const id of ["export-1", "provider-1", "range-1"]) {
			const claim = jobs.claim(id, "opencut-mcp:1:x")!;
			jobs.start(id, claim);
			jobs.fail(id, claim, { error: "boom" });
		}
		expect((await service.retry("export-1", { reason: "r", operationId: "op" })).state).toBe("queued");
		expect(exportCalls).toEqual(["retry:export-1"]);
		expect((await service.retry("provider-1", { reason: "r", operationId: "op" })).state).toBe("queued");
		expect(launched).toEqual(["provider-1"]);
		await expect(service.retry("range-1", { reason: "r", operationId: "op" })).rejects.toMatchObject({
			code: "JOB_RESOLUTION_UNSUPPORTED",
		});
		await expect(service.retry("export-1", { reason: "r", operationId: "op" })).rejects.toMatchObject({
			code: "JOB_ILLEGAL_TRANSITION",
		});
	});

	test("resolves recovery-required jobs per type", async () => {
		for (const [id, type] of [
			["export-1", "export"],
			["provider-1", "provider"],
			["range-1", "preview-range"],
		] as const) {
			jobs.submit(submission(id, type));
			const claim = jobs.claim(id, "opencut-mcp:999999:dead")!;
			jobs.start(id, claim);
		}
		await jobs.reconcileInterrupted({
			isAlive: () => false,
			reconcile: async () => ({
				kind: "recovery-required",
				code: "unknown-outcome",
				detail: "owner died",
			}),
		});
		expect(
			(await service.resolve("export-1", { kind: "rerun-as-new-attempt", reason: "r", operationId: "op" })).state,
		).toBe("queued");
		expect(exportCalls).toEqual(["resolve:export-1:rerun-as-new-attempt"]);
		expect(
			(await service.resolve("provider-1", { kind: "rerun-as-new-attempt", reason: "r", operationId: "op" })).state,
		).toBe("queued");
		expect(launched).toEqual(["provider-1"]);
		await expect(
			service.resolve("range-1", { kind: "rerun-as-new-attempt", reason: "r", operationId: "op" }),
		).rejects.toBeInstanceOf(JobServiceError);
		expect(
			(await service.resolve("range-1", { kind: "mark-failed", reason: "gave up", operationId: "op" })).state,
		).toBe("failed");
		expect(await service.summary()).toMatchObject({ depth: 2, counts: { failed: 1 } });
	});
});

function submission(jobId: string, jobType: JobRecord["jobType"]) {
	return {
		jobId,
		jobType,
		operationId: `op-${jobId}`,
		semanticInputHash: "a".repeat(64),
		input: {},
	};
}
