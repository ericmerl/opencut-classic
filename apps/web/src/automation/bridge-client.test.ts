import { afterEach, describe, expect, test } from "bun:test";
import { EditorBridge } from "../../../../packages/mcp-server/src/editor-bridge";
import type { EditorAutomation } from "./editor-automation";
import {
	AutomationBridgeClient,
	AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY,
	getOrCreateEditorInstanceId,
	type AutomationConnectionIdentity,
} from "./bridge-client";

const TOKEN = "0123456789abcdef0123456789abcdef";
const cleanup: Array<() => void> = [];
const recordedReceipts: Array<{
	method: string;
	request: unknown;
	result: unknown;
}> = [];

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	recordedReceipts.length = 0;
});

describe("automation editor instance identity", () => {
	test("persists and reuses one durable editor instance ID", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};

		expect(getOrCreateEditorInstanceId(storage, () => "editor-1")).toBe(
			"editor-1",
		);
		expect(values.get(AUTOMATION_EDITOR_INSTANCE_STORAGE_KEY)).toBe("editor-1");
		expect(getOrCreateEditorInstanceId(storage, () => "editor-2")).toBe(
			"editor-1",
		);
	});

	test("fails closed when durable identity storage does not retain the ID", () => {
		const storage = {
			getItem: () => null,
			setItem: () => undefined,
		};
		expect(() =>
			getOrCreateEditorInstanceId(storage, () => "editor-1"),
		).toThrow("could not be persisted");
	});

	test("negotiates v2, envelopes responses, and reconnects with a new generation", async () => {
		const bridge = createBridge();
		const client = createClient(
			`ws://127.0.0.1:${bridge.getStatus().port}/editor`,
		);
		client.start();
		await bridge.waitForConnection(1_000);
		const firstIdentity = bridge.getStatus().connectionIdentity;
		if (!firstIdentity) throw new Error("v2 connection identity is missing");
		expect(firstIdentity).toMatchObject({
			editorInstanceId: "editor-browser-1",
			editorSessionId: "session-browser-1",
			connectionGeneration: 1,
		});

		const result = await bridge.request(
			"read_project",
			{
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: firstIdentity,
			},
			1_000,
			firstIdentity,
		);
		expect(result).toMatchObject({
			projectId: "project-1",
			sceneId: "scene-1",
			connectionIdentity: firstIdentity,
			requestConnectionIdentity: firstIdentity,
		});
		const saved = await bridge.request(
			"save_project",
			{
				projectId: "project-1",
				sceneId: "scene-1",
				operationId: "save-1",
				expectedRevision: 0,
				expectedContentHash: "a".repeat(64),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: firstIdentity,
			},
			1_000,
			firstIdentity,
		);
		expect(saved).toMatchObject({
			status: "saved",
			receiptId: "receipt-1",
			connectionIdentity: firstIdentity,
		});
		expect(recordedReceipts).toContainEqual({
			method: "save_project",
			request: expect.objectContaining({ operationId: "save-1" }),
			result: expect.objectContaining({ status: "saved" }),
		});
		const receipt = await bridge.request(
			"get_operation_receipt",
			{
				operationId: "save-1",
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: firstIdentity,
			},
			1_000,
			firstIdentity,
		);
		expect(receipt).toMatchObject({
			status: "found",
			operationId: "save-1",
			method: "save_project",
			connectionIdentity: firstIdentity,
			requestConnectionIdentity: firstIdentity,
		});

		client.stop();
		expect(client.getStatus()).toEqual({
			protocolVersion: null,
			connectionIdentity: null,
		});
		await waitFor(() => !bridge.getStatus().connected);
		client.start();
		await bridge.waitForConnection(1_000);
		expect(bridge.getStatus().connectionIdentity).toEqual({
			...firstIdentity,
			connectionGeneration: 2,
		});
	});

	test("rejects a stale v2 target over the browser client socket", async () => {
		const protocol = createProtocolServer("v2");
		const client = createClient(protocol.url);
		client.start();
		const socket = await protocol.connected;
		const identity: AutomationConnectionIdentity = {
			serverInstanceId: "server-browser",
			editorInstanceId: "editor-browser-1",
			editorSessionId: "session-browser-1",
			connectionGeneration: 1,
		};
		socket.send(
			JSON.stringify({
				kind: "authenticated",
				protocolVersion: 2,
				identity,
			}),
		);
		await waitFor(() => client.getStatus().protocolVersion === 2);
		socket.send(
			JSON.stringify({
				kind: "request",
				id: "stale-request",
				method: "read_project",
				params: {},
				target: { ...identity, connectionGeneration: 99 },
			}),
		);
		const response = await protocol.nextClientMessage();
		expect(response).toMatchObject({
			kind: "response",
			id: "stale-request",
			ok: false,
			error: { code: "STALE_CONNECTION" },
			identity,
		});
	});

	test("rejects stale edit-plan affinity before browser dispatch", async () => {
		const protocol = createProtocolServer("v2");
		const client = createClient(protocol.url);
		client.start();
		const socket = await protocol.connected;
		const identity: AutomationConnectionIdentity = {
			serverInstanceId: "server-browser",
			editorInstanceId: "editor-browser-1",
			editorSessionId: "session-browser-1",
			connectionGeneration: 1,
		};
		socket.send(
			JSON.stringify({ kind: "authenticated", protocolVersion: 2, identity }),
		);
		await waitFor(() => client.getStatus().protocolVersion === 2);
		socket.send(
			JSON.stringify({
				kind: "request",
				id: "stale-preflight-source",
				method: "preflight_edit_plan",
				params: {
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: {
						...identity,
						connectionGeneration: 2,
					},
				},
				target: identity,
			}),
		);
		const response = await protocol.nextClientMessage();
		expect(response).toMatchObject({
			kind: "response",
			id: "stale-preflight-source",
			ok: false,
			error: { code: "STALE_CONNECTION" },
			identity,
		});

		socket.send(
			JSON.stringify({
				kind: "request",
				id: "wrong-editor-preflight-source",
				method: "preflight_edit_plan",
				params: {
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: {
						...identity,
						editorInstanceId: "editor-browser-other",
					},
				},
				target: identity,
			}),
		);
		const wrongEditorResponse = await protocol.nextClientMessage();
		expect(wrongEditorResponse).toMatchObject({
			kind: "response",
			id: "wrong-editor-preflight-source",
			ok: false,
			error: { code: "STALE_CONNECTION" },
			identity,
		});
	});

	test("closes the browser socket after receipt commit and before response delivery", async () => {
		const bridge = createBridge();
		let receiptCommitted = false;
		const client = createClient(
			`ws://127.0.0.1:${bridge.getStatus().port}/editor`,
			async () => {
				receiptCommitted = true;
				return true;
			},
		);
		client.start();
		await bridge.waitForConnection(1_000);
		const identity = bridge.getStatus().connectionIdentity;
		if (!identity) throw new Error("v2 connection identity is missing");

		let transportFailure: unknown;
		try {
			await bridge.request(
				"save_project",
				{
					operationId: "drop-after-receipt",
					projectId: "project-1",
					sceneId: "scene-1",
					expectedRevision: 0,
					expectedContentHash: "a".repeat(64),
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: identity,
				},
				1_000,
				identity,
			);
		} catch (error) {
			transportFailure = error;
		}
		expect(transportFailure).toBeInstanceOf(Error);
		if (!receiptCommitted) throw transportFailure;
		expect(receiptCommitted).toBeTrue();
		expect(client.getStatus()).toEqual({
			protocolVersion: null,
			connectionIdentity: null,
		});
		expect(recordedReceipts).toContainEqual({
			method: "save_project",
			request: expect.objectContaining({ operationId: "drop-after-receipt" }),
			result: expect.objectContaining({ status: "saved" }),
		});
	});

	test("drops a preflight response only after the durable read-only receipt commits", async () => {
		const bridge = createBridge();
		let receiptCommitted = false;
		const client = createClient(
			`ws://127.0.0.1:${bridge.getStatus().port}/editor`,
			({ method }) => method === "preflight_edit_plan" && receiptCommitted,
			{
				preflightEditPlan: async (request: { preflightId: string }) => {
					receiptCommitted = true;
					return {
						status: "rejected",
						preflightId: request.preflightId,
						code: "PERSISTED_SOURCE_UNAVAILABLE",
						reason: "fixture terminal receipt",
					};
				},
			},
		);
		client.start();
		await bridge.waitForConnection(1_000);
		const identity = bridge.getStatus().connectionIdentity;
		if (!identity) throw new Error("v2 connection identity is missing");
		await bridge.request(
			"read_project",
			{
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: identity,
			},
			1_000,
			identity,
		);
		const lookup = await bridge.request(
			"get_edit_plan_preflight_receipt",
			{
				preflightId: "preflight-response-loss",
				requestFingerprint: "a".repeat(64),
			},
			1_000,
			identity,
		);
		expect(lookup).toMatchObject({ status: "not-found" });
		expect(receiptCommitted).toBeFalse();
		expect(client.getStatus().connectionIdentity).toEqual(identity);

		let transportFailure: unknown;
		try {
			await bridge.request(
				"preflight_edit_plan",
				{
					contractVersion: 2,
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: identity,
					preflightId: "preflight-response-loss",
					projectId: "project-1",
					sceneId: "scene-1",
					expectedRevision: 0,
					expectedProjectContentHash: "a".repeat(64),
					expectedWriteVersion: 1,
					saveReceiptOperationId: "save-1",
					expectedSaveReceiptId: "receipt-1",
					description: "fixture",
					operations: [],
					policy: {
						warningPolicy: "allow",
						providerExecution: "forbidden",
						costPolicy: "require-exact",
					},
				},
				1_000,
				identity,
			);
		} catch (error) {
			transportFailure = error;
		}

		if (!receiptCommitted) throw transportFailure;
		expect(receiptCommitted).toBeTrue();
		expect(transportFailure).toBeInstanceOf(Error);
		expect(client.getStatus().connectionIdentity).toBeNull();
	});

	test("degrades cleanly against an old server using target-free v1", async () => {
		const protocol = createProtocolServer("v1");
		const client = createClient(protocol.url);
		client.start();
		const socket = await protocol.connected;
		socket.send(JSON.stringify({ kind: "authenticated" }));
		await waitFor(() => client.getStatus().protocolVersion === 1);
		socket.send(
			JSON.stringify({
				kind: "request",
				id: "legacy-request",
				method: "read_project",
				params: {},
			}),
		);
		const response = await protocol.nextClientMessage();
		expect(response).toMatchObject({
			kind: "response",
			id: "legacy-request",
			ok: true,
			result: { projectId: "project-1", sceneId: "scene-1" },
		});
		expect(response.identity).toBeUndefined();
	});

	test("exposes native history state, redo, and exact history restore", async () => {
		const calls: Array<{ method: string; request: unknown }> = [];
		const bridge = createBridge();
		const client = createClient(
			`ws://127.0.0.1:${bridge.getStatus().port}/editor`,
			undefined,
			{
				getHistoryState: async (request: unknown) => {
					calls.push({ method: "get_history_state", request });
					return {
						status: "history-state",
						projectId: "project-1",
						sceneId: "scene-1",
						revision: 3,
						contentHash: "a".repeat(64),
						contentHashProjectionVersion: 3,
						nativeHistory: {
							activitySequence: 4,
							history: [{ entryId: 1, commandName: "BatchCommand" }],
							redo: [],
							pending: null,
							rippleEnabled: false,
						},
					};
				},
				redo: (async (request: unknown) => {
					calls.push({ method: "redo", request });
					return {
						status: "redone",
						projectId: "project-1",
						sceneId: "scene-1",
						revision: 4,
					};
				}) as unknown as EditorAutomation["redo"],
				restoreHistoryState: (async (request: unknown) => {
					calls.push({ method: "restore_history_state", request });
					return { status: "restored", revision: 5 };
				}) as unknown as EditorAutomation["restoreHistoryState"],
			},
		);
		client.start();
		await bridge.waitForConnection(1_000);
		const identity = bridge.getStatus().connectionIdentity;
		if (!identity) throw new Error("v2 connection identity is missing");
		const safety = {
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 0,
			expectedProjectContentHash: "a".repeat(64),
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: identity,
		};

		await bridge.request("read_project", {}, 1_000, identity);
		await bridge.request("get_history_state", safety, 1_000, identity);
		await bridge.request(
			"redo",
			{ ...safety, expectedRevision: 3, steps: 2 },
			1_000,
			identity,
		);
		await bridge.request(
			"restore_history_state",
			{
				...safety,
				expectedRevision: 4,
				expectedTargetProjectContentHash: "b".repeat(64),
				nativeHistory: { history: [], redo: [] },
			},
			1_000,
			identity,
		);

		expect(calls.map((call) => call.method)).toEqual([
			"get_history_state",
			"redo",
			"restore_history_state",
		]);
	});
});

function createClient(
	url: string,
	afterOperationReceipt?: (details: {
		method: string;
		request: unknown;
		result: unknown;
	}) => Promise<boolean> | boolean,
	overrides: Partial<EditorAutomation> = {},
): AutomationBridgeClient {
	const ids = ["editor-browser-1", "session-browser-1"];
	const storageValues = new Map<string, string>();
	const automation = {
		readProject: () => ({
			projectId: "project-1",
			sceneId: "scene-1",
			revision: 0,
		}),
		saveProject: (request: { operationId: string }) => ({
			status: "saved",
			operationId: request.operationId,
			receiptId: "receipt-1",
		}),
		recordOperationReceipt: async ({
			method,
			request,
			result,
		}: {
			method: string;
			request: unknown;
			result: unknown;
		}) => {
			if (
				request &&
				typeof request === "object" &&
				typeof (request as { operationId?: unknown }).operationId === "string"
			) {
				recordedReceipts.push({ method, request, result });
			}
		},
		getOperationReceipt: (request: { operationId: string }) => {
			const receipt = recordedReceipts.find(
				(entry) =>
					(entry.request as { operationId?: string }).operationId ===
					request.operationId,
			);
			return receipt
				? {
						status: "found",
						operationId: request.operationId,
						method: receipt.method,
						requestFingerprint: "fingerprint",
						result: receipt.result,
						recordedAt: "2026-09-02T00:00:00.000Z",
					}
				: { status: "not-found", operationId: request.operationId };
		},
		getEditPlanPreflightReceipt: () => ({
			status: "not-found",
			preflightId: "missing",
		}),
		...overrides,
	} as unknown as EditorAutomation;
	const client = new AutomationBridgeClient(automation, {
		url,
		token: TOKEN,
		identityStorage: {
			getItem: (key) => storageValues.get(key) ?? null,
			setItem: (key, value) => storageValues.set(key, value),
		},
		createId: () => ids.shift() ?? "unexpected-id",
		afterOperationReceipt,
	});
	cleanup.push(() => client.stop());
	return client;
}

function createBridge(): EditorBridge {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const bridge = new EditorBridge({
				token: TOKEN,
				port: 35_000 + Math.floor(Math.random() * 20_000),
				serverInstanceId: "server-browser",
			});
			cleanup.push(() => bridge.stop());
			return bridge;
		} catch (error) {
			if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error("Could not allocate an editor bridge test port");
}

function createProtocolServer(_version: "v1" | "v2"): {
	url: string;
	connected: Promise<Bun.ServerWebSocket<object>>;
	nextClientMessage(): Promise<Record<string, unknown>>;
} {
	let resolveConnected!: (socket: Bun.ServerWebSocket<object>) => void;
	const connected = new Promise<Bun.ServerWebSocket<object>>((resolve) => {
		resolveConnected = resolve;
	});
	const waiting: Array<(message: Record<string, unknown>) => void> = [];
	const messages: Record<string, unknown>[] = [];
	let server: Bun.Server<object> | null = null;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			server = Bun.serve<object>({
				hostname: "127.0.0.1",
				port: 35_000 + Math.floor(Math.random() * 20_000),
				fetch: (request, activeServer) =>
					activeServer.upgrade(request, { data: {} })
						? undefined
						: new Response("upgrade failed", { status: 400 }),
				websocket: {
					open: (socket) => resolveConnected(socket),
					message: (_socket, raw) => {
						const message = JSON.parse(String(raw)) as Record<string, unknown>;
						if (message.kind === "authenticate") return;
						const resolve = waiting.shift();
						if (resolve) resolve(message);
						else messages.push(message);
					},
				},
			});
			break;
		} catch (error) {
			if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		}
	}
	if (!server) throw new Error("Could not allocate a protocol test port");
	cleanup.push(() => server?.stop(true));
	return {
		url: `ws://127.0.0.1:${server.port}`,
		connected,
		nextClientMessage: () => {
			const available = messages.shift();
			if (available) return Promise.resolve(available);
			return new Promise((resolve) => waiting.push(resolve));
		},
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!condition() && Date.now() < deadline) await Bun.sleep(5);
	if (!condition()) throw new Error("Timed out waiting for protocol state");
}
