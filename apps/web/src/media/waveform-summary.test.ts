import { describe, expect, test } from "bun:test";
import type { RetimeConfig } from "@/timeline";
import { buildWaveformSampleBuckets } from "./waveform-summary";

describe("time-mapped waveform buckets", () => {
	test("converts second-domain waveform positions at the Rust time-map boundary", () => {
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
						timelineEnd: 60_000,
						sourceStart: 0,
						startRate: 1,
						endRate: 1,
						direction: "forward",
					},
					{
						kind: "hold",
						timelineStart: 60_000,
						timelineEnd: 120_000,
						sourceTime: 60_000,
						frameIdentity: "source-frame:60000",
					},
				],
			},
		};

		expect(
			buildWaveformSampleBuckets({
				clipLeftPx: 75,
				clipRightPx: 100,
				barCount: 1,
				pixelsPerSecond: 100,
				clipDurationSec: 1,
				sourceStartSec: 0,
				retime,
				sampleRate: 48_000,
				maxSampleExclusive: 96_000,
				barStepPx: 25,
			}),
		).toEqual([{ bucketStart: 24_000, bucketEnd: 24_000 }]);
	});
});
