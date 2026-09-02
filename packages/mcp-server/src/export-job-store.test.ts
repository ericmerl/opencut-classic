import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportJobStore } from "./export-job-store";

describe("ExportJobStore", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-jobs-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("persists append-only job revisions across store instances", async () => {
		const store = new ExportJobStore(directory);
		const createdAt = "2026-09-01T00:00:00.000Z";
		const created = await store.create({
			schemaVersion: 1,
			jobId: "job-1",
			fingerprint: "fingerprint-1",
			status: "queued",
			createdAt,
			updatedAt: createdAt,
			attempts: 0,
			lastAttemptAt: null,
			completedAt: null,
			input: {
				projectId: "project-1",
				operationId: "export-1",
				expectedRevision: 3,
				outputPath: join(directory, "video.mp4"),
				format: "mp4",
				quality: "high",
				includeAudio: true,
			},
			result: null,
			lastError: null,
		});
		expect(created).toMatchObject({
			replayed: false,
			record: { storeRevision: 0 },
		});

		await store.update("job-1", (current) => ({
			...current,
			status: "running",
			attempts: 1,
			lastAttemptAt: "2026-09-01T00:01:00.000Z",
		}));

		const reloaded = await new ExportJobStore(directory).get("job-1");
		expect(reloaded).toMatchObject({
			jobId: "job-1",
			status: "running",
			storeRevision: 1,
			attempts: 1,
		});

		const recovered = await new ExportJobStore(directory).recoverInterrupted();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({
			status: "queued",
			storeRevision: 2,
			attempts: 1,
			lastError: "MCP process stopped while the export job was running",
		});
	});
});
