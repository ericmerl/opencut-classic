import { mock } from "bun:test";
import { createCanvas, type Canvas } from "@napi-rs/canvas";

const TICKS_PER_SECOND = 120_000;

if (typeof globalThis.OffscreenCanvas === "undefined") {
	class TestOffscreenCanvas {
		private readonly canvas: Canvas;

		constructor(width: number, height: number) {
			this.canvas = createCanvas(width, height);
		}

		getContext(contextId: "2d") {
			return contextId === "2d" ? this.canvas.getContext("2d") : null;
		}
	}

	Object.assign(globalThis, { OffscreenCanvas: TestOffscreenCanvas });
}

function roundHalfAwayFromZero(value: number): number {
	const magnitude = Math.round(Math.abs(value));
	return magnitude === 0 ? 0 : value < 0 ? -magnitude : magnitude;
}

function frameTicks({
	rate,
}: {
	rate: { numerator: number; denominator: number };
}): number {
	return (TICKS_PER_SECOND * rate.denominator) / rate.numerator;
}

/**
 * Bun cannot execute wasm-pack's bundler-target bootstrap directly in its test
 * runtime. Web tests exercise TypeScript adapters, so give every test process a
 * complete, deterministic implementation of the native time boundary. Tests
 * that need a more specific native mock may replace this module in their file.
 */
mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => TICKS_PER_SECOND,
	floorToFrame: ({ time, rate }: NativeFrameTime) =>
		Math.floor(time / frameTicks({ rate })) * frameTicks({ rate }),
	formatTimecode: ({ time }: { time: number }) =>
		new Date((time / TICKS_PER_SECOND) * 1_000).toISOString().slice(11, 19),
	guessTimecodeFormat: () => "HH:MM:SS",
	isFrameAligned: ({ time, rate }: NativeFrameTime) =>
		Number.isInteger(time / frameTicks({ rate })),
	lastFrameTime: ({ duration, rate }: NativeDurationTime) =>
		Math.max(0, duration - frameTicks({ rate })),
	mediaTimeAdd: ({ lhs, rhs }: { lhs: number; rhs: number }) => lhs + rhs,
	mediaTimeClamp: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => Math.min(max, Math.max(min, time)),
	mediaTimeFromFrame: ({ frame, rate }: NativeFrame) =>
		roundHalfAwayFromZero(frame * frameTicks({ rate })),
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		roundHalfAwayFromZero(seconds * TICKS_PER_SECOND),
	mediaTimeMax: ({ lhs, rhs }: { lhs: number; rhs: number }) =>
		Math.max(lhs, rhs),
	mediaTimeMin: ({ lhs, rhs }: { lhs: number; rhs: number }) =>
		Math.min(lhs, rhs),
	mediaTimeSub: ({ lhs, rhs }: { lhs: number; rhs: number }) => lhs - rhs,
	mediaTimeToFrame: ({ time, rate }: NativeFrameTime) =>
		BigInt(roundHalfAwayFromZero(time / frameTicks({ rate }))),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / TICKS_PER_SECOND,
	parseTimecode: ({ timeCode }: { timeCode: string }) => {
		const parts = timeCode.split(":").map(Number);
		if (parts.some((part) => !Number.isFinite(part))) return undefined;
		const seconds = parts.reduce((total, part) => total * 60 + part, 0);
		return roundHalfAwayFromZero(seconds * TICKS_PER_SECOND);
	},
	roundToFrame: ({ time, rate }: NativeFrameTime) =>
		roundHalfAwayFromZero(time / frameTicks({ rate })) * frameTicks({ rate }),
	snappedSeekTime: ({ time, duration, rate }: NativeDurationTime) =>
		Math.min(
			duration,
			Math.max(
				0,
				roundHalfAwayFromZero(time / frameTicks({ rate })) *
					frameTicks({ rate }),
			),
		),
}));

interface NativeFrame {
	frame: number;
	rate: { numerator: number; denominator: number };
}

interface NativeFrameTime {
	time: number;
	rate: { numerator: number; denominator: number };
}

interface NativeDurationTime extends NativeFrameTime {
	duration: number;
}
