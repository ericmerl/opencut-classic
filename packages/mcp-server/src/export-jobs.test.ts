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
import { stableSerialize } from "./matte-generation-data";

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
		const persisted = await new ExportJobStore(directory).get("job-1");
		expect(persisted).toMatchObject({
			status: "completed",
			execution: {
				jobState: "succeeded",
				attemptHistory: [{ number: 1, outcome: "succeeded" }],
				artifacts: [],
			},
		});
		expect(persisted!.storeRevision).toBeGreaterThanOrEqual(2);
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
		const queueBridge = fakeBridge({
			connected: true,
			connectionIdentity: queuedIdentity,
			request: async (method) => {
				expect(method).toBe("save_project");
				return persistedProjectState("d", 7);
			},
		});
		const firstQueue = new ExportJobQueue(
			queueBridge,
			{ export: async () => ({ status: "unexpected" }) },
			new ExportJobStore(directory),
			{
				autoRun: false,
				capabilitySnapshotHash: async () => "c".repeat(64),
			},
		);
		const queued = await firstQueue.enqueue({
			jobId: "job-affinity",
			input: {
				...exportInput(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: queuedIdentity,
				expectedProjectContentHash: "d".repeat(64),
			},
		});
		expect(queued.job.input.queuedProjectPersistence).toEqual({
			contentHash: "d".repeat(64),
			contentHashProjectionVersion: 2,
			writeVersion: 7,
		});
		expect(queued.job.input.capabilitySnapshotHash).toBe("c".repeat(64));
		firstQueue.stop();

		let openedWith: unknown;
		let exportedWith: unknown;
		const methods: string[] = [];
		const bridge = fakeBridge({
			connected: true,
			connectionIdentity: reconnectedIdentity,
			request: async (method, _params, _timeout, expectedIdentity) => {
				methods.push(method);
				openedWith = expectedIdentity;
				return method === "open_project"
					? {
							status: "opened",
							projectId: "project-1",
							revision: 0,
							snapshot: { contentIdentity: hashedContentIdentity("d") },
						}
					: persistedProjectState("d", 7);
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
		const replayed = await queue.enqueue({
			jobId: "job-affinity",
			input: {
				...exportInput(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: reconnectedIdentity,
				expectedProjectContentHash: "d".repeat(64),
			},
		});
		expect(replayed.replayed).toBe(true);
		expect(replayed.job.input.expectedConnectionIdentity).toEqual(
			queuedIdentity,
		);
		expect(methods).toEqual([]);
		const [processed] = await queue.runQueued(1);

		expect(processed).toMatchObject({ status: "completed" });
		expect(methods).toEqual(["open_project", "save_project"]);
		expect(openedWith).toEqual(reconnectedIdentity);
		expect(exportedWith).toMatchObject({
			expectedRevision: 0,
			expectedConnectionIdentity: reconnectedIdentity,
			requestConnectionIdentity: queuedIdentity,
			capabilitySnapshotHash: "c".repeat(64),
		});
		queue.stop();
	});

	test("migrates a legacy durable v2 job fingerprint on reconnect", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const reconnectedIdentity = identity("editor-1", "session-2", 2);
		const legacyInput = {
			...exportInput(directory),
			bridgeProtocolVersion: 2 as const,
			expectedConnectionIdentity: queuedIdentity,
			expectedProjectContentHash: "d".repeat(64),
		};
		const store = new ExportJobStore(directory);
		const timestamp = new Date().toISOString();
		await store.create({
			schemaVersion: 1,
			jobId: "job-legacy-fingerprint",
			fingerprint: stableSerialize(legacyInput),
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
			attempts: 0,
			lastAttemptAt: null,
			completedAt: null,
			input: legacyInput,
			result: null,
			lastError: null,
		});
		let requests = 0;
		const queue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: reconnectedIdentity,
				request: async () => {
					requests += 1;
					return persistedProjectState("d", 7);
				},
			}),
			{ export: async () => ({ status: "unexpected" }) },
			store,
			{ autoRun: false },
		);

		const replayed = await queue.enqueue({
			jobId: "job-legacy-fingerprint",
			input: {
				...legacyInput,
				expectedConnectionIdentity: reconnectedIdentity,
			},
		});

		expect(replayed.replayed).toBe(true);
		expect(requests).toBe(1);
		expect(replayed.job.input).toMatchObject({
			expectedConnectionIdentity: queuedIdentity,
			queuedProjectPersistence: {
				contentHash: "d".repeat(64),
				contentHashProjectionVersion: 2,
				writeVersion: 7,
			},
		});
		queue.stop();
	});

	test("migrates a legacy durable v2 job before startup auto-run", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const reconnectedIdentity = identity("editor-1", "session-2", 2);
		const legacyInput = {
			...exportInput(directory),
			bridgeProtocolVersion: 2 as const,
			expectedConnectionIdentity: queuedIdentity,
			expectedProjectContentHash: "d".repeat(64),
		};
		const store = new ExportJobStore(directory);
		const timestamp = new Date().toISOString();
		await store.create({
			schemaVersion: 1,
			jobId: "job-legacy-startup",
			fingerprint: stableSerialize(legacyInput),
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
			attempts: 0,
			lastAttemptAt: null,
			completedAt: null,
			input: legacyInput,
			result: null,
			lastError: null,
		});
		const methods: string[] = [];
		let resolveExported!: () => void;
		const exported = new Promise<void>((resolve) => {
			resolveExported = resolve;
		});
		const queue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: reconnectedIdentity,
				request: async (method) => {
					methods.push(method);
					return method === "open_project"
						? {
								status: "opened",
								projectId: "project-1",
								revision: 0,
								snapshot: {
									contentIdentity: hashedContentIdentity("d"),
								},
							}
						: persistedProjectState("d", 7);
				},
			}),
			{
				export: async () => {
					resolveExported();
					return { status: "exported" };
				},
			},
			store,
		);

		await exported;
		let completed = await store.get("job-legacy-startup");
		for (
			let attempt = 0;
			completed?.status !== "completed" && attempt < 20;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			completed = await store.get("job-legacy-startup");
		}

		expect(methods).toEqual(["save_project", "open_project", "save_project"]);
		expect(completed).toMatchObject({
			status: "completed",
			input: {
				queuedProjectPersistence: {
					contentHash: "d".repeat(64),
					contentHashProjectionVersion: 2,
					writeVersion: 7,
				},
			},
		});
		queue.stop();
	});

	test("replays a completed legacy durable v2 job while offline", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const replayIdentity = identity("editor-1", "session-2", 2);
		const legacyInput = {
			...exportInput(directory),
			bridgeProtocolVersion: 2 as const,
			expectedConnectionIdentity: queuedIdentity,
			expectedProjectContentHash: "d".repeat(64),
		};
		const store = new ExportJobStore(directory);
		const timestamp = new Date().toISOString();
		await store.create({
			schemaVersion: 1,
			jobId: "job-legacy-completed",
			fingerprint: stableSerialize(legacyInput),
			status: "completed",
			createdAt: timestamp,
			updatedAt: timestamp,
			attempts: 1,
			lastAttemptAt: timestamp,
			completedAt: timestamp,
			input: legacyInput,
			result: { status: "exported", sha256: "a".repeat(64) },
			lastError: null,
		});
		let requests = 0;
		const queue = new ExportJobQueue(
			fakeBridge({
				connected: false,
				request: async () => {
					requests += 1;
					return {};
				},
			}),
			{ export: async () => ({ status: "unexpected" }) },
			store,
			{ autoRun: false },
		);

		const replayed = await queue.enqueue({
			jobId: "job-legacy-completed",
			input: {
				...legacyInput,
				expectedConnectionIdentity: replayIdentity,
			},
		});

		expect(replayed).toMatchObject({
			replayed: true,
			job: { status: "completed", result: { status: "exported" } },
		});
		expect(requests).toBe(0);
		queue.stop();
	});

	test("rejects replaying a durable v2 job for a different editor", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const queue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: queuedIdentity,
				request: async () => persistedProjectState("d", 7),
			}),
			{ export: async () => ({ status: "unexpected" }) },
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		const input = {
			...exportInput(directory),
			bridgeProtocolVersion: 2 as const,
			expectedConnectionIdentity: queuedIdentity,
			expectedProjectContentHash: "d".repeat(64),
		};
		await queue.enqueue({ jobId: "job-replay-affinity", input });

		expect(
			queue.enqueue({
				jobId: "job-replay-affinity",
				input: {
					...input,
					expectedConnectionIdentity: identity("editor-2", "session-2", 2),
				},
			}),
		).rejects.toThrow("different export job");
		queue.stop();
	});

	test("rejects same-editor rebind when persisted content hash changed", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const firstQueue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: queuedIdentity,
				request: async () => persistedProjectState("d", 7),
			}),
			{ export: async () => ({ status: "unexpected" }) },
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		await firstQueue.enqueue({
			jobId: "job-changed-content",
			input: {
				...exportInput(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: queuedIdentity,
				expectedProjectContentHash: "d".repeat(64),
			},
		});
		firstQueue.stop();

		let exports = 0;
		const queue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: identity("editor-1", "session-2", 2),
				request: async () => ({
					status: "opened",
					projectId: "project-1",
					revision: 0,
					snapshot: { contentIdentity: hashedContentIdentity("e") },
				}),
			}),
			{
				export: async () => {
					exports += 1;
					return { status: "exported" };
				},
			},
			new ExportJobStore(directory),
			{ autoRun: false },
		);

		const [processed] = await queue.runQueued(1);

		expect(processed).toMatchObject({
			status: "failed",
			lastError: expect.stringContaining("pinned hash"),
		});
		expect(exports).toBe(0);
		queue.stop();
	});

	test("rejects same-editor rebind when persisted write version changed", async () => {
		const queuedIdentity = identity("editor-1", "session-1", 1);
		const firstQueue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: queuedIdentity,
				request: async () => persistedProjectState("d", 7),
			}),
			{ export: async () => ({ status: "unexpected" }) },
			new ExportJobStore(directory),
			{ autoRun: false },
		);
		await firstQueue.enqueue({
			jobId: "job-changed-persistence",
			input: {
				...exportInput(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: queuedIdentity,
				expectedProjectContentHash: "d".repeat(64),
			},
		});
		firstQueue.stop();

		let exports = 0;
		const queue = new ExportJobQueue(
			fakeBridge({
				connected: true,
				connectionIdentity: identity("editor-1", "session-2", 2),
				request: async (method) =>
					method === "open_project"
						? {
								status: "opened",
								projectId: "project-1",
								revision: 0,
								snapshot: {
									contentIdentity: hashedContentIdentity("d"),
								},
							}
						: persistedProjectState("d", 8),
			}),
			{
				export: async () => {
					exports += 1;
					return { status: "exported" };
				},
			},
			new ExportJobStore(directory),
			{ autoRun: false },
		);

		const [processed] = await queue.runQueued(1);

		expect(processed).toMatchObject({
			status: "failed",
			lastError: expect.stringContaining("write version"),
		});
		expect(exports).toBe(0);
		queue.stop();
	});

	test("rejects a durable v2 job when another editor is connected", async () => {
		let requests = 0;
		const bridge = fakeBridge({
			connected: true,
			connectionIdentity: identity("editor-2", "session-2", 2),
			request: async (method) => {
				requests += 1;
				return method === "save_project" ? persistedProjectState("d", 7) : {};
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
				expectedProjectContentHash: "d".repeat(64),
			},
		});
		requests = 0;

		const [processed] = await queue.runQueued(1);

		expect(processed).toMatchObject({
			status: "failed",
			lastError: expect.stringContaining("STALE_CONNECTION"),
		});
		expect(requests).toBe(0);
		queue.stop();
	});

	test("rejects a durable v2 job without a pinned project content hash", async () => {
		const queue = new ExportJobQueue(
			fakeBridge({ connected: false }),
			{ export: async () => ({ status: "exported" }) },
			new ExportJobStore(directory),
			{ autoRun: false },
		);

		expect(
			queue.enqueue({
				jobId: "job-unpinned",
				input: {
					...exportInput(directory),
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: identity("editor-1", "session-1", 1),
				},
			}),
		).rejects.toThrow("require expectedProjectContentHash");
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

function hashedContentIdentity(seed: string) {
	return {
		status: "hashed",
		hash: {
			algorithm: "SHA-256",
			digest: seed.repeat(64),
			projection: "opencut-project-content",
			projectionVersion: 2,
		},
	};
}

function persistedProjectState(seed: string, writeVersion: number) {
	return {
		status: "saved",
		contentHash: seed.repeat(64),
		contentHashProjectionVersion: 2,
		writeVersion,
		reloadVerified: true,
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
