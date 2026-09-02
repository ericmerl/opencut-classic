/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	CompoundElement,
	SceneTracks,
	VideoElement,
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

const { collectAudibleCandidates } = await import("./audio");
const { mediaTime } = await import("@/wasm");

function elementBase({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}) {
	return {
		id,
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 10 }),
		trimEnd: mediaTime({ ticks: 5 }),
		sourceDuration: mediaTime({ ticks: duration + 15 }),
		params: { volume: 0, muted: false },
	};
}

function fixture({ muted = false }: { muted?: boolean } = {}): SceneTracks {
	const nestedVideo: VideoElement = {
		...elementBase({ id: "nested-video", startTime: 50, duration: 200 }),
		type: "video",
		mediaId: "video-media",
	};
	const nestedAudio: AudioElement = {
		...elementBase({ id: "nested-audio", startTime: 0, duration: 100 }),
		type: "audio",
		sourceType: "upload",
		mediaId: "audio-media",
	};
	const compound: CompoundElement = {
		id: "compound",
		name: "compound",
		type: "compound",
		startTime: mediaTime({ ticks: 1000 }),
		duration: mediaTime({ ticks: 200 }),
		trimStart: mediaTime({ ticks: 50 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: mediaTime({ ticks: 250 }),
		params: {},
		tracks: {
			main: {
				id: "nested-main",
				name: "Nested main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [nestedVideo],
			},
			overlay: [],
			audio: [
				{
					id: "nested-audio-track",
					name: "Nested audio",
					type: "audio",
					muted: false,
					elements: [nestedAudio],
				},
			],
		},
	};
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted,
			hidden: false,
			elements: [compound],
		},
		overlay: [],
		audio: [],
	};
}

describe("compound audio flattening", () => {
	test("translates and clips nested video and audio candidates", () => {
		const mediaAssets = [
			{
				id: "video-media",
				name: "video.mp4",
				type: "video" as const,
				file: new File([], "video.mp4", { type: "video/mp4" }),
				hasAudio: true,
			},
			{
				id: "audio-media",
				name: "audio.wav",
				type: "audio" as const,
				file: new File([], "audio.wav", { type: "audio/wav" }),
			},
		];
		const candidates = collectAudibleCandidates({
			tracks: fixture(),
			mediaAssets,
		});
		const video = candidates.find(
			({ element }) => element.id === "nested-video",
		);
		const audio = candidates.find(
			({ element }) => element.id === "nested-audio",
		);
		expect(video?.element).toMatchObject({ startTime: 1000, duration: 200 });
		expect(audio?.element).toMatchObject({
			startTime: 1000,
			duration: 50,
			trimStart: 60,
			trimEnd: 5,
		});
		expect(audio?.localTimeOffset).toBe(50);
		expect(
			collectAudibleCandidates({
				tracks: fixture({ muted: true }),
				mediaAssets,
			}),
		).toHaveLength(0);
	});
});
