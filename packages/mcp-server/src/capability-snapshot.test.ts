import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CapabilitySnapshotService,
	EDIT_PLAN_OPERATION_VARIANTS,
	hashCapabilitySnapshot,
	REGISTERED_TOOL_NAMES,
} from "./capability-snapshot";

describe("CapabilitySnapshotService", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-capabilities-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("returns a complete hashable offline snapshot with plain readiness reasons", async () => {
		const service = new CapabilitySnapshotService({
			bridge: fakeBridge(false),
			worker: fakeWorker(directory),
			stateDirectory: directory,
			queueState: async () => ({
				jobs: {
					total: 3,
					queued: 1,
					running: 0,
					completed: 1,
					failed: 1,
					cancelled: 0,
				},
				batches: 2,
			}),
			buildTimestamp: "2026-09-03T00:00:00.000Z",
			now: () => new Date("2026-09-03T01:00:00.000Z"),
			environment: {
				OPENCUT_BUILD_COMMIT: "a".repeat(40),
				OPENCUT_FFMPEG_PATH: "missing-ffmpeg-for-test",
				OPENCUT_FFPROBE_PATH: "missing-ffprobe-for-test",
			},
		});

		const snapshot = await service.capture();
		const { snapshotHash, ...content } = snapshot;

		expect(snapshotHash).toBe(hashCapabilitySnapshot(content));
		expect(snapshotHash).toMatch(/^[a-f0-9]{64}$/);
		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			build: {
				gitCommit: "a".repeat(40),
				buildTimestamp: "2026-09-03T00:00:00.000Z",
			},
			editor: {
				status: "unavailable",
				connected: false,
				reason: "OpenCut web editor is not running or connected.",
			},
			queue: { jobs: { total: 3, queued: 1 }, batches: 2 },
		});
		expect((snapshot.tools as Record<string, unknown>).registered).toEqual(
			REGISTERED_TOOL_NAMES,
		);
		expect(
			(snapshot.tools as Record<string, unknown>).editPlanOperationVariants,
		).toEqual(EDIT_PLAN_OPERATION_VARIANTS);
	});

	test("uses a connected editor runtime report for renderer and font readiness", async () => {
		const service = new CapabilitySnapshotService({
			bridge: fakeBridge(true),
			worker: fakeWorker(directory),
			stateDirectory: directory,
			queueState: async () => ({
				jobs: {
					total: 0,
					queued: 0,
					running: 0,
					completed: 0,
					failed: 0,
					cancelled: 0,
				},
				batches: 0,
			}),
			environment: {
				OPENCUT_BUILD_COMMIT: "b".repeat(40),
				OPENCUT_PINNED_COMPOSITOR_BACKEND: "opencut-wasm-webgl",
				OPENCUT_FFMPEG_PATH: "missing-ffmpeg-for-test",
				OPENCUT_FFPROBE_PATH: "missing-ffprobe-for-test",
				OPENCUT_AUDIO_CLEANER_COMMAND: process.execPath,
			},
		});

		const snapshot = await service.capture();

		expect(snapshot).toMatchObject({
			editor: { status: "ready", connected: true },
			renderer: {
				status: "ready",
				selectedBackend: "opencut-wasm-webgl",
				pinnedBackend: "opencut-wasm-webgl",
				isPinned: true,
				reportedWasmPackageVersion: "0.2.10",
				wasmMatchesEditor: true,
				browser: "test-browser",
			},
			fonts: { status: "ready" },
			providers: {
				audioCleanup: {
					status: "ready",
					version: expect.any(String),
					model: { status: "unknown" },
				},
			},
		});
	});
});

function fakeBridge(connected: boolean) {
	return {
		getStatus: () => ({
			connected,
			host: "127.0.0.1",
			port: 32191,
			serverInstanceId: "server-1",
			supportedProtocolVersions: [2, 1],
			negotiatedProtocolVersion: connected ? 2 : null,
			connectionIdentity: connected
				? {
						serverInstanceId: "server-1",
						editorInstanceId: "editor-1",
						editorSessionId: "session-1",
						connectionGeneration: 1,
					}
				: null,
		}),
		request: async () => ({
			status: "ready",
			compositorBackend: "opencut-wasm-webgl",
			wasmPackageVersion: "0.2.10",
			browser: "test-browser",
			fonts: {
				status: "ready",
				presets: [{ id: "default-caption", status: "ready" }],
			},
			timelineTranscription: {
				status: "ready",
				model: { status: "unknown", id: null, version: null },
			},
		}),
	};
}

function fakeWorker(directory: string) {
	return {
		getStatus: () => ({
			enabled: false,
			running: false,
			connected: false,
			baseUrl: null,
			profileDirectory: join(directory, "profile"),
			browserPath: null,
			projectId: null,
			lastError: null,
		}),
	};
}
