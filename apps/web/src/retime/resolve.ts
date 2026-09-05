import type { RetimeConfig } from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";
import * as opencutWasm from "opencut-wasm";
import {
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	type MediaTime,
} from "@/wasm";

function getSafeRate({ rate }: { rate: number }): number {
	return clampRetimeRate({ rate });
}

export function getSourceTimeAtClipTimeTicks({
	clipTime,
	retime,
}: {
	clipTime: MediaTime;
	retime?: RetimeConfig;
}): MediaTime {
	if (retime?.timeMap) {
		const sourceTime = opencutWasm.resolveTimeMapSourceTime({
			timeMap: retime.timeMap,
			clipTime,
		});
		if (sourceTime === undefined) {
			throw new Error("Rust rejected the time-map source lookup");
		}
		return mediaTime({ ticks: sourceTime });
	}
	return roundMediaTime({
		time: clipTime * getSafeRate({ rate: retime?.rate ?? 1 }),
	});
}

export function getSourceTimeAtClipTimeSeconds({
	clipTimeSeconds,
	retime,
}: {
	clipTimeSeconds: number;
	retime?: RetimeConfig;
}): number {
	if (!retime?.timeMap) {
		return clipTimeSeconds * getSafeRate({ rate: retime?.rate ?? 1 });
	}
	return mediaTimeToSeconds({
		time: getSourceTimeAtClipTimeTicks({
			clipTime: mediaTimeFromSeconds({ seconds: clipTimeSeconds }),
			retime,
		}),
	});
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
	clipTime?: MediaTime;
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
