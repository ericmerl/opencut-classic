import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime } from "./resolve";
import * as opencutWasm from "opencut-wasm";

export function getSourceSpanAtClipTime({
	clipTime,
	retime,
}: {
	clipTime: number;
	retime?: RetimeConfig;
}): number {
	return Math.max(0, getSourceTimeAtClipTime({ clipTime, retime }));
}

export function splitRetimeAtClipTime({
	retime,
	splitClipTime,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
} {
	if (retime?.timeMap) {
		const duration = retime.timeMap.segments.at(-1)?.timelineEnd ?? 0;
		const leftMap = opencutWasm.sliceTimeMap({
			timeMap: retime.timeMap,
			timelineStart: 0,
			timelineEnd: splitClipTime,
		});
		const rightMap = opencutWasm.sliceTimeMap({
			timeMap: retime.timeMap,
			timelineStart: splitClipTime,
			timelineEnd: duration,
		});
		if (!leftMap || !rightMap) {
			throw new Error("Rust rejected a split of the canonical time map");
		}
		return {
			left: { ...retime, timeMap: leftMap },
			right: { ...retime, timeMap: rightMap },
		};
	}
	return { left: retime, right: retime };
}

export function sliceRetimeForTimelineRange({
	retime,
	startClipTime,
	endClipTime,
}: {
	retime?: RetimeConfig;
	startClipTime: number;
	endClipTime: number;
}): RetimeConfig | undefined {
	if (!retime?.timeMap) return retime;
	const timeMap = opencutWasm.sliceTimeMap({
		timeMap: retime.timeMap,
		timelineStart: startClipTime,
		timelineEnd: endClipTime,
	});
	if (!timeMap) {
		throw new Error("Rust rejected a trim of the canonical time map");
	}
	return { ...retime, timeMap };
}

export function adjustRetimeForTrimChange({
	retime,
}: {
	retime?: RetimeConfig;
	clipTrimTime: number;
	side: "start" | "end";
}): RetimeConfig | undefined {
	return retime;
}
