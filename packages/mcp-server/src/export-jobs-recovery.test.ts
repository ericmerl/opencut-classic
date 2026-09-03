import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportJobStore } from "./export-job-store";
import {
	ExportJobQueue,
	type PersistentExportJobBridge,
	type PersistentExportProjectService,
} from "./export-jobs";
import { ExportTickets } from "./export-tickets";

/**
 * Fault cases from spec 24.2 for jobs: export process death with a partial
 * upload, interrupted runs without artifacts, running cancellation through the
 * export ticket, and lease owners whose PID is reused by another process.
 */
describe("export job recovery and cancellation", () => {
	let directory: string;
	const queues: ExportJobQueue[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-recovery-"));
	});

	afterEach(async () => {
		for (const queue of queues.splice(0)) queue.stop();
		await rm(directory, { recursive: true, force: true });
	});

	test("a dead owner with an output file but no receipt enters recovery-required, and a rerun quarantines the file", async () => {
		const store = new ExportJobStore(join(directory, "jobs"));
		const outputPath = join(directory, "video.mp4");
		const queue = trackedQueue(
			new ExportJobQueue(
				fakeBridge({ connected: false }),
				{ export: async () => ({ status: "exported" }) },
				store,
				{ autoRun: false, receipts: { get: async () => null } },
			),
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(outputPath) });
		// Simulate an MCP process that claimed the job, started rendering, wrote a
		// partial output, and died: the owner PID is dead and the heartbeat stale.
		const claim = store.jobs.claim("job-1", "opencut-mcp:999999:dead")!;
		store.jobs.start("job-1", claim, { phase: "rendering" });
		await writeFile(outputPath, "partial mp4 bytes");
		await new Promise((resolve) => setTimeout(resolve, 5));

		const recovered = await queue.reconcileInterrupted();
		expect(recovered.map((record) => record.status)).toEqual(["recovery-required"]);
		const job = (await queue.get("job-1"))!;
		expect(job).toMatchObject({
			status: "recovery-required",
			execution: {
				jobState: "recovery-required",
				attemptHistory: [{ number: 1, outcome: "unknown" }],
				diagnostics: [{ code: "partial-artifact" }],
				artifacts: [{ path: outputPath, disposition: "partial-retained", bytes: 17 }],
			},
		});
		expect(await queue.list({ statuses: ["recovery-required"], limit: 10 })).toHaveLength(1);

		const rerun = await queue.resolve("job-1", {
			kind: "rerun-as-new-attempt",
			reason: "operator",
			operationId: "op-rerun",
		});
		expect(rerun).toMatchObject({
			status: "queued",
			execution: {
				attemptHistory: [
					{ number: 1, resolution: { kind: "rerun-as-new-attempt", operationId: "op-rerun" } },
				],
				artifacts: [
					{ disposition: "partial-retained" },
					{ path: `${outputPath}.attempt1.partial`, disposition: "quarantined" },
				],
			},
		});
		expect(await stat(outputPath).catch(() => null)).toBeNull();
		expect(await readFile(`${outputPath}.attempt1.partial`, "utf8")).toBe(
			"partial mp4 bytes",
		);
	});

	test("a dead owner whose receipt was written is terminalized without rerendering", async () => {
		const store = new ExportJobStore(join(directory, "jobs"));
		let exports = 0;
		const queue = trackedQueue(
			new ExportJobQueue(
				fakeBridge({ connected: false }),
				{
					export: async () => {
						exports += 1;
						return { status: "exported" };
					},
				},
				store,
				{
					autoRun: false,
					receipts: {
						get: async (operationId) =>
							operationId === "export-1"
								? { result: { status: "exported", outputPath: join(directory, "v.mp4"), sha256: "b".repeat(64), bytesWritten: 12 } }
								: null,
					},
				},
			),
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(join(directory, "v.mp4")) });
		const claim = store.jobs.claim("job-1", "opencut-mcp:999999:dead")!;
		store.jobs.start("job-1", claim);
		const recovered = await queue.reconcileInterrupted();
		expect(recovered.map((job) => job.status)).toEqual(["completed"]);
		expect(await queue.get("job-1")).toMatchObject({
			status: "completed",
			result: { status: "exported" },
			execution: { artifacts: [{ sha256: "b".repeat(64), disposition: "final" }] },
		});
		expect(exports).toBe(0);
	});

	test("a dead owner without artifacts is requeued as an interrupted attempt until the policy is exhausted", async () => {
		const store = new ExportJobStore(join(directory, "jobs"));
		const queue = trackedQueue(
			new ExportJobQueue(
				fakeBridge({ connected: false }),
				{ export: async () => ({ status: "exported" }) },
				store,
				{ autoRun: false, receipts: { get: async () => null }, maximumAttempts: 2 },
			),
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(join(directory, "v.mp4")) });
		for (const attempt of [1, 2]) {
			const claim = store.jobs.claim("job-1", `opencut-mcp:999999:dead-${attempt}`)!;
			store.jobs.start("job-1", claim);
			await queue.reconcileInterrupted();
		}
		expect(await queue.get("job-1")).toMatchObject({
			status: "failed",
			attempts: 2,
			execution: {
				attemptHistory: [
					{ number: 1, outcome: "interrupted" },
					{ number: 2, outcome: "failed" },
				],
			},
		});
		expect(await queue.retry("job-1", { reason: "x", operationId: null }).catch((error: Error) => error.message)).toMatch(/attempts/);
	});

	test("a live owner with a fresh heartbeat is left alone even after its lease expired", async () => {
		const store = new ExportJobStore(join(directory, "jobs"));
		const queue = trackedQueue(
			new ExportJobQueue(
				fakeBridge({ connected: false }),
				{ export: async () => ({ status: "exported" }) },
				store,
				{ autoRun: false, receipts: { get: async () => null } },
			),
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(join(directory, "v.mp4")) });
		const claim = store.jobs.claim("job-1", `opencut-mcp:${process.pid}:live`, {
			leaseMs: 1,
		})!;
		store.jobs.start("job-1", claim);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(await queue.reconcileInterrupted()).toEqual([]);
		expect(await queue.get("job-1")).toMatchObject({ status: "running" });
	});

	test("cancelling a running export reaches the renderer through the ticket status and records the observation", async () => {
		const store = new ExportJobStore(join(directory, "jobs"));
		const tickets = new ExportTickets(1);
		let statusUrl = "";
		const queue = trackedQueue(
			new ExportJobQueue(
				fakeBridge({
					connected: true,
					request: async () => ({ status: "opened", projectId: "project-1" }),
					tickets,
				}),
				{
					export: async (input, options) => {
						const ticket = await tickets.create(input.outputPath, input.format, {
							cancellationRequested: options?.cancellationRequested,
						});
						statusUrl = ticket.url;
						const id = ticket.url.split("/").at(-1)!;
						expect(tickets.status(id)).toEqual({ status: "active", cancellationRequested: false });
						// The MCP-side cancel lands while the renderer is busy.
						await queue.cancel("job-1");
						expect(tickets.status(id)).toEqual({ status: "active", cancellationRequested: true });
						options?.onPhase?.("validating");
						return { status: "rejected", reason: "export was cancelled" };
					},
				} satisfies PersistentExportProjectService,
				store,
				{ autoRun: false, receipts: { get: async () => null } },
			),
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(join(directory, "v.mp4")) });
		const processed = await queue.runQueued(1);
		expect(statusUrl).toMatch(/^http:\/\/127\.0\.0\.1:1\/export\//);
		expect(processed).toHaveLength(1);
		expect(processed[0]).toMatchObject({
			status: "cancelled",
			execution: {
				jobState: "cancelled",
				cancellationRequestedAt: expect.any(String),
				cancellationObservedAt: expect.any(String),
				attemptHistory: [{ number: 1, outcome: "cancelled" }],
			},
		});
		expect(await stat(join(directory, "v.mp4")).catch(() => null)).toBeNull();
		// Cancellation is idempotent on a terminal job.
		expect(await queue.cancel("job-1")).toMatchObject({ status: "cancelled" });
	});

	test("cancelling a queued export finishes immediately and cancel remains idempotent", async () => {
		const store = new ExportJobStore(join(directory, "jobs"));
		const queue = trackedQueue(
			new ExportJobQueue(
				fakeBridge({ connected: false }),
				{ export: async () => ({ status: "exported" }) },
				store,
				{ autoRun: false },
			),
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(join(directory, "v.mp4")) });
		expect(await queue.cancel("job-1")).toMatchObject({ status: "cancelled", attempts: 0 });
		expect(await queue.cancel("job-1")).toMatchObject({ status: "cancelled" });
		await expect(queue.cancel("missing")).rejects.toThrow(/not found/);
	});

	function trackedQueue(queue: ExportJobQueue): ExportJobQueue {
		queues.push(queue);
		return queue;
	}
});

function exportInput(outputPath: string) {
	return {
		projectId: "project-1",
		operationId: "export-1",
		expectedRevision: 3,
		outputPath,
		format: "mp4" as const,
		quality: "high" as const,
		includeAudio: true,
	};
}

function fakeBridge({
	connected,
	request = async () => ({}),
	tickets,
}: {
	connected: boolean;
	request?: PersistentExportJobBridge["request"];
	tickets?: ExportTickets;
}): PersistentExportJobBridge {
	return {
		getStatus: () => ({ connected, connectionIdentity: null }),
		onConnectionChange: () => () => undefined,
		request,
		exportTickets: tickets ?? {
			create: async (path) => ({ url: "http://fixture", outputPath: path }),
		},
	};
}
