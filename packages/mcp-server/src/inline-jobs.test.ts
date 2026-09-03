import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineJobMirror } from "./inline-jobs";
import { JobStore } from "./job-store";

describe("InlineJobMirror", () => {
	let directory: string;
	let jobs: JobStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-inline-jobs-"));
		jobs = new JobStore(directory);
		await jobs.initialize();
	});

	afterEach(async () => {
		jobs.close();
		await rm(directory, { recursive: true, force: true });
	});

	test("mirrors inline work as running rows and finishes them under its own fence", async () => {
		const mirror = new InlineJobMirror(jobs);
		const started = await mirror.start({
			jobId: "preview-range:op-1",
			jobType: "preview-range",
			operationId: "op-1",
			semanticInputHash: "a".repeat(64),
			input: { range: {} },
			progressUnits: "frames",
			total: 10,
			phase: "rendering",
		});
		expect(started).toMatchObject({
			state: "running",
			progress: { units: "frames", phase: "rendering", total: 10 },
			lease: { ownerId: mirror.ownerId },
		});
		await mirror.progress("preview-range:op-1", { completed: 4 });
		expect(jobs.get("preview-range:op-1")).toMatchObject({ progress: { completed: 4 } });
		await mirror.succeed("preview-range:op-1", { receiptId: "r" });
		expect(jobs.get("preview-range:op-1")).toMatchObject({
			state: "succeeded",
			result: { receiptId: "r" },
			lease: null,
		});
		// A second start for the same id is a no-op that does not throw.
		expect(
			await mirror.start({
				jobId: "preview-range:op-1",
				jobType: "preview-range",
				operationId: "op-1",
				semanticInputHash: "a".repeat(64),
				input: {},
			}),
		).toBeNull();
	});

	test("records cancellation requests and confirms them, and never throws into the caller", async () => {
		const mirror = new InlineJobMirror(jobs);
		await mirror.start({
			jobId: "comparison:op-2",
			jobType: "comparison",
			operationId: "op-2",
			semanticInputHash: "b".repeat(64),
			input: {},
		});
		expect((await mirror.cancelRequest("comparison:op-2", "operator"))?.state).toBe(
			"cancelling",
		);
		await mirror.cancelled("comparison:op-2", "renderer stopped");
		expect(jobs.get("comparison:op-2")).toMatchObject({
			state: "cancelled",
			cancellationObservedAt: expect.any(String),
		});
		await expect(mirror.fail("comparison:op-2", "late failure")).resolves.toBeUndefined();
		expect(await mirror.cancelRequest("missing", "x")).toBeNull();
	});

	test("fails inline rows left running by a dead owner and reports them to the caller", async () => {
		const dead = new InlineJobMirror(jobs, { ownerId: "opencut-mcp:999999:dead" });
		await dead.start({
			jobId: "transcription:op-3",
			jobType: "transcription",
			operationId: "op-3",
			semanticInputHash: "c".repeat(64),
			input: {},
		});
		jobs.submit({
			jobId: "provider:x:op-4",
			jobType: "provider",
			operationId: "op-4",
			semanticInputHash: "d".repeat(64),
			input: {},
		});
		const claim = jobs.claim("provider:x:op-4", "opencut-mcp:999999:dead")!;
		jobs.start("provider:x:op-4", claim);
		const fresh = new InlineJobMirror(jobs);
		const interrupted: string[] = [];
		const reconciled = await fresh.reconcileInterrupted(async (record) => {
			interrupted.push(record.operationId);
		});
		expect(interrupted).toEqual(["op-3"]);
		expect(reconciled.map((record) => [record.jobId, record.state])).toEqual([
			["transcription:op-3", "failed"],
		]);
		expect(jobs.get("provider:x:op-4")).toMatchObject({ state: "recovery-required" });
	});
});
