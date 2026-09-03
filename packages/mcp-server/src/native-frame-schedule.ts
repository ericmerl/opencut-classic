import { createRequire } from "node:module";
import { stableSerialize } from "./matte-generation-data";

const require = createRequire(import.meta.url);
const native = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	scheduleFrameRange(options: {
		rate: { numerator: number; denominator: number };
		sceneDurationTicks: number;
		range: unknown;
		limits: { maxDurationTicks: number; maxFrames: number };
	}): { status: "scheduled"; schedule: unknown } | { status: "rejected" };
};

export function requireNativeFrameSchedule({
	schedule,
	limits,
}: {
	schedule: Record<string, unknown>;
	limits: { maxDurationTicks: number; maxFrames: number };
}): { frameCount: number } {
	const rate = requireRecord(schedule.rate, "rate");
	const sceneDurationTicks = requireSafeInteger(
		schedule.sceneDurationTicks,
		"sceneDurationTicks",
	);
	const frameCount = requireSafeInteger(schedule.frameCount, "frameCount");
	const evaluation = native.scheduleFrameRange({
		rate: {
			numerator: requireSafeInteger(rate.numerator, "rate.numerator"),
			denominator: requireSafeInteger(rate.denominator, "rate.denominator"),
		},
		sceneDurationTicks,
		range: schedule.requestedRange,
		limits,
	});
	if (
		evaluation.status !== "scheduled" ||
		stableSerialize(evaluation.schedule) !== stableSerialize(schedule)
	)
		throw new Error(
			"preview range manifest does not equal the Rust-recomputed schedule",
		);
	return { frameCount };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`preview range ${name} is invalid`);
	return value as Record<string, unknown>;
}

function requireSafeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value))
		throw new Error(`preview range ${name} is invalid`);
	return Number(value);
}
