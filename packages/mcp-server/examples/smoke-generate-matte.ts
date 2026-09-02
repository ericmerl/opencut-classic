import { fileURLToPath } from "node:url";

const projectId = process.env.OPENCUT_SMOKE_PROJECT_ID;
if (!projectId) throw new Error("OPENCUT_SMOKE_PROJECT_ID is required");

const server = Bun.spawn(
	[process.execPath, "run", "packages/mcp-server/src/index.ts"],
	{
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	},
);
void forwardDiagnostics(server.stderr);
const reader = server.stdout.getReader();
const decoder = new TextDecoder();
let readBuffer = "";

try {
	await send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "opencut-matte-smoke", version: "1" },
		},
	});
	await response(1);
	await send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
		params: {},
	});

	await waitForEditor();
	const before = await callTool(2, "opencut_get_project", {});
	if (before.projectId !== projectId) {
		throw new Error(
			`Expected active project ${projectId}, got ${before.projectId}`,
		);
	}
	const element = asArray(before.elements).find(
		(value) => asRecord(value).type === "video",
	);
	const clip = asRecord(element);
	const operationId = `matte-smoke-${Date.now()}`;
	const generated = await callTool(3, "opencut_generate_matte", {
		projectId,
		operationId,
		expectedRevision: before.revision,
		trackId: clip.trackId,
		elementId: clip.elementId,
		options: { fixture: true },
		timeoutSeconds: 120,
	});
	const replayed = await callTool(4, "opencut_generate_matte", {
		projectId,
		operationId,
		expectedRevision: before.revision,
		trackId: clip.trackId,
		elementId: clip.elementId,
		options: { fixture: true },
		timeoutSeconds: 120,
	});
	console.log(JSON.stringify({ before, generated, replayed }, null, 2));
} finally {
	server.kill();
}

async function waitForEditor(): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const status = await callTool(
			100 + attempt,
			"opencut_connection_status",
			{},
		);
		if (status.connected === true) return;
		await Bun.sleep(500);
	}
	throw new Error("OpenCut editor did not connect to the smoke-test sidecar");
}

async function callTool(
	id: number,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	await send({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	});
	const message = await response(id);
	if (message.error) throw new Error(JSON.stringify(message.error));
	const result = asRecord(message.result);
	if (result.isError === true) throw new Error(JSON.stringify(result));
	const content = asArray(result.content).map(asRecord);
	const text = content.find((item) => item.type === "text")?.text;
	if (typeof text !== "string")
		throw new Error(`${name} returned no text result`);
	return asRecord(JSON.parse(text));
}

async function response(id: number): Promise<Record<string, unknown>> {
	while (true) {
		const message = await nextMessage();
		if (!message) break;
		if (message.id === id) return message;
	}
	throw new Error(`MCP server closed before response ${id}`);
}

async function send(message: Record<string, unknown>): Promise<void> {
	server.stdin.write(`${JSON.stringify(message)}\n`);
	await server.stdin.flush();
}

async function nextMessage(): Promise<Record<string, unknown> | null> {
	while (true) {
		const newline = readBuffer.indexOf("\n");
		if (newline >= 0) {
			const line = readBuffer.slice(0, newline).trim();
			readBuffer = readBuffer.slice(newline + 1);
			if (line) return asRecord(JSON.parse(line));
			continue;
		}
		const { done, value } = await reader.read();
		if (done) return null;
		readBuffer += decoder.decode(value, { stream: true });
	}
}

async function forwardDiagnostics(
	stream: ReadableStream<Uint8Array>,
): Promise<void> {
	const text = await new Response(stream).text();
	if (text.trim()) console.error(text.trim());
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected an object");
	}
	return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected an array");
	return value;
}
