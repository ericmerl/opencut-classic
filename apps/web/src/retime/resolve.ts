import type { RetimeConfig } from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";
import * as opencutWasm from "opencut-wasm";

function getSafeRate({ rate }: { rate: number }): number {
	return clampRetimeRate({ rate });
}

export function getSourceTimeAtClipTime({
	clipTime,
	retime,
}: {
	clipTime: number;
	retime?: RetimeConfig;
}): number {
	if (retime?.timeMap) {
		return (
			opencutWasm.resolveTimeMapSourceTime({
				timeMap: retime.timeMap,
				clipTime,
			}) ?? clipTime
		);
	}
	return clipTime * getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getClipTimeAtSourceTime({
	sourceTime,
	retime,
}: {
	sourceTime: number;
	retime?: RetimeConfig;
}): number {
	if (retime?.timeMap) {
		throw new Error(
			"source-to-clip inversion is ambiguous for reverse and hold time maps",
		);
	}
	return sourceTime / getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getEffectiveRateAt({
	clipTime,
	retime,
}: {
	clipTime?: number;
	retime?: RetimeConfig;
}): number {
	if (retime?.timeMap) {
		const segment = retime.timeMap.segments.find(
			(candidate) =>
				(clipTime ?? 0) >= candidate.timelineStart &&
				(clipTime ?? 0) <= candidate.timelineEnd,
		);
		if (!segment || segment.kind === "hold") return 0;
		const duration = segment.timelineEnd - segment.timelineStart;
		const position = Math.max(
			0,
			Math.min(1, ((clipTime ?? 0) - segment.timelineStart) / duration),
		);
		const magnitude =
			segment.startRate + (segment.endRate - segment.startRate) * position;
		return segment.direction === "reverse" ? -magnitude : magnitude;
	}
	return getSafeRate({ rate: retime?.rate ?? 1 });
}

export function getTimelineDurationForSourceSpan({
	sourceSpan,
	retime,
}: {
	sourceSpan: number;
	retime?: RetimeConfig;
}): number {
	if (sourceSpan <= 0) {
		return 0;
	}
	if (retime?.timeMap) {
		return retime.timeMap.segments.at(-1)?.timelineEnd ?? 0;
	}
	return sourceSpan / getSafeRate({ rate: retime?.rate ?? 1 });
}
