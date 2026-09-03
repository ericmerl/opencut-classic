import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportJobStore } from "./export-job-store";

describe("ExportJobStore", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-job-store-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("imports legacy append-versioned job files once and projects them", async () => {
		await mkdir(directory, { recursive: true });
		const key = createHash("sha256").update("job-legacy").digest("hex");
		const base = {
			schemaVersion: 1,
			jobId: "job-legacy",
			fingerprint: "legacy-fingerprint",
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:01.000Z",
			attempts: 1,
			lastAttemptAt: "2026-09-01T00:00:00.500Z",
			completedAt: null,
			input: {
				projectId: "project-1",
				operationId: "export-legacy",
				expectedRevision: 3,
				outputPath: join(directory, "legacy.mp4"),
				format: "mp4",
				quality: "high",
				includeAudio: true,
			},
			result: null,
			lastError: null,
		};
		await writeFile(
			join(directory, `${key}.000000000000.json`),
			JSON.stringify({ ...base, storeRevision: 0, status: "queued", attempts: 0 }),
		);
		await writeFile(
			join(directory, `${key}.000000000001.json`),
			JSON.stringify({ ...base, storeRevision: 1, status: "running" }),
		);
		const store = new ExportJobStore(directory);
		const imported = await store.get("job-legacy");
		expect(imported).toMatchObject({
			jobId: "job-legacy",
			fingerprint: "legacy-fingerprint",
			status: "queued",
			attempts: 1,
			lastAttemptAt: "2026-09-01T00:00:00.500Z",
			lastError: "MCP process stopped while the export job was running",
			input: { operationId: "export-legacy" },
			execution: {
				jobState: "queued",
				attemptHistory: [{ number: 1, outcome: null }],
			},
		});
		const again = new ExportJobStore(directory);
		expect((await again.list()).map((job) => job.jobId)).toEqual(["job-legacy"]);
		store.close();
		again.close();
	});

	test("seeds legacy records in a known state and replays identical seeds", async () => {
		const store = new ExportJobStore(directory);
		const record = {
			schemaVersion: 1 as const,
			jobId: "job-1",
			fingerprint: "fp",
			status: "completed" as const,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:02.000Z",
			attempts: 1,
			lastAttemptAt: "2026-09-01T00:00:01.000Z",
			completedAt: "2026-09-01T00:00:02.000Z",
			input: {
				projectId: "project-1",
				operationId: "export-1",
				expectedRevision: 1,
				outputPath: join(directory, "video.mp4"),
				format: "mp4" as const,
				quality: "high" as const,
				includeAudio: false,
			},
			result: { status: "exported" },
			lastError: null,
		};
		const created = await store.create(record);
		expect(created.replayed).toBe(false);
		expect(created.record).toMatchObject({
			status: "completed",
			storeRevision: 0,
			result: { status: "exported" },
			execution: { jobState: "succeeded", attemptHistory: [{ outcome: "succeeded" }] },
		});
		expect(await store.create(record)).toMatchObject({ replayed: true });
		await expect(store.create({ ...record, fingerprint: "other" })).rejects.toThrow(
			/different export job/,
		);
		await store.initialize();
		expect(store.jobs.history("job-1")).toHaveLength(1);
		store.close();
	});
});
