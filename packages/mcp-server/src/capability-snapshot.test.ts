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
			previewRange: {
				status: "ready",
				endpointPolicy: "start-inclusive-end-exclusive",
				limits: {
					maxDurationSeconds: 10,
					maxDurationTicks: 1_200_000,
					maxFrames: 300,
				},
			},
			comparison: {
				status: "ready",
				contractVersion: 1,
				sourceProjection: {
					name: "opencut-project-content",
					version: 2,
					supportedVersions: [1, 2],
				},
				outputs: ["side-by-side", "wipe", "pixel-diff"],
				normalization: {
					canvas: "none",
					color: "none",
					fonts: "exact",
					timing: "shared-schedule",
				},
				limits: {
					maxDurationSeconds: 10,
					maxDurationTicks: 1_200_000,
					maxFrames: 300,
				},
			},
		});
		expect((snapshot.tools as Record<string, unknown>).registered).toEqual(
			REGISTERED_TOOL_NAMES,
		);
		for (const name of [
			"opencut_compare_project_states",
			"opencut_cancel_comparison",
			"opencut_get_comparison",
			"opencut_list_comparisons",
		] as const) {
			expect(REGISTERED_TOOL_NAMES).toContain(name);
		}
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
				selectedBackend: "webgpu",
				pinnedBackend: "webgpu",
				isPinned: true,
				rendererClass: "software",
				adapter: { description: "SwiftShader", isFallbackAdapter: true },
				surfaceFormat: "bgra8unorm",
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

	test("reports compositor initialization failure as renderer unavailable", async () => {
		const bridge = fakeBridge(true, {
			status: "unavailable",
			reason: "No WebGPU adapter is available",
			compositorBackend: "unknown",
			wasmPackageVersion: "0.2.10",
			renderer: {
				status: "unavailable",
				reason: "No WebGPU adapter is available",
				adapter: null,
				surfaceFormat: "unknown",
			},
		});
		const snapshot = await new CapabilitySnapshotService({
			bridge,
			worker: fakeWorker(directory),
			stateDirectory: directory,
			queueState: emptyQueueState,
			environment: {
				OPENCUT_BUILD_COMMIT: "f".repeat(40),
				OPENCUT_FFMPEG_PATH: "missing-ffmpeg-for-test",
				OPENCUT_FFPROBE_PATH: "missing-ffprobe-for-test",
			},
		}).capture();

		expect(snapshot.renderer).toMatchObject({
			status: "unavailable",
			reason: "No WebGPU adapter is available",
			selectedBackend: "unknown",
			isPinned: false,
		});
	});
});

async function emptyQueueState() {
	return {
		jobs: {
			total: 0,
			queued: 0,
			running: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
		},
		batches: 0,
	};
}

function fakeBridge(connected: boolean, runtime: unknown = connectedRuntime()) {
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
		request: async () => runtime,
	};
}

function connectedRuntime() {
	return {
		status: "ready",
		compositorBackend: "webgpu",
		wasmPackageVersion: "0.2.10",
		browser: "test-browser",
		renderer: {
			status: "ready",
			reason: null,
			rendererClass: "software",
			adapterMatchesClass: true,
			adapter: { description: "SwiftShader", isFallbackAdapter: true },
			surfaceFormat: "bgra8unorm",
		},
		fonts: {
			status: "ready",
			presets: [
				{ id: "tiktok-sans-caption", status: "ready" },
				{ id: "montserrat-caption", status: "ready" },
			],
		},
		timelineTranscription: {
			status: "ready",
			model: { status: "unknown", id: null, version: null },
		},
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
			rendererClass: "software" as const,
			pinnedCompositorBackend: "webgpu" as const,
		}),
	};
}
