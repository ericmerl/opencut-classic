/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import {
	SAVE_RECEIPT_ENVELOPE_VERSION,
	SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
} from "@/services/storage/types";
import type { TScene } from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	evaluateEditPlan: () => {
		throw new Error("save tests must not evaluate an edit plan");
	},
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

const { mediaTime } = await import("@/wasm");
const { storageService } = await import("@/services/storage/service");
const { EditorAutomation } = await import("./editor-automation");
const originalLoadProjectFresh = storageService.loadProjectFresh;
const originalLoadSaveReceipt = storageService.loadSaveReceipt;
const originalSaveSaveReceipt = storageService.saveSaveReceipt;
const originalLoadOperationReceipt = storageService.loadOperationReceipt;
const originalSaveOperationReceipt = storageService.saveOperationReceipt;

afterEach(() => {
	storageService.loadProjectFresh = originalLoadProjectFresh;
	storageService.loadSaveReceipt = originalLoadSaveReceipt;
	storageService.saveSaveReceipt = originalSaveSaveReceipt;
	storageService.loadOperationReceipt = originalLoadOperationReceipt;
	storageService.saveOperationReceipt = originalSaveOperationReceipt;
});

describe("EditorAutomation save barrier", () => {
	test("flushes, freshly verifies, and replays without mutating editor state", async () => {
		const project = buildProject("Saved");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let persistedReceipt: Parameters<typeof originalSaveSaveReceipt>[0] | null =
			null;
		const editor = createEditor({
			project,
			scene,
			onFlush: () => (flushCalls += 1),
		});
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 1 });
		storageService.loadSaveReceipt = async ({ parseResult }) => {
			if (!persistedReceipt) return null;
			return {
				...persistedReceipt,
				id: persistedReceipt.operationId,
				envelopeVersion: SAVE_RECEIPT_ENVELOPE_VERSION,
				storageSchemaVersion: SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
				result: parseResult(persistedReceipt.result),
			};
		};
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
			readback({ project: buildProject("Stale"), writeVersion: 1 });
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
		let persistedReceipt: Parameters<typeof originalSaveSaveReceipt>[0] | null =
			null;
		const editor = createEditor({
			project,
			scene,
			onFlush: () => {
				flushCalls += 1;
			},
		});
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 1 });
		storageService.loadSaveReceipt = async ({ parseResult }) => {
			if (!persistedReceipt) return null;
			return {
				...persistedReceipt,
				id: persistedReceipt.operationId,
				envelopeVersion: SAVE_RECEIPT_ENVELOPE_VERSION,
				storageSchemaVersion: SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
				result: parseResult(persistedReceipt.result),
			};
		};
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

	test("verifies a bound committed receipt after revision reset without flushing", async () => {
		const project = buildProject("Committed browser edit");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let savedReceipt: unknown = null;
		const editor = createEditor({
			project,
			scene,
			onFlush: () => (flushCalls += 1),
		});
		const automation = new EditorAutomation(editor);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed")
			throw new Error("hash blocked");
		const committedContentHash = snapshot.contentIdentity.hash.digest;
		const binding = {
			version: 1 as const,
			outerOperationId: "edit-before-response-loss",
			outerToolName: "opencut_apply_edit_plan",
			outerRequestFingerprint: "a".repeat(64),
			role: "direct-terminal" as const,
			stepId: "opencut_apply_edit_plan:direct",
			browserMethod: "apply_edit_plan",
			browserRequestFingerprint: "b".repeat(64),
		};
		storageService.loadOperationReceipt = async () => ({
			id: "bound-receipt",
			envelopeVersion: 3,
			storageSchemaVersion: 3,
			operationId: binding.outerOperationId,
			binding,
			afterState: {
				projectId: "project-1",
				sceneId: "scene-1",
				revisionAfter: 19,
				sessionRevisionAfter: 19,
				durableWriteVersion: 7,
				contentHashAfter: committedContentHash,
			},
			result: { status: "applied", revision: 19, snapshot },
			recordedAt: "2026-09-02T12:00:00.000Z",
		});
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 7 });
		storageService.loadSaveReceipt = async () => null;
		storageService.saveSaveReceipt = async (receipt) => {
			savedReceipt = receipt;
		};

		const result = await automation.verifyOperationReceipt({
			binding,
			saveOperationId: `${binding.outerOperationId}:ledger-save`,
		});

		expect(result).toMatchObject({
			status: "saved",
			revision: 19,
			writeVersion: 7,
			contentHash: committedContentHash,
		});
		expect(savedReceipt).toBeTruthy();
		expect(flushCalls).toBe(0);
	});

	test("keeps receipt recovery unresolved when persisted content advanced", async () => {
		const committedProject = buildProject("Committed browser edit");
		const advancedProject = buildProject("Advanced after commit");
		const scene = committedProject.scenes[0]!;
		let flushCalls = 0;
		let saveReceiptWrites = 0;
		const automation = new EditorAutomation(
			createEditor({
				project: committedProject,
				scene,
				onFlush: () => (flushCalls += 1),
			}),
		);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed")
			throw new Error("hash blocked");
		const committedContentHash = snapshot.contentIdentity.hash.digest;
		const binding = {
			version: 1 as const,
			outerOperationId: "advanced-before-recovery",
			outerToolName: "opencut_apply_edit_plan",
			outerRequestFingerprint: "c".repeat(64),
			role: "direct-terminal" as const,
			stepId: "opencut_apply_edit_plan:direct",
			browserMethod: "apply_edit_plan",
			browserRequestFingerprint: "d".repeat(64),
		};
		storageService.loadOperationReceipt = async () => ({
			id: "advanced-bound-receipt",
			envelopeVersion: 3,
			storageSchemaVersion: 3,
			operationId: binding.outerOperationId,
			binding,
			afterState: {
				projectId: "project-1",
				sceneId: "scene-1",
				revisionAfter: 19,
				sessionRevisionAfter: 19,
				durableWriteVersion: 7,
				contentHashAfter: committedContentHash,
			},
			result: { status: "applied", revision: 19, snapshot },
			recordedAt: "2026-09-02T12:00:00.000Z",
		});
		storageService.loadProjectFresh = async () =>
			readback({ project: advancedProject, writeVersion: 8 });
		storageService.loadSaveReceipt = async () => null;
		storageService.saveSaveReceipt = async () => {
			saveReceiptWrites += 1;
		};

		const result = await automation.verifyOperationReceipt({
			binding,
			saveOperationId: `${binding.outerOperationId}:ledger-save`,
		});

		expect(result).toMatchObject({
			status: "verification-failed",
			operationId: `${binding.outerOperationId}:ledger-save`,
		});
		expect(flushCalls).toBe(0);
		expect(saveReceiptWrites).toBe(0);
	});

	test("rejects same-hash recovery when the durable write version differs", async () => {
		const project = buildProject("Committed browser edit");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let saveReceiptWrites = 0;
		const automation = new EditorAutomation(
			createEditor({
				project,
				scene,
				onFlush: () => (flushCalls += 1),
			}),
		);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed")
			throw new Error("hash blocked");
		const committedContentHash = snapshot.contentIdentity.hash.digest;
		const binding = {
			version: 1 as const,
			outerOperationId: "same-hash-wrong-write-version",
			outerToolName: "opencut_apply_edit_plan",
			outerRequestFingerprint: "e".repeat(64),
			role: "direct-terminal" as const,
			stepId: "opencut_apply_edit_plan:direct",
			browserMethod: "apply_edit_plan",
			browserRequestFingerprint: "f".repeat(64),
		};
		storageService.loadOperationReceipt = async () => ({
			id: "wrong-write-version-receipt",
			envelopeVersion: 3,
			storageSchemaVersion: 3,
			operationId: binding.outerOperationId,
			binding,
			afterState: {
				projectId: "project-1",
				sceneId: "scene-1",
				revisionAfter: 19,
				sessionRevisionAfter: 19,
				durableWriteVersion: 7,
				contentHashAfter: committedContentHash,
			},
			result: { status: "applied", revision: 19, snapshot },
			recordedAt: "2026-09-02T12:00:00.000Z",
		});
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 8 });
		storageService.loadSaveReceipt = async () => null;
		storageService.saveSaveReceipt = async () => {
			saveReceiptWrites += 1;
		};

		const result = await automation.verifyOperationReceipt({
			binding,
			saveOperationId: `${binding.outerOperationId}:ledger-save`,
		});

		expect(result).toMatchObject({ status: "verification-failed" });
		expect(flushCalls).toBe(0);
		expect(saveReceiptWrites).toBe(0);
	});

	test("records exact-frame evidence for a persisted non-active scene", async () => {
		const project = buildProject("Non-active evidence");
		const activeScene = project.scenes[0]!;
		const requestedScene = {
			...activeScene,
			id: "scene-2",
			name: "Requested non-active scene",
			isMain: false,
		};
		project.scenes.push(requestedScene);
		const automation = new EditorAutomation(
			createEditor({
				project,
				scene: activeScene,
				onFlush: () => undefined,
			}),
		);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed")
			throw new Error("hash blocked");
		const requestWithoutBinding = {
			operationId: "preview-non-active",
			projectId: project.metadata.id,
			sceneId: requestedScene.id,
			expectedRevision: snapshot.revision,
			expectedProjectContentHash: snapshot.contentIdentity.hash.digest,
		};
		const binding = {
			version: 1 as const,
			outerOperationId: "preview-non-active",
			outerToolName: "opencut_render_preview_frame",
			outerRequestFingerprint: "a".repeat(64),
			role: "composite-step" as const,
			stepId: "exact-frame-render",
			browserMethod: "render_preview_frame",
			browserRequestFingerprint: createHash("sha256")
				.update(stableSerializeForTest(requestWithoutBinding))
				.digest("hex"),
		};
		let stored: unknown = null;
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 9 });
		storageService.saveOperationReceipt = async (receipt) => {
			stored = receipt;
		};

		await automation.recordOperationReceipt(
			"render_preview_frame",
			{ ...requestWithoutBinding, operationReceiptBinding: binding },
			{
				status: "rendered",
				projectId: project.metadata.id,
				sceneId: requestedScene.id,
				revision: snapshot.revision,
				contentIdentity: snapshot.contentIdentity,
			},
		);

		expect(stored).toMatchObject({
			operationId: binding.outerOperationId,
			afterState: {
				sceneId: requestedScene.id,
				durableWriteVersion: 9,
			},
		});
		expect(project.currentSceneId).toBe(activeScene.id);
	});
});

function stableSerializeForTest(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(stableSerializeForTest).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerializeForTest(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function createEditor({
	project,
	scene,
	onFlush,
}: {
	project: TProject;
	scene: TScene;
	onFlush: () => void;
}): EditorCore {
	const editor: unknown = {
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
	};
	if (!isTestEditorCore(editor)) throw new Error("invalid test editor fixture");
	return editor;
}

function isTestEditorCore(value: unknown): value is EditorCore {
	return (
		value !== null &&
		typeof value === "object" &&
		"project" in value &&
		"scenes" in value &&
		"media" in value &&
		"save" in value
	);
}

function readback({
	project,
	writeVersion,
}: {
	project: TProject;
	writeVersion: number;
}) {
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
			duration: mediaTime({ ticks: 0 }),
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
