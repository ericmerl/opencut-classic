import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportJobStore } from "./export-job-store";
import {
	ExportJobQueue,
	type PersistentExportJobBridge,
	type PersistentExportProjectService,
} from "./export-jobs";

describe("ExportJobQueue", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-queue-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("opens the project and completes a durable queued export", async () => {
		const methods: string[] = [];
		const bridge = fakeBridge({
			connected: true,
			request: async (method) => {
				methods.push(method);
				return { status: "opened", projectId: "project-1" };
			},
		});
		const exporter = {
			async export() {
				return { status: "exported", sha256: "a".repeat(64) };
			},
		} satisfies PersistentExportProjectService;
		const queue = new ExportJobQueue(
			bridge,
			exporter,
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(directory) });
		const processed = await queue.runQueued(1);

		expect(methods).toEqual(["open_project"]);
		expect(processed).toHaveLength(1);
		expect(processed[0]).toMatchObject({
			status: "completed",
			attempts: 1,
			result: { status: "exported" },
		});
		expect(await new ExportJobStore(directory).get("job-1")).toMatchObject({
			status: "completed",
			storeRevision: 2,
		});
		queue.stop();
	});

	test("leaves work queued while no editor worker is connected", async () => {
		const bridge = fakeBridge({ connected: false });
		const queue = new ExportJobQueue(
			bridge,
			{ export: async () => ({ status: "exported" }) },
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(directory) });

		expect(await queue.runQueued(1)).toEqual([]);
		expect(await queue.get("job-1")).toMatchObject({ status: "queued" });
		queue.stop();
	});
});

function exportInput(directory: string) {
	return {
		projectId: "project-1",
		operationId: "export-1",
		expectedRevision: 3,
		outputPath: join(directory, "video.mp4"),
		format: "mp4" as const,
		quality: "high" as const,
		includeAudio: true,
	};
}

function fakeBridge({
	connected,
	request = async () => ({}),
}: {
	connected: boolean;
	request?: PersistentExportJobBridge["request"];
}): PersistentExportJobBridge {
	return {
		getStatus: () => ({ connected }),
		onConnectionChange: () => () => undefined,
		request,
		exportTickets: {
			create: async (path) => ({ url: "http://fixture", outputPath: path }),
		},
	};
}
