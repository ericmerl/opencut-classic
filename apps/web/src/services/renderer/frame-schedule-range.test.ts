import { describe, expect, test } from "bun:test";
import { scheduleFrameRange } from "./frame-schedule";

describe("Rust-backed preview range schedule", () => {
	test("materializes the canonical half-open 30fps frame grid", async () => {
		const result = await scheduleFrameRange({
			rate: { numerator: 30, denominator: 1 },
			sceneDurationTicks: 240_000,
			range: { kind: "media-time", startTicks: 1, endTicksExclusive: 8_001 },
			limits: { maxDurationTicks: 1_200_000, maxFrames: 300 },
		});
		expect(result).toMatchObject({
			status: "scheduled",
			schedule: {
				schemaVersion: "opencut.frame-range-schedule.v1",
				endpointPolicy: "start-inclusive-end-exclusive",
				frameCount: 2,
				frames: [
					{ ordinal: 0, frameIndex: 1, timelineTicks: 4_000, outputTicks: 0 },
					{
						ordinal: 1,
						frameIndex: 2,
						timelineTicks: 8_000,
						outputTicks: 4_000,
					},
				],
				policy: { outputFrames: "contiguous-once-fail-on-missing" },
			},
		});
	});

	test("rejects a ten-second 60fps range against the 300-frame default", async () => {
		expect(
			await scheduleFrameRange({
				rate: { numerator: 60, denominator: 1 },
				sceneDurationTicks: 1_200_000,
				range: {
					kind: "media-time",
					startTicks: 0,
					endTicksExclusive: 1_200_000,
				},
				limits: { maxDurationTicks: 1_200_000, maxFrames: 300 },
			}),
		).toMatchObject({ status: "rejected", code: "RANGE_FRAME_LIMIT_EXCEEDED" });
	});
});
