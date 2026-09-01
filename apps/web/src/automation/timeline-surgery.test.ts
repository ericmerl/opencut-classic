/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { VideoElement } from "@/timeline";

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
const { buildTrimPatch, getElementSourceDuration, validateTrackCreationPlan } =
	await import("./timeline-surgery");

function buildVideoElement(): VideoElement {
	return {
		id: "video-1",
		name: "fixture.mp4 (right)",
		type: "video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 240000 }),
		duration: mediaTime({ ticks: 300000 }),
		trimStart: mediaTime({ ticks: 180000 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: mediaTime({ ticks: 480000 }),
		params: { volume: 0, muted: false },
	};
}

describe("timeline surgery", () => {
	test("requires new tracks to be populated atomically", () => {
		expect(() =>
			validateTrackCreationPlan([
				{ kind: "add_track", trackType: "video", trackId: "overlay-1" },
			]),
		).toThrow(
			"new track overlay-1 must receive an element from a later move in the same plan",
		);

		expect(() =>
			validateTrackCreationPlan([
				{ kind: "add_track", trackType: "video", trackId: "overlay-1" },
				{
					kind: "move",
					trackId: "main-track",
					targetTrackId: "overlay-1",
					elementId: "video-1",
					startTime: mediaTime({ ticks: 300000 }),
				},
			]),
		).not.toThrow();
	});

	test("reports the full source duration after a split", () => {
		expect(
			Number(getElementSourceDuration({ element: buildVideoElement() })),
		).toBe(480000);
	});

	test("derives visible duration from independent source-edge trims", () => {
		const patch = buildTrimPatch({
			element: buildVideoElement(),
			trimStart: mediaTime({ ticks: 210000 }),
			trimEnd: mediaTime({ ticks: 60000 }),
		});

		expect(patch).toMatchObject({
			startTime: 240000,
			duration: 210000,
			trimStart: 210000,
			trimEnd: 60000,
		});
	});

	test("rejects a duration inconsistent with the source trims", () => {
		expect(() =>
			buildTrimPatch({
				element: buildVideoElement(),
				duration: mediaTime({ ticks: 200000 }),
				trimStart: mediaTime({ ticks: 210000 }),
				trimEnd: mediaTime({ ticks: 60000 }),
			}),
		).toThrow("duration must be 210000 ticks for the requested source trims");
	});

	test("rejects trims that consume the full source", () => {
		expect(() =>
			buildTrimPatch({
				element: buildVideoElement(),
				trimStart: mediaTime({ ticks: 240000 }),
				trimEnd: mediaTime({ ticks: 240000 }),
			}),
		).toThrow("trimStart and trimEnd must leave a visible source span");
	});
});
