import { describe, expect, test } from "bun:test";
import type { RetimeConfig, VideoElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildSeparatedAudioElement } from "./index";

const timeMapRetime: RetimeConfig = {
	rate: 1,
	maintainPitch: true,
	mode: "time-map",
	timeMap: {
		schemaVersion: "opencut.time-map.v1",
		frameInterpolation: { requested: "nearest", fallback: "nearest" },
		audioPolicy: { maintainPitch: true, hold: "mute" },
		segments: [
			{
				kind: "speed",
				timelineStart: 0,
				timelineEnd: 120_000,
				sourceStart: 0,
				startRate: 0.5,
				endRate: 1.5,
				direction: "forward",
			},
		],
	},
};

function buildVideoElement(): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		retime: timeMapRetime,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			volume: 0.5,
		},
	} as VideoElement;
}

describe("separated source audio", () => {
	test("carries the video's canonical time map, not just its rate", () => {
		const separated = buildSeparatedAudioElement({
			sourceElement: buildVideoElement(),
		});
		expect(separated.retime).toEqual(timeMapRetime);
		expect(separated.retime).not.toBe(timeMapRetime);
	});
});
