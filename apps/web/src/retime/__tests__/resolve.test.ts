import { describe, expect, test } from "bun:test";
import {
	getClipTimeAtSourceTime,
	getEffectiveRateAt,
	getSourceTimeAtClipTimeSeconds,
	getSourceTimeAtClipTimeTicks,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type { RetimeConfig } from "@/timeline";
import { mediaTime } from "@/wasm";

const twoX: RetimeConfig = { rate: 2 };
const halfX: RetimeConfig = { rate: 0.5 };

describe("retime resolve", () => {
	test("maps clip time to source time at 2x speed", () => {
		expect(
			getSourceTimeAtClipTimeSeconds({ clipTimeSeconds: 5, retime: twoX }),
		).toBe(10);
	});

	test("maps clip time to source time at 0.5x speed", () => {
		expect(
			getSourceTimeAtClipTimeSeconds({ clipTimeSeconds: 4, retime: halfX }),
		).toBe(2);
	});

	test("returns clip time unchanged when no retime", () => {
		expect(getSourceTimeAtClipTimeSeconds({ clipTimeSeconds: 7 })).toBe(7);
	});

	test("inverts source time back to clip time at 2x speed", () => {
		expect(getClipTimeAtSourceTime({ sourceTime: 10, retime: twoX })).toBe(5);
	});

	test("returns effective rate", () => {
		expect(getEffectiveRateAt({ retime: twoX })).toBe(2);
		expect(getEffectiveRateAt({})).toBe(1);
	});

	test("derives timeline duration for a visible source span", () => {
		expect(
			getTimelineDurationForSourceSpan({ sourceSpan: 10, retime: twoX }),
		).toBe(5);
		expect(
			getTimelineDurationForSourceSpan({ sourceSpan: 10, retime: halfX }),
		).toBe(20);
	});

	test("clamps invalid rates to 1", () => {
		expect(
			getSourceTimeAtClipTimeSeconds({
				clipTimeSeconds: 5,
				retime: { rate: 0 },
			}),
		).toBe(5);
		expect(
			getSourceTimeAtClipTimeSeconds({
				clipTimeSeconds: 5,
				retime: { rate: -1 },
			}),
		).toBe(5);
	});

	test("caps retime rates above 5x", () => {
		expect(
			getSourceTimeAtClipTimeSeconds({
				clipTimeSeconds: 5,
				retime: { rate: 100 },
			}),
		).toBe(25);
		expect(
			getTimelineDurationForSourceSpan({
				sourceSpan: 10,
				retime: { rate: 100 },
			}),
		).toBe(2);
	});

	test("fails closed when Rust rejects a time-map lookup", () => {
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
						timelineEnd: 120_000,
						sourceStart: 0,
						startRate: 1,
						endRate: 1,
						direction: "forward",
					},
				],
			},
		};
		expect(() =>
			getSourceTimeAtClipTimeTicks({
				clipTime: mediaTime({ ticks: 120_001 }),
				retime,
			}),
		).toThrow("Rust rejected");
	});
});
