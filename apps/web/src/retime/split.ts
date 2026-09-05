import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTimeTicks } from "./resolve";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import * as opencutWasm from "opencut-wasm";
import type { TimeMapSplitPlan, TimeMapTrimPlan } from "opencut-wasm";

export function getSourceSpanAtClipTime({
	clipTime,
	retime,
}: {
	clipTime: MediaTime;
	retime?: RetimeConfig;
}): MediaTime {
	if (clipTime <= ZERO_MEDIA_TIME) return ZERO_MEDIA_TIME;
	return getSourceTimeAtClipTimeTicks({ clipTime, retime });
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
	timeMapRange,
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
	timeMapRange?: { start: number; end: number };
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
		requestedTimeMapRange: timeMapRange,
		requestedTrimStart,
		requestedTrimEnd,
	});
	if (!plan) {
		throw new Error(
			"Rust rejected the time-map trim: startTime repositions, timeMapRange selects clip-local boundaries, duration must match that range, and source trims remain fixed",
		);
	}
	return plan;
}
