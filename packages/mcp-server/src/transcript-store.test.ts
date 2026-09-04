import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("durable transcript store", () => {
	test("persists stable word identities, provenance, mappings, and append-only corrections", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-transcripts-"));
		directories.push(directory);
		const store = new TranscriptStore(directory);
		const created = await store.create(
			baseTranscript(),
			"2026-09-04T10:00:00.000Z",
		);
		expect(created.status).toBe("created");
		expect(created.transcript.version).toBe(1);
		expect(created.transcript.words[0]?.wordId).toBe("word-1");

		const replayed = await store.create(
			baseTranscript(),
			"2026-09-04T11:00:00.000Z",
		);
		expect(replayed.status).toBe("replayed");
		expect(replayed.transcript.createdAt).toBe("2026-09-04T10:00:00.000Z");

		const corrected = await store.update({
			transcriptId: "transcript-1",
			expectedVersion: 1,
			now: "2026-09-04T10:05:00.000Z",
			update: (current) => ({
				...current,
				text: "Hello world",
				words: current.words.map((word) =>
					word.wordId === "word-1" ? { ...word, text: "Hello" } : word,
				),
				segments: current.segments.map((segment) => ({
					...segment,
					text: "Hello world",
				})),
				correctionHistory: [
					...current.correctionHistory,
					{
						correctionId: "correction-1",
						appliedAt: "2026-09-04T10:05:00.000Z",
						policy: "transcript-only",
						changes: [{ wordId: "word-1", before: "hello", after: "Hello" }],
						generatedCaptionOperations: [],
					},
				],
			}),
		});
		expect(corrected.version).toBe(2);
		expect((await store.require("transcript-1", 1)).words[0]?.text).toBe(
			"hello",
		);
		expect(
			(await new TranscriptStore(directory).require("transcript-1")).words[0]
				?.text,
		).toBe("Hello");
	});

	test("rejects changed durable transcript bytes", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-transcripts-tamper-"),
		);
		directories.push(directory);
		const store = new TranscriptStore(directory);
		await store.create(baseTranscript());
		const path = join(directory, sha256("transcript-1"), "00000001.json");
		const record = await store.require("transcript-1");
		await writeFile(path, JSON.stringify({ ...record, text: "tampered" }));
		await expect(store.require("transcript-1")).rejects.toThrow(
			"content hash mismatch",
		);
	});
});

function baseTranscript(): Parameters<TranscriptStore["create"]>[0] {
	const providerArtifact = {
		path: "C:\\evidence\\transcript.json",
		bytes: 100,
		sha256: "b".repeat(64),
	};
	return {
		transcriptId: "transcript-1",
		operationId: "operation-1",
		requestFingerprint: "e".repeat(64),
		projectId: "project-1",
		sceneId: "scene-1",
		projectRevision: 2,
		projectContentHash: "a".repeat(64),
		source: {
			assetId: "asset-1",
			trackId: "track-1",
			clipId: "clip-1",
			name: "source.wav",
			mimeType: "audio/wav",
			contentHash: { algorithm: "SHA-256", digest: "c".repeat(64) },
			sourceFingerprint: "source-fingerprint",
			durationTicks: 240_000,
			clip: {
				timelineStartTicks: 120_000,
				durationTicks: 120_000,
				trimStartTicks: 0,
				trimEndTicks: 120_000,
				retimeRate: 1,
			},
		},
		language: "en",
		originalText: "hello world",
		text: "hello world",
		segments: [
			{
				segmentId: "segment-1",
				index: 0,
				originalText: "hello world",
				text: "hello world",
				sourceTime: { startTicks: 0, endTicks: 120_000 },
				timelineTime: { startTicks: 120_000, endTicks: 240_000 },
				speaker: null,
				confidence: 0.9,
				wordIds: ["word-1", "word-2"],
			},
		],
		words: [
			{
				wordId: "word-1",
				segmentId: "segment-1",
				index: 0,
				originalText: "hello",
				text: "hello",
				sourceTime: { startTicks: 0, endTicks: 48_000 },
				timelineTime: { startTicks: 120_000, endTicks: 168_000 },
				speaker: null,
				confidence: 0.9,
			},
			{
				wordId: "word-2",
				segmentId: "segment-1",
				index: 1,
				originalText: "world",
				text: "world",
				sourceTime: { startTicks: 60_000, endTicks: 120_000 },
				timelineTime: { startTicks: 180_000, endTicks: 240_000 },
				speaker: null,
				confidence: 0.9,
			},
		],
		correctionHistory: [],
		mappings: { captions: [], cuts: [] },
		provider: {
			providerId: "nvidia-parakeet",
			providerVersion: "1",
			workflowVersion: "parakeet-raw-padded-v1",
			modelId: "nvidia/parakeet-tdt-0.6b-v2",
			modelRevision: "revision-1",
			modelArtifact: {
				path: "C:\\models\\parakeet.nemo",
				bytes: 2_472_222_720,
				sha256: "d".repeat(64),
			},
			device: "cuda",
			deviceName: "test GPU",
			runtime: { torch: "2.8.0" },
			decision: "matching_parakeet",
			usedFallback: false,
			reviewReasons: [],
			warnings: [],
		},
		providerArtifact,
	};
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
