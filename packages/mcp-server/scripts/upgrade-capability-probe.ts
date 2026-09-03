import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

const expectedCommit = readArgument("--expected-commit");
if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
	throw new Error("--expected-commit must be a 40-character Git commit");
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const serverEntry = resolve(repositoryRoot, "packages/mcp-server/src/index.ts");
const child = spawn(process.execPath, [serverEntry], {
	cwd: repositoryRoot,
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});

let outputBuffer = "";
let diagnostics = "";
let nextId = 1;
const pending = new Map<
	number,
	{ resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

child.stdout.on("data", (chunk) => readOutput(String(chunk)));
child.stderr.on("data", (chunk) => {
	diagnostics += String(chunk);
});
child.once("exit", (code) => {
	for (const request of pending.values()) {
		request.reject(
			new Error(
				`MCP server exited with ${String(code)}: ${diagnostics.slice(-2_000)}`,
			),
		);
	}
	pending.clear();
});

try {
	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "opencut-upgrade-probe", version: "1.0.0" },
	});
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
	);
	const toolResult = requireRecord(
		await request("tools/call", {
			name: "opencut_capabilities",
			arguments: {},
		}),
	);
	if (toolResult.isError === true) {
		throw new Error(
			`opencut_capabilities failed: ${JSON.stringify(toolResult)}`,
		);
	}
	const content = Array.isArray(toolResult.content) ? toolResult.content : [];
	const text = content.find(
		(value) => isRecord(value) && value.type === "text",
	);
	if (!isRecord(text) || typeof text.text !== "string") {
		throw new Error("opencut_capabilities returned no JSON text content");
	}
	const capabilities = requireRecord(JSON.parse(text.text));
	const build = requireRecord(capabilities.build);
	if (build.gitCommit !== expectedCommit) {
		throw new Error(
			`capability build commit ${String(build.gitCommit)} does not match expected ${expectedCommit}`,
		);
	}
	console.log(
		JSON.stringify({
			verified: true,
			expectedCommit,
			actualCommit: build.gitCommit,
			buildTimestamp: build.buildTimestamp,
			snapshotHash: capabilities.snapshotHash,
			bridgePort: requireRecord(requireRecord(capabilities.instance).bridge)
				.port,
		}),
	);
} finally {
	await closeChild(child);
}

function request(
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	const id = nextId++;
	return new Promise((resolveRequest, rejectRequest) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			rejectRequest(
				new Error(`${method} timed out: ${diagnostics.slice(-2_000)}`),
			);
		}, 30_000);
		pending.set(id, {
			resolve: (value) => {
				clearTimeout(timer);
				resolveRequest(value);
			},
			reject: (error) => {
				clearTimeout(timer);
				rejectRequest(error);
			},
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
	});
}

function readOutput(chunk: string): void {
	outputBuffer += chunk;
	for (;;) {
		const newline = outputBuffer.indexOf("\n");
		if (newline < 0) return;
		const line = outputBuffer.slice(0, newline).trim();
		outputBuffer = outputBuffer.slice(newline + 1);
		if (!line) continue;
		const message = requireRecord(JSON.parse(line));
		if (typeof message.id !== "number") continue;
		const waiting = pending.get(message.id);
		if (!waiting) continue;
		pending.delete(message.id);
		if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
		else waiting.resolve(message.result);
	}
}

async function closeChild(
	process: ChildProcessWithoutNullStreams,
): Promise<void> {
	if (process.exitCode !== null) return;
	const exited = new Promise<void>((resolveExit) =>
		process.once("exit", () => resolveExit()),
	);
	process.kill("SIGTERM");
	await Promise.race([
		exited,
		new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
	]);
	if (process.exitCode === null) process.kill("SIGKILL");
}

function readArgument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index < 0 ? undefined : process.argv[index + 1];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("expected an object");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
