import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GenerateMatteInput,
	MatteGenerationBridge,
} from "./generate-matte";
import { MatteGenerationService } from "./generate-matte";

describe("MatteGenerationService", () => {
	test("transfers, produces, attaches, and replays one operation", async () => {
		let sourcePath = "";
		let producerCalls = 0;
		const providerStates: string[] = [];
		const methods: string[] = [];
		const bridge: MatteGenerationBridge = {
			sourceTickets: {
				async create(path) {
					sourcePath = path;
					return { url: "http://127.0.0.1/source/fixture", outputPath: path };
				},
			},
			mediaTickets: {
				async create(path) {
					expect((await stat(path)).size).toBe(3);
					return {
						url: "http://127.0.0.1/media/fixture",
						name: "matte.webm",
						mimeType: "video/webm",
						size: 3,
						sourceFingerprint: "matte-fingerprint",
						contentHash: "matte-hash",
					};
				},
			},
			async request(method) {
				methods.push(method);
				if (method === "read_project") return snapshot();
				if (method === "transfer_source_media") {
					await writeFile(sourcePath, new Uint8Array([4, 5, 6]));
					return {
						status: "transferred",
						revision: 2,
						mediaId: "media-1",
						name: "source.mp4",
						mimeType: "video/mp4",
						bytesTransferred: 3,
						sourceFingerprint: "source-fingerprint",
					};
				}
				if (method === "attach_matte") {
					return { status: "applied", revision: 3, assetId: "matte-1" };
				}
				throw new Error(`unexpected method: ${method}`);
			},
		};
		const service = new MatteGenerationService(bridge, () => ({
			async produce(job) {
				producerCalls += 1;
				expect(job.source.contentHash).toHaveLength(64);
				const artifactPath = `${job.outputDirectory}/matte.webm`;
				await writeFile(artifactPath, new Uint8Array([1, 2, 3]));
				return {
					artifactPath,
					channel: "red",
					modelId: "fixture",
					modelVersion: "1",
					warnings: [],
				};
			},
		}));

		const first = await service.generate(input(), async (event) => {
			providerStates.push(event.state);
		});
		const replay = await service.generate(input());

		expect(first).toMatchObject({
			status: "generated-and-attached",
			projectId: "project-1",
			sceneId: "scene-1",
			bridgeProtocolVersion: 2,
			connectionIdentity,
			producer: { modelId: "fixture", modelVersion: "1" },
			source: { mediaId: "media-1", bytesTransferred: 3 },
		});
		expect(replay.status).toBe("replayed");
		expect(producerCalls).toBe(1);
		expect(providerStates).toEqual(["prepared", "committed", "verified"]);
		expect(methods).toEqual([
			"read_project",
			"transfer_source_media",
			"attach_matte",
		]);
	});

	test("reattaches a retained matte without rerunning the provider", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-matte-recover-"));
		const path = join(directory, "matte.webm");
		await writeFile(path, new Uint8Array([1, 2, 3]));
		let producerCalls = 0;
		const states: string[] = [];
		const service = new MatteGenerationService(
			{
				sourceTickets: { create: async () => ({ url: "", outputPath: "" }) },
				mediaTickets: {
					create: async () => ({
						url: "http://fixture",
						name: "matte.webm",
						mimeType: "video/webm",
						size: 3,
						sourceFingerprint: "fingerprint",
						contentHash: "a".repeat(64),
					}),
				},
				request: async (method) => {
					expect(method).toBe("attach_matte");
					return { status: "applied", revision: 3 };
				},
			},
			() => ({
				produce: async () => {
					producerCalls += 1;
					throw new Error("provider must not rerun");
				},
			}),
		);
		try {
			const result = await service.attachRecovered(
				input(),
				{
					path,
					sha256: "a".repeat(64),
					modelId: "fixture",
					modelVersion: "1",
					channel: "red",
				},
				async (event) => {
					states.push(event.state);
				},
			);
			expect(result).toMatchObject({
				status: "generated-and-attached",
				recoveredProviderArtifact: true,
			});
			expect(producerCalls).toBe(0);
			expect(states).toEqual(["verified"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function input(): GenerateMatteInput {
	return {
		projectId: "project-1",
		operationId: "generate-1",
		expectedRevision: 2,
		trackId: "main",
		elementId: "clip-1",
		options: {},
		timeoutSeconds: 30,
	};
}

function snapshot(): Record<string, unknown> {
	return {
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 2,
		bridgeProtocolVersion: 2,
		connectionIdentity,
		requestConnectionIdentity: connectionIdentity,
		elements: [
			{
				trackId: "main",
				elementId: "clip-1",
				type: "video",
				mediaId: "media-1",
			},
		],
		mediaAssets: [
			{
				assetId: "media-1",
				name: "source.mp4",
				width: 1080,
				height: 1920,
				duration: 2,
				fps: 30,
			},
		],
	};
}

const connectionIdentity = {
	serverInstanceId: "server-1",
	editorInstanceId: "editor-1",
	editorSessionId: "session-1",
	connectionGeneration: 1,
};
