/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";

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

const { DEFAULT_REFRAME } = await import("@/rendering");
const { resolveReframe } = await import("./reframe-control");

describe("reframe control", () => {
	test("normalizes fit and fill aliases", () => {
		expect(
			resolveReframe({
				current: DEFAULT_REFRAME,
				operation: {
					kind: "set_reframe",
					trackId: "main",
					elementId: "clip-1",
					mode: "fill",
				},
			}).mode,
		).toBe("cover");
	});

	test("resolves picture-in-picture presets", () => {
		const result = resolveReframe({
			current: DEFAULT_REFRAME,
			operation: {
				kind: "set_reframe",
				trackId: "overlay",
				elementId: "clip-1",
				layout: "pip-bottom-right",
			},
		});
		expect(result.targetRect).toEqual({
			x: 0.64,
			y: 0.64,
			width: 0.32,
			height: 0.32,
		});
	});

	test("rejects a crop outside normalized bounds", () => {
		expect(() =>
			resolveReframe({
				current: DEFAULT_REFRAME,
				operation: {
					kind: "set_reframe",
					trackId: "main",
					elementId: "clip-1",
					crop: { x: 0.8, y: 0, width: 0.4, height: 1 },
				},
			}),
		).toThrow("normalized bounds");
	});
});
