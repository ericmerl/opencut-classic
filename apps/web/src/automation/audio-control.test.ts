/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { AudioElement, ImageElement } from "@/timeline";

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

const { getElementKeyframes } = await import("@/animation");
const { mediaTime } = await import("@/wasm");
const { buildAudioControlPatch } = await import("./audio-control");

function buildAudioElement(): AudioElement {
	return {
		id: "audio-1",
		name: "dialogue.wav",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 480000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: 0, muted: false },
	};
}

describe("buildAudioControlPatch", () => {
	test("sets gain and mute without replacing existing automation", () => {
		const element = buildAudioElement();
		const patch = buildAudioControlPatch({
			element,
			control: { volumeDb: -6, muted: true },
		});

		expect(patch.params?.volume).toBe(-6);
		expect(patch.params?.muted).toBe(true);
		expect("animations" in patch).toBe(false);
	});

	test("builds a deterministic linear fade envelope", () => {
		const element = buildAudioElement();
		const patch = buildAudioControlPatch({
			element,
			control: {
				volumeDb: -6,
				fade: {
					inDuration: mediaTime({ ticks: 120000 }),
					outDuration: mediaTime({ ticks: 240000 }),
					floorDb: -60,
				},
			},
		});

		expect(
			getElementKeyframes({ animations: patch.animations }).map(
				({ propertyPath, time, value, interpolation }) => ({
					propertyPath,
					time: Number(time),
					value,
					interpolation,
				}),
			),
		).toEqual([
			{ propertyPath: "volume", time: 0, value: -60, interpolation: "linear" },
			{
				propertyPath: "volume",
				time: 120000,
				value: -6,
				interpolation: "linear",
			},
			{
				propertyPath: "volume",
				time: 240000,
				value: -6,
				interpolation: "linear",
			},
			{
				propertyPath: "volume",
				time: 480000,
				value: -60,
				interpolation: "linear",
			},
		]);
	});

	test("rejects fades that overlap", () => {
		expect(() =>
			buildAudioControlPatch({
				element: buildAudioElement(),
				control: {
					fade: {
						inDuration: mediaTime({ ticks: 300000 }),
						outDuration: mediaTime({ ticks: 300000 }),
						floorDb: -60,
					},
				},
			}),
		).toThrow("audio fades cannot overlap");
	});

	test("rejects non-audio-capable elements", () => {
		const image: ImageElement = {
			id: "image-1",
			name: "image.png",
			type: "image",
			mediaId: "media-1",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 480000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};

		expect(() =>
			buildAudioControlPatch({
				element: image,
				control: { volumeDb: -6 },
			}),
		).toThrow("audio controls require a video or audio element");
	});
});
