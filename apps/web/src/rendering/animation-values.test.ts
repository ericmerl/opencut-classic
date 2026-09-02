/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { ElementAnimations } from "@/animation/types";

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
const { DEFAULT_REFRAME } = await import("./reframe");
const { resolveReframeAtTime } = await import("./animation-values");

function linearChannel({
	path,
	start,
	end,
}: {
	path: string;
	start: number;
	end: number;
}): ElementAnimations {
	return {
		[path]: {
			keys: [
				{
					id: `${path}-start`,
					time: mediaTime({ ticks: 0 }),
					value: start,
					segmentToNext: "linear",
					tangentMode: "auto",
				},
				{
					id: `${path}-end`,
					time: mediaTime({ ticks: 120000 }),
					value: end,
					segmentToNext: "linear",
					tangentMode: "auto",
				},
			],
		},
	};
}

describe("animated reframe values", () => {
	test("interpolates focal point and crop values at local clip time", () => {
		const animations = {
			...linearChannel({ path: "reframe.focalX", start: 0.2, end: 0.8 }),
			...linearChannel({ path: "reframe.cropX", start: 0, end: 0.4 }),
		};

		const resolved = resolveReframeAtTime({
			baseReframe: DEFAULT_REFRAME,
			animations,
			localTime: mediaTime({ ticks: 60000 }),
		});

		expect(resolved.focalPoint.x).toBeCloseTo(0.5);
		expect(resolved.crop.x).toBeCloseTo(0.2);
		expect(resolved.targetRect).toEqual(DEFAULT_REFRAME.targetRect);
	});

	test("sanitizes animated rectangles before rendering", () => {
		const resolved = resolveReframeAtTime({
			baseReframe: DEFAULT_REFRAME,
			animations: linearChannel({
				path: "reframe.targetX",
				start: 0,
				end: 2,
			}),
			localTime: mediaTime({ ticks: 120000 }),
		});

		expect(resolved.targetRect.x).toBeLessThan(1);
		expect(resolved.targetRect.width).toBeGreaterThan(0);
		expect(
			resolved.targetRect.x + resolved.targetRect.width,
		).toBeLessThanOrEqual(1);
	});
});
