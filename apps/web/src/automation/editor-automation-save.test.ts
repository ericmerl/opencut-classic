/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/services/renderer/canvas-renderer", () => ({
	CanvasRenderer: class {},
}));
mock.module("@/services/renderer/scene-builder", () => ({
	buildScene: () => ({}),
}));

const { storageService } = await import("@/services/storage/service");
const { EditorAutomation } = await import("./editor-automation");
const originalLoadProjectFresh = storageService.loadProjectFresh;
const originalLoadSaveReceipt = storageService.loadSaveReceipt;
const originalSaveSaveReceipt = storageService.saveSaveReceipt;

afterEach(() => {
	storageService.loadProjectFresh = originalLoadProjectFresh;
	storageService.loadSaveReceipt = originalLoadSaveReceipt;
	storageService.saveSaveReceipt = originalSaveSaveReceipt;
});

describe("EditorAutomation save barrier", () => {
	test("flushes, freshly verifies, and replays without mutating editor state", async () => {
		const project = buildProject("Saved");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let persistedReceipt: unknown = null;
		const editor = createEditor({
			project,
			scene,
			onFlush: () => (flushCalls += 1),
		});
		storageService.loadProjectFresh = async () => readback(project, 1);
		storageService.loadSaveReceipt = async () => persistedReceipt as never;
		storageService.saveSaveReceipt = async (receipt) => {
			persistedReceipt = receipt;
		};
		const automation = new EditorAutomation(editor);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed")
			throw new Error("hash blocked");
		const request = {
			projectId: project.metadata.id,
			sceneId: scene.id,
			operationId: "save-1",
			expectedRevision: snapshot.revision,
			expectedContentHash: snapshot.contentIdentity.hash.digest,
			bridgeProtocolVersion: 2 as const,
		};

		const saved = await automation.saveProject(request);
		const replayed = await automation.saveProject(request);
		const restartedReplay = await new EditorAutomation(editor).saveProject(
			request,
		);

		expect(saved).toMatchObject({
			status: "saved",
			projectId: "project-1",
			writeVersion: 1,
			reloadVerified: true,
			readbackContentHash: snapshot.contentIdentity.hash.digest,
		});
		expect(replayed).toMatchObject({
			status: "replayed",
			receiptId: "receiptId" in saved ? saved.receiptId : "missing",
		});
		expect(restartedReplay).toMatchObject({ status: "replayed" });
		expect(flushCalls).toBe(1);
		expect(editor.project.getActive()).toBe(project);
		expect(editor.scenes.getActiveScene()).toBe(scene);
	});

	test("fails closed when fresh readback hashes different content", async () => {
		const project = buildProject("Live");
		const scene = project.scenes[0]!;
		const editor = createEditor({ project, scene, onFlush: () => undefined });
		storageService.loadSaveReceipt = async () => null;
		storageService.saveSaveReceipt = async () => undefined;
		storageService.loadProjectFresh = async () =>
			readback(buildProject("Stale"), 1);
		const automation = new EditorAutomation(editor);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed")
			throw new Error("hash blocked");

		expect(
			await automation.saveProject({
				projectId: "project-1",
				operationId: "save-stale",
				expectedRevision: snapshot.revision,
				expectedContentHash: snapshot.contentIdentity.hash.digest,
				bridgeProtocolVersion: 2,
			}),
		).toMatchObject({ status: "verification-failed" });
	});

	test("does not cache success until its durable receipt write completes", async () => {
		const project = buildProject("Receipt retry");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let receiptWriteCalls = 0;
		let persistedReceipt: unknown = null;
		const editor = createEditor({
			project,
			scene,
			onFlush: () => {
				flushCalls += 1;
			},
		});
		storageService.loadProjectFresh = async () => readback(project, 1);
		storageService.loadSaveReceipt = async () => persistedReceipt as never;
		storageService.saveSaveReceipt = async (receipt) => {
			receiptWriteCalls += 1;
			if (receiptWriteCalls === 1) {
				throw new Error("injected receipt write failure");
			}
			persistedReceipt = receipt;
		};
		const automation = new EditorAutomation(editor);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed") {
			throw new Error("hash blocked");
		}
		const request = {
			projectId: project.metadata.id,
			sceneId: scene.id,
			operationId: "save-receipt-retry",
			expectedRevision: snapshot.revision,
			expectedContentHash: snapshot.contentIdentity.hash.digest,
			bridgeProtocolVersion: 2 as const,
		};

		await expect(automation.saveProject(request)).rejects.toThrow(
			"injected receipt write failure",
		);
		expect(persistedReceipt).toBeNull();

		const saved = await automation.saveProject(request);
		expect(saved).toMatchObject({
			status: "saved",
			operationId: request.operationId,
		});
		expect(flushCalls).toBe(2);
		expect(receiptWriteCalls).toBe(2);

		const restartedAutomation = new EditorAutomation(editor);
		expect(
			await restartedAutomation.getSaveReceipt({
				operationId: request.operationId,
			}),
		).toMatchObject({
			status: "found",
			operationId: request.operationId,
		});
		expect(await restartedAutomation.saveProject(request)).toMatchObject({
			status: "replayed",
			operationId: request.operationId,
		});
		expect(flushCalls).toBe(2);
	});
});

function createEditor({
	project,
	scene,
	onFlush,
}: {
	project: TProject;
	scene: TScene;
	onFlush: () => void;
}): EditorCore {
	return {
		project: { getActive: () => project, getActiveOrNull: () => project },
		scenes: { getScenes: () => project.scenes, getActiveScene: () => scene },
		media: { getAssets: () => [] },
		save: {
			flush: async () => {
				onFlush();
				return {
					projectId: "project-1",
					persistedAt: "2026-09-02T12:00:00.000Z",
					snapshotAt: "2026-09-02T12:00:00.100Z",
					completedAt: "2026-09-02T12:00:00.200Z",
					storageSchemaVersion: 1,
					writeVersion: 1,
				};
			},
		},
	} as unknown as EditorCore;
}

function readback(project: TProject, writeVersion: number) {
	return {
		project,
		mediaAssets: [],
		persistence: {
			projectId: "project-1",
			storageSchemaVersion: 1,
			writeVersion,
			snapshotAt: "2026-09-02T12:00:00.100Z",
			completedAt: "2026-09-02T12:00:00.200Z",
		},
	};
}

function buildProject(name: string): TProject {
	const scene = {
		id: "scene-1",
		name: "Main",
		isMain: true,
		tracks: {
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [],
			audio: [],
		},
		bookmarks: [],
		createdAt: new Date("2026-09-02T00:00:00.000Z"),
		updatedAt: new Date("2026-09-02T00:00:00.000Z"),
	} as TScene;
	return {
		metadata: {
			id: "project-1",
			name,
			duration: 0 as TProject["metadata"]["duration"],
			createdAt: scene.createdAt,
			updatedAt: scene.updatedAt,
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}
