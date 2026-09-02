/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { AudioElement } from "./types";

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

const { mediaTime } = await import("@/wasm");
const { dBToLinear, hasAnimatedVolume, resolveEffectiveAudioGain } =
	await import("./audio-state");

function duckedAudio(): AudioElement {
	return {
		id: "music-1",
		name: "music.wav",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: -6 },
		animations: {
			ducking: {
				keys: [
					{
						id: "duck-1",
						time: mediaTime({ ticks: 0 }),
						value: -12,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: "duck-2",
						time: mediaTime({ ticks: 120_000 }),
						value: -12,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
	};
}

describe("audio ducking gain", () => {
	test("adds the ducking envelope to existing clip volume", () => {
		const element = duckedAudio();
		expect(hasAnimatedVolume({ element })).toBe(true);
		expect(resolveEffectiveAudioGain({ element, localTime: 0.5 })).toBeCloseTo(
			dBToLinear(-18),
		);
	});

	test("track mute still wins over ducking", () => {
		expect(
			resolveEffectiveAudioGain({
				element: duckedAudio(),
				trackMuted: true,
				localTime: 0.5,
			}),
		).toBe(0);
	});
});
