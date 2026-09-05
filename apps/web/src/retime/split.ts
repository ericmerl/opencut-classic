import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime } from "./resolve";
import * as opencutWasm from "opencut-wasm";
import type { TimeMapSplitPlan, TimeMapTrimPlan } from "opencut-wasm";

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
	sourceTrimStart = 0,
	sourceTrimEnd = 0,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
	sourceTrimStart?: number;
	sourceTrimEnd?: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
	timeMapPlan?: TimeMapSplitPlan;
} {
	if (retime?.timeMap) {
		const plan = opencutWasm.planTimeMapSplit({
			timeMap: retime.timeMap,
			splitClipTime,
			sourceTrimStart,
			sourceTrimEnd,
		});
		if (!plan) {
			throw new Error("Rust rejected a split of the canonical time map");
		}
		return {
			left: { ...retime, timeMap: plan.leftTimeMap },
			right: { ...retime, timeMap: plan.rightTimeMap },
			timeMapPlan: plan,
		};
	}
	return { left: retime, right: retime };
}

export function planTimeMapTrim({
	retime,
	elementStartTime,
	elementDuration,
	sourceTrimStart,
	sourceTrimEnd,
	requestedStartTime,
	requestedDuration,
	requestedTrimStart,
	requestedTrimEnd,
}: {
	retime: RetimeConfig;
	elementStartTime: number;
	elementDuration: number;
	sourceTrimStart: number;
	sourceTrimEnd: number;
	requestedStartTime?: number;
	requestedDuration?: number;
	requestedTrimStart: number;
	requestedTrimEnd: number;
}): TimeMapTrimPlan {
	if (!retime.timeMap) throw new Error("time-map trim requires a time map");
	const plan = opencutWasm.planTimeMapTrim({
		timeMap: retime.timeMap,
		elementStartTime,
		elementDuration,
		sourceTrimStart,
		sourceTrimEnd,
		requestedStartTime,
		requestedDuration,
		requestedTrimStart,
		requestedTrimEnd,
	});
	if (!plan) {
		throw new Error(
			"Rust rejected the time-map trim: startTime repositions, duration crops the right timeline edge, and source trims remain fixed",
		);
	}
	return plan;
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
