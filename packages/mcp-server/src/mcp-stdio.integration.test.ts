import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const integrationTest =
	process.env.OPENCUT_RUN_HEADLESS_INTEGRATION === "1" ? test : test.skip;

let directory: string;
const processes: McpStdioHarness[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-public-mcp-integration-"));
});

afterEach(async () => {
	for (const process of processes.splice(0)) await process.close();
	await removeTemporaryDirectory(directory);
});

integrationTest(
	"drives save, restart replay, and verified export through public MCP tools",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl) {
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		}
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath) {
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		}
		const bridgePort = await availablePort();
		const profileDirectory = join(directory, "profile");
		const receiptDirectory = join(directory, "receipts");
		const sourcePath = join(directory, "public-source.mp4");
		await createSyntheticVideo(sourcePath);
		const sourceHash = createHash("sha256")
			.update(await readFile(sourcePath))
			.digest("hex");

		const first = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		const initialStatus = await first.callTool("opencut_connection_status", {});
		expect(initialStatus.connected).toBe(false);
		await first.callTool("opencut_start_editor_worker", {});
		const connected = await first.callTool("opencut_connection_status", {});
		expect(connected).toMatchObject({ connected: true });
		const initialIdentity = requireRecord(
			connected.connectionIdentity,
			"connectionIdentity",
		);
		const initial = await first.callTool(
			"opencut_get_project",
			affinity(initialIdentity),
		);
		const projectId = requireString(initial.projectId, "projectId");
		const imported = await first.callTool("opencut_import_media", {
			...affinity(initialIdentity),
			projectId,
			operationId: "public-media-import",
			expectedRevision: requireNumber(initial.revision, "revision"),
			path: sourcePath,
			startTime: 0,
			adoptMediaSettings: true,
		});
		expect(imported.status).toBe("applied");
		const importedSnapshot = requireRecord(imported.snapshot, "snapshot");
		const importedElementId = requireString(imported.elementId, "elementId");
		const importedElement = requireRecords(
			importedSnapshot.elements,
			"elements",
		).find((element) => element.elementId === importedElementId);
		if (!importedElement) throw new Error("imported video is missing");
		const importedAsset = requireRecords(
			importedSnapshot.mediaAssets,
			"mediaAssets",
		).find((asset) => asset.assetId === imported.assetId);
		expect(
			requireRecord(
				requireRecord(importedAsset?.sourceIdentity, "sourceIdentity")
					.contentHash,
				"contentHash",
			).digest,
		).toBe(sourceHash);

		const edited = await first.callTool("opencut_apply_edit_plan", {
			...affinity(initialIdentity),
			projectId,
			operationId: "public-observable-grade",
			expectedRevision: requireNumber(imported.revision, "revision"),
			description: "Apply the complete realistic color grade",
			operations: [
				{
					kind: "upsert_effect",
					trackId: requireString(importedElement.trackId, "trackId"),
					elementId: importedElementId,
					effectId: "public-realistic-grade",
					effectType: "color-grade",
					params: {
						temperature: -3,
						tint: 2,
						saturation: -6,
						exposure: -3,
						contrast: 12,
						highlights: -35,
						shadows: 18,
						fade: 6,
					},
					enabled: true,
				},
			],
		});
		expect(edited.status).toBe("applied");
		const editedSnapshot = requireRecord(edited.snapshot, "snapshot");
		const contentHash = requireProjectContentHash(editedSnapshot);
		const saveRequest = {
			...affinity(initialIdentity),
			projectId,
			sceneId: requireString(editedSnapshot.sceneId, "sceneId"),
			operationId: "public-save-barrier",
			expectedRevision: requireNumber(edited.revision, "revision"),
			expectedContentHash: contentHash,
		};
		const saved = await first.callTool("opencut_save_project", saveRequest);
		expect(saved).toMatchObject({
			status: "saved",
			projectId,
			contentHash,
			readbackContentHash: contentHash,
			reloadVerified: true,
		});
		const saveReceiptId = requireString(saved.receiptId, "receiptId");
		const writeVersion = requireNumber(saved.writeVersion, "writeVersion");
		const saveReceipt = await first.callTool("opencut_get_save_receipt", {
			...affinity(initialIdentity),
			operationId: saveRequest.operationId,
		});
		expect(saveReceipt).toMatchObject({
			status: "found",
			receiptId: saveReceiptId,
			writeVersion,
		});

		await first.callTool("opencut_stop_editor_worker", {});
		await first.close();
		const second = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await second.callTool("opencut_start_editor_worker", { projectId });
		const restartedStatus = await second.callTool(
			"opencut_connection_status",
			{},
		);
		const restartedIdentity = requireRecord(
			restartedStatus.connectionIdentity,
			"connectionIdentity",
		);
		expect(restartedIdentity.serverInstanceId).not.toBe(
			initialIdentity.serverInstanceId,
		);
		expect(restartedIdentity.editorInstanceId).toBe(
			initialIdentity.editorInstanceId,
		);
		const reloaded = await second.callTool(
			"opencut_get_project",
			affinity(restartedIdentity),
		);
		expect(requireProjectContentHash(reloaded)).toBe(contentHash);
		const reloadedElement = requireRecords(reloaded.elements, "elements").find(
			(element) => element.elementId === importedElementId,
		);
		expect(reloadedElement).toMatchObject({
			effects: [
				expect.objectContaining({
					effectId: "public-realistic-grade",
					effectType: "color-grade",
				}),
			],
		});
		const replayed = await second.callTool("opencut_save_project", {
			...saveRequest,
			...affinity(restartedIdentity),
		});
		expect(replayed).toMatchObject({
			status: "replayed",
			receiptId: saveReceiptId,
			writeVersion,
			contentHash,
		});

		const outputPath = join(directory, "public-verified.webm");
		const exported = await second.callTool(
			"opencut_export_project",
			{
				...affinity(restartedIdentity),
				projectId,
				operationId: "public-pinned-export",
				expectedRevision: requireNumber(reloaded.revision, "revision"),
				expectedProjectContentHash: contentHash,
				outputPath,
				format: "webm",
				quality: "low",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: true,
				canvasSize: { width: 320, height: 240 },
			},
			5 * 60_000,
		);
		expect(exported).toMatchObject({
			status: "exported",
			projectId,
			savedContentHash: contentHash,
			validation: {
				status: "validated",
				fullDecode: true,
				video: { width: 320, height: 240, fps: 30 },
				audio: { present: true },
			},
		});
		expect((await stat(outputPath)).size).toBeGreaterThan(0);
		const validation = requireRecord(exported.validation, "validation");
		const samples = requireRecords(validation.frameSamples, "frameSamples");
		expect(samples.map((sample) => sample.position)).toEqual([
			"opening",
			"middle",
			"ending",
		]);
		for (const sample of samples) {
			expect(sample.bytes).toBeGreaterThan(0);
			expect(sample.sha256).toMatch(/^[a-f0-9]{64}$/);
		}
		const outerReceipt = await second.callTool("opencut_get_export_receipt", {
			operationId: "public-pinned-export",
		});
		expect(outerReceipt).toMatchObject({
			status: "found",
			receipt: {
				schemaVersion: 1,
				operationId: "public-pinned-export",
				result: {
					status: "exported",
					savedContentHash: contentHash,
				},
			},
		});
		await second.callTool("opencut_stop_editor_worker", {});
	},
	5 * 60_000,
);

function affinity(identity: Record<string, unknown>) {
	return { bridgeProtocolVersion: 2, expectedConnectionIdentity: identity };
}

async function startMcp(options: {
	baseUrl: string;
	browserPath: string;
	bridgePort: number;
	profileDirectory: string;
	receiptDirectory: string;
}): Promise<McpStdioHarness> {
	const harness = new McpStdioHarness(options);
	processes.push(harness);
	await harness.start();
	return harness;
}

class McpStdioHarness {
	private child: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private outputBuffer = "";
	private diagnostics = "";
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(
		private options: {
			baseUrl: string;
			browserPath: string;
			bridgePort: number;
			profileDirectory: string;
			receiptDirectory: string;
		},
	) {}

	async start(): Promise<void> {
		this.child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
			cwd: import.meta.dir,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
				OPENCUT_BRIDGE_PORT: String(this.options.bridgePort),
				OPENCUT_HEADLESS_EDITOR_URL: this.options.baseUrl,
				OPENCUT_HEADLESS_BROWSER_PATH: this.options.browserPath,
				OPENCUT_HEADLESS_PROFILE_DIR: this.options.profileDirectory,
				OPENCUT_HEADLESS_CONNECTION_TIMEOUT_MS: "90000",
				OPENCUT_RECEIPT_DIR: this.options.receiptDirectory,
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
						`MCP server exited with ${String(code)}: ${this.diagnostics.slice(-4000)}`,
					),
				);
			}
			this.pending.clear();
		});
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "opencut-public-integration", version: "1.0.0" },
		});
		this.notify("notifications/initialized", {});
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		timeoutMs = 90_000,
	): Promise<Record<string, unknown>> {
		const result = requireRecord(
			await this.request("tools/call", { name, arguments: args }, timeoutMs),
			`${name} result`,
		);
		if (result.isError === true) {
			throw new Error(`${name} failed: ${JSON.stringify(result)}`);
		}
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			(item) =>
				item &&
				typeof item === "object" &&
				(item as Record<string, unknown>).type === "text",
		) as Record<string, unknown> | undefined;
		if (typeof text?.text !== "string") {
			throw new Error(`${name} returned no JSON text content`);
		}
		return requireRecord(JSON.parse(text.text), `${name} payload`);
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = null;
		const exited = new Promise<void>((resolve) => {
			if (hasExited(child)) resolve();
			else child.once("exit", () => resolve());
		});
		child.stdin.end();
		child.kill("SIGTERM");
		await Promise.race([exited, delay(5_000)]);
		if (!hasExited(child)) {
			child.kill("SIGKILL");
			await Promise.race([exited, delay(2_000)]);
		}
		if (!hasExited(child)) {
			throw new Error("MCP server process did not stop");
		}
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 30_000,
	): Promise<unknown> {
		const child = this.child;
		if (!child) throw new Error("MCP server is not running");
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`${method} timed out: ${this.diagnostics.slice(-4000)}`),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	private readOutput(chunk: string): void {
		this.outputBuffer += chunk;
		for (;;) {
			const newline = this.outputBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.outputBuffer.slice(0, newline).trim();
			this.outputBuffer = this.outputBuffer.slice(newline + 1);
			if (!line) continue;
			let message: Record<string, unknown>;
			try {
				message = requireRecord(JSON.parse(line), "JSON-RPC response");
			} catch (error) {
				this.diagnostics += `\nstdout parse error: ${String(error)}: ${line}`;
				continue;
			}
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(
					new Error(
						`JSON-RPC error for ${message.id}: ${JSON.stringify(message.error)}`,
					),
				);
			} else {
				pending.resolve(message.result);
			}
		}
	}
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function removeTemporaryDirectory(path: string): Promise<void> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			const code =
				error && typeof error === "object" && "code" in error
					? (error as { code?: string }).code
					: null;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
				throw error;
			}
			await delay(100);
		}
	}
	throw lastError;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate a bridge port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

async function createSyntheticVideo(outputPath: string): Promise<void> {
	const ffmpeg =
		process.env.OPENCUT_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
	await new Promise<void>((resolve, reject) => {
		let diagnostics = "";
		const child = spawn(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=320x240:rate=30:duration=2",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=48000:duration=2",
				"-shortest",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-ar",
				"48000",
				"-ac",
				"2",
				outputPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
		);
		child.stderr?.on("data", (data) => {
			diagnostics += String(data);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else
				reject(new Error(`synthetic video generation failed: ${diagnostics}`));
		});
	});
}

function requireProjectContentHash(value: Record<string, unknown>): string {
	const identity = requireRecord(value.contentIdentity, "contentIdentity");
	if (identity.status !== "hashed") {
		throw new Error(`project content identity is ${String(identity.status)}`);
	}
	return requireString(
		requireRecord(identity.hash, "content hash").digest,
		"content digest",
	);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireRecords(
	value: unknown,
	name: string,
): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map((entry) => requireRecord(entry, name));
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number") throw new Error(`${name} must be a number`);
	return value;
}
