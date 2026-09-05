import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string | null = null;

afterEach(async () => {
	if (!directory) return;
	await rm(directory, { recursive: true, force: true, maxRetries: 5 });
	directory = null;
});

test("exits promptly after the MCP client closes stdin", async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-mcp-shutdown-"));
	const child = Bun.spawn(
		[process.execPath, "run", "packages/mcp-server/src/index.ts"],
		{
			cwd: resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				OPENCUT_BRIDGE_TOKEN: "a".repeat(64),
				OPENCUT_BRIDGE_PORT: String(await availablePort()),
				OPENCUT_RECEIPT_DIR: directory,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "shutdown-test", version: "1.0.0" },
				},
			})}\n`,
		);
		child.stdin.flush();
		await readFirstLine(child.stdout);
		child.stdin.end();
		const exitCode = await Promise.race([
			child.exited,
			Bun.sleep(2_000).then(() => null),
		]);
		expect(exitCode).not.toBeNull();
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}, 30_000);

async function readFirstLine(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let value = "";
	try {
		while (!value.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("MCP server closed before initialize");
			value += decoder.decode(next.value, { stream: true });
		}
		return value.split("\n", 1)[0] ?? "";
	} finally {
		reader.releaseLock();
	}
}

function availablePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolvePort(port)));
		});
	});
}
