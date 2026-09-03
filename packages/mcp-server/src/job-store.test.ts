import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	JOB_HEARTBEAT_STALE_MS,
	JobStore,
	JobStoreError,
	jobOwnerIsLive,
	type JobRecord,
	type JobSubmission,
} from "./job-store";

describe("JobStore", () => {
	let directory: string;
	let store: JobStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-job-store-"));
		store = new JobStore(directory);
		await store.initialize();
	});

	afterEach(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});

	test("submits once, replays the same identity, and rejects changed input", () => {
		const first = store.submit(submission("job-1"));
		expect(first.replayed).toBe(false);
		expect(first.record).toMatchObject({
			state: "queued",
			attempt: 0,
			storeRevision: 0,
			jobType: "export",
			preconditions: { projectId: "project-1", contentHash: "a".repeat(64) },
		});
		expect(first.record.checksum).toMatch(/^[a-f0-9]{64}$/);
		const again = store.submit(submission("job-1"));
		expect(again).toEqual({ record: first.record, replayed: true });
		expect(() =>
			store.submit({ ...submission("job-1"), semanticInputHash: "b".repeat(64) }),
		).toThrow(JobStoreError);
		expect(store.history("job-1")).toHaveLength(1);
	});

	test("runs a job through claim, start, heartbeat, and success under the fence", () => {
		store.submit(submission("job-1"));
		const claim = store.claim("job-1", "opencut-mcp:1:owner");
		expect(claim?.record).toMatchObject({
			state: "starting",
			attempt: 1,
			lease: { ownerId: "opencut-mcp:1:owner" },
			attempts: [{ number: 1, outcome: null }],
		});
		const fence = { ownerId: claim!.ownerId, fencingToken: claim!.fencingToken };
		expect(store.claim("job-1", "opencut-mcp:2:other")).toBeNull();
		expect(store.start("job-1", fence, { phase: "rendering", total: 10 })).toMatchObject({
			state: "running",
			progress: { phase: "rendering", total: 10, completed: 0 },
		});
		expect(
			store.heartbeat("job-1", fence, {
				progress: { completed: 4 },
				checkpoint: { name: "frame", completed: 4, total: 10, metadata: null },
			}),
		).toMatchObject({ progress: { completed: 4 }, checkpoints: [{ name: "frame" }] });
		expect(() =>
			store.heartbeat("job-1", { ownerId: fence.ownerId, fencingToken: "stale" }),
		).toThrow(/lease is not held/);
		const done = store.succeed("job-1", fence, {
			result: { status: "exported" },
			artifacts: [
				{
					kind: "export-output",
					path: "C:/out.mp4",
					sha256: "c".repeat(64),
					bytes: 10,
					disposition: "final",
					recordedAt: new Date().toISOString(),
				},
			],
		});
		expect(done).toMatchObject({
			state: "succeeded",
			lease: null,
			result: { status: "exported" },
			progress: { phase: "complete", completed: 10 },
			attempts: [{ number: 1, outcome: "succeeded" }],
		});
		expect(done.completedAt).not.toBeNull();
		expect(store.history("job-1").map((entry) => entry.state)).toEqual([
			"queued",
			"starting",
			"running",
			"running",
			"succeeded",
		]);
	});

	test("cancels queued jobs immediately and running jobs through cancelling", () => {
		store.submit(submission("queued"));
		expect(store.cancel("queued", "operator")).toMatchObject({
			state: "cancelled",
			cancellationObservedAt: expect.any(String),
			attempts: [],
		});
		expect(store.cancel("queued", "again")).toMatchObject({ state: "cancelled" });

		store.submit(submission("running"));
		const claim = store.claim("running", "opencut-mcp:1:owner")!;
		const fence = { ownerId: claim.ownerId, fencingToken: claim.fencingToken };
		store.start("running", fence);
		expect(store.cancel("running", "operator")).toMatchObject({
			state: "cancelling",
			cancellationRequestedAt: expect.any(String),
			cancellationObservedAt: null,
		});
		expect(store.heartbeat("running", fence)).toMatchObject({
			state: "cancelling",
			cancellationObservedAt: expect.any(String),
		});
		expect(
			store.confirmCancelled("running", fence, { reason: "renderer stopped" }),
		).toMatchObject({
			state: "cancelled",
			lease: null,
			attempts: [{ number: 1, outcome: "cancelled", error: "renderer stopped" }],
		});
		expect(() => store.succeed("running", fence, { result: null })).toThrow(
			JobStoreError,
		);
	});

	test("retries failed jobs within policy and preserves attempt history", () => {
		store.submit({
			...submission("job-1"),
			attemptPolicy: { maximumAttempts: 2 },
		});
		const first = store.claim("job-1", "opencut-mcp:1:owner")!;
		store.start("job-1", first);
		store.fail("job-1", first, { error: "boom", errorClass: "renderer-failed" });
		expect(store.get("job-1")).toMatchObject({
			state: "failed",
			diagnostics: [{ code: "renderer-failed" }],
		});
		const retried = store.retry("job-1", { reason: "operator", operationId: "op-retry" });
		expect(retried).toMatchObject({
			state: "queued",
			attempt: 1,
			lastError: null,
			attempts: [
				{ number: 1, outcome: "failed", resolution: { kind: "retry", operationId: "op-retry" } },
			],
		});
		const second = store.claim("job-1", "opencut-mcp:1:owner")!;
		store.start("job-1", second);
		store.fail("job-1", second, { error: "boom again" });
		expect(() => store.retry("job-1", { reason: "x", operationId: null })).toThrow(
			/attempts/,
		);
		expect(store.get("job-1")!.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
	});

	test("releases interrupted work back to the queue unless cancellation was requested", () => {
		store.submit(submission("job-1"));
		const claim = store.claim("job-1", "opencut-mcp:1:owner")!;
		expect(store.release("job-1", claim, "editor disconnected")).toMatchObject({
			state: "queued",
			attempts: [{ number: 1, outcome: "interrupted" }],
		});
		const again = store.claim("job-1", "opencut-mcp:1:owner")!;
		store.start("job-1", again);
		store.cancel("job-1", "operator");
		expect(store.release("job-1", again, "editor disconnected")).toMatchObject({
			state: "cancelled",
		});
	});

	test("reconciles dead owners through the caller's outcome and leaves live owners alone", async () => {
		for (const id of ["stale", "live", "recover", "done"]) store.submit(submission(id));
		const owners = new Map<string, ReturnType<JobStore["claim"]>>();
		for (const id of ["stale", "live", "recover", "done"]) {
			const claim = store.claim(id, `opencut-mcp:${id === "live" ? 4242 : 99999}:x`)!;
			store.start(id, claim);
			owners.set(id, claim);
		}
		const outcomes: string[] = [];
		const reconciled = await store.reconcileInterrupted({
			isAlive: (pid) => pid === 4242,
			reconcile: async (record) => {
				outcomes.push(record.jobId);
				if (record.jobId === "recover") {
					return {
						kind: "recovery-required",
						code: "partial-artifact",
						detail: "output exists without receipt",
						artifacts: [
							{
								kind: "export-output",
								path: "C:/partial.mp4",
								sha256: null,
								bytes: 3,
								disposition: "partial-retained",
								recordedAt: new Date().toISOString(),
							},
						],
					};
				}
				if (record.jobId === "done") {
					return { kind: "succeeded", result: { status: "exported" } };
				}
				return { kind: "requeue", reason: "process stopped" };
			},
		});
		expect(outcomes.sort()).toEqual(["done", "recover", "stale"]);
		expect(reconciled.map((record) => [record.jobId, record.state]).sort()).toEqual([
			["done", "succeeded"],
			["recover", "recovery-required"],
			["stale", "queued"],
		]);
		expect(store.get("live")).toMatchObject({ state: "running" });
		expect(store.get("recover")).toMatchObject({
			attempts: [{ outcome: "unknown" }],
			diagnostics: [{ code: "partial-artifact" }],
			artifacts: [{ disposition: "partial-retained" }],
		});
		expect(store.get("stale")).toMatchObject({
			attempts: [{ outcome: "interrupted" }],
			lease: null,
		});
	});

	test("treats a live PID with a stale heartbeat as dead and a fresh heartbeat with an expired lease as live", () => {
		const now = Date.now();
		const base = {
			lease: {
				ownerId: `opencut-mcp:${process.pid}:x`,
				fencingToken: "t",
				expiresAt: new Date(now - 1).toISOString(),
			},
		};
		expect(
			jobOwnerIsLive({ ...base, heartbeatAt: new Date(now - 1000).toISOString() }, now),
		).toBe(true);
		expect(
			jobOwnerIsLive(
				{ ...base, heartbeatAt: new Date(now - JOB_HEARTBEAT_STALE_MS - 1).toISOString() },
				now,
			),
		).toBe(false);
		expect(
			jobOwnerIsLive(
				{
					lease: { ...base.lease, ownerId: "opencut-mcp:999999:x" },
					heartbeatAt: new Date(now).toISOString(),
				},
				now,
				() => false,
			),
		).toBe(false);
	});

	test("resolves recovery-required jobs as a rerun or as failed while keeping history", () => {
		store.submit(submission("rerun"));
		store.submit(submission("dead"));
		for (const id of ["rerun", "dead"]) {
			const claim = store.claim(id, "opencut-mcp:99999:x")!;
			store.start(id, claim);
		}
		return store
			.reconcileInterrupted({
				isAlive: () => false,
				reconcile: async () => ({
					kind: "recovery-required",
					code: "unknown-outcome",
					detail: "worker died",
				}),
			})
			.then(() => {
				const rerun = store.resolve("rerun", {
					kind: "rerun-as-new-attempt",
					reason: "operator",
					operationId: "op-1",
				});
				expect(rerun).toMatchObject({
					state: "queued",
					attempt: 1,
					attempts: [
						{
							number: 1,
							outcome: "unknown",
							resolution: { kind: "rerun-as-new-attempt", operationId: "op-1" },
						},
					],
				});
				expect(store.claim("rerun", "opencut-mcp:1:y")?.record.attempt).toBe(2);
				const dead = store.resolve("dead", {
					kind: "mark-failed",
					reason: "operator gave up",
					operationId: null,
				});
				expect(dead).toMatchObject({
					state: "failed",
					lastError: "operator gave up",
					attempts: [{ resolution: { kind: "mark-failed" } }],
				});
				expect(() =>
					store.resolve("dead", { kind: "mark-failed", reason: "x", operationId: null }),
				).toThrow(JobStoreError);
			});
	});

	test("orders the queue by priority then age and reports queue depth", () => {
		store.submit({ ...submission("old-normal"), createdAt: "2026-01-01T00:00:00.000Z" });
		store.submit({ ...submission("new-high"), priority: "high", createdAt: "2026-01-02T00:00:00.000Z" });
		store.submit({ ...submission("future"), scheduledFor: "2999-01-01T00:00:00.000Z" });
		expect(store.nextQueued()?.jobId).toBe("new-high");
		expect(store.nextQueued(["provider"])).toBeNull();
		const summary = store.summary();
		expect(summary).toMatchObject({
			depth: 3,
			running: null,
			counts: { queued: 3 },
			byType: { export: { queued: 3, active: 0 } },
			recoveryRequired: [],
		});
		const claim = store.claim("new-high", "opencut-mcp:1:x")!;
		store.start("new-high", claim);
		expect(store.summary()).toMatchObject({
			depth: 2,
			running: { jobId: "new-high", state: "running" },
			byType: { export: { queued: 2, active: 1 } },
		});
	});

	test("rejects illegal transitions, terminal mutation, and tampered rows", async () => {
		store.submit(submission("job-1"));
		store.submit(submission("job-2"));
		expect(() =>
			store.resolve("job-1", { kind: "mark-failed", reason: "x", operationId: null }),
		).toThrow(/cannot move/);
		store.cancel("job-1", "operator");
		const database = new Database(store.databasePath, { strict: true });
		expect(() =>
			database
				.query("UPDATE jobs SET state = 'queued', store_revision = store_revision + 1 WHERE job_id = ?")
				.run("job-1"),
		).toThrow(/immutable/);
		expect(() => database.query("DELETE FROM job_history").run()).toThrow(/append-only/);
		database
			.query(
				"UPDATE jobs SET record_json = replace(record_json, '\"queued\"', '\"running\"'), store_revision = store_revision + 1 WHERE job_id = ?",
			)
			.run("job-2");
		database.close();
		expect(() => store.get("job-2")).toThrow(/malformed|checksum/);
		await expect(new JobStore(directory).initialize()).rejects.toThrow(
			/malformed|checksum/,
		);
	});

	test("serializes two store instances contending on the same job", async () => {
		store.submit(submission("job-1"));
		const other = new JobStore(directory);
		await other.initialize();
		try {
			const claims = [
				store.claim("job-1", "opencut-mcp:1:a"),
				other.claim("job-1", "opencut-mcp:1:b"),
			];
			expect(claims.filter(Boolean)).toHaveLength(1);
			const winner = claims.find(Boolean)!;
			const loser = claims[0] ? other : store;
			expect(() =>
				loser.start("job-1", { ownerId: "opencut-mcp:1:z", fencingToken: "no" }),
			).toThrow(/lease is not held/);
			expect((claims[0] ? store : other).start("job-1", winner)).toMatchObject({
				state: "running",
			});
			expect(other.get("job-1")?.state).toBe("running");
		} finally {
			other.close();
		}
	});

	test("refuses an unsupported schema version", async () => {
		store.close();
		const database = new Database(join(directory, "jobs.sqlite"), { strict: true });
		database.query("UPDATE job_store_metadata SET value = '99' WHERE key = 'schema_version'").run();
		database.close();
		await expect(new JobStore(directory).initialize()).rejects.toThrow(/schema 99/);
		store = new JobStore(await mkdtemp(join(tmpdir(), "opencut-job-store-")));
		await store.initialize();
	});
});

function submission(jobId: string): JobSubmission {
	return {
		jobId,
		jobType: "export",
		operationId: `op-${jobId}`,
		semanticInputHash: "a".repeat(64),
		preconditions: { projectId: "project-1", contentHash: "a".repeat(64) },
		input: { projectId: "project-1", outputPath: "C:/out.mp4" },
	};
}

export type { JobRecord };
