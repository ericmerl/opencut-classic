import { TICKS_PER_SECOND } from "@/wasm";
import type { FrameRangeScheduleEvaluation } from "opencut-wasm";

export type FrameTimeSelector =
	| { kind: "frame-index"; frameIndex: number }
	| {
			kind: "media-time";
			ticks: number;
			rounding: "exact" | "floor" | "nearest" | "ceil";
	  };

export function resolveFrameTime({
	time,
	fps,
}: {
	time: FrameTimeSelector;
	fps: { numerator: number; denominator: number };
}):
	| {
			status: "ok";
			requestedTicks: number;
			resolvedTicks: number;
			frameIndex: number;
			fps: typeof fps;
			ticksPerFrame: number;
			rounding: "exact" | "floor" | "nearest" | "ceil";
	  }
	| {
			status: "error";
			code:
				| "UNSUPPORTED_FRAME_RATE"
				| "TIME_ALIGNMENT_REQUIRED"
				| "TIME_OUT_OF_BOUNDS";
			reason: string;
	  } {
	const numerator = TICKS_PER_SECOND * fps.denominator;
	if (
		!Number.isSafeInteger(numerator) ||
		fps.numerator <= 0 ||
		fps.denominator <= 0 ||
		numerator % fps.numerator !== 0
	) {
		return {
			status: "error",
			code: "UNSUPPORTED_FRAME_RATE",
			reason: "frame rate has no integral duration in the 120000-tick timebase",
		};
	}
	const ticksPerFrame = numerator / fps.numerator;
	const requestedTicks =
		time.kind === "frame-index" ? time.frameIndex * ticksPerFrame : time.ticks;
	if (!Number.isSafeInteger(requestedTicks) || requestedTicks < 0) {
		return {
			status: "error",
			code: "TIME_OUT_OF_BOUNDS",
			reason: "requested time is outside the safe nonnegative tick range",
		};
	}
	const rounding = time.kind === "frame-index" ? "exact" : time.rounding;
	const quotient = Math.floor(requestedTicks / ticksPerFrame);
	const remainder = requestedTicks % ticksPerFrame;
	if (rounding === "exact" && remainder !== 0) {
		return {
			status: "error",
			code: "TIME_ALIGNMENT_REQUIRED",
			reason: "exact media time is not aligned to a project frame",
		};
	}
	const frameIndex =
		rounding === "ceil" && remainder > 0
			? quotient + 1
			: rounding === "nearest" && remainder * 2 >= ticksPerFrame
				? quotient + 1
				: quotient;
	return {
		status: "ok",
		requestedTicks,
		resolvedTicks: frameIndex * ticksPerFrame,
		frameIndex,
		fps,
		ticksPerFrame,
		rounding,
	};
}

export function requireFrameSchedule(fps: {
	numerator: number;
	denominator: number;
}): { ticksPerFrame: number } {
	const resolved = resolveFrameTime({
		time: { kind: "frame-index", frameIndex: 0 },
		fps,
	});
	if (resolved.status === "error") throw new Error(resolved.reason);
	return { ticksPerFrame: resolved.ticksPerFrame };
}

export async function scheduleFrameRange(options: {
	rate: { numerator: number; denominator: number };
	sceneDurationTicks: number;
	range:
		| { kind: "media-time"; startTicks: number; endTicksExclusive: number }
		| {
				kind: "frame-index";
				startFrameIndex: number;
				endFrameIndexExclusive: number;
		  };
	limits: { maxDurationTicks: number; maxFrames: number };
}): Promise<FrameRangeScheduleEvaluation> {
	const { scheduleFrameRange: scheduleFrameRangeNative } = await import(
		"opencut-wasm"
	);
	return scheduleFrameRangeNative(options);
}
