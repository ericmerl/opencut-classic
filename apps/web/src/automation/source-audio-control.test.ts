/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { ImageElement, VideoElement } from "@/timeline";

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

class BatchCommand {}
class ToggleSourceAudioSeparationCommand {}

mock.module("@/commands", () => ({ BatchCommand }));
mock.module("@/commands/timeline", () => ({
	ToggleSourceAudioSeparationCommand,
}));

const { mediaTime } = await import("@/wasm");
const { buildSourceAudioSeparationCommand } =
	await import("./source-audio-control");

function video(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-1",
		name: "presenter.mp4",
		type: "video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 480_000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		...overrides,
	};
}

describe("source audio separation", () => {
	test("builds the existing extraction command for a video with audio", () => {
		const command = buildSourceAudioSeparationCommand({
			element: video(),
			trackId: "main",
			mediaAsset: { id: "media-1", type: "video", hasAudio: true } as never,
		});

		expect(command.constructor.name).toBe("ToggleSourceAudioSeparationCommand");
	});

	test("is a deterministic no-op when source audio is already separated", () => {
		const command = buildSourceAudioSeparationCommand({
			element: video({ isSourceAudioEnabled: false }),
			trackId: "main",
			mediaAsset: null,
		});

		expect(command.constructor.name).toBe("BatchCommand");
	});

	test("rejects unsupported elements and silent video sources", () => {
		const image: ImageElement = {
			id: "image-1",
			name: "image.png",
			type: "image",
			mediaId: "media-2",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};
		expect(() =>
			buildSourceAudioSeparationCommand({
				element: image,
				trackId: "main",
				mediaAsset: null,
			}),
		).toThrow("only be separated from video");
		expect(() =>
			buildSourceAudioSeparationCommand({
				element: video(),
				trackId: "main",
				mediaAsset: {
					id: "media-1",
					type: "video",
					hasAudio: false,
				} as never,
			}),
		).toThrow("does not contain extractable audio");
	});
});
