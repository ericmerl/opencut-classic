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
		const sourceTime = opencutWasm.resolveTimeMapSourceTime({
			timeMap: retime.timeMap,
			clipTime,
		});
		if (sourceTime === undefined) {
			throw new Error("Rust rejected the time-map source lookup");
		}
		return sourceTime;
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
		const rate = opencutWasm.resolveTimeMapRate({
			timeMap: retime.timeMap,
			clipTime: clipTime ?? 0,
		});
		if (rate === undefined) {
			throw new Error("Rust rejected the time-map rate lookup");
		}
		return rate;
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
		const result = opencutWasm.evaluateTimeMap({
			timeMap: retime.timeMap,
			sampleClipTimes: [],
		});
		if (result.status !== "evaluated") {
			throw new Error(`Rust rejected the time map: ${result.reason}`);
		}
		return result.duration;
	}
	return sourceSpan / getSafeRate({ rate: retime?.rate ?? 1 });
}
