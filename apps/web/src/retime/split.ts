import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTimeTicks } from "./resolve";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import * as opencutWasm from "opencut-wasm";
import type { RetimeSplitPlan, TimeMapTrimPlan } from "opencut-wasm";

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

/**
 * Rust plans every split: a constant rate snaps the source boundary once, a
 * canonical time map is sliced and rebased into both halves.
 */
export function splitRetimeAtClipTime({
	retime,
	clipDuration,
	splitClipTime,
	sourceTrimStart = 0,
	sourceTrimEnd = 0,
}: {
	retime?: RetimeConfig;
	clipDuration: number;
	splitClipTime: number;
	sourceTrimStart?: number;
	sourceTrimEnd?: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
	plan: RetimeSplitPlan;
} {
	const plan = opencutWasm.planRetimeSplit({
		rate: retime?.rate ?? 1,
		timeMap: retime?.timeMap,
		clipDuration,
		splitClipTime,
		sourceTrimStart,
		sourceTrimEnd,
	});
	if (!plan) {
		throw new Error("Rust rejected the retime split");
	}
	return {
		left:
			retime && plan.leftTimeMap
				? { ...retime, timeMap: plan.leftTimeMap }
				: retime,
		right:
			retime && plan.rightTimeMap
				? { ...retime, timeMap: plan.rightTimeMap }
				: retime,
		plan,
	};
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
