/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
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

class ToggleSourceAudioSeparationCommand {
	constructor(readonly params: unknown) {}
}

mock.module(
	"@/commands/timeline/element/toggle-source-audio-separation",
	() => ({ ToggleSourceAudioSeparationCommand }),
);

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

function videoAsset(hasAudio: boolean): MediaAsset {
	return {
		id: "media-1",
		name: "presenter.mp4",
		type: "video",
		file: new File([], "presenter.mp4", { type: "video/mp4" }),
		hasAudio,
	};
}

describe("source audio separation", () => {
	test("builds the existing extraction command for a video with audio", () => {
		const command = buildSourceAudioSeparationCommand({
			element: video(),
			trackId: "main",
			mediaAsset: videoAsset(true),
		});

		expect(command.constructor.name).toBe("ToggleSourceAudioSeparationCommand");
	});

	test("passes every evaluator-resolved ID to the native command", () => {
		const resolvedAllocations = [
			{
				role: "keyframe" as const,
				sourceId: "source-gain-keyframe",
				resolvedId: "resolved-gain-keyframe",
			},
		];
		const command = buildSourceAudioSeparationCommand({
			element: video(),
			trackId: "main",
			mediaAsset: videoAsset(true),
			resolvedIds: {
				audioTrackId: "resolved-audio-track",
				audioElementId: "resolved-audio-element",
				linkId: "resolved-link",
				resolvedAllocations,
			},
		});
		if (!(command instanceof ToggleSourceAudioSeparationCommand)) {
			throw new Error("expected source audio separation command");
		}

		expect(command.params).toEqual({
			trackId: "main",
			elementId: "video-1",
			audioTrackId: "resolved-audio-track",
			audioElementId: "resolved-audio-element",
			linkId: "resolved-link",
			resolvedAllocations,
		});
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
				mediaAsset: videoAsset(false),
			}),
		).toThrow("does not contain extractable audio");
	});
});
