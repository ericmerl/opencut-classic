import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTranscriptFixture } from "./transcript-test-fixture";
import { TranscriptStore } from "./transcript-store";

let child: ChildProcessWithoutNullStreams | null = null;
let root: string | null = null;

afterEach(async () => {
	await stopServer();
	if (root) await rm(root, { recursive: true, force: true });
	root = null;
});

test("publishes durable transcript analysis and editorial decisions through MCP stdio across restart", async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-transcript-stdio-"));
	const transcriptDirectory = join(root, "transcripts");
	const receipts = join(root, "receipts");
	const providerArtifact = join(root, "provider-transcript.json");
	const modelArtifact = join(root, "parakeet.nemo");
	await writeFile(providerArtifact, '{"text":"one two three"}\n');
	await writeFile(modelArtifact, "pinned-parakeet-model");
	const fixture = makeTranscriptFixture({
		words: [
			{ text: "one", startTicks: 60_000, endTicks: 84_000, confidence: 0.99 },
			{ text: "two", startTicks: 120_000, endTicks: 144_000, confidence: 0.8 },
			{
				text: "three",
				startTicks: 180_000,
				endTicks: 204_000,
				confidence: 0.98,
			},
		],
	});
	fixture.provider.modelArtifact = {
		path: modelArtifact,
		bytes: Buffer.byteLength("pinned-parakeet-model"),
		sha256: sha256("pinned-parakeet-model"),
	};
	fixture.providerArtifact = {
		path: providerArtifact,
		bytes: Buffer.byteLength('{"text":"one two three"}\n'),
		sha256: sha256('{"text":"one two three"}\n'),
	};
	await new TranscriptStore(transcriptDirectory).create(fixture);

	const port = await availablePort();
	let client = await startServer({ port, receipts, transcriptDirectory });
	const listed = asRecord(await client.request("tools/list", {}));
	const names = (Array.isArray(listed.tools) ? listed.tools : [])
		.map(asRecord)
		.map((tool) => tool.name);
	for (const name of [
		"opencut_get_transcript",
		"opencut_search_transcript",
		"opencut_analyze_speech",
		"opencut_create_editorial_decision",
		"opencut_export_editorial_decision_json",
		"opencut_import_editorial_decision_json",
	]) {
		expect(names).toContain(name);
	}

	const transcript = await callTool(client, "opencut_get_transcript", {
		transcriptId: fixture.transcriptId,
	});
	expect(transcript).toMatchObject({
		status: "found",
		transcript: {
			provider: {
				providerId: "nvidia-parakeet-local",
				usedFallback: false,
			},
		},
	});
	const search = await callTool(client, "opencut_search_transcript", {
		transcriptId: fixture.transcriptId,
		query: "two three",
		limit: 5,
	});
	expect(search).toMatchObject({
		status: "found",
		matches: [
			{
				selector: { startWordId: "word-2", endWordId: "word-3" },
				text: "two three",
			},
		],
	});

	const identity = {
		serverInstanceId: "test-server",
		editorInstanceId: "test-editor",
		editorSessionId: "test-session",
		connectionGeneration: 1,
	};
	const mutation = (operationId: string) => ({
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: identity,
		operationId,
	});
	const analyzed = await callTool(client, "opencut_analyze_speech", {
		...mutation("stdio:analysis"),
		analysisId: "analysis:stdio",
		transcriptId: fixture.transcriptId,
		expectedTranscriptVersion: 1,
		parameters: {
			minimumWordConfidence: 0.85,
			minimumSilenceTicks: 1,
			paddingTicks: 0,
			channel: "mix",
			rangePolicy: { kind: "visible-clip" },
		},
	});
	expect(analyzed).toMatchObject({
		status: "analyzed",
		durableOperationStatus: "completed",
	});
	const silenceId = String(
		asRecord((asRecord(analyzed.analysis).silenceRanges as unknown[])[1])
			.rangeId,
	);
	const decision = await callTool(client, "opencut_create_editorial_decision", {
		...mutation("stdio:decision"),
		decisionId: "decision:stdio",
		projectId: fixture.projectId,
		sceneId: fixture.sceneId,
		baseRevision: fixture.projectRevision,
		baseProjectContentHash: fixture.projectContentHash,
		description: "Remove selected silence",
		rationale: "Tighten pacing",
		selection: {
			kind: "silence-ranges",
			analysisId: "analysis:stdio",
			rangeIds: [silenceId],
		},
	});
	expect(decision).toMatchObject({
		status: "created",
		durableOperationStatus: "completed",
		decision: {
			kind: "remove-silence",
			constraints: { ripple: true, providerExecution: "forbidden" },
		},
	});
	expect(
		(
			asRecord(decision.decision).operations as Array<Record<string, unknown>>
		).map((operation) => operation.kind),
	).toEqual(["split", "split", "delete"]);

	const exportPath = join(root, "decision-v1.json");
	const exported = await callTool(
		client,
		"opencut_export_editorial_decision_json",
		{
			...mutation("stdio:export"),
			decisionId: "decision:stdio",
			outputPath: exportPath,
		},
	);
	expect(exported).toMatchObject({ status: "exported", path: exportPath });

	await stopServer();
	client = await startServer({
		port: await availablePort(),
		receipts,
		transcriptDirectory,
	});
	const replay = await callTool(client, "opencut_analyze_speech", {
		...mutation("stdio:analysis"),
		analysisId: "analysis:stdio",
		transcriptId: fixture.transcriptId,
		expectedTranscriptVersion: 1,
		parameters: {
			minimumWordConfidence: 0.85,
			minimumSilenceTicks: 1,
			paddingTicks: 0,
			channel: "mix",
			rangePolicy: { kind: "visible-clip" },
		},
	});
	expect(replay).toMatchObject({
		status: "analyzed",
		durableOperationStatus: "replayed",
	});
	const diff = await callTool(client, "opencut_diff_editorial_decision", {
		decisionId: "decision:stdio",
		currentRevision: fixture.projectRevision + 1,
		currentProjectContentHash: "9".repeat(64),
	});
	expect(diff).toMatchObject({ status: "project-changed" });
	const imported = await callTool(
		client,
		"opencut_import_editorial_decision_json",
		{
			...mutation("stdio:import"),
			path: exportPath,
		},
	);
	expect(imported).toMatchObject({
		status: "replayed",
		lossReport: { lossy: false, droppedFields: [] },
	});
});

async function startServer({
	port,
	receipts,
	transcriptDirectory,
}: {
	port: number;
	receipts: string;
	transcriptDirectory: string;
}): Promise<JsonLineClient> {
	child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
		cwd: import.meta.dir,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
			OPENCUT_BRIDGE_PORT: String(port),
			OPENCUT_RECEIPT_DIR: receipts,
			OPENCUT_TRANSCRIPT_DIR: transcriptDirectory,
		},
	});
	const client = new JsonLineClient(child);
	await client.request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "transcript-stdio-test", version: "1" },
	});
	client.notify("notifications/initialized", {});
	return client;
}

async function stopServer(): Promise<void> {
	if (!child) return;
	const current = child;
	child = null;
	const exited = new Promise<void>((resolve) => {
		if (current.exitCode !== null) resolve();
		else current.once("exit", () => resolve());
	});
	current.stdin.end();
	current.kill("SIGTERM");
	await exited;
}

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
	if (typeof text !== "string") throw new Error(`${name} returned no text`);
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
		process.stdout.setEncoding("utf8");
		process.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
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
		});
		process.once("exit", (code) => {
			for (const pending of this.pending.values()) {
				pending.reject(new Error(`MCP server exited with ${code}`));
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
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected object");
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
				server.close();
				reject(new Error("failed to allocate port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
