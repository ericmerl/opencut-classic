import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement } from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => Math.round(time),
	snappedSeekTime: ({ time }: { time: number }) => time,
}));

const { applyElementUpdate } = await import("@/timeline/update-pipeline");
const { getElementKeyframes } = await import("@/animation");
const { mediaTime, ZERO_MEDIA_TIME } = await import("@/wasm");

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(element: VideoElement): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [element],
		},
		audio: [],
	};
}

describe("applyElementUpdate", () => {
	test("rounds retimed durations back to integer media time", () => {
		const element = buildVideoElement();
		const tracks = buildTracks(element);

		const updatedElement = applyElementUpdate({
			element,
			patch: {
				retime: { rate: 1.5 },
			},
			context: {
				tracks,
				trackId: tracks.main.id,
			},
		});

		expect(updatedElement.duration).toBe(mediaTime({ ticks: 7 }));
		expect(Number.isInteger(updatedElement.duration)).toBe(true);
	});

	test("uses receipt-pinned boundary IDs in lexical property order", () => {
		const element = buildVideoElement({
			animations: {
				volume: {
					keys: [
						{
							id: "volume-start",
							time: mediaTime({ ticks: 0 }),
							value: 0,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
						{
							id: "volume-end",
							time: mediaTime({ ticks: 10 }),
							value: -6,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
					],
				},
				opacity: {
					keys: [
						{
							id: "opacity-start",
							time: mediaTime({ ticks: 0 }),
							value: 1,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
						{
							id: "opacity-end",
							time: mediaTime({ ticks: 10 }),
							value: 0,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
					],
				},
			},
		});
		const calls: string[] = [];
		const updatedElement = applyElementUpdate({
			element,
			patch: { retime: { rate: 2 } },
			context: {
				tracks: buildTracks(element),
				trackId: "main-track",
				resolveDurationClampLeftBoundaryId: (propertyPath) => {
					calls.push(`left:${propertyPath}`);
					return `left-${propertyPath}`;
				},
				resolveDurationClampRightBoundaryId: (propertyPath) => {
					calls.push(`right:${propertyPath}`);
					return `right-${propertyPath}`;
				},
			},
		});

		expect(calls).toEqual([
			"left:opacity",
			"right:opacity",
			"left:volume",
			"right:volume",
		]);
		expect(
			getElementKeyframes({ animations: updatedElement.animations }).map(
				({ id }) => id,
			),
		).toEqual(["opacity-start", "left-opacity", "volume-start", "left-volume"]);
	});
});
