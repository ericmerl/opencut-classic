import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editOperationSchema } from "./tool-schemas";

let child: ChildProcessWithoutNullStreams | null = null;
let directory: string | null = null;

afterEach(async () => {
	if (child) {
		const exited = new Promise<void>((resolve) => {
			if (child?.exitCode !== null) resolve();
			else child?.once("exit", () => resolve());
		});
		child.stdin.end();
		child.kill("SIGTERM");
		await exited;
		child = null;
	}
	if (directory) {
		await rm(directory, { recursive: true, force: true });
		directory = null;
	}
});

test("publishes strict preflight receipt tools over MCP stdio", async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-preflight-stdio-"));
	const port = await availablePort();
	child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
		cwd: import.meta.dir,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
			OPENCUT_BRIDGE_PORT: String(port),
			OPENCUT_RECEIPT_DIR: directory,
		},
	});
	const client = new JsonLineClient(child);
	await client.request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "preflight-registration-test", version: "1" },
	});
	client.notify("notifications/initialized", {});
	const listed = asRecord(await client.request("tools/list", {}));
	const tools = Array.isArray(listed.tools) ? listed.tools.map(asRecord) : [];
	const names = tools.map((tool) => tool.name);
	expect(names).toContain("opencut_preflight_edit_plan");
	expect(names).toContain("opencut_get_edit_plan_preflight");
	expect(names).toContain("opencut_list_edit_plan_preflights");
	const preflight = tools.find(
		(tool) => tool.name === "opencut_preflight_edit_plan",
	);
	const inputSchema = asRecord(preflight?.inputSchema);
	expect(inputSchema.additionalProperties).toBe(false);
	expect(JSON.stringify(inputSchema)).toContain(
		'"resolvedAllocations":{"not":{}}',
	);
	const expectedOperationKinds = editOperationSchema.options
		.map((schema) => schema.shape.kind.value)
		.sort();
	const expectedOperationKindSet = new Set<string>(expectedOperationKinds);
	const properties = asRecord(inputSchema.properties);
	const operations = asRecord(properties.operations);
	const publishedOperationKinds = [...collectStringConstants(operations)]
		.filter((value) => expectedOperationKindSet.has(value))
		.sort();
	expect(expectedOperationKinds).toHaveLength(55);
	expect(publishedOperationKinds).toEqual(expectedOperationKinds);
	expect(inputSchema.required).toEqual(
		expect.arrayContaining([
			"contractVersion",
			"preflightId",
			"expectedProjectContentHash",
			"expectedWriteVersion",
			"policy",
		]),
	);
	const receiptlessApply = await callTool(client, "opencut_apply_edit_plan", {
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
		},
		projectId: "project-1",
		operationId: "receiptless-v2-plan",
		expectedRevision: 0,
		expectedProjectContentHash: "a".repeat(64),
		description: "must not apply",
		operations: [
			{
				kind: "delete",
				trackId: "track-1",
				elementId: "element-1",
				ripple: false,
				relationshipScope: "all",
			},
		],
	});
	expect(receiptlessApply).toMatchObject({
		status: "rejected",
		code: "PREFLIGHT_REQUIRED",
		retryable: false,
		operationId: "receiptless-v2-plan",
	});
	expect(
		await callTool(client, "opencut_get_operation", {
			operationId: "receiptless-v2-plan",
		}),
	).toMatchObject({ operation: null, versions: [] });

	const missing = await callTool(client, "opencut_get_edit_plan_preflight", {
		receiptId: "preflight-receipt:missing",
	});
	expect(missing).toMatchObject({
		schemaVersion: "opencut.edit-plan-preflight.v2",
		status: "not-found",
		receiptId: "preflight-receipt:missing",
	});
	const empty = await callTool(client, "opencut_list_edit_plan_preflights", {
		projectId: "project-1",
		limit: 10,
	});
	expect(empty).toMatchObject({
		schemaVersion: "opencut.edit-plan-preflight.v2",
		receipts: [],
	});
});

async function callTool(
	client: JsonLineClient,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = asRecord(
		await client.request("tools/call", { name, arguments: args }),
	);
	expect(result.isError).not.toBe(true);
	const content = Array.isArray(result.content)
		? result.content.map(asRecord)
		: [];
	const text = content.find((entry) => entry.type === "text")?.text;
	if (typeof text !== "string")
		throw new Error(`${name} returned no text result`);
	return asRecord(JSON.parse(text));
}

class JsonLineClient {
	private nextId = 1;
	private buffer = "";
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(private readonly process: ChildProcessWithoutNullStreams) {
		process.stdout.on("data", (chunk) => this.read(String(chunk)));
		process.once("exit", (code) => {
			for (const pending of this.pending.values()) {
				pending.reject(new Error(`MCP server exited with ${String(code)}`));
			}
			this.pending.clear();
		});
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		this.process.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	notify(method: string, params: unknown): void {
		this.process.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = asRecord(JSON.parse(line));
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			if (message.error)
				pending.reject(new Error(JSON.stringify(message.error)));
			else pending.resolve(message.result);
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object");
	}
	return value as Record<string, unknown>;
}

function collectStringConstants(value: unknown): Set<string> {
	const constants = new Set<string>();
	const visit = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") return;
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		for (const [key, nested] of Object.entries(candidate)) {
			if (key === "const" && typeof nested === "string") {
				constants.add(nested);
			} else {
				visit(nested);
			}
		}
	};
	visit(value);
	return constants;
}

async function availablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("failed to allocate a port")));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}
