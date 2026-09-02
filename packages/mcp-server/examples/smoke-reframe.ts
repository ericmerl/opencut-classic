import { fileURLToPath } from "node:url";

const mediaPath = process.env.OPENCUT_SMOKE_MEDIA_PATH;
const outputPath = process.env.OPENCUT_SMOKE_OUTPUT_PATH;
if (!mediaPath) throw new Error("OPENCUT_SMOKE_MEDIA_PATH is required");
if (!outputPath) throw new Error("OPENCUT_SMOKE_OUTPUT_PATH is required");

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
	await initialize();
	await waitForEditor();
	const operationSuffix = Date.now();
	const created = await callTool(2, "opencut_create_project", {
		operationId: `reframe-project-${operationSuffix}`,
		name: "Reframe MCP Smoke Test",
	});
	const projectId = stringField(created, "projectId");
	const imported = await callTool(3, "opencut_import_media", {
		projectId,
		operationId: `reframe-import-${operationSuffix}`,
		expectedRevision: numberField(created, "revision"),
		path: mediaPath,
		startTime: 0,
	});
	const importedSnapshot = asRecord(imported.snapshot);
	const clip = asRecord(
		asArray(importedSnapshot.elements).find(
			(value) => asRecord(value).type === "video",
		),
	);
	const edited = await callTool(4, "opencut_apply_edit_plan", {
		projectId,
		operationId: `reframe-edit-${operationSuffix}`,
		expectedRevision: numberField(importedSnapshot, "revision"),
		description: "Cover crop around the right-side focal point",
		operations: [
			{
				kind: "set_reframe",
				trackId: clip.trackId,
				elementId: clip.elementId,
				mode: "fill",
				crop: { x: 0.1, y: 0, width: 0.8, height: 1 },
				focalPoint: { x: 0.7, y: 0.5 },
			},
		],
	});
	const editedSnapshot = asRecord(edited.snapshot);
	const editedClip = asRecord(
		asArray(editedSnapshot.elements).find(
			(value) => asRecord(value).elementId === clip.elementId,
		),
	);
	const exported = await callTool(5, "opencut_export_project", {
		projectId,
		operationId: `reframe-export-${operationSuffix}`,
		expectedRevision: numberField(editedSnapshot, "revision"),
		format: "mp4",
		quality: "medium",
		outputPath,
	});
	console.log(
		JSON.stringify(
			{
				projectId,
				revision: editedSnapshot.revision,
				elementId: editedClip.elementId,
				reframe: editedClip.reframe,
				exported,
			},
			null,
			2,
		),
	);
} finally {
	server.kill();
}

async function initialize(): Promise<void> {
	await send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "opencut-reframe-smoke", version: "1" },
		},
	});
	await response(1);
	await send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
		params: {},
	});
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
	if (typeof text !== "string") {
		throw new Error(`${name} returned no text result`);
	}
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

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`${key} must be a string`);
	return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (typeof field !== "number") throw new Error(`${key} must be a number`);
	return field;
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
