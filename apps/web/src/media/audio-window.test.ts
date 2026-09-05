import { describe, expect, test } from "bun:test";
import type { RetimeConfig, SceneTracks, VideoElement } from "@/timeline";
import { mediaTime } from "@/wasm";
import { collectAudibleCandidates } from "./audio";

const mediaAssets = [
	{
		id: "video-media",
		name: "video.mp4",
		type: "video" as const,
		file: new File([], "video.mp4", { type: "video/mp4" }),
		hasAudio: true,
	},
];

function tracksWith(retime: RetimeConfig): SceneTracks {
	const video: VideoElement = {
		id: "video-1",
		name: "video-1",
		type: "video",
		mediaId: "video-media",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 240_000 }),
		trimStart: mediaTime({ ticks: 10 }),
		trimEnd: mediaTime({ ticks: 5 }),
		sourceDuration: mediaTime({ ticks: 480_000 }),
		params: { volume: 0, muted: false },
		retime,
	};
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [video],
		},
		overlay: [],
		audio: [],
	};
}

describe("windowed audio over retimed clips", () => {
	test("slices a reverse time map to the window and keeps source trims fixed", () => {
		// Source plays from 240000 down to 0 over the 240000-tick clip.
		const [candidate] = collectAudibleCandidates({
			tracks: tracksWith({
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
							timelineEnd: 240_000,
							sourceStart: 240_000,
							startRate: 1,
							endRate: 1,
							direction: "reverse",
						},
					],
				},
			}),
			mediaAssets,
			window: { startTicks: 60_000, endTicksExclusive: 180_000 },
		});

		expect(candidate?.localTimeOffset).toBe(60_000);
		expect(candidate?.element).toMatchObject({
			startTime: 0,
			duration: 120_000,
			trimStart: 10,
			trimEnd: 5,
			retime: {
				timeMap: {
					segments: [
						{
							kind: "speed",
							timelineStart: 0,
							timelineEnd: 120_000,
							sourceStart: 180_000,
							startRate: 1,
							endRate: 1,
							direction: "reverse",
						},
					],
				},
			},
		});
	});

	test("shifts source trims for a rate-based clip", () => {
		const [candidate] = collectAudibleCandidates({
			tracks: tracksWith({ rate: 2 }),
			mediaAssets,
			window: { startTicks: 60_000, endTicksExclusive: 180_000 },
		});
		expect(candidate?.element).toMatchObject({
			startTime: 0,
			duration: 120_000,
			trimStart: 120_010,
			trimEnd: 120_005,
		});
	});
});
