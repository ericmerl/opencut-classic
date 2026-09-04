import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TranscriptService,
	type SourceTranscriber,
} from "./transcript-service";
import { TranscriptStore } from "./transcript-store";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("source transcript service", () => {
	test("transcribes one source into durable word and timeline mappings, then searches after restart", async () => {
		const fixture = await createFixture();
		const result = await fixture.service.transcribe(fixture.input);
		expect(result.status).toBe("transcribed");
		expect(result.transcript.words).toHaveLength(3);
		expect(result.transcript.words[0]?.timelineTime).toEqual({
			startTicks: 60_000,
			endTicks: 72_000,
		});
		expect(result.transcript.words[2]?.timelineTime).toBeNull();
		expect(result.transcript.provider.modelArtifact.sha256).toBe(
			hashFileContents("model"),
		);

		const restarted = new TranscriptService(
			fixture.bridge,
			new TranscriptStore(fixture.storeDirectory),
			fixture.createTranscriber,
			fixture.artifactDirectory,
		);
		const matches = await restarted.search({
			transcriptId: "transcript-1",
			query: "hello world",
			limit: 10,
		});
		expect(matches).toHaveLength(1);
		expect(matches[0]?.selector.startWordId).toBe(
			result.transcript.words[0]?.wordId,
		);
		expect((await restarted.get("transcript-1"))?.contentHash).toEqual(
			result.transcript.contentHash,
		);
		expect((await restarted.transcribe(fixture.input)).status).toBe("replayed");
	});

	test("keeps original recognition inspectable and generates explicit caption propagation operations", async () => {
		const fixture = await createFixture();
		const created = await fixture.service.transcribe(fixture.input);
		const first = created.transcript.words[0]!;
		await fixture.store.update({
			transcriptId: "transcript-1",
			expectedVersion: 1,
			update: (record) => ({
				...record,
				mappings: {
					...record.mappings,
					captions: [
						{
							trackId: "caption-track",
							elementId: "caption-1",
							startWordId: record.words[0]!.wordId,
							endWordId: record.words[1]!.wordId,
						},
					],
				},
			}),
		});
		const corrected = await fixture.service.correct({
			transcriptId: "transcript-1",
			expectedVersion: 2,
			correctionId: "correction-1",
			policy: "propagate-linked-captions",
			changes: [{ wordId: first.wordId, text: "Hello" }],
		});
		expect(corrected.transcript.words[0]?.originalText).toBe("hello");
		expect(corrected.transcript.words[0]?.text).toBe("Hello");
		expect(corrected.captionOperations).toEqual([
			{
				kind: "update_caption",
				trackId: "caption-track",
				elementId: "caption-1",
				text: "Hello world",
			},
		]);
		expect(corrected.transcript.correctionHistory[0]?.policy).toBe(
			"propagate-linked-captions",
		);
	});

	test("rejects a changed provider artifact during restart readback", async () => {
		const fixture = await createFixture();
		await fixture.service.transcribe(fixture.input);
		await writeFile(
			join(fixture.artifactDirectory, hash("operation-1"), "transcript.json"),
			"changed",
		);

		await expect(fixture.service.get("transcript-1")).rejects.toThrow(
			"provenance artifact changed",
		);
	});

	test("rejects changed reuse of a durable correction ID", async () => {
		const fixture = await createFixture();
		const first = await fixture.service.transcribe(fixture.input);
		const wordId = first.transcript.words[0]!.wordId;
		await fixture.service.correct({
			transcriptId: first.transcript.transcriptId,
			expectedVersion: 1,
			correctionId: "correction:stable",
			policy: "transcript-only",
			changes: [{ wordId, text: "Hello" }],
		});
		await expect(
			fixture.service.correct({
				transcriptId: first.transcript.transcriptId,
				expectedVersion: 2,
				correctionId: "correction:stable",
				policy: "transcript-only",
				changes: [{ wordId, text: "Different" }],
			}),
		).rejects.toThrow("correctionId was already used");
	});
});

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "opencut-transcript-service-"));
	directories.push(root);
	const storeDirectory = join(root, "records");
	const artifactDirectory = join(root, "artifacts");
	const modelPath = join(root, "parakeet.nemo");
	await writeFile(modelPath, "model");
	const bridge = {
		sourceTickets: {
			create: async (path: string) => {
				await writeFile(path, "source-audio");
				return { url: "http://source-ticket", outputPath: path };
			},
		},
		request: async (method: string) => {
			if (method === "read_project") return snapshot();
			if (method === "transfer_source_media") {
				return {
					status: "transferred",
					mediaId: "asset-1",
					name: "source.wav",
					mimeType: "audio/wav",
					bytesTransferred: 12,
					sourceFingerprint: "fingerprint-1",
				};
			}
			throw new Error(`unexpected method ${method}`);
		},
	};
	const createTranscriber = (): SourceTranscriber => ({
		transcribe: async ({ outputDirectory }) => {
			const artifactPath = join(outputDirectory, "transcript.json");
			await writeFile(
				artifactPath,
				JSON.stringify({ text: "hello world outside" }),
			);
			return {
				language: "en",
				text: "hello world outside",
				words: [
					{
						text: "hello",
						startSeconds: 0.5,
						endSeconds: 0.7,
						confidence: 0.95,
						speaker: null,
					},
					{
						text: "world",
						startSeconds: 0.8,
						endSeconds: 1.1,
						confidence: 0.9,
						speaker: null,
					},
					{
						text: "outside",
						startSeconds: 2.6,
						endSeconds: 2.7,
						confidence: 0.8,
						speaker: null,
					},
				],
				provider: {
					providerId: "nvidia-parakeet",
					providerVersion: "1",
					workflowVersion: "parakeet-raw-padded-v1",
					modelId: "nvidia/parakeet-tdt-0.6b-v2",
					modelRevision: "revision-1",
					modelArtifact: {
						path: modelPath,
						bytes: 5,
						sha256: hashFileContents("model"),
					},
					device: "cuda",
					deviceName: "test GPU",
					runtime: { torch: "2.8.0" },
					decision: "matching_parakeet",
					usedFallback: false,
					reviewReasons: [],
					warnings: [],
				},
				artifactPath,
			};
		},
	});
	const store = new TranscriptStore(storeDirectory);
	const service = new TranscriptService(
		bridge,
		store,
		createTranscriber,
		artifactDirectory,
	);
	return {
		root,
		store,
		service,
		bridge,
		createTranscriber,
		storeDirectory,
		artifactDirectory,
		input: {
			bridgeProtocolVersion: 2 as const,
			expectedConnectionIdentity: {
				serverInstanceId: "server-1",
				editorInstanceId: "editor-1",
				editorSessionId: "session-1",
				connectionGeneration: 1,
			},
			projectId: "project-1",
			operationId: "operation-1",
			transcriptId: "transcript-1",
			expectedRevision: 2,
			expectedProjectContentHash: "f".repeat(64),
			trackId: "track-1",
			elementId: "clip-1",
			language: "en" as const,
			terms: [],
			timeoutSeconds: 60,
		},
	};
}

function snapshot() {
	return {
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 2,
		contentIdentity: {
			status: "hashed",
			hash: { algorithm: "SHA-256", digest: "f".repeat(64) },
		},
		elements: [
			{
				trackId: "track-1",
				elementId: "clip-1",
				type: "audio",
				mediaId: "asset-1",
				startTime: 60_000,
				duration: 120_000,
				trimStart: 60_000,
				trimEnd: 60_000,
				retime: { rate: 2 },
			},
		],
		mediaAssets: [{ assetId: "asset-1", name: "source.wav", duration: 3 }],
	};
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashFileContents(value: string): string {
	return hash(value);
}
