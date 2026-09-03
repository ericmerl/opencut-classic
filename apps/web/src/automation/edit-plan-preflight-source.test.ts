/// <reference types="bun" />

import { createHash } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { PersistedSaveReceiptEnvelope } from "@/services/storage/types";
import type { TScene } from "@/timeline";
import type { AutomationEditPlanPreflightRequest } from "./types";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	TICKS_PER_SECOND: 120000,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundMediaTime: ({ time }: { time: number }) => time,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
}));

const { hashProjectContent, serializeProjectContent } =
	await import("./project-content-hash");
const { mediaTime } = await import("@/wasm");
const { buildEditorProjectContentInput } =
	await import("./project-content-identity");
const { captureEditPlanPreflightSource } =
	await import("./edit-plan-preflight-source");

describe("edit-plan preflight source capture", () => {
	test("freshly binds a persisted non-active scene without editor side effects", async () => {
		const project = buildProject();
		const activeScene = project.scenes[0]!;
		const editor = buildEditor({ project, activeScene });
		const request = await buildRequest(project);
		const fixture = persistedFixture({ project, request });
		const capture = await captureEditPlanPreflightSource({
			editor,
			request,
			sessionRevision: 0,
			knownStateFingerprint: "",
			storage: fixture.storage,
		});

		expect(capture.status).toBe("captured");
		if (capture.status !== "captured") throw new Error(capture.reason);
		expect(capture.scene.id).toBe("scene-2");
		expect(capture.observation).toMatchObject({
			projectId: "project-1",
			sceneId: "scene-2",
			activeProjectId: "project-1",
			activeSceneId: "scene-1",
			sessionRevision: 0,
			durableWriteVersion: 4,
			saveOperationId: "save-4",
			saveReceiptId: "receipt-4",
			connectionIdentity: {
				serverInstanceId: "server-1",
				bridgeProtocolVersion: 2,
			},
		});
		expect(capture.observation.selectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(capture.observation.historyFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(capture.observation.persistenceFingerprint).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(fixture.readCalls).toEqual({ project: 1, receipt: 1 });
		expect(editor.command.execute).not.toHaveBeenCalled();
		expect(editor.save.flush).not.toHaveBeenCalled();
		expect(project.currentSceneId).toBe("scene-1");
	});

	test("rejects a save receipt that is not bound to the requested operation", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const fixture = persistedFixture({
			project,
			request,
			overrides: {
				saveOperationId: "different-save",
			},
		});
		const capture = await captureEditPlanPreflightSource({
			editor: buildEditor({ project, activeScene: project.scenes[0]! }),
			request,
			sessionRevision: 0,
			knownStateFingerprint: "",
			storage: fixture.storage,
		});

		expect(capture).toMatchObject({
			status: "rejected",
			code: "SAVE_RECEIPT_MISMATCH",
		});
	});

	test("rejects session revision and durable write-version drift before evaluation", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const fixture = persistedFixture({ project, request });
		const revisionConflict = await captureEditPlanPreflightSource({
			editor: buildEditor({ project, activeScene: project.scenes[0]! }),
			request: { ...request, expectedRevision: 1 },
			sessionRevision: 0,
			knownStateFingerprint: "",
			storage: fixture.storage,
		});
		expect(revisionConflict).toMatchObject({
			status: "conflict",
			code: "SOURCE_STATE_CONFLICT",
		});
		expect(fixture.readCalls).toEqual({ project: 0, receipt: 0 });

		const writeVersionConflict = await captureEditPlanPreflightSource({
			editor: buildEditor({ project, activeScene: project.scenes[0]! }),
			request,
			sessionRevision: 0,
			knownStateFingerprint: "",
			storage: {
				...fixture.storage,
				loadProjectFreshReadOnly: async () => {
					const readback = await fixture.storage.loadProjectFreshReadOnly();
					return readback
						? {
								...readback,
								persistence: { ...readback.persistence, writeVersion: 5 },
							}
						: null;
				},
			},
		});
		expect(writeVersionConflict).toMatchObject({
			status: "rejected",
			code: "PERSISTED_SOURCE_MISMATCH",
		});
	});

	test("accepts an immutable verified save after the browser session revision resets", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const fixture = persistedFixture({
			project,
			request,
			overrides: { receiptRevision: 9 },
		});
		const capture = await captureEditPlanPreflightSource({
			editor: buildEditor({ project, activeScene: project.scenes[0]! }),
			request,
			sessionRevision: request.expectedRevision,
			knownStateFingerprint: "",
			storage: fixture.storage,
		});

		expect(capture.status).toBe("captured");
		if (capture.status !== "captured") throw new Error(capture.reason);
		expect(capture.observation).toMatchObject({
			sessionRevision: request.expectedRevision,
			durableWriteVersion: request.expectedWriteVersion,
			saveReceiptId: request.expectedSaveReceiptId,
		});
	});

	test("rejects every durable save binding mismatch after a session reset", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const mismatches = [
			{ receiptId: "receipt-other" },
			{ projectId: "project-other" },
			{ sceneId: "scene-missing" },
			{
				contentHash: "b".repeat(64),
				readbackContentHash: "b".repeat(64),
			},
			{ storageSchemaVersion: 2 },
			{ writeVersion: request.expectedWriteVersion + 1 },
			{ completedAt: "2026-09-02T12:00:01.000Z" },
		] as const;

		for (const receipt of mismatches) {
			const fixture = persistedFixture({
				project,
				request,
				overrides: {
					receiptRevision: 9,
					receipt,
				},
			});
			const capture = await captureEditPlanPreflightSource({
				editor: buildEditor({ project, activeScene: project.scenes[0]! }),
				request,
				sessionRevision: request.expectedRevision,
				knownStateFingerprint: "",
				storage: fixture.storage,
			});

			expect(capture).toMatchObject({
				status: "rejected",
				code: "SAVE_RECEIPT_MISMATCH",
			});
		}

		const missingScene = await captureEditPlanPreflightSource({
			editor: buildEditor({ project, activeScene: project.scenes[0]! }),
			request: { ...request, sceneId: "scene-missing" },
			sessionRevision: request.expectedRevision,
			knownStateFingerprint: "",
			storage: persistedFixture({ project, request }).storage,
		});
		expect(missingScene).toMatchObject({
			status: "rejected",
			code: "PERSISTED_SOURCE_MISMATCH",
		});
	});

	test("rejects persisted project bytes that drift behind the same live hash", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const fixture = persistedFixture({ project, request });
		const drifted = structuredClone(project);
		drifted.settings.background = { type: "color", color: "#112233" };
		const capture = await captureEditPlanPreflightSource({
			editor: buildEditor({ project, activeScene: project.scenes[0]! }),
			request,
			sessionRevision: 0,
			knownStateFingerprint: "",
			storage: {
				...fixture.storage,
				loadProjectFreshReadOnly: async () => {
					const readback = await fixture.storage.loadProjectFreshReadOnly();
					return readback ? { ...readback, project: drifted } : null;
				},
			},
		});

		expect(capture).toMatchObject({
			status: "rejected",
			code: "PERSISTED_SOURCE_MISMATCH",
		});
	});

	test("fails closed on live state drift without reconciling or saving", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const editor = buildEditor({ project, activeScene: project.scenes[0]! });
		const capture = await captureEditPlanPreflightSource({
			editor,
			request,
			sessionRevision: 0,
			knownStateFingerprint: "not-the-current-state",
			storage: persistedFixture({ project, request }).storage,
		});

		expect(capture).toMatchObject({
			status: "conflict",
			code: "SOURCE_STATE_CONFLICT",
		});
		expect(editor.command.execute).not.toHaveBeenCalled();
		expect(editor.save.flush).not.toHaveBeenCalled();
	});

	test("fails closed when UI state changes during persisted source reads", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const ui = { playheadTicks: 123 };
		const editor = buildEditor({
			project,
			activeScene: project.scenes[0]!,
			ui,
		});
		const fixture = persistedFixture({ project, request });
		const capture = await captureEditPlanPreflightSource({
			editor,
			request,
			sessionRevision: 0,
			knownStateFingerprint: serializeProjectContent(
				buildEditorProjectContentInput({ project, mediaAssets: [] }),
			),
			storage: {
				...fixture.storage,
				loadProjectFreshReadOnly: async () => {
					const readback = await fixture.storage.loadProjectFreshReadOnly();
					ui.playheadTicks += 1;
					return readback;
				},
			},
		});

		expect(capture).toMatchObject({
			status: "conflict",
			code: "SOURCE_STATE_CONFLICT",
		});
		expect(editor.command.execute).not.toHaveBeenCalled();
		expect(editor.save.flush).not.toHaveBeenCalled();
	});

	test("performs no project persistence or native command writes", async () => {
		const project = buildProject();
		const request = await buildRequest(project);
		const fixture = persistedFixture({ project, request });
		const editor = buildEditor({ project, activeScene: project.scenes[0]! });
		const saveProject = mock(async () => undefined);
		const writeProject = mock(async () => undefined);
		const storage = {
			...fixture.storage,
			saveProject,
			writeProject,
		};
		const capture = await captureEditPlanPreflightSource({
			editor,
			request,
			sessionRevision: 0,
			knownStateFingerprint: "",
			storage,
		});

		expect(capture.status).toBe("captured");
		expect(saveProject).not.toHaveBeenCalled();
		expect(writeProject).not.toHaveBeenCalled();
		expect(editor.command.execute).not.toHaveBeenCalled();
		expect(editor.save.flush).not.toHaveBeenCalled();
	});
});

function buildEditor({
	project,
	activeScene,
	ui = { playheadTicks: 123 },
}: {
	project: TProject;
	activeScene: TScene;
	ui?: { playheadTicks: number };
}): EditorCore {
	const editor: EditorCore = Object.assign(Object.create(null), {
		project: {
			getActive: () => project,
			getActiveOrNull: () => project,
		},
		scenes: {
			getScenes: () => project.scenes,
			getActiveScene: () => activeScene,
		},
		media: { getAssets: () => [] },
		playback: {
			getCurrentTime: () => ui.playheadTicks,
			getIsPlaying: () => false,
		},
		selection: { getSnapshot: () => ({ selectedElements: [] }) },
		command: {
			execute: mock(() => undefined),
			getHistorySnapshot: () => ({
				activitySequence: 9,
				history: [{ entryId: 3, commandName: "PriorCommand" }],
				redo: [],
				pending: null,
				rippleEnabled: true,
			}),
		},
		save: { flush: mock(async () => null) },
	});
	return editor;
}

async function buildRequest(
	project: TProject,
): Promise<AutomationEditPlanPreflightRequest> {
	const identity = await hashProjectContent(
		buildEditorProjectContentInput({ project, mediaAssets: [] }),
	);
	if (identity.status !== "hashed") throw new Error("fixture hash blocked");
	return {
		contractVersion: 2,
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 2,
		},
		preflightId: "preflight-1",
		projectId: "project-1",
		sceneId: "scene-2",
		expectedRevision: 0,
		expectedProjectContentHash: identity.hash.digest,
		expectedWriteVersion: 4,
		saveReceiptOperationId: "save-4",
		expectedSaveReceiptId: "receipt-4",
		description: "validate title insertion",
		operations: [
			{
				kind: "insert_text",
				content: "Title",
				startTime: mediaTime({ ticks: 0 }),
				duration: mediaTime({ ticks: 120000 }),
			},
		],
		policy: {
			warningPolicy: "allow",
			providerExecution: "forbidden",
			costPolicy: "require-exact",
		},
	};
}

function persistedFixture({
	project,
	request,
	overrides = {},
}: {
	project: TProject;
	request: AutomationEditPlanPreflightRequest;
	overrides?: {
		saveOperationId?: string;
		receiptRevision?: number;
		receipt?: Partial<{
			receiptId: string;
			projectId: string;
			sceneId: string;
			contentHash: string;
			readbackContentHash: string;
			storageSchemaVersion: number;
			writeVersion: number;
			completedAt: string;
		}>;
	};
}) {
	const readCalls = { project: 0, receipt: 0 };
	const saveOperationId =
		overrides.saveOperationId ?? request.saveReceiptOperationId;
	const result = {
		status: "saved" as const,
		receiptId: request.expectedSaveReceiptId,
		operationId: saveOperationId,
		projectId: request.projectId,
		sceneId: "scene-1",
		revision: overrides.receiptRevision ?? request.expectedRevision,
		contentHash: request.expectedProjectContentHash,
		persistedAt: "2026-09-02T12:00:00.000Z",
		completedAt: "2026-09-02T12:00:00.200Z",
		storageSchemaVersion: 1,
		writeVersion: request.expectedWriteVersion,
		reloadVerified: true as const,
		readbackContentHash: request.expectedProjectContentHash,
		...overrides.receipt,
	};
	const receipt: PersistedSaveReceiptEnvelope<typeof result> = {
		id: saveOperationId,
		envelopeVersion: 1,
		storageSchemaVersion: 1,
		operationId: saveOperationId,
		fingerprint: createHash("sha256").update("save").digest("hex"),
		result,
		recordedAt: "2026-09-02T12:00:00.300Z",
	};
	return {
		readCalls,
		storage: {
			loadProjectFreshReadOnly: async () => {
				readCalls.project += 1;
				return {
					project,
					mediaAssets: [],
					persistence: {
						projectId: request.projectId,
						storageSchemaVersion: 1,
						writeVersion: request.expectedWriteVersion,
						snapshotAt: "2026-09-02T12:00:00.100Z",
						completedAt: "2026-09-02T12:00:00.200Z",
					},
				};
			},
			loadSaveReceipt: async <T extends { operationId: string }>({
				parseResult,
			}: {
				operationId: string;
				parseResult: (value: unknown) => T;
			}) => {
				readCalls.receipt += 1;
				return { ...receipt, result: parseResult(receipt.result) };
			},
		},
	};
}

function buildProject(): TProject {
	const timestamp = new Date("2026-09-02T00:00:00.000Z");
	const scene = ({ id, isMain }: { id: string; isMain: boolean }): TScene => ({
		id,
		name: id,
		isMain,
		tracks: {
			main: {
				id: `${id}-main`,
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
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	return {
		metadata: {
			id: "project-1",
			name: "Preflight fixture",
			duration: mediaTime({ ticks: 0 }),
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		scenes: [
			scene({ id: "scene-1", isMain: true }),
			scene({ id: "scene-2", isMain: false }),
		],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}
