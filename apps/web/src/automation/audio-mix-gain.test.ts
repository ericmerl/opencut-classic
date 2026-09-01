/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, VideoElement } from "@/timeline";

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
const { buildAudioMixGainCommand, getUniformAudioGainRange } =
	await import("./audio-mix-gain");

function buildFixture(): { tracks: SceneTracks; mediaAssets: MediaAsset[] } {
	const element: VideoElement = {
		id: "video-1",
		name: "video.mp4",
		type: "video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 240000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: -6, muted: false },
		animations: {
			volume: {
				keys: [
					{
						id: "volume-1",
						time: mediaTime({ ticks: 0 }),
						value: -12,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
	};
	return {
		tracks: {
			overlay: [],
			main: {
				id: "main",
				name: "Main Track",
				type: "video",
				muted: false,
				hidden: false,
				elements: [element],
			},
			audio: [],
		},
		mediaAssets: [
			{
				id: "media-1",
				name: "video.mp4",
				type: "video",
				file: new File([], "video.mp4", { type: "video/mp4" }),
				hasAudio: true,
			},
		],
	};
}

describe("audio mix gain", () => {
	test("computes the common gain range across base and automated volume", () => {
		const fixture = buildFixture();
		expect(getUniformAudioGainRange(fixture)).toEqual({
			minimumGainDb: -48,
			maximumGainDb: 26,
			affectedElementCount: 1,
		});
	});

	test("builds one native update while preserving relative automation", () => {
		const fixture = buildFixture();
		const command = buildAudioMixGainCommand({ ...fixture, gainDb: 4 });
		expect(command.constructor.name).toBe("UpdateElementsCommand");
	});

	test("rejects gains outside the shared range", () => {
		const fixture = buildFixture();
		expect(() => buildAudioMixGainCommand({ ...fixture, gainDb: 27 })).toThrow(
			"audio mix gain must be between",
		);
	});
});
