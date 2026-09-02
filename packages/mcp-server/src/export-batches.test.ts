import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportBatchStore } from "./export-batch-store";
import { ExportBatchQueue } from "./export-batches";
import { ExportJobStore } from "./export-job-store";
import { ExportJobQueue, type PersistentExportJobBridge } from "./export-jobs";
import { expandExportBatch, type ExportBatchInput } from "./export-variants";

describe("platform export batches", () => {
	let directory: string;
	let jobs: ExportJobQueue;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-batch-test-"));
		jobs = new ExportJobQueue(
			fakeBridge(),
			{ export: async () => ({ status: "exported" }) },
			new ExportJobStore(join(directory, "jobs")),
			{ autoRun: false },
		);
	});

	afterEach(async () => {
		jobs.stop();
		await rm(directory, { recursive: true, force: true });
	});

	test("expands platform presets into independent canvas-safe exports", () => {
		const variants = expandExportBatch(batchInput(directory));

		expect(variants).toHaveLength(2);
		expect(variants[0]).toMatchObject({
			variantId: "vertical",
			preset: "tiktok_9_16",
			input: {
				canvasSize: { width: 1080, height: 1920 },
				fps: { numerator: 30, denominator: 1 },
				format: "mp4",
			},
		});
		expect(variants[1]).toMatchObject({
			variantId: "square",
			preset: "instagram_square_1_1",
			input: { canvasSize: { width: 1080, height: 1080 } },
		});
	});

	test("persists, replays, summarizes, and cancels a complete batch", async () => {
		const storeDirectory = join(directory, "batches");
		const batches = new ExportBatchQueue(
			jobs,
			new ExportBatchStore(storeDirectory),
		);
		const first = await batches.enqueue(batchInput(directory));

		expect(first.replayed).toBe(false);
		expect(first.summary).toMatchObject({
			status: "queued",
			counts: { queued: 2, missing: 0 },
		});
		expect(first.summary.jobs.map((job) => job?.input.canvasSize)).toEqual([
			{ width: 1080, height: 1920 },
			{ width: 1080, height: 1080 },
		]);

		const replayed = await new ExportBatchQueue(
			jobs,
			new ExportBatchStore(storeDirectory),
		).enqueue(batchInput(directory));
		expect(replayed.replayed).toBe(true);

		const cancelled = await batches.cancel("campaign-1");
		expect(cancelled).toMatchObject({
			status: "cancelled",
			counts: { cancelled: 2 },
		});
	});

	test("rejects duplicate outputs before creating durable jobs", () => {
		const input = batchInput(directory);
		input.variants[1]!.outputPath = input.variants[0]!.outputPath;
		expect(() => expandExportBatch(input)).toThrow(
			"duplicate export output path",
		);
	});
});

function batchInput(directory: string): ExportBatchInput {
	return {
		batchId: "campaign-1",
		projectId: "project-1",
		expectedRevision: 4,
		variants: [
			{
				variantId: "vertical",
				preset: "tiktok_9_16",
				outputPath: join(directory, "vertical.mp4"),
			},
			{
				variantId: "square",
				preset: "instagram_square_1_1",
				outputPath: join(directory, "square.mp4"),
			},
		],
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
