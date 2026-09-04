import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	hashCapabilitySnapshot,
	REGISTERED_TOOL_NAMES,
} from "./capability-snapshot";

describe("capability snapshot public MCP transport", () => {
	const processes: CapabilityHarness[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(processes.splice(0).map((process) => process.close()));
		await Promise.all(
			directories
				.splice(0)
				.map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	test("lists and hashes readiness while the editor is not running", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-capability-stdio-"),
		);
		directories.push(directory);
		const port = reservePort();
		const harness = new CapabilityHarness({ port, directory });
		processes.push(harness);
		await harness.start();

		const listed = requireRecord(await harness.request("tools/list", {}));
		const publicToolNames = (listed.tools as Array<Record<string, unknown>>)
			.map((tool) => String(tool.name))
			.sort();
		const snapshot = await harness.callTool("opencut_capabilities");
		const { snapshotHash, ...content } = snapshot;

		expect(publicToolNames).toEqual([...REGISTERED_TOOL_NAMES]);
		expect((snapshot.tools as Record<string, unknown>).registered).toEqual(
			publicToolNames,
		);
		expect(snapshotHash).toBe(hashCapabilitySnapshot(content));
		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			build: {
				buildTimestamp: "2026-09-03T00:00:00.000Z",
				dirty: expect.any(Boolean),
			},
			instance: {
				bridge: { host: "127.0.0.1", port },
				stateDirectory: directory,
			},
			editor: {
				status: "unavailable",
				connected: false,
				reason: "OpenCut web editor is not running or connected.",
			},
			renderer: {
				status: "unknown",
				selectedBackend: null,
				isPinned: false,
				wasm: {
					status: "ready",
					sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
			fonts: {
				status: "unavailable",
				presets: [
					{ id: "tiktok-sans-caption", status: "unknown" },
					{ id: "montserrat-caption", status: "unknown" },
				],
			},
			mediaTools: {
				ffmpeg: { status: "ready", version: expect.any(String) },
				ffprobe: { status: "ready", version: expect.any(String) },
			},
			queue: { jobs: { total: 0 }, batches: 0, disk: { status: "ready" } },
		});
	});
});

class CapabilityHarness {
	private child: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private outputBuffer = "";
	private diagnostics = "";
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(private options: { port: number; directory: string }) {}

	async start(): Promise<void> {
		this.child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
			cwd: join(import.meta.dir, "../../.."),
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
				OPENCUT_BRIDGE_PORT: String(this.options.port),
				OPENCUT_RECEIPT_DIR: this.options.directory,
				OPENCUT_BUILD_TIMESTAMP: "2026-09-03T00:00:00.000Z",
				OPENCUT_HEADLESS_EDITOR_URL: undefined,
				OPENCUT_AUDIO_CLEANER_COMMAND: undefined,
				OPENCUT_MATTE_PRODUCER_COMMAND: undefined,
				OPENCUT_SUBJECT_TRACKER_COMMAND: undefined,
			},
		});
		this.child.stdout.on("data", (chunk) => this.readOutput(String(chunk)));
		this.child.stderr.on("data", (chunk) => {
			this.diagnostics += String(chunk);
		});
		this.child.once("exit", (code) => {
			for (const pending of this.pending.values()) {
				pending.reject(
					new Error(
						`MCP server exited with ${String(code)}: ${this.diagnostics.slice(-2000)}`,
					),
				);
			}
			this.pending.clear();
		});
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "capability-test", version: "1.0.0" },
		});
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
		);
	}

	async callTool(name: string): Promise<Record<string, unknown>> {
		const result = requireRecord(
			await this.request("tools/call", { name, arguments: {} }),
		);
		if (result.isError === true) {
			throw new Error(`${name} failed: ${JSON.stringify(result)}`);
		}
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			(value) => isRecord(value) && value.type === "text",
		);
		if (!isRecord(text) || typeof text.text !== "string") {
			throw new Error(`${name} returned no JSON text content`);
		}
		return requireRecord(JSON.parse(text.text));
	}

	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this.child) throw new Error("MCP server is not running");
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`${method} timed out: ${this.diagnostics.slice(-2000)}`),
				);
			}, 30_000);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject,
			});
			this.child!.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = null;
		const exited = new Promise<void>((resolve) =>
			child.once("exit", () => resolve()),
		);
		child.kill("SIGTERM");
		await Promise.race([
			exited,
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}

	private readOutput(chunk: string): void {
		this.outputBuffer += chunk;
		for (;;) {
			const newline = this.outputBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.outputBuffer.slice(0, newline).trim();
			this.outputBuffer = this.outputBuffer.slice(newline + 1);
			if (!line) continue;
			const message = requireRecord(JSON.parse(line));
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

function reservePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("Bun did not allocate a test port");
	return port;
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("expected an object");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
