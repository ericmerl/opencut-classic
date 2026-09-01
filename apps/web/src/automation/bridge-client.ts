import type { EditorAutomation } from "./editor-automation";
import type {
	AutomationAudioAnalysisRequest,
	AutomationCreateProjectRequest,
	AutomationEditPlan,
	AutomationExportRequest,
	AutomationImportRequest,
	AutomationOpenProjectRequest,
} from "./types";

type BridgeRequest =
	| { kind: "request"; id: string; method: "read_project"; params: object }
	| { kind: "request"; id: string; method: "list_effects"; params: object }
	| {
			kind: "request";
			id: string;
			method: "analyze_audio";
			params: AutomationAudioAnalysisRequest;
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
			method: "export_project";
			params: AutomationExportRequest;
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
			method: "apply_edit_plan";
			params: AutomationEditPlan;
	  }
	| {
			kind: "request";
			id: string;
			method: "undo";
			params: { projectId: string; expectedRevision: number };
	  };

type BridgeServerMessage = BridgeRequest | { kind: "authenticated" };

export class AutomationBridgeClient {
	private socket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = true;

	constructor(
		private automation: EditorAutomation,
		private options: {
			url: string;
			token: string;
			onActiveProjectChange?: (projectId: string) => void;
		},
	) {}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.socket?.close(1000, "editor unmounted");
		this.socket = null;
	}

	private connect(): void {
		if (this.stopped || this.socket) return;
		const socket = new WebSocket(this.options.url);
		this.socket = socket;

		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({ kind: "authenticate", token: this.options.token }),
			);
		});
		socket.addEventListener("message", (event) => {
			void this.handleMessage(socket, event.data);
		});
		socket.addEventListener("close", () => {
			if (this.socket === socket) this.socket = null;
			this.scheduleReconnect();
		});
		socket.addEventListener("error", () => socket.close());
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, 1500);
	}

	private async handleMessage(socket: WebSocket, raw: unknown): Promise<void> {
		if (typeof raw !== "string") return;
		let message: BridgeServerMessage;
		try {
			message = JSON.parse(raw) as BridgeServerMessage;
		} catch {
			return;
		}
		if (message.kind !== "request") return;

		try {
			const result = await this.dispatch(message);
			this.sendResponse(socket, {
				kind: "response",
				id: message.id,
				ok: true,
				result,
			});
			const activatedProjectId = getActivatedProjectId(result);
			if (
				activatedProjectId &&
				(message.method === "create_project" ||
					message.method === "open_project")
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
				error: error instanceof Error ? error.message : "unknown editor error",
			});
		}
	}

	private dispatch(message: BridgeRequest): unknown | Promise<unknown> {
		switch (message.method) {
			case "read_project":
				return this.automation.readProject();
			case "list_effects":
				return this.automation.listEffects();
			case "analyze_audio":
				return this.automation.analyzeAudio(message.params);
			case "list_projects":
				return this.automation.listProjects();
			case "create_project":
				return this.automation.createProject(message.params);
			case "open_project":
				return this.automation.openProject(message.params);
			case "apply_edit_plan":
				return this.automation.applyEditPlan(message.params);
			case "export_project":
				return this.automation.exportProject(message.params);
			case "import_media":
				return this.automation.importMedia(message.params);
			case "undo":
				return this.automation.undo(message.params);
		}
	}

	private sendResponse(socket: WebSocket, response: object): void {
		if (socket.readyState === WebSocket.OPEN)
			socket.send(JSON.stringify(response));
	}
}

function getActivatedProjectId(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	if (
		!("status" in value) ||
		(value.status !== "created" &&
			value.status !== "opened" &&
			value.status !== "replayed")
	) {
		return null;
	}
	return "projectId" in value && typeof value.projectId === "string"
		? value.projectId
		: null;
}
