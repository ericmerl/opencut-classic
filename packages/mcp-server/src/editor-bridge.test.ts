import { afterEach, describe, expect, test } from "bun:test";
import {
	BridgeProtocolError,
	type BridgeConnectionIdentity,
	EditorBridge,
} from "./editor-bridge";
import {
	timelineQueryInputSchema,
	withConnectionAffinity,
} from "./tool-schemas";

const TOKEN = "0123456789abcdef0123456789abcdef";
const bridges: EditorBridge[] = [];

afterEach(() => {
	for (const bridge of bridges.splice(0)) bridge.stop();
});

describe("EditorBridge identity protocol", () => {
	test("negotiates v2 and identity-locks request and response envelopes", async () => {
		const bridge = createBridge("server-1");
		const socket = await connect(bridge);
		const identity = await authenticate(socket, "editor-1", "session-1");

		expect(bridge.getStatus()).toMatchObject({
			connected: true,
			serverInstanceId: "server-1",
			negotiatedProtocolVersion: 2,
			connectionIdentity: identity,
		});

		const requestMessage = nextJson(socket);
		const resultPromise = bridge.request("read_project", {}, 1_000, identity);
		const request = await requestMessage;
		expect(request).toMatchObject({
			kind: "request",
			method: "read_project",
			target: identity,
		});
		socket.send(
			JSON.stringify({
				kind: "response",
				id: request.id,
				ok: true,
				result: { projectId: "project-1", sceneId: "scene-1" },
				identity,
			}),
		);
		await expect(resultPromise).resolves.toEqual({
			projectId: "project-1",
			sceneId: "scene-1",
			bridgeProtocolVersion: 2,
			connectionIdentity: identity,
			requestConnectionIdentity: identity,
		});
	});

	test("increments generation across reconnects and distinguishes sessions", async () => {
		const bridge = createBridge("server-2");
		const first = await connect(bridge);
		const firstIdentity = await authenticate(first, "editor-1", "session-1");
		await close(first);

		const reconnect = await connect(bridge);
		const reconnectIdentity = await authenticate(
			reconnect,
			"editor-1",
			"session-1",
		);
		expect(reconnectIdentity).toEqual({
			...firstIdentity,
			connectionGeneration: firstIdentity.connectionGeneration + 1,
		});
		await close(reconnect);

		const newSession = await connect(bridge);
		const newSessionIdentity = await authenticate(
			newSession,
			"editor-1",
			"session-2",
		);
		expect(newSessionIdentity.editorInstanceId).toBe("editor-1");
		expect(newSessionIdentity.editorSessionId).toBe("session-2");
		expect(newSessionIdentity.connectionGeneration).toBe(
			reconnectIdentity.connectionGeneration + 1,
		);
	});

	test("rejects a second live editor and a stale request target", async () => {
		const bridge = createBridge("server-3");
		const first = await connect(bridge);
		const identity = await authenticate(first, "editor-1", "session-1");
		const second = await connect(bridge);
		second.send(
			JSON.stringify({
				kind: "authenticate",
				token: TOKEN,
				protocolVersions: [2],
				editorInstanceId: "editor-2",
				editorSessionId: "session-2",
			}),
		);
		await waitUntilNotOpen(second);
		expect(second.readyState).not.toBe(WebSocket.OPEN);
		expect(bridge.getStatus().connectionIdentity).toEqual(identity);

		const stale = { ...identity, connectionGeneration: 999 };
		expect(() => bridge.request("read_project", {}, 1_000, stale)).toThrow(
			BridgeProtocolError,
		);
		try {
			bridge.request("read_project", {}, 1_000, stale);
		} catch (error) {
			expect(error).toMatchObject({ code: "STALE_CONNECTION" });
		}
	});

	test("rejects pending work with a machine error when the editor disconnects", async () => {
		const bridge = createBridge("server-4");
		const socket = await connect(bridge);
		const identity = await authenticate(socket, "editor-1", "session-1");
		const requestMessage = nextJson(socket);
		const pending = bridge.request("read_project", {}, 5_000, identity);
		await requestMessage;
		await close(socket);
		await expect(pending).rejects.toMatchObject({
			code: "EDITOR_DISCONNECTED",
		});
	});

	test("does not retarget a request after a different editor reconnects", async () => {
		const bridge = createBridge("server-affinity");
		const first = await connect(bridge);
		const firstIdentity = await authenticate(first, "editor-1", "session-1");
		await close(first);

		const second = await connect(bridge);
		const secondIdentity = await authenticate(second, "editor-2", "session-2");
		expect(secondIdentity.editorInstanceId).toBe("editor-2");
		expect(() =>
			bridge.request(
				"read_project",
				{
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: firstIdentity,
				},
				1_000,
				firstIdentity,
			),
		).toThrow(BridgeProtocolError);
	});

	test("requires revision readback after reconnect before dispatching edits", async () => {
		const bridge = createBridge("server-readback");
		const first = await connect(bridge);
		const firstIdentity = await authenticate(first, "editor-1", "session-1");
		const readMessage = nextJson(first);
		const readResult = bridge.request("read_project", {}, 1_000, firstIdentity);
		const readRequest = await readMessage;
		first.send(
			JSON.stringify({
				kind: "response",
				id: readRequest.id,
				ok: true,
				result: { projectId: "project-1", sceneId: "scene-1", revision: 7 },
				identity: firstIdentity,
			}),
		);
		await readResult;
		await close(first);

		const reconnect = await connect(bridge);
		const reconnectIdentity = await authenticate(
			reconnect,
			"editor-1",
			"session-1",
		);
		try {
			bridge.request("apply_edit_plan", {
				projectId: "project-1",
				expectedRevision: 7,
			});
			throw new Error("stale edit unexpectedly dispatched");
		} catch (error) {
			expect(error).toMatchObject({ code: "STALE_CONNECTION" });
		}
		const currentReadMessage = nextJson(reconnect);
		const currentReadResult = bridge.request(
			"read_project",
			{},
			1_000,
			reconnectIdentity,
		);
		const currentReadRequest = await currentReadMessage;
		reconnect.send(
			JSON.stringify({
				kind: "response",
				id: currentReadRequest.id,
				ok: true,
				result: { projectId: "project-1", sceneId: "scene-1", revision: 0 },
				identity: reconnectIdentity,
			}),
		);
		await currentReadResult;

		const saveMessage = nextJson(reconnect);
		const saveResult = bridge.request(
			"save_project",
			{ projectId: "project-1", expectedRevision: 7 },
			1_000,
			reconnectIdentity,
		);
		const saveRequest = await saveMessage;
		expect(saveRequest).toMatchObject({
			kind: "request",
			method: "save_project",
			params: { projectId: "project-1", expectedRevision: 7 },
		});
		reconnect.send(
			JSON.stringify({
				kind: "response",
				id: saveRequest.id,
				ok: true,
				result: {
					status: "replayed",
					projectId: "project-1",
					revision: 7,
				},
				identity: reconnectIdentity,
			}),
		);
		expect(await saveResult).toMatchObject({
			status: "replayed",
			projectId: "project-1",
			revision: 7,
		});
		const currentEditMessage = nextJson(reconnect);
		const currentEditResult = bridge.request(
			"apply_edit_plan",
			{ projectId: "project-1", expectedRevision: 0 },
			1_000,
			reconnectIdentity,
		);
		const currentEditRequest = await currentEditMessage;
		reconnect.send(
			JSON.stringify({
				kind: "response",
				id: currentEditRequest.id,
				ok: true,
				result: { projectId: "project-1", revision: 1 },
				identity: reconnectIdentity,
			}),
		);
		expect(await currentEditResult).toMatchObject({ revision: 1 });
	});

	test("rejects declared protocol mismatches in both directions", async () => {
		const v2Bridge = createBridge("server-v2-mismatch");
		const v2Socket = await connect(v2Bridge);
		await authenticate(v2Socket, "editor-1", "session-1");
		expect(() =>
			v2Bridge.request("read_project", { bridgeProtocolVersion: 1 }),
		).toThrow("negotiated v2");
		await close(v2Socket);

		const v1Bridge = createBridge("server-v1-mismatch");
		const v1Socket = await connect(v1Bridge);
		const authenticated = nextJson(v1Socket);
		v1Socket.send(JSON.stringify({ kind: "authenticate", token: TOKEN }));
		await authenticated;
		expect(() =>
			v1Bridge.request("read_project", {
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: {
					serverInstanceId: "server-v1-mismatch",
					editorInstanceId: "editor-1",
					editorSessionId: "session-1",
					connectionGeneration: 1,
				},
			}),
		).toThrow("negotiated v1");
	});

	test("dispatches an omitted legacy MCP declaration over negotiated v2", async () => {
		const bridge = createBridge("server-legacy-v2");
		const socket = await connect(bridge);
		const identity = await authenticate(socket, "editor-1", "session-1");
		const readMessage = nextJson(socket);
		const readResult = bridge.request("read_project", {}, 1_000);
		const readRequest = await readMessage;
		socket.send(
			JSON.stringify({
				kind: "response",
				id: readRequest.id,
				ok: true,
				result: { projectId: "project-1", sceneId: "scene-1", revision: 0 },
				identity,
			}),
		);
		await readResult;

		const parsed = withConnectionAffinity(timelineQueryInputSchema).parse({
			projectId: "project-1",
			expectedRevision: 0,
		});
		expect(parsed).toEqual({ projectId: "project-1", expectedRevision: 0 });
		const queryMessage = nextJson(socket);
		const queryResult = bridge.request("query_timeline", parsed, 1_000);
		const queryRequest = await queryMessage;
		expect(queryRequest).toMatchObject({
			method: "query_timeline",
			target: identity,
		});
		socket.send(
			JSON.stringify({
				kind: "response",
				id: queryRequest.id,
				ok: true,
				result: {
					status: "queried",
					projectId: "project-1",
					sceneId: "scene-1",
					revision: 0,
				},
				identity,
			}),
		);
		const resolved = (await queryResult) as Record<string, unknown>;
		expect(resolved).toMatchObject({
			bridgeProtocolVersion: 2,
			connectionIdentity: identity,
		});
		expect("requestConnectionIdentity" in resolved).toBe(false);
	});

	test("keeps the token-only protocol v1 handshake compatible", async () => {
		const bridge = createBridge("server-5");
		const socket = await connect(bridge);
		const authenticated = nextJson(socket);
		socket.send(JSON.stringify({ kind: "authenticate", token: TOKEN }));
		const response = await authenticated;
		expect(response).toMatchObject({
			kind: "authenticated",
			protocolVersion: 1,
		});

		const requestMessage = nextJson(socket);
		const resultPromise = bridge.request(
			"read_project",
			{ bridgeProtocolVersion: 1 },
			1_000,
		);
		const request = await requestMessage;
		expect(request.target).toBeUndefined();
		socket.send(
			JSON.stringify({
				kind: "response",
				id: request.id,
				ok: true,
				result: { projectId: "legacy-project" },
			}),
		);
		await expect(resultPromise).resolves.toMatchObject({
			projectId: "legacy-project",
			connectionIdentity: expect.objectContaining({
				serverInstanceId: "server-5",
			}),
		});

		const defaultRequestMessage = nextJson(socket);
		const defaultResult = bridge.request("read_project", {}, 1_000);
		const defaultRequest = await defaultRequestMessage;
		socket.send(
			JSON.stringify({
				kind: "response",
				id: defaultRequest.id,
				ok: true,
				result: { projectId: "legacy-project", sceneId: "legacy-scene" },
			}),
		);
		await expect(defaultResult).resolves.toMatchObject({
			bridgeProtocolVersion: 1,
			projectId: "legacy-project",
			sceneId: "legacy-scene",
		});
	});
});

function createBridge(serverInstanceId: string): EditorBridge {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const bridge = new EditorBridge({
				token: TOKEN,
				port: 35_000 + Math.floor(Math.random() * 20_000),
				serverInstanceId,
			});
			bridges.push(bridge);
			return bridge;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			if ((error as Error & { code?: string }).code !== "EADDRINUSE")
				throw error;
		}
	}
	throw new Error("Could not allocate an editor bridge test port");
}

async function connect(bridge: EditorBridge): Promise<WebSocket> {
	const socket = new WebSocket(
		`ws://127.0.0.1:${bridge.getStatus().port}/editor`,
	);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("socket error")), {
			once: true,
		});
	});
	return socket;
}

async function authenticate(
	socket: WebSocket,
	editorInstanceId: string,
	editorSessionId: string,
): Promise<BridgeConnectionIdentity> {
	const authenticated = nextJson(socket);
	socket.send(
		JSON.stringify({
			kind: "authenticate",
			token: TOKEN,
			protocolVersions: [2, 1],
			editorInstanceId,
			editorSessionId,
		}),
	);
	const response = await authenticated;
	expect(response).toMatchObject({ kind: "authenticated", protocolVersion: 2 });
	return response.identity as BridgeConnectionIdentity;
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		socket.addEventListener(
			"message",
			(event) => {
				try {
					resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
				} catch (error) {
					reject(error);
				}
			},
			{ once: true },
		);
	});
}

function nextClose(
	socket: WebSocket,
): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		socket.addEventListener(
			"close",
			(event) => resolve({ code: event.code, reason: event.reason }),
			{ once: true },
		);
	});
}

async function close(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const closed = nextClose(socket);
	socket.close(1000, "test complete");
	await closed;
}

async function waitUntilNotOpen(socket: WebSocket): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (socket.readyState === WebSocket.OPEN && Date.now() < deadline) {
		await Bun.sleep(5);
	}
	if (socket.readyState === WebSocket.OPEN) {
		throw new Error("second editor connection was not rejected");
	}
}
