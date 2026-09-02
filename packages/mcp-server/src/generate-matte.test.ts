import { describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import type {
	GenerateMatteInput,
	MatteGenerationBridge,
} from "./generate-matte";
import { MatteGenerationService } from "./generate-matte";

describe("MatteGenerationService", () => {
	test("transfers, produces, attaches, and replays one operation", async () => {
		let sourcePath = "";
		let producerCalls = 0;
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

		const first = await service.generate(input());
		const replay = await service.generate(input());

		expect(first).toMatchObject({
			status: "generated-and-attached",
			producer: { modelId: "fixture", modelVersion: "1" },
			source: { mediaId: "media-1", bytesTransferred: 3 },
		});
		expect(replay.status).toBe("replayed");
		expect(producerCalls).toBe(1);
		expect(methods).toEqual([
			"read_project",
			"transfer_source_media",
			"attach_matte",
		]);
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
		revision: 2,
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
