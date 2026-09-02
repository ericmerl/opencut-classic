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
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => null },
}));

const { mediaTime } = await import("@/wasm");
const { buildAuthoredMaskPatch } = await import("./authored-mask-control");

function buildElement(): VideoElement {
	return {
		id: "clip-1",
		name: "clip.mp4",
		type: "video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 240000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

describe("authored mask control", () => {
	test("creates and removes a stable-ID feathered mask", () => {
		const created = buildAuthoredMaskPatch({
			element: buildElement(),
			operation: {
				kind: "set_mask",
				trackId: "main",
				elementId: "clip-1",
				maskId: "mask-1",
				maskType: "ellipse",
				params: {
					feather: 18,
					inverted: true,
					strokeAlign: "inside",
					width: 1,
				},
			},
		});

		expect(created.masks?.[0]).toMatchObject({
			id: "mask-1",
			type: "ellipse",
			params: {
				feather: 18,
				inverted: true,
				strokeAlign: "inside",
				width: 1,
			},
		});
		const removed = buildAuthoredMaskPatch({
			element: { ...buildElement(), masks: created.masks },
			operation: {
				kind: "remove_mask",
				trackId: "main",
				elementId: "clip-1",
				maskId: "mask-1",
			},
		});
		expect(removed.masks).toEqual([]);
	});

	test("accepts authored freeform points and validates closed paths", () => {
		const points = [
			{ id: "a", x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
			{ id: "b", x: 1, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
			{ id: "c", x: 0, y: 1, inX: 0, inY: 0, outX: 0, outY: 0 },
		];
		const patch = buildAuthoredMaskPatch({
			element: buildElement(),
			operation: {
				kind: "set_mask",
				trackId: "main",
				elementId: "clip-1",
				maskId: "freeform-1",
				maskType: "freeform",
				params: { path: points, closed: true },
			},
		});
		expect(patch.masks?.[0]?.params).toMatchObject({
			path: points,
			closed: true,
		});

		expect(() =>
			buildAuthoredMaskPatch({
				element: buildElement(),
				operation: {
					kind: "set_mask",
					trackId: "main",
					elementId: "clip-1",
					maskId: "freeform-2",
					maskType: "freeform",
					params: { path: points.slice(0, 2), closed: true },
				},
			}),
		).toThrow("requires at least three points");
	});
});
