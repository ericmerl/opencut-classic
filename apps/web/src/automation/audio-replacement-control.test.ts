/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	LibraryAudioElement,
	SceneTracks,
	TScene,
	UploadAudioElement,
} from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => null },
}));

const {
	buildAudioReplacementAttachment,
	buildAudioReplacementSnapshot,
	countAudioReplacementReferences,
	countProjectAudioReplacementReferences,
	validateAudioReplacementAsset,
} = await import("./audio-replacement-control");
const { resolveElementAudioAsset } = await import("@/media/audio");
const { mediaTime } = await import("@/wasm");

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id,
		name: `${id}.wav`,
		type: "audio",
		file: new File([], `${id}.wav`, { type: "audio/wav" }),
		duration: 2,
		...overrides,
	};
}

function element(
	id: string,
	replacementAssetId = "cleaned-1",
): UploadAudioElement {
	return {
		id,
		name: `${id}.wav`,
		type: "audio",
		sourceType: "upload",
		mediaId: "source-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 240000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: 0, muted: false },
		audioReplacement: {
			assetId: replacementAssetId,
			sourceMediaId: "source-1",
			sourceFingerprint: "source-fingerprint",
			artifactHash: "artifact-hash",
			artifactFingerprint: "artifact-fingerprint",
			modelId: "cleaner",
			modelVersion: "1",
			enabled: true,
		},
	};
}

function tracks(elements: UploadAudioElement[]): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		overlay: [],
		audio: [
			{
				id: "audio-1",
				name: "Audio",
				type: "audio",
				muted: false,
				elements,
			},
		],
	};
}

describe("audio replacement control", () => {
	test("builds provenance and reports source staleness", () => {
		const source = media("source-1", {
			sourceFingerprint: "source-fingerprint",
		});
		const attachment = buildAudioReplacementAttachment({
			assetId: "cleaned-1",
			source,
			artifactHash: "artifact-hash",
			artifactFingerprint: "artifact-fingerprint",
			modelId: "cleaner",
			modelVersion: "1",
		});
		expect(
			buildAudioReplacementSnapshot({
				audioReplacement: attachment,
				assets: [source, media("cleaned-1")],
				source: { ...source, sourceFingerprint: "changed" },
			}),
		).toMatchObject({ assetType: "audio", duration: 2, stale: true });
	});

	test("requires cleaned audio to cover the complete source", () => {
		const source = media("source-1", { duration: 2 });
		expect(() =>
			validateAudioReplacementAsset({
				source,
				replacement: media("cleaned-1", { duration: 2 }),
			}),
		).not.toThrow();
		expect(() =>
			validateAudioReplacementAsset({
				source,
				replacement: media("cleaned-1", { duration: 1 }),
			}),
		).toThrow("does not cover source duration");
	});

	test("resolves enabled replacements without affecting library audio", () => {
		const source = media("source-1");
		const replacement = media("cleaned-1");
		const upload = element("clip-1");
		const assets = new Map([
			[source.id, source],
			[replacement.id, replacement],
		]);
		expect(
			resolveElementAudioAsset({ element: upload, mediaMap: assets }),
		).toBe(replacement);
		upload.audioReplacement = { ...upload.audioReplacement!, enabled: false };
		expect(
			resolveElementAudioAsset({ element: upload, mediaMap: assets }),
		).toBe(source);

		const library: LibraryAudioElement = {
			id: "library-1",
			name: "Library",
			type: "audio",
			sourceType: "library",
			sourceUrl: "https://example.invalid/audio.mp3",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 240000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};
		expect(
			resolveElementAudioAsset({ element: library, mediaMap: assets }),
		).toBeNull();
	});

	test("counts shared replacement references before asset cleanup", () => {
		expect(
			countAudioReplacementReferences({
				tracks: tracks([element("clip-1"), element("clip-2")]),
				assetId: "cleaned-1",
			}),
		).toBe(2);
		expect(
			countProjectAudioReplacementReferences({
				projectScenes: [
					scene({ id: "scene-1", tracks: tracks([element("clip-1")]) }),
					scene({ id: "scene-2", tracks: tracks([element("clip-2")]) }),
				],
				assetId: "cleaned-1",
			}),
		).toBe(2);
	});
});

function scene({ id, tracks }: { id: string; tracks: SceneTracks }): TScene {
	const timestamp = new Date("2026-09-02T00:00:00.000Z");
	return {
		id,
		name: id,
		isMain: id === "scene-1",
		tracks,
		bookmarks: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}
