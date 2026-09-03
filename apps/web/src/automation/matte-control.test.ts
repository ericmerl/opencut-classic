/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, TScene, VideoElement } from "@/timeline";

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

const { mediaTime } = await import("@/wasm");
const {
	buildMatteAttachment,
	buildMatteSnapshot,
	countMatteReferences,
	countProjectMatteReferences,
	validateMatteAsset,
} = await import("./matte-control");

function media(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([], `${id}.mp4`, { type: "video/mp4" }),
		width: 1080,
		height: 1920,
		duration: 2,
		fps: 30,
		...overrides,
	};
}

function element(id: string, matteAssetId = "matte-1"): VideoElement {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		mediaId: "source-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 240000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		matte: {
			assetId: matteAssetId,
			sourceMediaId: "source-1",
			sourceFingerprint: "source-fingerprint",
			artifactHash: "artifact-hash",
			artifactFingerprint: "artifact-fingerprint",
			channel: "red",
			modelId: "test-model",
			modelVersion: "1",
			enabled: true,
		},
	};
}

function tracks(elements: VideoElement[]): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements,
		},
		overlay: [],
		audio: [],
	};
}

describe("matte control", () => {
	test("builds persisted provenance and reports source staleness", () => {
		const source = media("source-1", {
			sourceFingerprint: "source-fingerprint",
		});
		const attachment = buildMatteAttachment({
			assetId: "matte-1",
			source,
			artifactHash: "artifact-hash",
			artifactFingerprint: "artifact-fingerprint",
			channel: "red",
			modelId: "test-model",
			modelVersion: "1",
		});
		expect(
			buildMatteSnapshot({
				matte: attachment,
				assets: [source, media("matte-1")],
				source: { ...source, sourceFingerprint: "changed" },
			}),
		).toMatchObject({
			assetType: "video",
			width: 1080,
			height: 1920,
			duration: 2,
			fps: 30,
			stale: true,
		});
	});

	test("accepts static or full-duration matching mattes", () => {
		const source = media("source-1");
		expect(() =>
			validateMatteAsset({
				source,
				matte: media("matte-1", { type: "image", duration: undefined }),
			}),
		).not.toThrow();
		expect(() =>
			validateMatteAsset({ source, matte: media("matte-1") }),
		).not.toThrow();
	});

	test("rejects mismatched aspect ratios and incomplete video mattes", () => {
		const source = media("source-1");
		expect(() =>
			validateMatteAsset({
				source,
				matte: media("matte-1", { width: 1920, height: 1080 }),
			}),
		).toThrow("aspect ratio");
		expect(() =>
			validateMatteAsset({
				source,
				matte: media("matte-1", { duration: 1 }),
			}),
		).toThrow("full source media duration");
	});

	test("counts shared matte references before asset cleanup", () => {
		expect(
			countMatteReferences({
				tracks: tracks([element("clip-1"), element("clip-2")]),
				assetId: "matte-1",
			}),
		).toBe(2);
		expect(
			countProjectMatteReferences({
				projectScenes: [
					scene({ id: "scene-1", tracks: tracks([element("clip-1")]) }),
					scene({ id: "scene-2", tracks: tracks([element("clip-2")]) }),
				],
				assetId: "matte-1",
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
