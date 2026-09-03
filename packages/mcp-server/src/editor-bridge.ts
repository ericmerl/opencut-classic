import { randomUUID, timingSafeEqual } from "node:crypto";
import { BootstrapTickets } from "./bootstrap-tickets";
import { ExportTickets } from "./export-tickets";
import { MediaTickets } from "./media-tickets";
import { SourceTickets } from "./source-tickets";
import { PreviewEvidenceStore } from "./preview-evidence-store";
import { RangePreviewEvidenceStore } from "./range-preview-evidence-store";
import { ComparisonEvidenceStore } from "./comparison-evidence-store";
import { nativeComparison } from "./native-comparison";
import { readPreviewRangeLimits } from "./range-preview-config";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SocketData {
	authenticated: boolean;
	authTimer: ReturnType<typeof setTimeout> | null;
	protocolVersion: number | null;
	identity: BridgeConnectionIdentity | null;
	observedProjectRevisions: Map<string, number>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	socket: EditorSocket;
	identity: BridgeConnectionIdentity;
	requestIdentity: BridgeConnectionIdentity | null;
	protocolVersion: 1 | 2;
	method: string;
}

type EditorSocket = Bun.ServerWebSocket<SocketData>;

export const CURRENT_BRIDGE_PROTOCOL_VERSION = 2;
export const SUPPORTED_BRIDGE_PROTOCOL_VERSIONS = [2, 1] as const;

export interface BridgeConnectionIdentity {
	serverInstanceId: string;
	editorInstanceId: string;
	editorSessionId: string;
	connectionGeneration: number;
}

export class BridgeProtocolError extends Error {
	constructor(
		readonly code:
			| "STALE_CONNECTION"
			| "EDITOR_DISCONNECTED"
			| "PROTOCOL_MISMATCH",
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "BridgeProtocolError";
	}
}

export class EditorBridge {
	private activeSocket: EditorSocket | null = null;
	private connectionListeners = new Set<(connected: boolean) => void>();
	private pending = new Map<string, PendingRequest>();
	private server: Bun.Server<SocketData>;
	private bootstrapTickets = new BootstrapTickets();
	private connectionGeneration = 0;
	private readonly serverInstanceId: string;
	readonly exportTickets: ExportTickets;
	readonly mediaTickets: MediaTickets;
	readonly sourceTickets: SourceTickets;
	readonly previewEvidence: PreviewEvidenceStore;
	readonly rangePreviewEvidence: RangePreviewEvidenceStore;
	readonly comparisonEvidence: ComparisonEvidenceStore;

	constructor(
		private options: {
			token: string;
			port: number;
			requestTimeoutMs?: number;
			serverInstanceId?: string;
			previewEvidence?: PreviewEvidenceStore;
			rangePreviewEvidence?: RangePreviewEvidenceStore;
			comparisonEvidence?: ComparisonEvidenceStore;
		},
	) {
		this.serverInstanceId = options.serverInstanceId ?? randomUUID();
		this.exportTickets = new ExportTickets(options.port);
		this.mediaTickets = new MediaTickets(options.port);
		this.sourceTickets = new SourceTickets(options.port);
		this.previewEvidence =
			options.previewEvidence ??
			new PreviewEvidenceStore(
				join(tmpdir(), `opencut-preview-${this.serverInstanceId}`),
				options.port,
			);
		this.rangePreviewEvidence =
			options.rangePreviewEvidence ??
			new RangePreviewEvidenceStore(
				join(tmpdir(), `opencut-preview-ranges-${this.serverInstanceId}`),
				options.port,
				readPreviewRangeLimits(),
			);
		this.comparisonEvidence =
			options.comparisonEvidence ??
			new ComparisonEvidenceStore(
				join(tmpdir(), `opencut-comparisons-${this.serverInstanceId}`),
				options.port,
				readPreviewRangeLimits(),
				nativeComparison,
			);
		this.server = Bun.serve<SocketData>({
			hostname: "127.0.0.1",
			port: options.port,
			fetch: (request, server) => this.handleUpgrade(request, server),
			websocket: {
				open: (socket) => this.handleOpen(socket),
				message: (socket, message) => this.handleMessage(socket, message),
				close: (socket) => this.handleClose(socket),
			},
		});
	}

	getStatus(): {
		connected: boolean;
		host: "127.0.0.1";
		port: number;
		serverInstanceId: string;
		supportedProtocolVersions: readonly number[];
		negotiatedProtocolVersion: number | null;
		connectionIdentity: BridgeConnectionIdentity | null;
	} {
		return {
			connected: this.activeSocket !== null,
			host: "127.0.0.1",
			port: this.options.port,
			serverInstanceId: this.serverInstanceId,
			supportedProtocolVersions: SUPPORTED_BRIDGE_PROTOCOL_VERSIONS,
			negotiatedProtocolVersion:
				this.activeSocket?.data.protocolVersion ?? null,
			connectionIdentity: this.activeSocket?.data.identity ?? null,
		};
	}

	onConnectionChange(listener: (connected: boolean) => void): () => void {
		this.connectionListeners.add(listener);
		return () => this.connectionListeners.delete(listener);
	}

	createBootstrapTicket(): { id: string; expiresAt: string } {
		return this.bootstrapTickets.create();
	}

	waitForConnection(timeoutMs = 30_000): Promise<void> {
		if (this.activeSocket) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error("Timed out waiting for an OpenCut editor worker"));
			}, timeoutMs);
			unsubscribe = this.onConnectionChange((connected) => {
				if (!connected) return;
				clearTimeout(timer);
				unsubscribe();
				resolve();
			});
			if (this.activeSocket) {
				clearTimeout(timer);
				unsubscribe();
				resolve();
			}
		});
	}

	waitForDisconnection(timeoutMs = 5_000): Promise<void> {
		if (!this.activeSocket) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const timer = setTimeout(() => {
				unsubscribe();
				reject(
					new Error("Timed out waiting for the OpenCut editor to disconnect"),
				);
			}, timeoutMs);
			unsubscribe = this.onConnectionChange((connected) => {
				if (connected) return;
				clearTimeout(timer);
				unsubscribe();
				resolve();
			});
			if (!this.activeSocket) {
				clearTimeout(timer);
				unsubscribe();
				resolve();
			}
		});
	}

	request(
		method: string,
		params: unknown,
		timeoutMs = this.options.requestTimeoutMs ?? 30_000,
		expectedIdentity?: BridgeConnectionIdentity,
	): Promise<unknown> {
		const socket = this.activeSocket;
		if (!socket)
			throw new BridgeProtocolError(
				"EDITOR_DISCONNECTED",
				"No authenticated OpenCut editor is connected",
			);
		const identity = socket.data.identity;
		const protocolVersion = socket.data.protocolVersion;
		if (!identity) {
			throw new BridgeProtocolError(
				"PROTOCOL_MISMATCH",
				"Authenticated editor connection has no identity",
			);
		}
		if (protocolVersion !== 1 && protocolVersion !== 2) {
			throw new BridgeProtocolError(
				"PROTOCOL_MISMATCH",
				"Authenticated editor connection has no negotiated protocol",
			);
		}
		const declaredProtocolVersion = readDeclaredProtocolVersion(params);
		if (
			declaredProtocolVersion !== null &&
			declaredProtocolVersion !== protocolVersion
		) {
			throw new BridgeProtocolError(
				"PROTOCOL_MISMATCH",
				`Request declares bridge protocol v${declaredProtocolVersion}, but the editor negotiated v${protocolVersion}`,
				{ declaredProtocolVersion, negotiatedProtocolVersion: protocolVersion },
			);
		}
		if (declaredProtocolVersion === 1 && expectedIdentity) {
			throw new BridgeProtocolError(
				"PROTOCOL_MISMATCH",
				"Bridge protocol v1 requests cannot declare v2 connection affinity",
			);
		}
		const declaredIdentity = readDeclaredConnectionIdentity(params);
		if (
			expectedIdentity &&
			declaredIdentity &&
			!identitiesEqual(expectedIdentity, declaredIdentity)
		) {
			throw new BridgeProtocolError(
				"STALE_CONNECTION",
				"Request identity arguments disagree",
				{ expectedIdentity, declaredIdentity },
			);
		}
		const requestIdentity = expectedIdentity ?? declaredIdentity;
		if (requestIdentity && !identitiesEqual(requestIdentity, identity)) {
			throw new BridgeProtocolError(
				"STALE_CONNECTION",
				"Editor connection identity changed before request dispatch",
				{ expectedIdentity: requestIdentity, actualIdentity: identity },
			);
		}
		this.assertObservedRevision(socket, method, params);
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Editor request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				timer,
				socket,
				identity,
				requestIdentity,
				protocolVersion,
				method,
			});
			socket.send(
				JSON.stringify({
					kind: "request",
					id,
					method,
					params,
					...(socket.data.protocolVersion === CURRENT_BRIDGE_PROTOCOL_VERSION
						? { target: identity }
						: {}),
				}),
			);
		});
	}

	stop(): void {
		this.activeSocket?.close(1001, "MCP server stopping");
		this.rejectPending("MCP server stopped");
		this.server.stop(true);
	}

	private async handleUpgrade(
		request: Request,
		server: Bun.Server<SocketData>,
	): Promise<Response | undefined> {
		const url = new URL(request.url);
		const origin = request.headers.get("origin");
		if (origin && !isAllowedOrigin(origin)) {
			return new Response("Forbidden origin", { status: 403 });
		}
		if (url.pathname.startsWith("/export/")) {
			return this.handleExportRequest(request, url, origin);
		}
		if (url.pathname.startsWith("/preview/")) {
			return this.handlePreviewRequest(request, url, origin);
		}
		if (url.pathname.startsWith("/preview-range/")) {
			return this.handlePreviewRangeRequest(request, url, origin);
		}
		if (url.pathname.startsWith("/comparison-capture/")) {
			return this.handleComparisonCaptureRequest(request, url, origin);
		}
		if (url.pathname.startsWith("/bootstrap/")) {
			return this.handleBootstrapRequest(request, url, origin);
		}
		if (url.pathname.startsWith("/source/")) {
			return this.handleSourceRequest(request, url, origin);
		}
		if (url.pathname.startsWith("/media/")) {
			const ticket = this.mediaTickets.take(
				url.pathname.slice("/media/".length),
			);
			if (!ticket) {
				return new Response("Expired or invalid media ticket", { status: 404 });
			}
			return new Response(ticket.file, {
				headers: {
					"Content-Type": ticket.mimeType,
					"Access-Control-Allow-Origin": origin ?? "http://127.0.0.1",
					"Cache-Control": "no-store",
				},
			});
		}
		if (url.pathname !== "/editor") {
			return new Response("Not found", { status: 404 });
		}
		return server.upgrade(request, {
			data: {
				authenticated: false,
				authTimer: null,
				protocolVersion: null,
				identity: null,
				observedProjectRevisions: new Map(),
			},
		})
			? undefined
			: new Response("WebSocket upgrade failed", { status: 400 });
	}

	private handleBootstrapRequest(
		request: Request,
		url: URL,
		origin: string | null,
	): Response {
		const id = url.pathname.slice("/bootstrap/".length);
		const headers = bootstrapCorsHeaders(origin);
		if (request.method === "OPTIONS") {
			return this.bootstrapTickets.has(id)
				? new Response(null, { status: 204, headers })
				: new Response("Expired or invalid bootstrap ticket", {
						status: 404,
						headers,
					});
		}
		if (request.method !== "GET") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { ...headers, Allow: "GET, OPTIONS" },
			});
		}
		if (!this.bootstrapTickets.take(id)) {
			return new Response("Expired or invalid bootstrap ticket", {
				status: 404,
				headers,
			});
		}
		return Response.json(
			{ token: this.options.token, port: this.options.port },
			{ headers },
		);
	}

	private async handleSourceRequest(
		request: Request,
		url: URL,
		origin: string | null,
	): Promise<Response> {
		const id = url.pathname.slice("/source/".length);
		const headers = transferCorsHeaders(origin);
		if (request.method === "OPTIONS") {
			return this.sourceTickets.has(id)
				? new Response(null, { status: 204, headers })
				: new Response("Expired or invalid source ticket", {
						status: 404,
						headers,
					});
		}
		if (request.method !== "PUT") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { ...headers, Allow: "PUT, OPTIONS" },
			});
		}
		try {
			const result = await this.sourceTickets.receive(id, request);
			return Response.json(result, { headers });
		} catch (error) {
			return new Response(
				error instanceof Error ? error.message : "Source upload failed",
				{ status: 409, headers },
			);
		}
	}

	private async handleExportRequest(
		request: Request,
		url: URL,
		origin: string | null,
	): Promise<Response> {
		const id = url.pathname.slice("/export/".length);
		const headers = exportCorsHeaders(origin);
		if (request.method === "OPTIONS") {
			return this.exportTickets.has(id)
				? new Response(null, { status: 204, headers })
				: new Response("Expired or invalid export ticket", {
						status: 404,
						headers,
					});
		}
		if (request.method !== "PUT") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { ...headers, Allow: "PUT, OPTIONS" },
			});
		}
		try {
			const result = await this.exportTickets.receive(id, request);
			return Response.json(result, { headers });
		} catch (error) {
			return new Response(
				error instanceof Error ? error.message : "Export upload failed",
				{ status: 409, headers },
			);
		}
	}

	private async handlePreviewRequest(
		request: Request,
		url: URL,
		origin: string | null,
	): Promise<Response> {
		const id = url.pathname.slice("/preview/".length);
		const headers = transferCorsHeaders(origin);
		if (request.method === "OPTIONS") {
			return this.previewEvidence.hasTicket(id)
				? new Response(null, { status: 204, headers })
				: new Response("Expired or invalid preview ticket", {
						status: 404,
						headers,
					});
		}
		if (request.method !== "PUT") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { ...headers, Allow: "PUT, OPTIONS" },
			});
		}
		try {
			return Response.json(await this.previewEvidence.receive(id, request), {
				headers,
			});
		} catch (error) {
			return new Response(
				error instanceof Error ? error.message : "Preview upload failed",
				{ status: 409, headers },
			);
		}
	}

	private async handlePreviewRangeRequest(
		request: Request,
		url: URL,
		origin: string | null,
	): Promise<Response> {
		const remainder = url.pathname.slice("/preview-range/".length);
		const slash = remainder.indexOf("/");
		const token = slash < 0 ? remainder : remainder.slice(0, slash);
		const part = slash < 0 ? "" : remainder.slice(slash + 1);
		const headers = transferCorsHeaders(origin);
		if (request.method === "OPTIONS") {
			return this.rangePreviewEvidence.hasTicket(token)
				? new Response(null, { status: 204, headers })
				: new Response("Expired or invalid preview-range ticket", {
						status: 404,
						headers,
					});
		}
		if (request.method === "GET" && part === "status") {
			try {
				return Response.json(await this.rangePreviewEvidence.status(token), {
					headers,
				});
			} catch (error) {
				return new Response(
					error instanceof Error
						? error.message
						: "Preview-range status failed",
					{ status: 404, headers },
				);
			}
		}
		if (request.method !== "PUT") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { ...headers, Allow: "GET, PUT, OPTIONS" },
			});
		}
		try {
			return Response.json(
				await this.rangePreviewEvidence.receive(token, part, request),
				{ headers },
			);
		} catch (error) {
			return new Response(
				error instanceof Error ? error.message : "Preview-range upload failed",
				{ status: 409, headers },
			);
		}
	}

	private async handleComparisonCaptureRequest(
		request: Request,
		url: URL,
		origin: string | null,
	): Promise<Response> {
		const remainder = url.pathname.slice("/comparison-capture/".length);
		const slash = remainder.indexOf("/");
		const token = slash < 0 ? remainder : remainder.slice(0, slash);
		const part = slash < 0 ? "" : remainder.slice(slash + 1);
		const headers = transferCorsHeaders(origin);
		if (request.method === "OPTIONS") {
			return this.comparisonEvidence.hasCaptureTicket(token)
				? new Response(null, { status: 204, headers })
				: new Response("Expired or invalid comparison-capture ticket", {
						status: 404,
						headers,
					});
		}
		if (request.method === "GET" && part === "status") {
			try {
				return Response.json(
					await this.comparisonEvidence.statusCapture(token),
					{ headers },
				);
			} catch (error) {
				return new Response(
					error instanceof Error
						? error.message
						: "Comparison-capture status failed",
					{ status: 404, headers },
				);
			}
		}
		if (request.method !== "PUT") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { ...headers, Allow: "GET, PUT, OPTIONS" },
			});
		}
		try {
			return Response.json(
				await this.comparisonEvidence.receiveCapture(token, part, request),
				{ headers },
			);
		} catch (error) {
			return new Response(
				error instanceof Error
					? error.message
					: "Comparison-capture upload failed",
				{ status: 409, headers },
			);
		}
	}

	private handleOpen(socket: EditorSocket): void {
		socket.data.authTimer = setTimeout(() => {
			if (!socket.data.authenticated)
				socket.close(1008, "authentication timeout");
		}, 3000);
	}

	private handleMessage(socket: EditorSocket, raw: string | Buffer): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(
				typeof raw === "string" ? raw : raw.toString(),
			) as Record<string, unknown>;
		} catch {
			socket.close(1003, "invalid JSON");
			return;
		}

		if (!socket.data.authenticated) {
			this.authenticate(socket, message);
			return;
		}
		if (message.kind !== "response" || typeof message.id !== "string") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		if (pending.socket !== socket) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (
			socket.data.protocolVersion === CURRENT_BRIDGE_PROTOCOL_VERSION &&
			(!isConnectionIdentity(message.identity) ||
				!identitiesEqual(message.identity, pending.identity))
		) {
			pending.reject(
				new BridgeProtocolError(
					"STALE_CONNECTION",
					"Editor response identity did not match the dispatched request",
					{
						expectedIdentity: pending.identity,
						actualIdentity: message.identity,
					},
				),
			);
			return;
		}
		if (message.ok === true) {
			this.recordObservedRevision(socket, pending.method, message.result);
			pending.resolve(
				withConnectionIdentity(
					message.result,
					pending.identity,
					pending.requestIdentity,
					pending.protocolVersion,
				),
			);
			return;
		}
		const error = readProtocolError(message.error);
		pending.reject(
			error
				? new BridgeProtocolError(error.code, error.message, error.details)
				: new Error(String(message.error ?? "unknown editor error")),
		);
	}

	private authenticate(
		socket: EditorSocket,
		message: Record<string, unknown>,
	): void {
		if (
			message.kind !== "authenticate" ||
			typeof message.token !== "string" ||
			!tokensEqual(message.token, this.options.token)
		) {
			socket.close(1008, "authentication failed");
			return;
		}
		const protocolVersion = negotiateProtocolVersion(message);
		if (protocolVersion === null) {
			socket.close(1002, "unsupported bridge protocol version");
			return;
		}
		const editorInstanceId =
			protocolVersion === CURRENT_BRIDGE_PROTOCOL_VERSION
				? readNonEmptyString(message.editorInstanceId)
				: `legacy-editor-${randomUUID()}`;
		const editorSessionId =
			protocolVersion === CURRENT_BRIDGE_PROTOCOL_VERSION
				? readNonEmptyString(message.editorSessionId)
				: `legacy-session-${randomUUID()}`;
		if (!editorInstanceId || !editorSessionId) {
			socket.close(1002, "bridge protocol v2 requires editor identity");
			return;
		}
		if (this.activeSocket && this.activeSocket !== socket) {
			socket.close(1013, "an editor already owns this session");
			return;
		}
		if (socket.data.authTimer) clearTimeout(socket.data.authTimer);
		socket.data.authTimer = null;
		socket.data.authenticated = true;
		socket.data.protocolVersion = protocolVersion;
		socket.data.identity = {
			serverInstanceId: this.serverInstanceId,
			editorInstanceId,
			editorSessionId,
			connectionGeneration: ++this.connectionGeneration,
		};
		this.activeSocket = socket;
		socket.send(
			JSON.stringify({
				kind: "authenticated",
				protocolVersion,
				identity: socket.data.identity,
			}),
		);
		this.emitConnectionChange(true);
	}

	private handleClose(socket: EditorSocket): void {
		if (socket.data.authTimer) clearTimeout(socket.data.authTimer);
		if (this.activeSocket !== socket) return;
		this.activeSocket = null;
		this.rejectPending("OpenCut editor disconnected");
		this.emitConnectionChange(false);
	}

	private rejectPending(reason: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new BridgeProtocolError("EDITOR_DISCONNECTED", reason));
		}
		this.pending.clear();
	}

	private assertObservedRevision(
		socket: EditorSocket,
		method: string,
		params: unknown,
	): void {
		if (
			socket.data.protocolVersion !== CURRENT_BRIDGE_PROTOCOL_VERSION ||
			method === "save_project" ||
			method === "recover_save_project" ||
			!params ||
			typeof params !== "object"
		) {
			return;
		}
		const record = params as Record<string, unknown>;
		if (
			typeof record.projectId !== "string" ||
			typeof record.expectedRevision !== "number"
		) {
			return;
		}
		const observed = socket.data.observedProjectRevisions.get(record.projectId);
		if (observed === record.expectedRevision) return;
		throw new BridgeProtocolError(
			"STALE_CONNECTION",
			"Project revision was not observed on this editor connection",
			{
				projectId: record.projectId,
				expectedRevision: record.expectedRevision,
				observedRevision: observed ?? null,
				connectionIdentity: socket.data.identity,
			},
		);
	}

	private recordObservedRevision(
		socket: EditorSocket,
		method: string,
		result: unknown,
	): void {
		if (method === "recover_save_project") return;
		if (
			method === "save_project" &&
			result &&
			typeof result === "object" &&
			(result as Record<string, unknown>).status === "replayed"
		) {
			return;
		}
		const version = readProjectVersion(result);
		if (version) {
			socket.data.observedProjectRevisions.set(
				version.projectId,
				version.revision,
			);
		}
	}

	private emitConnectionChange(connected: boolean): void {
		for (const listener of this.connectionListeners) listener(connected);
	}
}

function negotiateProtocolVersion(
	message: Record<string, unknown>,
): number | null {
	if (message.protocolVersions === undefined) return 1;
	const requestedVersions = message.protocolVersions;
	if (!Array.isArray(requestedVersions)) return null;
	return (
		SUPPORTED_BRIDGE_PROTOCOL_VERSIONS.find((version) =>
			requestedVersions.includes(version),
		) ?? null
	);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function isConnectionIdentity(
	value: unknown,
): value is BridgeConnectionIdentity {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		readNonEmptyString(record.serverInstanceId) !== null &&
		readNonEmptyString(record.editorInstanceId) !== null &&
		readNonEmptyString(record.editorSessionId) !== null &&
		typeof record.connectionGeneration === "number" &&
		Number.isSafeInteger(record.connectionGeneration) &&
		record.connectionGeneration > 0
	);
}

function identitiesEqual(
	left: BridgeConnectionIdentity,
	right: BridgeConnectionIdentity,
): boolean {
	return (
		left.serverInstanceId === right.serverInstanceId &&
		left.editorInstanceId === right.editorInstanceId &&
		left.editorSessionId === right.editorSessionId &&
		left.connectionGeneration === right.connectionGeneration
	);
}

function withConnectionIdentity(
	value: unknown,
	connectionIdentity: BridgeConnectionIdentity,
	requestConnectionIdentity: BridgeConnectionIdentity | null,
	bridgeProtocolVersion: 1 | 2,
): unknown {
	const identityFields = {
		bridgeProtocolVersion,
		connectionIdentity,
		...(requestConnectionIdentity ? { requestConnectionIdentity } : {}),
	};
	return value && typeof value === "object" && !Array.isArray(value)
		? { ...(value as Record<string, unknown>), ...identityFields }
		: { value, ...identityFields };
}

function readDeclaredConnectionIdentity(
	params: unknown,
): BridgeConnectionIdentity | null {
	if (!params || typeof params !== "object") return null;
	const record = params as Record<string, unknown>;
	if (record.bridgeProtocolVersion !== CURRENT_BRIDGE_PROTOCOL_VERSION)
		return null;
	if (!isConnectionIdentity(record.expectedConnectionIdentity)) {
		throw new BridgeProtocolError(
			"PROTOCOL_MISMATCH",
			"Bridge protocol v2 requires expectedConnectionIdentity",
		);
	}
	return record.expectedConnectionIdentity;
}

function readDeclaredProtocolVersion(params: unknown): 1 | 2 | null {
	if (!params || typeof params !== "object") return null;
	const version = (params as Record<string, unknown>).bridgeProtocolVersion;
	if (version === undefined) return null;
	if (version === 1 || version === 2) return version;
	throw new BridgeProtocolError(
		"PROTOCOL_MISMATCH",
		"Request declares an unsupported bridge protocol version",
		{ declaredProtocolVersion: version },
	);
}

function readProtocolError(value: unknown): {
	code: "STALE_CONNECTION" | "EDITOR_DISCONNECTED" | "PROTOCOL_MISMATCH";
	message: string;
	details?: Record<string, unknown>;
} | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		(record.code !== "STALE_CONNECTION" &&
			record.code !== "EDITOR_DISCONNECTED" &&
			record.code !== "PROTOCOL_MISMATCH") ||
		typeof record.message !== "string"
	) {
		return null;
	}
	return {
		code: record.code,
		message: record.message,
		...(record.details && typeof record.details === "object"
			? { details: record.details as Record<string, unknown> }
			: {}),
	};
}

function readProjectVersion(
	value: unknown,
): { projectId: string; revision: number } | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.projectId === "string" &&
		typeof record.revision === "number"
	) {
		return { projectId: record.projectId, revision: record.revision };
	}
	const snapshot = record.snapshot;
	if (!snapshot || typeof snapshot !== "object") return null;
	const snapshotRecord = snapshot as Record<string, unknown>;
	return typeof snapshotRecord.projectId === "string" &&
		typeof snapshotRecord.revision === "number"
		? {
				projectId: snapshotRecord.projectId,
				revision: snapshotRecord.revision,
			}
		: null;
}

function exportCorsHeaders(origin: string | null): Record<string, string> {
	return transferCorsHeaders(origin);
}

function bootstrapCorsHeaders(origin: string | null): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": origin ?? "http://127.0.0.1",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Cache-Control": "no-store",
	};
}

function transferCorsHeaders(origin: string | null): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": origin ?? "http://127.0.0.1",
		"Access-Control-Allow-Methods": "PUT, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, X-OpenCut-Pixel-Rgba-Sha256, X-OpenCut-Audio-Start-Ticks, X-OpenCut-Audio-End-Ticks-Exclusive",
		"Cache-Control": "no-store",
	};
}

function isAllowedOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1")
		);
	} catch {
		return false;
	}
}

function tokensEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}
