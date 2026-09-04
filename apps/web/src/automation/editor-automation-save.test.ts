/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type {
	ProjectSaveReceiptBinding,
	ProjectSaveReceiptIdentity,
} from "@/services/storage/types";
import {
	SAVE_RECEIPT_ENVELOPE_VERSION,
	SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
} from "@/services/storage/types";
import type { TScene } from "@/timeline";

const require = createRequire(import.meta.url);
const projectState =
	require("../../../../rust/wasm/pkg-node/opencut_wasm.js") as {
		evaluateAutomationOperationPolicy: (options: {
			method: string;
			status: string;
		}) => { durableSuccess: boolean; retainSnapshot: boolean };
		evaluateProjectSnapshotRetention: (options: unknown) => unknown;
	};

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	evaluateAutomationOperationPolicy:
		projectState.evaluateAutomationOperationPolicy,
	evaluateEditPlan: () => {
		throw new Error("save tests must not evaluate an edit plan");
	},
	evaluateProjectSnapshotRetention:
		projectState.evaluateProjectSnapshotRetention,
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
const { SaveManager } = await import("@/core/managers/save-manager");
const { EditorAutomation } = await import("./editor-automation");
const { parsePersistedSaveProjectResult } =
	await import("./save-project-receipt");
const originalBindProjectSaveReceiptIdentity =
	storageService.bindProjectSaveReceiptIdentity;
const originalLoadProjectFresh = storageService.loadProjectFresh;
const originalLoadSaveReceipt = storageService.loadSaveReceipt;
const originalSaveSaveReceipt = storageService.saveSaveReceipt;
const originalLoadOperationReceipt = storageService.loadOperationReceipt;
const originalSaveOperationReceipt = storageService.saveOperationReceipt;
const originalRetainVerifiedProjectSnapshot =
	storageService.retainVerifiedProjectSnapshot;
let retainedSnapshots: Array<
	Parameters<typeof originalRetainVerifiedProjectSnapshot>[0]
> = [];

beforeEach(() => {
	retainedSnapshots = [];
	storageService.retainVerifiedProjectSnapshot = async (input) => {
		retainedSnapshots.push(input);
	};
	storageService.bindProjectSaveReceiptIdentity = async ({
		projectId,
		expectedWriteVersion,
		binding,
	}) => ({
		version: 2,
		...binding,
		receiptId: `save:${projectId}:${expectedWriteVersion}:${binding.contentHash}`,
	});
});

afterEach(() => {
	storageService.bindProjectSaveReceiptIdentity =
		originalBindProjectSaveReceiptIdentity;
	storageService.loadProjectFresh = originalLoadProjectFresh;
	storageService.loadSaveReceipt = originalLoadSaveReceipt;
	storageService.saveSaveReceipt = originalSaveSaveReceipt;
	storageService.loadOperationReceipt = originalLoadOperationReceipt;
	storageService.saveOperationReceipt = originalSaveOperationReceipt;
	storageService.retainVerifiedProjectSnapshot =
		originalRetainVerifiedProjectSnapshot;
});

describe("EditorAutomation save barrier", () => {
	test("serves explicit legacy v1 hashes for persisted receipt recovery", async () => {
		const project = buildProject("Projection migration");
		const automation = new EditorAutomation(
			createEditor({ project, scene: project.scenes[0]!, onFlush: () => {} }),
		);
		const current = await automation.readProject();
		const legacy = await automation.readProject({
			projectContentProjectionVersion: 1,
		});
		if (
			current.contentIdentity.status !== "hashed" ||
			legacy.contentIdentity.status !== "hashed"
		) {
			throw new Error("hash blocked");
		}
		expect(current.contentIdentity.hash.projectionVersion).toBe(3);
		expect(legacy.contentIdentity.hash.projectionVersion).toBe(1);
		expect(current.contentIdentity.hash.digest).not.toBe(
			legacy.contentIdentity.hash.digest,
		);
	});

	test("flushes, freshly verifies, and replays without mutating editor state", async () => {
		const project = buildProject("Saved");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let persistedReceipt: Parameters<typeof originalSaveSaveReceipt>[0] | null =
			null;
		const publicationOrder: string[] = [];
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
			publicationOrder.push("receipt");
			persistedReceipt = receipt;
		};
		storageService.retainVerifiedProjectSnapshot = async (input) => {
			publicationOrder.push("snapshot");
			retainedSnapshots.push(input);
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
		expect(retainedSnapshots).toHaveLength(1);
		expect(retainedSnapshots[0]).toMatchObject({
			projectId: "project-1",
			contentHash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 3,
				digest: snapshot.contentIdentity.hash.digest,
			},
			verification: {
				writeVersion: 1,
				operationId: "save-1",
			},
		});
		expect(retainedSnapshots[0]!.verification.verifiedAt).not.toBe(
			"2026-09-02T12:00:00.200Z",
		);
		expect(
			new Date(retainedSnapshots[0]!.verification.verifiedAt).toISOString(),
		).toBe(retainedSnapshots[0]!.verification.verifiedAt);
		expect(publicationOrder).toEqual(["snapshot", "receipt"]);
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

	test("reconstructs the same receipt after the envelope commits but its receipt is lost", async () => {
		const project = buildProject("Receipt retry");
		const scene = project.scenes[0]!;
		let flushCalls = 0;
		let writeVersion = 0;
		let saveReceiptIdentity: ProjectSaveReceiptIdentity | undefined;
		let receiptWriteCalls = 0;
		let persistedReceipt: Parameters<typeof originalSaveSaveReceipt>[0] | null =
			null;
		const lostReceipts: Array<Parameters<typeof originalSaveSaveReceipt>[0]> =
			[];
		const editor = createEditor({
			project,
			scene,
			onFlush: () => undefined,
		});
		Object.assign(editor.project, {
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject: async ({
				saveReceiptBinding,
			}: {
				saveReceiptBinding?: ProjectSaveReceiptBinding;
			} = {}) => {
				flushCalls += 1;
				writeVersion += 1;
				saveReceiptIdentity = saveReceiptBinding
					? {
							version: 2,
							...saveReceiptBinding,
							receiptId: `save:project-1:${writeVersion}:${saveReceiptBinding.contentHash}`,
						}
					: undefined;
				return persistedWrite(writeVersion, saveReceiptIdentity);
			},
		});
		const firstSaveManager = new SaveManager({ editor, debounceMs: 60_000 });
		Object.assign(editor, { save: firstSaveManager });
		firstSaveManager.markDirty();
		storageService.loadProjectFresh = async () =>
			writeVersion === 0
				? null
				: readback({ project, writeVersion, saveReceiptIdentity });
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
				lostReceipts.push(structuredClone(receipt));
				throw new Error("injected receipt write failure");
			}
			persistedReceipt = receipt;
		};
		const automation = new EditorAutomation(editor);
		await automation.readProject();
		project.metadata.name = "Receipt retry after edit";
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed") {
			throw new Error("hash blocked");
		}
		expect(snapshot.revision).toBe(1);
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
		expect(writeVersion).toBe(1);

		const restartedSaveManager = new SaveManager({
			editor,
			debounceMs: 60_000,
		});
		Object.assign(editor, { save: restartedSaveManager });
		const restartedAutomation = new EditorAutomation(editor);
		expect(
			await restartedAutomation.recoverSaveProject({
				...request,
				expectedRevision: request.expectedRevision + 1,
			}),
		).toMatchObject({
			status: "rejected",
			operationId: request.operationId,
		});
		const saved = await restartedAutomation.recoverSaveProject(request);
		expect(saved).toMatchObject({
			status: "replayed",
			operationId: request.operationId,
			writeVersion: 1,
		});
		const lostResult = parsePersistedSaveProjectResult(lostReceipts[0]?.result);
		expect(saved).toEqual({ ...lostResult, status: "replayed" });
		expect(flushCalls).toBe(1);
		expect(writeVersion).toBe(1);
		expect(receiptWriteCalls).toBe(2);
		expect(retainedSnapshots).toHaveLength(2);
		expect(retainedSnapshots[1]).toMatchObject({
			projectId: project.metadata.id,
			contentHash: snapshot.contentIdentity.hash,
			verification: {
				writeVersion: 1,
				operationId: request.operationId,
			},
		});

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
		expect(flushCalls).toBe(1);
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
				contentHashProjectionVersion: 3,
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
		expect(retainedSnapshots).toHaveLength(1);
		expect(retainedSnapshots[0]).toMatchObject({
			projectId: project.metadata.id,
			contentHash: snapshot.contentIdentity.hash,
			verification: {
				writeVersion: 7,
				operationId: `${binding.outerOperationId}:ledger-save`,
			},
		});
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
				contentHashProjectionVersion: 3,
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
		expect(retainedSnapshots).toHaveLength(0);
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
				contentHashProjectionVersion: 3,
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
			fingerprintProbe: { "\ue000": 2, "\u{10000}": 1 },
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

		await automation.recordOperationReceipt({
			method: "render_preview_frame",
			request: { ...requestWithoutBinding, operationReceiptBinding: binding },
			result: {
				status: "rendered",
				projectId: project.metadata.id,
				sceneId: requestedScene.id,
				revision: snapshot.revision,
				contentIdentity: snapshot.contentIdentity,
			},
		});

		expect(stored).toMatchObject({
			operationId: binding.outerOperationId,
			afterState: {
				sceneId: requestedScene.id,
				durableWriteVersion: 9,
			},
		});
		expect(project.currentSceneId).toBe(activeScene.id);
		expect(retainedSnapshots).toHaveLength(0);

		const comparisonRequest = {
			...requestWithoutBinding,
			operationId: "compare-non-active",
		};
		const comparisonBinding = {
			...binding,
			outerOperationId: "compare-non-active",
			outerToolName: "opencut_compare_project_states",
			stepId: "comparison-render",
			browserMethod: "compare_project_states",
			browserRequestFingerprint: createHash("sha256")
				.update(stableSerializeForTest(comparisonRequest))
				.digest("hex"),
		};
		await automation.recordOperationReceipt({
			method: "compare_project_states",
			request: {
				...comparisonRequest,
				operationReceiptBinding: comparisonBinding,
			},
			result: {
				status: "rendered",
				projectId: project.metadata.id,
				sceneId: requestedScene.id,
				revision: snapshot.revision,
				contentHash: snapshot.contentIdentity.hash.digest,
				contentHashProjectionVersion:
					snapshot.contentIdentity.hash.projectionVersion,
			},
		});
		expect(stored).toMatchObject({
			operationId: comparisonBinding.outerOperationId,
			afterState: { sceneId: requestedScene.id, durableWriteVersion: 9 },
		});
	});

	test("records the active scene identity for a non-activating scene mutation", async () => {
		const project = buildProject("Non-activating scene mutation");
		const activeScene = project.scenes[0]!;
		const createdScene = {
			...activeScene,
			id: "scene-2",
			name: "Created without activation",
			isMain: false,
		};
		project.scenes.push(createdScene);
		const automation = new EditorAutomation(
			createEditor({
				project,
				scene: activeScene,
				onFlush: () => undefined,
			}),
		);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed") {
			throw new Error("hash blocked");
		}
		const requestWithoutBinding = {
			operationId: "create-scene-non-active",
		};
		const binding = {
			version: 1 as const,
			outerOperationId: requestWithoutBinding.operationId,
			outerToolName: "opencut_create_scene",
			outerRequestFingerprint: "a".repeat(64),
			role: "direct-terminal" as const,
			stepId: "opencut_create_scene:direct",
			browserMethod: "create_scene",
			browserRequestFingerprint: createHash("sha256")
				.update(stableSerializeForTest(requestWithoutBinding))
				.digest("hex"),
		};
		let stored: unknown = null;
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 10 });
		storageService.saveOperationReceipt = async (receipt) => {
			stored = receipt;
		};

		await automation.recordOperationReceipt({
			method: "create_scene",
			request: { ...requestWithoutBinding, operationReceiptBinding: binding },
			result: {
				status: "applied",
				operationId: requestWithoutBinding.operationId,
				projectId: project.metadata.id,
				sceneId: createdScene.id,
				activeSceneId: activeScene.id,
				revision: snapshot.revision,
				snapshot,
			},
		});

		expect(stored).toMatchObject({
			operationId: binding.outerOperationId,
			afterState: {
				sceneId: activeScene.id,
				durableWriteVersion: 10,
			},
		});
	});

	test("retains a verified mutating browser result before its operation receipt", async () => {
		const project = buildProject("Durable browser edit");
		const scene = project.scenes[0]!;
		const automation = new EditorAutomation(
			createEditor({ project, scene, onFlush: () => undefined }),
		);
		const snapshot = await automation.readProject();
		if (snapshot.contentIdentity.status !== "hashed") {
			throw new Error("hash blocked");
		}
		const requestWithoutBinding = { operationId: "edit-retain" };
		const binding = {
			version: 1 as const,
			outerOperationId: "edit-retain",
			outerToolName: "opencut_apply_edit_plan",
			outerRequestFingerprint: "a".repeat(64),
			role: "direct-terminal" as const,
			stepId: "opencut_apply_edit_plan:direct",
			browserMethod: "apply_edit_plan",
			browserRequestFingerprint: createHash("sha256")
				.update(stableSerializeForTest(requestWithoutBinding))
				.digest("hex"),
		};
		const publicationOrder: string[] = [];
		storageService.loadProjectFresh = async () =>
			readback({ project, writeVersion: 11 });
		storageService.retainVerifiedProjectSnapshot = async (input) => {
			publicationOrder.push("snapshot");
			retainedSnapshots.push(input);
		};
		storageService.saveOperationReceipt = async () => {
			publicationOrder.push("receipt");
		};

		await automation.recordOperationReceipt({
			method: "apply_edit_plan",
			request: { ...requestWithoutBinding, operationReceiptBinding: binding },
			result: {
				status: "applied",
				operationId: requestWithoutBinding.operationId,
				revision: snapshot.revision,
				snapshot,
			},
		});

		expect(retainedSnapshots).toHaveLength(1);
		expect(retainedSnapshots[0]).toMatchObject({
			projectId: project.metadata.id,
			contentHash: snapshot.contentIdentity.hash,
			verification: {
				writeVersion: 11,
				operationId: binding.outerOperationId,
			},
		});
		expect(publicationOrder).toEqual(["snapshot", "receipt"]);
	});
});

function stableSerializeForTest(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(stableSerializeForTest).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerializeForTest(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function createEditor({
	project,
	scene,
	onExecute = () => undefined,
	onFlush,
}: {
	project: TProject;
	scene: TScene;
	onExecute?: () => void;
	onFlush: () => void;
}): EditorCore {
	const editor: unknown = {
		project: { getActive: () => project, getActiveOrNull: () => project },
		scenes: { getScenes: () => project.scenes, getActiveScene: () => scene },
		media: { getAssets: () => [] },
		command: { execute: onExecute },
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
	saveReceiptIdentity,
}: {
	project: TProject;
	writeVersion: number;
	saveReceiptIdentity?: ProjectSaveReceiptIdentity;
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
			...(saveReceiptIdentity ? { saveReceiptIdentity } : {}),
		},
	};
}

function persistedWrite(
	writeVersion: number,
	saveReceiptIdentity?: ProjectSaveReceiptIdentity,
) {
	return {
		projectId: "project-1",
		persistedAt: "2026-09-02T12:00:00.000Z",
		snapshotAt: "2026-09-02T12:00:00.100Z",
		completedAt: "2026-09-02T12:00:00.200Z",
		storageSchemaVersion: 1,
		writeVersion,
		...(saveReceiptIdentity ? { saveReceiptIdentity } : {}),
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
