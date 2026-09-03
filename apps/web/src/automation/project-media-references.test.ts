/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type {
	CompoundElement,
	SceneTracks,
	TScene,
	UploadAudioElement,
	VideoElement,
} from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));

const { mediaTime } = await import("@/wasm");
const { countProjectAssetReferences } = await import(
	"./project-media-references"
);

describe("project media references", () => {
	test("counts primary media and both attachment kinds across scenes", () => {
		const target = video("target");
		target.matte = attachment("artifact");
		const primary = video("primary");
		primary.mediaId = "artifact";
		const replacement = audio("replacement");
		replacement.audioReplacement = audioAttachment("artifact");

		expect(
			countProjectAssetReferences({
				projectScenes: [
					scene({ id: "one", tracks: tracks({ videos: [target] }) }),
					scene({
						id: "two",
						tracks: tracks({ videos: [primary], audios: [replacement] }),
					}),
				],
				assetId: "artifact",
			}),
		).toBe(3);
	});

	test("recurses through compound tracks", () => {
		const nested = video("nested");
		nested.matte = attachment("artifact");
		const compound: CompoundElement = {
			id: "compound",
			name: "Compound",
			type: "compound",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
			tracks: tracks({ videos: [nested] }),
		};
		const sceneTracks = tracks({ videos: [] });
		sceneTracks.overlay.push({
			id: "compound-track",
			name: "Video track",
			type: "video",
			muted: false,
			hidden: false,
			elements: [compound],
		});

		expect(
			countProjectAssetReferences({
				projectScenes: [scene({ id: "one", tracks: sceneTracks })],
				assetId: "artifact",
			}),
		).toBe(1);
	});
});

function video(id: string): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: `media-${id}`,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function audio(id: string): UploadAudioElement {
	return {
		id,
		name: id,
		type: "audio",
		sourceType: "upload",
		mediaId: `media-${id}`,
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function attachment(assetId: string): NonNullable<VideoElement["matte"]> {
	return {
		assetId,
		sourceMediaId: "source",
		sourceFingerprint: null,
		artifactHash: "hash",
		artifactFingerprint: "fingerprint",
		channel: "alpha",
		modelId: "model",
		modelVersion: "1",
		enabled: true,
	};
}

function audioAttachment(
	assetId: string,
): NonNullable<UploadAudioElement["audioReplacement"]> {
	return {
		assetId,
		sourceMediaId: "source",
		sourceFingerprint: null,
		artifactHash: "hash",
		artifactFingerprint: "fingerprint",
		modelId: "model",
		modelVersion: "1",
		enabled: true,
	};
}

function tracks({
	videos,
	audios = [],
}: {
	videos: VideoElement[];
	audios?: UploadAudioElement[];
}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: videos,
		},
		overlay: [],
		audio: audios.length
			? [
					{
						id: "audio",
						name: "Audio track",
						type: "audio",
						muted: false,
						elements: audios,
					},
				]
			: [],
	};
}

function scene({ id, tracks }: { id: string; tracks: SceneTracks }): TScene {
	const timestamp = new Date("2026-09-02T00:00:00.000Z");
	return {
		id,
		name: id,
		isMain: id === "one",
		tracks,
		bookmarks: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}
