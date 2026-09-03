import type { EditorCore } from "@/core";
import type { CommandHistorySnapshot } from "@/core/managers/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { storageService } from "@/services/storage/service";
import type {
	FreshProjectReadback,
	PersistedSaveReceiptEnvelope,
} from "@/services/storage/types";
import type { TScene } from "@/timeline";
import { mediaTime, type MediaTime } from "@/wasm";
import type {
	AutomationConnectionIdentityV2,
	AutomationNoMutationObservation,
} from "./types";
import {
	buildEditorProjectContentInput,
	hashEditorProjectContent,
	serializeEditorProjectContent,
} from "./project-content-identity";
import {
	canonicalSerialize,
	hashProjectContent,
	type ProjectContentHashResult,
} from "./project-content-hash";
import {
	parsePersistedSaveProjectResult,
	type PersistedAutomationSaveResult,
} from "./save-project-receipt";

export type PreflightSourceFailure =
	| {
			status: "conflict";
			code: "SOURCE_STATE_CONFLICT";
			reason: string;
	  }
	| {
			status: "rejected";
			code:
				| "PERSISTED_SOURCE_UNAVAILABLE"
				| "PERSISTED_SOURCE_MISMATCH"
				| "SAVE_RECEIPT_MISMATCH";
			reason: string;
	  };

export type PreflightSourceCapture =
	| PreflightSourceFailure
	| {
			status: "captured";
			readback: FreshProjectReadback;
			scene: TScene;
			contentIdentity: Extract<ProjectContentHashResult, { status: "hashed" }>;
			observation: AutomationNoMutationObservation;
	  };

export interface EditPlanSourceRequest {
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: AutomationConnectionIdentityV2;
	projectId: string;
	sceneId: string;
	expectedRevision: number;
	expectedProjectContentHash: string;
	expectedWriteVersion: number;
	saveReceiptOperationId: string;
	expectedSaveReceiptId: string;
}

interface EditorUiObservation {
	activeProjectId: string;
	activeSceneId: string;
	playheadTicks: MediaTime;
	isPlaying: boolean;
	selection: EditorSelectionSnapshot;
	history: CommandHistorySnapshot;
}

interface PreflightSourceStorage {
	loadProjectFreshReadOnly(args: {
		id: string;
	}): Promise<FreshProjectReadback | null>;
	loadSaveReceipt<T extends { operationId: string }>(args: {
		operationId: string;
		parseResult: (value: unknown) => T;
	}): Promise<PersistedSaveReceiptEnvelope<T> | null>;
}

export async function captureEditPlanPreflightSource({
	editor,
	request,
	sessionRevision,
	knownStateFingerprint,
	storage = storageService,
}: {
	editor: EditorCore;
	request: EditPlanSourceRequest;
	sessionRevision: number;
	knownStateFingerprint: string;
	storage?: PreflightSourceStorage;
}): Promise<PreflightSourceCapture> {
	const activeProject = editor.project.getActiveOrNull();
	const activeScene = activeProject ? editor.scenes.getActiveScene() : null;
	if (
		!activeProject ||
		!activeScene ||
		activeProject.metadata.id !== request.projectId ||
		sessionRevision !== request.expectedRevision
	) {
		return conflict("active project or session revision does not match source");
	}
	const capturedLiveState = serializeEditorProjectContent(editor);
	const capturedUiState = captureEditorUiObservation(editor);
	if (knownStateFingerprint && capturedLiveState !== knownStateFingerprint) {
		return conflict("active editor state changed outside the automation session");
	}
	const liveIdentity = await hashEditorProjectContent(editor);
	if (
		liveIdentity.status !== "hashed" ||
		liveIdentity.hash.digest !== request.expectedProjectContentHash ||
		serializeEditorProjectContent(editor) !== capturedLiveState
	) {
		return conflict("active project content does not match source hash");
	}

	let readback: FreshProjectReadback | null;
	let saved: PersistedSaveReceiptEnvelope<PersistedAutomationSaveResult> | null;
	try {
		[readback, saved] = await Promise.all([
			storage.loadProjectFreshReadOnly({ id: request.projectId }),
			storage.loadSaveReceipt({
				operationId: request.saveReceiptOperationId,
				parseResult: parsePersistedSaveProjectResult,
			}),
		]);
	} catch (error) {
		return {
			status: "rejected",
			code: "PERSISTED_SOURCE_UNAVAILABLE",
			reason:
				error instanceof Error
					? error.message
					: "persisted source could not be read",
		};
	}
	if (!readback) {
		return {
			status: "rejected",
			code: "PERSISTED_SOURCE_UNAVAILABLE",
			reason: "persisted project could not be freshly read",
		};
	}
	const requestedScene = readback.project.scenes.find(
		(scene) => scene.id === request.sceneId,
	);
	if (
		readback.project.metadata.id !== request.projectId ||
		!requestedScene ||
		readback.persistence.projectId !== request.projectId ||
		readback.persistence.writeVersion !== request.expectedWriteVersion
	) {
		return {
			status: "rejected",
			code: "PERSISTED_SOURCE_MISMATCH",
			reason: "persisted project, scene, or write version does not match source",
		};
	}
	const persistedIdentity = await hashProjectContent(
		buildEditorProjectContentInput({
			project: readback.project,
			mediaAssets: readback.mediaAssets,
		}),
	);
	if (
		persistedIdentity.status !== "hashed" ||
		persistedIdentity.hash.digest !== request.expectedProjectContentHash
	) {
		return {
			status: "rejected",
			code: "PERSISTED_SOURCE_MISMATCH",
			reason: "persisted canonical project hash does not match source",
		};
	}
	if (!saved || !matchesSaveReceipt({ request, readback, saved })) {
		return {
			status: "rejected",
			code: "SAVE_RECEIPT_MISMATCH",
			reason: "verified save receipt does not bind the persisted source",
		};
	}
	if (
		serializeEditorProjectContent(editor) !== capturedLiveState ||
		canonicalSerialize(captureEditorUiObservation(editor)) !==
			canonicalSerialize(capturedUiState)
	) {
		return conflict("active editor or UI state changed while reading source");
	}
	const observation = await buildObservation({
		request,
		ui: capturedUiState,
		readback,
		saved,
	});
	return {
		status: "captured",
		readback,
		scene: requestedScene,
		contentIdentity: persistedIdentity,
		observation,
	};
}

function matchesSaveReceipt({
	request,
	readback,
	saved,
}: {
	request: EditPlanSourceRequest;
	readback: FreshProjectReadback;
	saved: PersistedSaveReceiptEnvelope<PersistedAutomationSaveResult>;
}): boolean {
	const receipt = saved.result;
	return (
		saved.id === request.saveReceiptOperationId &&
		saved.operationId === request.saveReceiptOperationId &&
		receipt.operationId === request.saveReceiptOperationId &&
		receipt.receiptId === request.expectedSaveReceiptId &&
		receipt.projectId === request.projectId &&
		readback.project.scenes.some((scene) => scene.id === receipt.sceneId) &&
		receipt.contentHash === request.expectedProjectContentHash &&
		receipt.readbackContentHash === request.expectedProjectContentHash &&
		receipt.storageSchemaVersion === readback.persistence.storageSchemaVersion &&
		receipt.writeVersion === request.expectedWriteVersion &&
		receipt.writeVersion === readback.persistence.writeVersion &&
		receipt.completedAt === readback.persistence.completedAt &&
		receipt.reloadVerified === true
	);
}

async function buildObservation({
	request,
	ui,
	readback,
	saved,
}: {
	request: EditPlanSourceRequest;
	ui: EditorUiObservation;
	readback: FreshProjectReadback;
	saved: PersistedSaveReceiptEnvelope<PersistedAutomationSaveResult>;
}): Promise<AutomationNoMutationObservation> {
	const hash = (value: unknown) => sha256(canonicalSerialize(value));
	return {
		projectId: request.projectId,
		sceneId: request.sceneId,
		sessionRevision: request.expectedRevision,
		canonicalProjectHash: request.expectedProjectContentHash,
		durableWriteVersion: request.expectedWriteVersion,
		saveReceiptId: request.expectedSaveReceiptId,
		saveOperationId: request.saveReceiptOperationId,
		connectionIdentity: {
			...request.expectedConnectionIdentity,
			bridgeProtocolVersion: 2,
		},
		activeProjectId: ui.activeProjectId,
		activeSceneId: ui.activeSceneId,
		playheadTicks: ui.playheadTicks,
		isPlaying: ui.isPlaying,
		selectionFingerprint: await hash(ui.selection),
		historyFingerprint: await hash(ui.history),
		persistenceFingerprint: await hash({
			persistence: readback.persistence,
			saveReceipt: saved,
			media: readback.mediaAssets
				.map((asset) => ({
					id: asset.id,
					size: asset.file.size,
					lastModified: asset.file.lastModified,
					sourceFingerprint: asset.sourceFingerprint ?? null,
					sourceIdentity: asset.sourceIdentity,
				}))
				.sort((left, right) =>
					left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
				),
		}),
	};
}

function captureEditorUiObservation(editor: EditorCore): EditorUiObservation {
	const project = editor.project.getActiveOrNull();
	if (!project) throw new Error("No active editor source");
	const scene = editor.scenes.getActiveScene();
	return {
		activeProjectId: project.metadata.id,
		activeSceneId: scene.id,
		playheadTicks: mediaTime({ ticks: editor.playback.getCurrentTime() }),
		isPlaying: editor.playback.getIsPlaying(),
		selection: editor.selection.getSnapshot(),
		history: editor.command.getHistorySnapshot(),
	};
}

function conflict(reason: string): PreflightSourceFailure {
	return { status: "conflict", code: "SOURCE_STATE_CONFLICT", reason };
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
