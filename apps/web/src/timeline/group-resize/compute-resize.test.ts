import { describe, expect, test } from "bun:test";
import type { RetimeConfig } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { computeGroupResize } from "./compute-resize";
import type { GroupResizeMember } from "./types";

const fps = { numerator: 30, denominator: 1 };

function member(retime?: RetimeConfig): GroupResizeMember {
	return {
		trackId: "track-1",
		elementId: "element-1",
		startTime: mediaTime({ ticks: 240_000 }),
		duration: mediaTime({ ticks: 240_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 480_000 }),
		retime,
		leftNeighborBound: null,
		rightNeighborBound: null,
	};
}

const timeMapRetime: RetimeConfig = {
	rate: 1,
	mode: "time-map",
	timeMap: {
		schemaVersion: "opencut.time-map.v1",
		frameInterpolation: { requested: "nearest", fallback: "nearest" },
		audioPolicy: { maintainPitch: false, hold: "mute" },
		segments: [
			{
				kind: "hold",
				timelineStart: 0,
				timelineEnd: 240_000,
				sourceTime: 60_000,
				frameIdentity: "source-frame:60000",
			},
		],
	},
};

describe("group resize and time maps", () => {
	test("still resizes a rate-based clip", () => {
		const result = computeGroupResize({
			members: [member({ rate: 2 })],
			side: "right",
			deltaTime: mediaTime({ ticks: -120_000 }),
			fps,
		});
		expect(result.deltaTime).toBe(mediaTime({ ticks: -120_000 }));
		expect(result.updates).toHaveLength(1);
	});

	test("refuses to drag-resize a time-mapped clip", () => {
		// Duration must stay equal to the map duration; only the Rust trim plan
		// (MCP trim with timeMapRange) may change it.
		const result = computeGroupResize({
			members: [member(timeMapRetime)],
			side: "right",
			deltaTime: mediaTime({ ticks: -120_000 }),
			fps,
		});
		expect(result).toEqual({ deltaTime: ZERO_MEDIA_TIME, updates: [] });
	});
});
