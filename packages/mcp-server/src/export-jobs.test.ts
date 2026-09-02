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

	test("starts a managed editor for queued work", async () => {
		let connected = false;
		const ensuredProjectIds: string[] = [];
		const bridge: PersistentExportJobBridge = {
			getStatus: () => ({ connected }),
			onConnectionChange: () => () => undefined,
			request: async () => ({ status: "opened", projectId: "project-1" }),
			exportTickets: {
				create: async (path) => ({ url: "http://fixture", outputPath: path }),
			},
		};
		const queue = new ExportJobQueue(
			bridge,
			{ export: async () => ({ status: "exported" }) },
			new ExportJobStore(directory),
			{
				autoRun: false,
				ensureEditor: async (projectId) => {
					ensuredProjectIds.push(projectId);
					connected = true;
				},
			},
		);
		await queue.enqueue({ jobId: "job-1", input: exportInput(directory) });

		const processed = await queue.runQueued(1);

		expect(ensuredProjectIds).toEqual(["project-1"]);
		expect(processed[0]).toMatchObject({ status: "completed" });
		queue.stop();
	});

	test("rebinds a durable v2 job only to a reconnect of the same editor", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const reconnectedIdentity = identity("editor-1", "session-2", 2);
		let openedWith: unknown;
		let exportedWith: unknown;
		const bridge = fakeBridge({
			connected: true,
			connectionIdentity: reconnectedIdentity,
			request: async (_method, _params, _timeout, expectedIdentity) => {
				openedWith = expectedIdentity;
				return { status: "opened", projectId: "project-1" };
			},
		});
		const queue = new ExportJobQueue(
			bridge,
			{
				export: async (input) => {
					exportedWith = input;
					return { status: "exported" };
				},
			},
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		await queue.enqueue({
			jobId: "job-affinity",
			input: {
				...exportInput(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: queuedIdentity,
			},
		});

		const [processed] = await queue.runQueued(1);

		expect(processed).toMatchObject({ status: "completed" });
		expect(openedWith).toEqual(reconnectedIdentity);
		expect(exportedWith).toMatchObject({
			expectedConnectionIdentity: reconnectedIdentity,
			requestConnectionIdentity: queuedIdentity,
		});
		queue.stop();
	});

	test("rejects a durable v2 job when another editor is connected", async () => {
		let requests = 0;
		const bridge = fakeBridge({
			connected: true,
			connectionIdentity: identity("editor-2", "session-2", 2),
			request: async () => {
				requests += 1;
				return {};
			},
		});
		const queue = new ExportJobQueue(
			bridge,
			{ export: async () => ({ status: "exported" }) },
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		await queue.enqueue({
			jobId: "job-other-editor",
			input: {
				...exportInput(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: identity("editor-1", "session-1", 1),
			},
		});

		const [processed] = await queue.runQueued(1);

		expect(processed).toMatchObject({
			status: "failed",
			lastError: expect.stringContaining("STALE_CONNECTION"),
		});
		expect(requests).toBe(0);
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
	connectionIdentity,
	request = async () => ({}),
}: {
	connected: boolean;
	connectionIdentity?: ReturnType<typeof identity>;
	request?: PersistentExportJobBridge["request"];
}): PersistentExportJobBridge {
	return {
		getStatus: () => ({ connected, connectionIdentity }),
		onConnectionChange: () => () => undefined,
		request,
		exportTickets: {
			create: async (path) => ({ url: "http://fixture", outputPath: path }),
		},
	};
}

function identity(
	editorInstanceId: string,
	editorSessionId: string,
	connectionGeneration: number,
) {
	return {
		serverInstanceId: "server-1",
		editorInstanceId,
		editorSessionId,
		connectionGeneration,
	};
}
