import { describe, expect, test } from "bun:test";
import {
	sliceRetimeForTimelineRange,
	getSourceSpanAtClipTime,
	splitRetimeAtClipTime,
} from "@/retime";
import type { RetimeConfig } from "@/timeline";

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
		const trimmed = sliceRetimeForTimelineRange({
			retime,
			startClipTime: 30,
			endClipTime: 105,
		});
		expect(trimmed?.timeMap?.segments).toEqual([
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
		expect(getSourceSpanAtClipTime({ clipTime: 5, retime })).toBe(10);
	});

	test("returns zero for non-positive clip time", () => {
		expect(getSourceSpanAtClipTime({ clipTime: 0 })).toBe(0);
		expect(getSourceSpanAtClipTime({ clipTime: -1 })).toBe(0);
	});

	test("passes the same retime to both halves when splitting", () => {
		const retime: RetimeConfig = { rate: 1.5 };
		const result = splitRetimeAtClipTime({ retime, splitClipTime: 3 });
		expect(result.left).toBe(retime);
		expect(result.right).toBe(retime);
	});

	test("returns undefined on both sides when no retime", () => {
		const result = splitRetimeAtClipTime({ splitClipTime: 3 });
		expect(result.left).toBeUndefined();
		expect(result.right).toBeUndefined();
	});
});
