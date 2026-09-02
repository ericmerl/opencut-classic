import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AudioCleanupService,
	type AudioCleanupBridge,
	type CleanAudioInput,
} from "./clean-audio";

describe("AudioCleanupService", () => {
	test("transfers, cleans, attaches, and replays one operation", async () => {
		let sourcePath = "";
		let cleanerCalls = 0;
		const providerStates: string[] = [];
		const methods: string[] = [];
		const bridge: AudioCleanupBridge = {
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
						name: "cleaned.wav",
						mimeType: "audio/wav",
						size: 3,
						sourceFingerprint: "artifact-fingerprint",
						contentHash: "artifact-hash",
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
						name: "source.wav",
						mimeType: "audio/wav",
						bytesTransferred: 3,
						sourceFingerprint: "source-fingerprint",
					};
				}
				if (method === "attach_clean_audio") {
					return { status: "applied", revision: 3, assetId: "cleaned-1" };
				}
				throw new Error(`unexpected method: ${method}`);
			},
		};
		const service = new AudioCleanupService(bridge, () => ({
			async clean(job) {
				cleanerCalls += 1;
				expect(job.source.contentHash).toHaveLength(64);
				expect(job.clip).toEqual({
					startTime: 12_000,
					duration: 120_000,
					trimStart: 24_000,
					trimEnd: 0,
					retimeRate: 2,
					maintainPitch: true,
				});
				expect(job.cleanup).toEqual({
					noiseReduction: 0.7,
					deReverb: 0.2,
					deEss: 0.1,
					highPassHz: 90,
					normalize: true,
				});
				const artifactPath = `${job.outputDirectory}/cleaned.wav`;
				await writeFile(artifactPath, new Uint8Array([1, 2, 3]));
				return {
					artifactPath,
					modelId: "fixture",
					modelVersion: "1",
					warnings: [],
				};
			},
		}));

		const first = await service.clean(input(), async (event) => {
			providerStates.push(event.state);
		});
		const replay = await service.clean(input());

		expect(first).toMatchObject({
			status: "cleaned-and-attached",
			projectId: "project-1",
			sceneId: "scene-1",
			bridgeProtocolVersion: 2,
			connectionIdentity,
			cleaner: { modelId: "fixture", modelVersion: "1" },
			source: { mediaId: "media-1", bytesTransferred: 3 },
		});
		expect(replay.status).toBe("replayed");
		expect(cleanerCalls).toBe(1);
		expect(providerStates).toEqual(["prepared", "committed", "verified"]);
		expect(methods).toEqual([
			"read_project",
			"transfer_source_media",
			"attach_clean_audio",
		]);
	});

	test("reattaches a retained provider artifact without rerunning cleanup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-clean-recover-"));
		const path = join(directory, "cleaned.wav");
		await writeFile(path, new Uint8Array([1, 2, 3]));
		let cleanerCalls = 0;
		const states: string[] = [];
		const service = new AudioCleanupService(
			{
				sourceTickets: { create: async () => ({ url: "", outputPath: "" }) },
				mediaTickets: {
					create: async () => ({
						url: "http://fixture",
						name: "cleaned.wav",
						mimeType: "audio/wav",
						size: 3,
						sourceFingerprint: "fingerprint",
						contentHash: "a".repeat(64),
					}),
				},
				request: async (method) => {
					expect(method).toBe("attach_clean_audio");
					return { status: "applied", revision: 3 };
				},
			},
			() => ({
				clean: async () => {
					cleanerCalls += 1;
					throw new Error("cleanup must not rerun");
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
				},
				async (event) => {
					states.push(event.state);
				},
			);
			expect(result).toMatchObject({
				status: "cleaned-and-attached",
				recoveredProviderArtifact: true,
			});
			expect(cleanerCalls).toBe(0);
			expect(states).toEqual(["verified"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function input(): CleanAudioInput {
	return {
		projectId: "project-1",
		operationId: "clean-1",
		expectedRevision: 2,
		trackId: "audio-1",
		elementId: "clip-1",
		noiseReduction: 0.7,
		deReverb: 0.2,
		deEss: 0.1,
		highPassHz: 90,
		normalize: true,
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
				trackId: "audio-1",
				elementId: "clip-1",
				type: "audio",
				mediaId: "media-1",
				startTime: 12_000,
				duration: 120_000,
				trimStart: 24_000,
				trimEnd: 0,
				retime: { rate: 2, maintainPitch: true },
			},
		],
		mediaAssets: [
			{
				assetId: "media-1",
				name: "source.wav",
				type: "audio",
				duration: 2,
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
