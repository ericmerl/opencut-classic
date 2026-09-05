import { mock } from "bun:test";
import type { Canvas, createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface NativeProjectState {
	evaluateAutomationOperationPolicy: (options: {
		method: string;
		status: string;
	}) => { durableSuccess: boolean; retainSnapshot: boolean };
	evaluateProjectSnapshotRetention: (
		options: EvaluateSnapshotRetentionOptions,
	) => SnapshotRetentionEvaluation;
	evaluateMediaRelinkCompatibility: (
		options: EvaluateMediaRelinkOptions,
	) => MediaRelinkEvaluation;
	evaluateLifecycleMutation: (options: unknown) => unknown;
	scheduleFrameRange: (options: unknown) => unknown;
	captionStylePresets: () => unknown;
	resolveCaptionStyle: (options: unknown) => unknown;
	resolveCaptionStyleParams: (options: unknown) => unknown;
	textStyleContract: () => unknown;
	resolveTextEffectGeometry: (options: unknown) => unknown;
	mapAssTextEffects: (options: unknown) => unknown;
}

/**
 * This preload runs in every web test process, but most of those processes
 * never reach the native boundary or draw anything. Loading the multi-megabyte
 * WASM package and the native canvas binding here would charge every process
 * for what only a few of them use, so both load on first use instead.
 */
let nativeProjectStateModule: NativeProjectState | undefined;
function nativeProjectState(): NativeProjectState {
	nativeProjectStateModule ??=
		require("../../../rust/wasm/pkg-node/opencut_wasm.js") as NativeProjectState;
	return nativeProjectStateModule;
}

const TICKS_PER_SECOND = 120_000;

if (typeof globalThis.OffscreenCanvas === "undefined") {
	class TestOffscreenCanvas {
		private readonly canvas: Canvas;

		constructor(width: number, height: number) {
			const { createCanvas: create } = require("@napi-rs/canvas") as {
				createCanvas: typeof createCanvas;
			};
			this.canvas = create(width, height);
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
	evaluateAutomationOperationPolicy: (options: {
		method: string;
		status: string;
	}) => nativeProjectState().evaluateAutomationOperationPolicy(options),
	floorToFrame: ({ time, rate }: NativeFrameTime) =>
		Math.floor(time / frameTicks({ rate })) * frameTicks({ rate }),
	formatTimecode: ({ time }: { time: number }) =>
		new Date((time / TICKS_PER_SECOND) * 1_000).toISOString().slice(11, 19),
	evaluateProjectSnapshotRetention: (
		options: EvaluateSnapshotRetentionOptions,
	) => nativeProjectState().evaluateProjectSnapshotRetention(options),
	evaluateMediaRelinkCompatibility: (options: EvaluateMediaRelinkOptions) =>
		nativeProjectState().evaluateMediaRelinkCompatibility(options),
	evaluateLifecycleMutation: (options: unknown) =>
		nativeProjectState().evaluateLifecycleMutation(options),
	captionStylePresets: () => nativeProjectState().captionStylePresets(),
	resolveCaptionStyle: (options: unknown) =>
		nativeProjectState().resolveCaptionStyle(options),
	resolveCaptionStyleParams: (options: unknown) =>
		nativeProjectState().resolveCaptionStyleParams(options),
	textStyleContract: () => nativeProjectState().textStyleContract(),
	resolveTextEffectGeometry: (options: unknown) =>
		nativeProjectState().resolveTextEffectGeometry(options),
	mapAssTextEffects: (options: unknown) =>
		nativeProjectState().mapAssTextEffects(options),
	scheduleFrameRange: (options: unknown) =>
		nativeProjectState().scheduleFrameRange(options),
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

interface SnapshotVerification {
	writeVersion: number;
	receiptId: string;
	operationId: string;
	verifiedAtMs: number;
}

interface SnapshotRetentionState {
	firstVerifiedAtMs: number;
	lastVerifiedAtMs: number;
	expiresAtMs: number;
	latestVerification: SnapshotVerification;
}

interface EvaluateSnapshotRetentionOptions {
	prior?: SnapshotRetentionState;
	verification: SnapshotVerification;
}

type SnapshotRetentionEvaluation =
	| { status: "retained"; state: SnapshotRetentionState }
	| { status: "rejected"; reason: string };

interface MediaRelinkDescriptor {
	type: string;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	size: number;
}

interface EvaluateMediaRelinkOptions {
	current: MediaRelinkDescriptor;
	replacement: MediaRelinkDescriptor;
}

interface MediaRelinkEvaluation {
	compatible: boolean;
	differences: Array<{
		field: string;
		before?: string | number | boolean;
		after?: string | number | boolean;
	}>;
}
