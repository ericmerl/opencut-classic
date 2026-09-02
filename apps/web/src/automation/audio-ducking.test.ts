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
const { buildAudioDuckingPatch } = await import("./audio-ducking");

function audio(): AudioElement {
	return {
		id: "music-1",
		name: "music.wav",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 100 }),
		duration: mediaTime({ ticks: 1_000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { volume: -6 },
		animations: {
			volume: {
				keys: [
					{
						id: "volume-1",
						time: mediaTime({ ticks: 0 }),
						value: -6,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
	};
}

describe("audio ducking", () => {
	test("creates an independent envelope and preserves volume automation", () => {
		const element = audio();
		const patch = buildAudioDuckingPatch({
			element,
			control: {
				regions: [
					{
						startTime: mediaTime({ ticks: 300 }),
						duration: mediaTime({ ticks: 300 }),
					},
				],
				reductionDb: 12,
				attackDuration: mediaTime({ ticks: 100 }),
				releaseDuration: mediaTime({ ticks: 200 }),
			},
		});

		expect(patch.animations?.volume).toBe(element.animations?.volume);
		expect(
			getElementKeyframes({ animations: patch.animations })
				.filter(({ propertyPath }) => propertyPath === "ducking")
				.map(({ time, value }) => [Number(time), value]),
		).toEqual([
			[0, 0],
			[100, 0],
			[200, -12],
			[500, -12],
			[700, 0],
			[1_000, 0],
		]);
	});

	test("merges nearby regions instead of pumping between speech phrases", () => {
		const patch = buildAudioDuckingPatch({
			element: audio(),
			control: {
				regions: [
					{
						startTime: mediaTime({ ticks: 200 }),
						duration: mediaTime({ ticks: 100 }),
					},
					{
						startTime: mediaTime({ ticks: 350 }),
						duration: mediaTime({ ticks: 100 }),
					},
				],
				reductionDb: 9,
				attackDuration: mediaTime({ ticks: 50 }),
				releaseDuration: mediaTime({ ticks: 50 }),
			},
		});

		expect(
			getElementKeyframes({ animations: patch.animations })
				.filter(({ propertyPath }) => propertyPath === "ducking")
				.map(({ time, value }) => [Number(time), value]),
		).toEqual([
			[0, 0],
			[50, 0],
			[100, -9],
			[350, -9],
			[400, 0],
			[1_000, 0],
		]);
	});

	test("clears only the ducking envelope", () => {
		const ducked = buildAudioDuckingPatch({
			element: audio(),
			control: {
				regions: [
					{
						startTime: mediaTime({ ticks: 200 }),
						duration: mediaTime({ ticks: 100 }),
					},
				],
				reductionDb: 12,
				attackDuration: mediaTime({ ticks: 0 }),
				releaseDuration: mediaTime({ ticks: 0 }),
			},
		});
		const patch = buildAudioDuckingPatch({
			element: { ...audio(), animations: ducked.animations },
			control: {
				regions: [],
				reductionDb: 12,
				attackDuration: mediaTime({ ticks: 0 }),
				releaseDuration: mediaTime({ ticks: 0 }),
			},
		});

		expect(patch.animations?.volume).toBeDefined();
		expect(patch.animations?.ducking).toBeUndefined();
	});

	test("uses one-tick edges when attack and release are zero", () => {
		const patch = buildAudioDuckingPatch({
			element: audio(),
			control: {
				regions: [
					{
						startTime: mediaTime({ ticks: 200 }),
						duration: mediaTime({ ticks: 100 }),
					},
				],
				reductionDb: 12,
				attackDuration: mediaTime({ ticks: 0 }),
				releaseDuration: mediaTime({ ticks: 0 }),
			},
		});

		expect(
			getElementKeyframes({ animations: patch.animations })
				.filter(({ propertyPath }) => propertyPath === "ducking")
				.map(({ time, value }) => [Number(time), value]),
		).toContainEqual([201, 0]);
	});

	test("rejects visual-only targets and non-overlapping regions", () => {
		const image: ImageElement = {
			id: "image-1",
			name: "image.png",
			type: "image",
			mediaId: "media-2",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 1_000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};
		expect(() =>
			buildAudioDuckingPatch({
				element: image,
				control: {
					regions: [],
					reductionDb: 12,
					attackDuration: mediaTime({ ticks: 0 }),
					releaseDuration: mediaTime({ ticks: 0 }),
				},
			}),
		).toThrow("requires a video or audio element");
		expect(() =>
			buildAudioDuckingPatch({
				element: audio(),
				control: {
					regions: [
						{
							startTime: mediaTime({ ticks: 2_000 }),
							duration: mediaTime({ ticks: 100 }),
						},
					],
					reductionDb: 12,
					attackDuration: mediaTime({ ticks: 0 }),
					releaseDuration: mediaTime({ ticks: 0 }),
				},
			}),
		).toThrow("do not overlap");
	});
});
