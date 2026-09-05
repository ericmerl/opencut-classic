import { describe, expect, test } from "bun:test";
import type { RetimeConfig } from "@/timeline";
import {
	planTimeMapAudioChunks,
	sampleRetimedAudioChannel,
} from "../audio-stretch";

describe("time-map audio", () => {
	test("plans pitch-preserved ramp, hold, and reverse chunks on exact boundaries", () => {
		const timeMap: NonNullable<RetimeConfig["timeMap"]> = {
			schemaVersion: "opencut.time-map.v1",
			frameInterpolation: { requested: "nearest", fallback: "nearest" },
			audioPolicy: { maintainPitch: true, hold: "hold-sample" },
			segments: [
				{
					kind: "speed",
					timelineStart: 0,
					timelineEnd: 120_000,
					sourceStart: 0,
					startRate: 2,
					endRate: 2,
					direction: "forward",
				},
				{
					kind: "hold",
					timelineStart: 120_000,
					timelineEnd: 240_000,
					sourceTime: 240_000,
					frameIdentity: "source-frame:240000",
				},
				{
					kind: "speed",
					timelineStart: 240_000,
					timelineEnd: 360_000,
					sourceStart: 240_000,
					startRate: 1,
					endRate: 1,
					direction: "reverse",
				},
			],
		};

		expect(planTimeMapAudioChunks({ timeMap, maxChunkTicks: 60_000 })).toEqual([
			{
				kind: "speed",
				timelineStart: 0,
				timelineEnd: 60_000,
				sourceStart: 0,
				sourceEnd: 120_000,
			},
			{
				kind: "speed",
				timelineStart: 60_000,
				timelineEnd: 120_000,
				sourceStart: 120_000,
				sourceEnd: 240_000,
			},
			{
				kind: "hold",
				timelineStart: 120_000,
				timelineEnd: 240_000,
				sourceStart: 240_000,
				sourceEnd: 240_000,
			},
			{
				kind: "speed",
				timelineStart: 240_000,
				timelineEnd: 300_000,
				sourceStart: 240_000,
				sourceEnd: 180_000,
			},
			{
				kind: "speed",
				timelineStart: 300_000,
				timelineEnd: 360_000,
				sourceStart: 180_000,
				sourceEnd: 120_000,
			},
		]);
	});

	test("maps ramps and reverse while muting hold intervals", () => {
		const retime: RetimeConfig = {
			rate: 1,
			mode: "time-map",
			maintainPitch: false,
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
						startRate: 2,
						endRate: 2,
						direction: "forward",
					},
					{
						kind: "hold",
						timelineStart: 120_000,
						timelineEnd: 240_000,
						sourceTime: 240_000,
						frameIdentity: "source-frame:240000",
					},
					{
						kind: "speed",
						timelineStart: 240_000,
						timelineEnd: 360_000,
						sourceStart: 240_000,
						startRate: 1,
						endRate: 1,
						direction: "reverse",
					},
				],
			},
		};
		const channelData = Float32Array.from(
			Array.from({ length: 12 }, (_, index) => (index + 1) / 10),
		);
		const rendered = Array.from({ length: 12 }, (_, index) =>
			sampleRetimedAudioChannel({
				channelData,
				sourceSampleRate: 4,
				trimStart: 0,
				clipTime: index / 4,
				retime,
			}),
		);

		expect(rendered).toEqual([
			0.10000000149011612, 0.30000001192092896, 0.5, 0.699999988079071, 0, 0, 0,
			0, 0.8999999761581421, 0.800000011920929, 0.699999988079071,
			0.6000000238418579,
		]);
	});
});
