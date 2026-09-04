import type { TranscriptStore } from "./transcript-store";

export function makeTranscriptFixture({
	words,
}: {
	words: Array<{
		text: string;
		startTicks: number;
		endTicks: number;
		confidence: number | null;
	}>;
}): Parameters<TranscriptStore["create"]>[0] {
	const transcriptWords = words.map((word, index) => ({
		wordId: `word-${index + 1}`,
		segmentId: "segment-1",
		index,
		originalText: word.text,
		text: word.text,
		sourceTime: { startTicks: word.startTicks, endTicks: word.endTicks },
		timelineTime: {
			startTicks: 120_000 + word.startTicks,
			endTicks: 120_000 + word.endTicks,
		},
		speaker: null,
		confidence: word.confidence,
	}));
	return {
		transcriptId: "transcript-1",
		operationId: "transcription-operation-1",
		requestFingerprint: "e".repeat(64),
		projectId: "project-1",
		sceneId: "scene-1",
		projectRevision: 2,
		projectContentHash: "f".repeat(64),
		source: {
			assetId: "asset-1",
			trackId: "track-1",
			clipId: "clip-1",
			name: "source.wav",
			mimeType: "audio/wav",
			contentHash: { algorithm: "SHA-256", digest: "c".repeat(64) },
			sourceFingerprint: "fingerprint-1",
			durationTicks: 360_000,
			clip: {
				timelineStartTicks: 120_000,
				durationTicks: 240_000,
				trimStartTicks: 0,
				trimEndTicks: 120_000,
				retimeRate: 1,
			},
		},
		language: "en",
		originalText: transcriptWords.map((word) => word.text).join(" "),
		text: transcriptWords.map((word) => word.text).join(" "),
		segments: transcriptWords.length
			? [
					{
						segmentId: "segment-1",
						index: 0,
						originalText: transcriptWords.map((word) => word.text).join(" "),
						text: transcriptWords.map((word) => word.text).join(" "),
						sourceTime: {
							startTicks: transcriptWords[0]!.sourceTime.startTicks,
							endTicks: transcriptWords.at(-1)!.sourceTime.endTicks,
						},
						timelineTime: {
							startTicks: transcriptWords[0]!.timelineTime.startTicks,
							endTicks: transcriptWords.at(-1)!.timelineTime.endTicks,
						},
						speaker: null,
						confidence: null,
						wordIds: transcriptWords.map((word) => word.wordId),
					},
				]
			: [],
		words: transcriptWords,
		correctionHistory: [],
		mappings: { captions: [], cuts: [] },
		provider: {
			providerId: "nvidia-parakeet-local",
			providerVersion: "provider-v1",
			workflowVersion: "parakeet-raw-padded-v1",
			modelId: "nvidia/parakeet-tdt-0.6b-v2",
			modelRevision: "revision-1",
			modelArtifact: {
				path: "C:\\models\\parakeet.nemo",
				bytes: 10,
				sha256: "a".repeat(64),
			},
			device: "cuda",
			deviceName: "test GPU",
			runtime: { torch: "2.8.0" },
			decision: "matching_parakeet",
			usedFallback: false,
			reviewReasons: [],
			warnings: [],
		},
		providerArtifact: {
			path: "C:\\evidence\\transcript.json",
			bytes: 10,
			sha256: "b".repeat(64),
		},
	};
}
