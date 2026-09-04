import type { EditorAutomation } from "./editor-automation";
import type {
	AutomationAudioAnalysisRequest,
	AutomationAudioSyncRequest,
	AutomationAttachCleanAudioRequest,
	AutomationAttachMatteRequest,
	AutomationCreateProjectRequest,
	AutomationEditPlan,
	AutomationEditPlanPreflightRequest,
	AutomationExportRequest,
	AutomationImportRequest,
	AutomationRenameProjectRequest,
	AutomationRenameProjectResult,
	AutomationDuplicateProjectRequest,
	AutomationDuplicateProjectResult,
	AutomationDeleteProjectRequest,
	AutomationDeleteProjectResult,
	AutomationListScenesRequest,
	AutomationListScenesResult,
	AutomationCreateSceneRequest,
	AutomationCloneSceneRequest,
	AutomationSwitchSceneRequest,
	AutomationRenameSceneRequest,
	AutomationDeleteSceneRequest,
	AutomationSetMainSceneRequest,
	AutomationReorderScenesRequest,
	AutomationSceneMutationResult,
	AutomationListMediaUsagesRequest,
	AutomationListMediaUsagesResult,
	AutomationImportMediaAssetRequest,
	AutomationRenameMediaAssetRequest,
	AutomationPreflightMediaRelinkRequest,
	AutomationPreflightLifecycleMutationRequest,
	AutomationRelinkMediaAssetRequest,
	AutomationRemoveMediaAssetRequest,
	AutomationMediaMutationResult,
	AutomationImportSubtitlesRequest,
	AutomationRenderPreviewFrameRequest,
	AutomationRenderPreviewRangeRequest,
	AutomationCompareProjectStatesRequest,
	AutomationReadProjectRequest,
	AutomationExportSubtitlesRequest,
	AutomationOpenProjectRequest,
	AutomationSaveProjectRequest,
	AutomationGetSaveReceiptRequest,
	AutomationGetOperationReceiptRequest,
	AutomationGetEditPlanPreflightReceiptRequest,
	AutomationVerifyOperationReceiptRequest,
	AutomationVerifyEditPlanPreflightSourceRequest,
	AutomationStickerSearchRequest,
	AutomationTransferSourceRequest,
	AutomationTranscriptionRequest,
} from "./types";
import type { AutomationTimelineQueryRequest } from "./timeline-query";
import { readRuntimeCapabilities } from "./runtime-capabilities";

type BridgeRequest =
	| {
			kind: "request";
			id: string;
			method: "read_runtime_capabilities";
			params: object;
			target?: AutomationConnectionIdentity;
	  }
	| {
			kind: "request";
			id: string;
			method: "read_project";
			params: AutomationReadProjectRequest;
			target?: AutomationConnectionIdentity;
	  }
	| {
			kind: "request";
			id: string;
			method: "query_timeline";
			params: AutomationTimelineQueryRequest;
	  }
	| { kind: "request"; id: string; method: "list_effects"; params: object }
	| {
			kind: "request";
			id: string;
			method: "list_visual_assets";
			params: object;
	  }
	| {
			kind: "request";
			id: string;
			method: "search_stickers";
			params: AutomationStickerSearchRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "analyze_audio";
			params: AutomationAudioAnalysisRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "sync_audio";
			params: AutomationAudioSyncRequest;
	  }
	| { kind: "request"; id: string; method: "list_projects"; params: object }
	| {
			kind: "request";
			id: string;
			method: "create_project";
			params: AutomationCreateProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "open_project";
			params: AutomationOpenProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "save_project";
			params: AutomationSaveProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "recover_save_project";
			params: AutomationSaveProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "get_save_receipt";
			params: AutomationGetSaveReceiptRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "get_operation_receipt";
			params: AutomationGetOperationReceiptRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "get_edit_plan_preflight_receipt";
			params: AutomationGetEditPlanPreflightReceiptRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "verify_edit_plan_preflight_source";
			params: AutomationVerifyEditPlanPreflightSourceRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "verify_operation_receipt";
			params: AutomationVerifyOperationReceiptRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "export_project";
			params: AutomationExportRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "render_preview_frame";
			params: AutomationRenderPreviewFrameRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "render_preview_range";
			params: AutomationRenderPreviewRangeRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "compare_project_states";
			params: AutomationCompareProjectStatesRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "attach_matte";
			params: AutomationAttachMatteRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "attach_clean_audio";
			params: AutomationAttachCleanAudioRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "transfer_source_media";
			params: AutomationTransferSourceRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "rename_project";
			params: AutomationRenameProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "duplicate_project";
			params: AutomationDuplicateProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "delete_project";
			params: AutomationDeleteProjectRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "list_scenes";
			params: AutomationListScenesRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "create_scene";
			params: AutomationCreateSceneRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "clone_scene";
			params: AutomationCloneSceneRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "switch_scene";
			params: AutomationSwitchSceneRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "rename_scene";
			params: AutomationRenameSceneRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "delete_scene";
			params: AutomationDeleteSceneRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "set_main_scene";
			params: AutomationSetMainSceneRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "reorder_scenes";
			params: AutomationReorderScenesRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "preflight_lifecycle_mutation";
			params: AutomationPreflightLifecycleMutationRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "list_media_usages";
			params: AutomationListMediaUsagesRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "import_media_asset";
			params: AutomationImportMediaAssetRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "rename_media_asset";
			params: AutomationRenameMediaAssetRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "preflight_media_relink";
			params: AutomationPreflightMediaRelinkRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "relink_media_asset";
			params: AutomationRelinkMediaAssetRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "remove_media_asset";
			params: AutomationRemoveMediaAssetRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "import_media";
			params: AutomationImportRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "import_subtitles";
			params: AutomationImportSubtitlesRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "export_subtitles";
			params: AutomationExportSubtitlesRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "transcribe_timeline";
			params: AutomationTranscriptionRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "preflight_edit_plan";
			params: AutomationEditPlanPreflightRequest;
	  }
	| {
			kind: "request";
			id: string;
			method: "apply_edit_plan";
			params: AutomationEditPlan;
	  }
	| ({
			kind: "request";
			id: string;
			method: "undo";
			params: {
				projectId: string;
				expectedRevision: number;
				bridgeProtocolVersion?: number;
			};
	  } & { target?: AutomationConnectionIdentity });

type BridgeRequestWithTarget = BridgeRequest & {
	target?: AutomationConnectionIdentity;
};

type BridgeServerMessage =
	| BridgeRequestWithTarget
	| {
			kind: "authenticated";
			protocolVersion?: number;
			identity?: AutomationConnectionIdentity;
	  };

export interface AutomationConnectionIdentity {
	serverInstanceId: string;
	editorInstanceId: string;
	editorSessionId: string;
	connectionGeneration: number;
}

export const AUTOMATION_BRIDGE_PROTOCOL_VERSION = 2;
export const AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY =
	"opencut.automation.editor-instance-id";
export const AUTOMATION_TEST_DROP_RESPONSE_OPERATION_STORAGE_KEY =
	"opencut.automation.test-drop-response-operation-id";
export const AUTOMATION_TEST_DROP_RESPONSE_OPERATION_QUERY_KEY =
	"automationTestDropResponseOperationId";

interface IdentityStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export class AutomationBridgeClient {
	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = true;
	private connectionIdentity: AutomationConnectionIdentity | null = null;
	private negotiatedProtocolVersion: 1 | 2 | null = null;
	private editorInstanceId: string;
	private readonly editorSessionId: string;
	private readonly identityReady: Promise<void>;

	constructor(
		private automation: EditorAutomation,
		private options: {
			url: string;
			token: string;
			onActiveProjectChange?: (projectId: string) => void;
			afterOperationReceipt?: (details: {
				method: string;
				request: unknown;
				result: unknown;
			}) => Promise<boolean> | boolean;
			identityStorage?: IdentityStorage;
			createId?: () => string;
		},
	) {
		const createId = options.createId ?? (() => crypto.randomUUID());
		const usesBrowserStorage = options.identityStorage === undefined;
		this.editorInstanceId = getOrCreateEditorInstanceId(
			options.identityStorage ?? window.localStorage,
			createId,
		);
		this.editorSessionId = createId();
		armBrowserResponseDropFromLocation();
		this.identityReady = usesBrowserStorage
			? reconcileIndexedDbIdentity(this.editorInstanceId)
					.catch(() => this.editorInstanceId)
					.then((identity) => {
						this.editorInstanceId = identity;
						window.localStorage.setItem(
							AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY,
							identity,
						);
					})
			: Promise.resolve();
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		void this.connectAfterIdentity();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.connectionIdentity = null;
		this.negotiatedProtocolVersion = null;
		this.socket?.close(1000, "editor unmounted");
		this.socket = null;
	}

	getStatus(): {
		protocolVersion: 1 | 2 | null;
		connectionIdentity: AutomationConnectionIdentity | null;
	} {
		return {
			protocolVersion: this.negotiatedProtocolVersion,
			connectionIdentity: this.connectionIdentity,
		};
	}

	private connect(): void {
		if (this.stopped || this.socket) return;
		const socket = new WebSocket(this.options.url);
		this.socket = socket;

		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({
					kind: "authenticate",
					token: this.options.token,
					protocolVersions: [AUTOMATION_BRIDGE_PROTOCOL_VERSION, 1],
					editorInstanceId: this.editorInstanceId,
					editorSessionId: this.editorSessionId,
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			void this.handleMessage(socket, event.data);
		});
		socket.addEventListener("close", () => {
			if (this.socket === socket) {
				this.socket = null;
				this.connectionIdentity = null;
			}
			this.scheduleReconnect();
		});
		socket.addEventListener("error", () => socket.close());
	}

	private async connectAfterIdentity(): Promise<void> {
		await this.identityReady;
		this.connect();
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connectAfterIdentity();
		}, 1500);
	}

	private async handleMessage(socket: WebSocket, raw: unknown): Promise<void> {
		if (this.socket !== socket || this.stopped) return;
		if (typeof raw !== "string") return;
		let message: BridgeServerMessage;
		try {
			message = JSON.parse(raw) as BridgeServerMessage;
		} catch {
			return;
		}
		if (message.kind === "authenticated") {
			try {
				this.acceptAuthentication(message);
			} catch {
				socket.close(1002, "unsupported bridge protocol version");
			}
			return;
		}
		if (message.kind !== "request") return;

		try {
			this.validateRequestTarget(message.target);
			this.validatePayloadAffinity(message);
			const result = await this.dispatch(message);
			await this.automation.recordOperationReceipt({
				method: message.method,
				request: message.params,
				result,
			});
			if (
				(await this.options.afterOperationReceipt?.({
					method: message.method,
					request: message.params,
					result,
				})) ||
				consumeBrowserResponseDrop({
					method: message.method,
					params: message.params,
				})
			) {
				// This test-only fault point models an abrupt browser/editor shutdown after
				// the durable receipt commits and before a response can be delivered.
				// stop() clears identity synchronously and prevents an automatic reconnect.
				this.stop();
				return;
			}
			if (this.socket !== socket || this.stopped) return;
			this.sendResponse(socket, {
				kind: "response",
				id: message.id,
				ok: true,
				result,
				...(this.connectionIdentity
					? { identity: this.connectionIdentity }
					: {}),
			});
			const activatedProjectId = getActivatedProjectId(result);
			if (
				activatedProjectId &&
				(message.method === "create_project" ||
					message.method === "open_project" ||
					message.method === "delete_project")
			) {
				queueMicrotask(() =>
					this.options.onActiveProjectChange?.(activatedProjectId),
				);
			}
		} catch (error) {
			this.sendResponse(socket, {
				kind: "response",
				id: message.id,
				ok: false,
				error: asProtocolError(error),
				...(this.connectionIdentity
					? { identity: this.connectionIdentity }
					: {}),
			});
		}
	}

	private acceptAuthentication(message: {
		protocolVersion?: number;
		identity?: AutomationConnectionIdentity;
	}): void {
		if (
			message.protocolVersion === undefined &&
			message.identity === undefined
		) {
			this.negotiatedProtocolVersion = 1;
			this.connectionIdentity = null;
			return;
		}
		if (message.protocolVersion === 1) {
			this.negotiatedProtocolVersion = 1;
			this.connectionIdentity = null;
			return;
		}
		if (message.protocolVersion !== AUTOMATION_BRIDGE_PROTOCOL_VERSION) {
			throw new AutomationBridgeProtocolError(
				"PROTOCOL_MISMATCH",
				`Server negotiated unsupported bridge protocol ${String(message.protocolVersion)}`,
			);
		}
		if (
			!isConnectionIdentity(message.identity) ||
			message.identity.editorInstanceId !== this.editorInstanceId ||
			message.identity.editorSessionId !== this.editorSessionId
		) {
			throw new AutomationBridgeProtocolError(
				"STALE_CONNECTION",
				"Server authenticated a different editor identity",
			);
		}
		this.negotiatedProtocolVersion = AUTOMATION_BRIDGE_PROTOCOL_VERSION;
		this.connectionIdentity = message.identity;
	}

	private validateRequestTarget(
		target: AutomationConnectionIdentity | undefined,
	): void {
		if (this.negotiatedProtocolVersion === 1) {
			if (target) {
				throw new AutomationBridgeProtocolError(
					"PROTOCOL_MISMATCH",
					"Legacy bridge protocol requests cannot carry a v2 target",
				);
			}
			return;
		}
		if (!this.connectionIdentity) {
			throw new AutomationBridgeProtocolError(
				"PROTOCOL_MISMATCH",
				"Editor received a request before protocol authentication completed",
			);
		}
		if (!target || !identitiesEqual(target, this.connectionIdentity)) {
			throw new AutomationBridgeProtocolError(
				"STALE_CONNECTION",
				"Request target does not match this editor connection",
				{
					expectedIdentity: this.connectionIdentity,
					actualIdentity: target ?? null,
				},
			);
		}
	}

	private validatePayloadAffinity(message: BridgeRequest): void {
		if (
			message.method !== "preflight_edit_plan" &&
			message.method !== "apply_edit_plan"
		) {
			return;
		}
		if (message.params.bridgeProtocolVersion !== 2) return;
		if (
			!this.connectionIdentity ||
			!identitiesEqual(
				message.params.expectedConnectionIdentity,
				this.connectionIdentity,
			)
		) {
			throw new AutomationBridgeProtocolError(
				"STALE_CONNECTION",
				"Edit-plan source identity does not match this editor connection",
				{
					expectedIdentity: this.connectionIdentity,
					actualIdentity: message.params.expectedConnectionIdentity,
				},
			);
		}
	}

	private dispatch(message: BridgeRequest): unknown | Promise<unknown> {
		switch (message.method) {
			case "read_runtime_capabilities":
				return readRuntimeCapabilities();
			case "read_project":
				return this.automation.readProject(message.params);
			case "query_timeline":
				return this.automation.queryTimeline(message.params);
			case "list_effects":
				return this.automation.listEffects();
			case "list_visual_assets":
				return this.automation.listVisualAssets();
			case "search_stickers":
				return this.automation.searchStickers(message.params);
			case "analyze_audio":
				return this.automation.analyzeAudio(message.params);
			case "sync_audio":
				return this.automation.syncAudio(message.params);
			case "list_projects":
				return this.automation.listProjects();
			case "create_project":
				return this.automation.createProject(message.params);
			case "open_project":
				return this.automation.openProject(message.params);
			case "save_project":
				return this.automation.saveProject(message.params);
			case "recover_save_project":
				return this.automation.recoverSaveProject(message.params);
			case "get_save_receipt":
				return this.automation.getSaveReceipt(message.params);
			case "get_operation_receipt":
				return this.automation.getOperationReceipt(message.params);
			case "get_edit_plan_preflight_receipt":
				return this.automation.getEditPlanPreflightReceipt(message.params);
			case "verify_edit_plan_preflight_source":
				return this.automation.verifyEditPlanPreflightSource(message.params);
			case "verify_operation_receipt":
				return this.automation.verifyOperationReceipt(message.params);
			case "apply_edit_plan":
				return this.automation.applyEditPlan(message.params);
			case "preflight_edit_plan":
				return this.automation.preflightEditPlan(message.params);
			case "export_project":
				return this.automation.exportProject(message.params);
			case "render_preview_frame":
				return this.automation.renderPreviewFrame(message.params);
			case "render_preview_range":
				return this.automation.renderPreviewRange(message.params);
			case "compare_project_states":
				return this.automation.compareProjectStates(message.params);
			case "rename_project":
				return this.automation.renameProject(message.params);
			case "duplicate_project":
				return this.automation.duplicateProject(message.params);
			case "delete_project":
				return this.automation.deleteProject(message.params);
			case "preflight_lifecycle_mutation":
				return this.automation.preflightLifecycleMutation(message.params);
			case "list_scenes":
				return this.automation.listScenes(message.params);
			case "create_scene":
				return this.automation.createScene(message.params);
			case "clone_scene":
				return this.automation.cloneScene(message.params);
			case "switch_scene":
				return this.automation.switchScene(message.params);
			case "rename_scene":
				return this.automation.renameScene(message.params);
			case "delete_scene":
				return this.automation.deleteScene(message.params);
			case "set_main_scene":
				return this.automation.setMainScene(message.params);
			case "reorder_scenes":
				return this.automation.reorderScenes(message.params);
			case "list_media_usages":
				return this.automation.listMediaUsages(message.params);
			case "import_media_asset":
				return this.automation.importMediaAsset(message.params);
			case "rename_media_asset":
				return this.automation.renameMediaAsset(message.params);
			case "preflight_media_relink":
				return this.automation.preflightMediaRelink(message.params);
			case "relink_media_asset":
				return this.automation.relinkMediaAsset(message.params);
			case "remove_media_asset":
				return this.automation.removeMediaAsset(message.params);
			case "import_media":
				return this.automation.importMedia(message.params);
			case "import_subtitles":
				return this.automation.importSubtitles(message.params);
			case "export_subtitles":
				return this.automation.exportSubtitles(message.params);
			case "transcribe_timeline":
				return this.automation.transcribeTimeline(message.params);
			case "attach_matte":
				return this.automation.attachMatte(message.params);
			case "attach_clean_audio":
				return this.automation.attachCleanAudio(message.params);
			case "transfer_source_media":
				return this.automation.transferSourceMedia(message.params);
			case "undo":
				return this.automation.undo(message.params);
		}
	}

	private sendResponse(socket: WebSocket, response: object): void {
		if (this.socket === socket && socket.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify(response));
	}
}

function consumeBrowserResponseDrop({
	method,
	params,
}: {
	method: string;
	params: unknown;
}): boolean {
	if (typeof window === "undefined" || !isRecord(params)) return false;
	const binding = isRecord(params.operationReceiptBinding)
		? params.operationReceiptBinding
		: null;
	const operationId =
		typeof binding?.outerOperationId === "string"
			? binding.outerOperationId
			: method === "preflight_edit_plan" &&
				  typeof params.preflightId === "string"
				? params.preflightId
				: undefined;
	if (typeof operationId !== "string") return false;
	try {
		if (
			window.sessionStorage.getItem(
				AUTOMATION_TEST_DROP_RESPONSE_OPERATION_STORAGE_KEY,
			) !== operationId
		)
			return false;
		window.sessionStorage.removeItem(
			AUTOMATION_TEST_DROP_RESPONSE_OPERATION_STORAGE_KEY,
		);
		return true;
	} catch {
		return false;
	}
}

function armBrowserResponseDropFromLocation(): void {
	if (typeof window === "undefined") return;
	try {
		const operationId = new URL(window.location.href).searchParams.get(
			AUTOMATION_TEST_DROP_RESPONSE_OPERATION_QUERY_KEY,
		);
		if (operationId) {
			window.sessionStorage.setItem(
				AUTOMATION_TEST_DROP_RESPONSE_OPERATION_STORAGE_KEY,
				operationId,
			);
		}
	} catch {
		// Test fault injection is optional and must not affect normal startup.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class AutomationBridgeProtocolError extends Error {
	constructor(
		readonly code:
			| "STALE_CONNECTION"
			| "EDITOR_DISCONNECTED"
			| "PROTOCOL_MISMATCH",
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AutomationBridgeProtocolError";
	}
}

export function getOrCreateEditorInstanceId(
	storage: IdentityStorage,
	createId: () => string = () => crypto.randomUUID(),
): string {
	const existing = storage.getItem(AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY);
	if (existing?.trim()) return existing;
	const created = createId();
	if (!created.trim()) throw new Error("Generated editor instance ID is empty");
	storage.setItem(AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY, created);
	if (storage.getItem(AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY) !== created) {
		throw new Error("Editor instance identity could not be persisted");
	}
	return created;
}

async function reconcileIndexedDbIdentity(
	localIdentity: string,
): Promise<string> {
	if (typeof indexedDB === "undefined") return localIdentity;
	return new Promise((resolve, reject) => {
		const open = indexedDB.open("opencut-automation", 1);
		open.onerror = () =>
			reject(open.error ?? new Error("identity database failed"));
		open.onupgradeneeded = () => {
			if (!open.result.objectStoreNames.contains("identity")) {
				open.result.createObjectStore("identity");
			}
		};
		open.onsuccess = () => {
			const database = open.result;
			const transaction = database.transaction("identity", "readwrite");
			const store = transaction.objectStore("identity");
			const read = store.get("editor-instance-id");
			let resolvedIdentity = localIdentity;
			read.onerror = () =>
				reject(read.error ?? new Error("identity read failed"));
			read.onsuccess = () => {
				if (typeof read.result === "string" && read.result.trim()) {
					resolvedIdentity = read.result;
				} else {
					store.put(localIdentity, "editor-instance-id");
				}
			};
			transaction.oncomplete = () => {
				database.close();
				resolve(resolvedIdentity);
			};
			transaction.onerror = () => {
				database.close();
				reject(transaction.error ?? new Error("identity write failed"));
			};
		};
	});
}

function isConnectionIdentity(
	value: unknown,
): value is AutomationConnectionIdentity {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.serverInstanceId === "string" &&
		!!record.serverInstanceId &&
		typeof record.editorInstanceId === "string" &&
		!!record.editorInstanceId &&
		typeof record.editorSessionId === "string" &&
		!!record.editorSessionId &&
		typeof record.connectionGeneration === "number" &&
		Number.isSafeInteger(record.connectionGeneration) &&
		record.connectionGeneration > 0
	);
}

function identitiesEqual(
	left: AutomationConnectionIdentity,
	right: AutomationConnectionIdentity,
): boolean {
	return (
		left.serverInstanceId === right.serverInstanceId &&
		left.editorInstanceId === right.editorInstanceId &&
		left.editorSessionId === right.editorSessionId &&
		left.connectionGeneration === right.connectionGeneration
	);
}

function asProtocolError(error: unknown):
	| string
	| {
			code: string;
			message: string;
			details?: Record<string, unknown>;
	  } {
	if (error instanceof AutomationBridgeProtocolError) {
		return {
			code: error.code,
			message: error.message,
			...(error.details ? { details: error.details } : {}),
		};
	}
	return error instanceof Error ? error.message : "unknown editor error";
}

function getActivatedProjectId(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	if (
		!("status" in value) ||
		(value.status !== "created" &&
			value.status !== "opened" &&
			value.status !== "deleted" &&
			value.status !== "replayed")
	) {
		return null;
	}
	return "projectId" in value && typeof value.projectId === "string"
		? value.projectId
		: null;
}
