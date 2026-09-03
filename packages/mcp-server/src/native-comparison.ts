import { createRequire } from "node:module";
import type { ComparisonNativeAdapter } from "./comparison-evidence-store";

const require = createRequire(import.meta.url);
const wasm = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	planComparison(
		options: unknown,
	):
		| { status: "planned"; plan: Record<string, unknown> }
		| { status: "rejected"; code: string; reason: string };
	compareRgba(options: unknown):
		| {
				status: "compared";
				comparison: {
					metrics: Record<string, unknown>;
					regions: Record<string, unknown>;
					diffRgba: ArrayLike<number>;
				};
		  }
		| { status: "rejected"; code: string; reason: string };
	composeRgba(options: unknown):
		| {
				status: "composed";
				composition: { width: number; height: number; rgba: ArrayLike<number> };
		  }
		| { status: "rejected"; code: string; reason: string };
	aggregateFrameMetrics(
		options: unknown,
	):
		| { status: "aggregated"; metrics: Record<string, unknown> }
		| { status: "rejected"; code: string; reason: string };
	comparePcmI16(
		options: unknown,
	):
		| { status: "compared"; metrics: Record<string, unknown> }
		| { status: "rejected"; code: string; reason: string };
};

export function planComparison(input: {
	before: {
		canvas: { width: number; height: number };
		rate: { numerator: number; denominator: number };
		sceneDurationTicks: number;
		rendererSettingsDigest: string;
	};
	after: {
		canvas: { width: number; height: number };
		rate: { numerator: number; denominator: number };
		sceneDurationTicks: number;
		rendererSettingsDigest: string;
	};
	range: unknown;
	limits: { maxDurationTicks: number; maxFrames: number };
}) {
	return wasm.planComparison(input);
}

export const nativeComparison: ComparisonNativeAdapter = {
	compareRgba(input) {
		const evaluation = wasm.compareRgba({
			...input,
			toleranceBoundary: "inclusive",
		});
		if (evaluation.status !== "compared")
			throwNative("RGBA comparison", evaluation);
		return {
			metrics: evaluation.comparison.metrics,
			regions: evaluation.comparison.regions,
			diffRgba: Uint8Array.from(evaluation.comparison.diffRgba),
		};
	},
	composeRgba(input) {
		const position =
			input.mode === "wipe"
				? Math.floor(input.width * requireWipePosition(input.wipePosition))
				: undefined;
		const evaluation = wasm.composeRgba({
			before: input.before,
			after: input.after,
			width: input.width,
			height: input.height,
			mode:
				input.mode === "side-by-side"
					? { kind: "side-by-side" }
					: { kind: "wipe", position },
		});
		if (evaluation.status !== "composed")
			throwNative("RGBA composition", evaluation);
		return {
			width: evaluation.composition.width,
			height: evaluation.composition.height,
			rgba: Uint8Array.from(evaluation.composition.rgba),
		};
	},
	aggregateFrameMetrics(metrics) {
		const evaluation = wasm.aggregateFrameMetrics({ perFrame: metrics });
		if (evaluation.status !== "aggregated")
			throwNative("frame metric aggregation", evaluation);
		return evaluation.metrics;
	},
	comparePcmI16(input) {
		const evaluation = wasm.comparePcmI16({
			...input,
		});
		if (evaluation.status !== "compared")
			throwNative("PCM comparison", evaluation);
		return evaluation.metrics;
	},
};

function requireWipePosition(value: number | undefined) {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	)
		throw new Error(
			"wipe comparison requires a finite position between 0 and 1",
		);
	return value;
}

function throwNative(
	operation: string,
	evaluation: { code: string; reason: string },
): never {
	throw new Error(
		`${operation} rejected by Rust (${evaluation.code}): ${evaluation.reason}`,
	);
}
