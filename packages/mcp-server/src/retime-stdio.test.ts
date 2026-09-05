import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("evaluates ramp, hold, and reverse source times through MCP stdio", async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-retime-stdio-"));
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
		clientInfo: { name: "retime-registration-test", version: "1" },
	});
	client.notify("notifications/initialized", {});

	const result = await callTool(client, "opencut_evaluate_time_map", {
		timeMap: {
			schemaVersion: "opencut.time-map.v1",
			frameInterpolation: {
				requested: "frame-blend",
				fallback: "nearest",
			},
			audioPolicy: { maintainPitch: true, hold: "mute" },
			segments: [
				{
					kind: "speed",
					timelineStart: 0,
					timelineEnd: 120_000,
					sourceStart: 0,
					startRate: 1,
					endRate: 3,
					direction: "forward",
				},
				{
					kind: "hold",
					timelineStart: 120_000,
					timelineEnd: 180_000,
					sourceTime: 240_000,
					frameIdentity: "source-frame:240000",
				},
				{
					kind: "speed",
					timelineStart: 180_000,
					timelineEnd: 300_000,
					sourceStart: 240_000,
					startRate: 1,
					endRate: 1,
					direction: "reverse",
				},
			],
		},
		sampleClipTimes: [0, 60_000, 120_000, 150_000, 240_000, 300_000],
	});

	expect(result).toMatchObject({
		status: "evaluated",
		duration: 300_000,
		frameInterpolation: {
			requested: "frame-blend",
			effective: "nearest",
			fallback: "nearest",
		},
		audioPolicy: { maintainPitch: true, hold: "mute" },
		diagnostics: [
			{
				code: "FRAME_INTERPOLATION_FALLBACK",
				requested: "frame-blend",
				effective: "nearest",
			},
		],
		sourceTimeReadback: [
			{ clipTime: 0, sourceTime: 0, segmentIndex: 0, kind: "speed" },
			{ clipTime: 60_000, sourceTime: 90_000, segmentIndex: 0, kind: "speed" },
			{
				clipTime: 120_000,
				sourceTime: 240_000,
				segmentIndex: 1,
				kind: "hold",
			},
			{
				clipTime: 150_000,
				sourceTime: 240_000,
				segmentIndex: 1,
				kind: "hold",
			},
			{
				clipTime: 240_000,
				sourceTime: 180_000,
				segmentIndex: 2,
				kind: "speed",
			},
			{
				clipTime: 300_000,
				sourceTime: 120_000,
				segmentIndex: 2,
				kind: "speed",
			},
		],
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
	if (typeof text !== "string") throw new Error(`${name} returned no text result`);
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
