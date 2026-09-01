import { randomUUID, timingSafeEqual } from "node:crypto";
import { MediaTickets } from "./media-tickets";

interface SocketData {
	authenticated: boolean;
	authTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

type EditorSocket = Bun.ServerWebSocket<SocketData>;

export class EditorBridge {
	private activeSocket: EditorSocket | null = null;
	private pending = new Map<string, PendingRequest>();
	private server: Bun.Server<SocketData>;
	readonly mediaTickets: MediaTickets;

	constructor(
		private options: { token: string; port: number; requestTimeoutMs?: number },
	) {
		this.mediaTickets = new MediaTickets(options.port);
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

	getStatus(): { connected: boolean; host: "127.0.0.1"; port: number } {
		return {
			connected: this.activeSocket !== null,
			host: "127.0.0.1",
			port: this.options.port,
		};
	}

	request(method: string, params: unknown): Promise<unknown> {
		const socket = this.activeSocket;
		if (!socket)
			throw new Error("No authenticated OpenCut editor is connected");
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Editor request timed out: ${method}`));
			}, this.options.requestTimeoutMs ?? 30_000);
			this.pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ kind: "request", id, method, params }));
		});
	}

	stop(): void {
		this.activeSocket?.close(1001, "MCP server stopping");
		this.rejectPending("MCP server stopped");
		this.server.stop(true);
	}

	private handleUpgrade(
		request: Request,
		server: Bun.Server<SocketData>,
	): Response | undefined {
		const url = new URL(request.url);
		const origin = request.headers.get("origin");
		if (origin && !isAllowedOrigin(origin)) {
			return new Response("Forbidden origin", { status: 403 });
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
			data: { authenticated: false, authTimer: null },
		})
			? undefined
			: new Response("WebSocket upgrade failed", { status: 400 });
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
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.ok === true) pending.resolve(message.result);
		else
			pending.reject(
				new Error(String(message.error ?? "unknown editor error")),
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
		if (this.activeSocket && this.activeSocket !== socket) {
			socket.close(1013, "an editor already owns this session");
			return;
		}
		if (socket.data.authTimer) clearTimeout(socket.data.authTimer);
		socket.data.authTimer = null;
		socket.data.authenticated = true;
		this.activeSocket = socket;
		socket.send(JSON.stringify({ kind: "authenticated" }));
	}

	private handleClose(socket: EditorSocket): void {
		if (socket.data.authTimer) clearTimeout(socket.data.authTimer);
		if (this.activeSocket !== socket) return;
		this.activeSocket = null;
		this.rejectPending("OpenCut editor disconnected");
	}

	private rejectPending(reason: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
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
