import { describe, expect, test } from "bun:test";
import {
	planTimeMapTrim,
	getSourceSpanAtClipTime,
	splitRetimeAtClipTime,
} from "@/retime";
import type { RetimeConfig } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

describe("retime split", () => {
	test("slices a ramp, hold, and reverse map for a timeline trim", () => {
		const retime: RetimeConfig = {
			rate: 1,
			mode: "time-map",
			timeMap: {
				schemaVersion: "opencut.time-map.v1",
				frameInterpolation: { requested: "nearest", fallback: "nearest" },
				audioPolicy: { maintainPitch: false, hold: "mute" },
				segments: [
					{
						kind: "speed",
						timelineStart: 0,
						timelineEnd: 60,
						sourceStart: 0,
						startRate: 1,
						endRate: 2,
						direction: "forward",
					},
					{
						kind: "hold",
						timelineStart: 60,
						timelineEnd: 90,
						sourceTime: 90,
						frameIdentity: "source-frame:90",
					},
					{
						kind: "speed",
						timelineStart: 90,
						timelineEnd: 120,
						sourceStart: 90,
						startRate: 1,
						endRate: 1,
						direction: "reverse",
					},
				],
			},
		};
		const trimmed = planTimeMapTrim({
			retime,
			elementStartTime: 0,
			elementDuration: 120,
			sourceTrimStart: 0,
			sourceTrimEnd: 0,
			requestedStartTime: 500,
			timeMapRange: { start: 30, end: 105 },
			requestedTrimStart: 0,
			requestedTrimEnd: 0,
		});
		expect(trimmed.startTime).toBe(500);
		expect(trimmed.duration).toBe(75);
		expect(trimmed.timeMap.segments).toEqual([
			{
				kind: "speed",
				timelineStart: 0,
				timelineEnd: 30,
				sourceStart: 38,
				startRate: 1.5,
				endRate: 2,
				direction: "forward",
			},
			{
				kind: "hold",
				timelineStart: 30,
				timelineEnd: 60,
				sourceTime: 90,
				frameIdentity: "source-frame:90",
			},
			{
				kind: "speed",
				timelineStart: 60,
				timelineEnd: 75,
				sourceStart: 90,
				startRate: 1,
				endRate: 1,
				direction: "reverse",
			},
		]);
	});

	test("measures source span at a clip time", () => {
		const retime: RetimeConfig = { rate: 2 };
		expect(
			getSourceSpanAtClipTime({ clipTime: mediaTime({ ticks: 5 }), retime }),
		).toBe(mediaTime({ ticks: 10 }));
	});

	test("returns zero for non-positive clip time", () => {
		expect(getSourceSpanAtClipTime({ clipTime: mediaTime({ ticks: 0 }) })).toBe(
			ZERO_MEDIA_TIME,
		);
		expect(
			getSourceSpanAtClipTime({ clipTime: mediaTime({ ticks: -1 }) }),
		).toBe(ZERO_MEDIA_TIME);
	});

	test("plans a constant-rate split in Rust and keeps the retime on both halves", () => {
		const retime: RetimeConfig = { rate: 1.5 };
		const result = splitRetimeAtClipTime({
			retime,
			clipDuration: 100,
			splitClipTime: 30,
			sourceTrimStart: 5,
			sourceTrimEnd: 7,
		});
		expect(result.left).toBe(retime);
		expect(result.right).toBe(retime);
		// 30 clip ticks at 1.5x consume 45 source ticks of the 150-tick total.
		expect(result.plan).toEqual({
			leftTimeMap: undefined,
			rightTimeMap: undefined,
			leftTrimStart: 5,
			leftTrimEnd: 112,
			rightTrimStart: 50,
			rightTrimEnd: 7,
		});
	});

	test("returns undefined on both sides when no retime", () => {
		const result = splitRetimeAtClipTime({
			clipDuration: 10,
			splitClipTime: 3,
		});
		expect(result.left).toBeUndefined();
		expect(result.right).toBeUndefined();
		expect(result.plan.rightTrimStart).toBe(3);
		expect(result.plan.leftTrimEnd).toBe(7);
	});

	test("fails closed when Rust rejects the split point", () => {
		expect(() =>
			splitRetimeAtClipTime({ clipDuration: 10, splitClipTime: 10 }),
		).toThrow("Rust rejected");
	});
});
