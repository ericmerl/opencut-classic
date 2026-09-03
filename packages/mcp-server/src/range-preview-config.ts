import * as z from "zod/v4";

export const DEFAULT_PREVIEW_RANGE_MAX_DURATION_SECONDS = 10;
export const DEFAULT_PREVIEW_RANGE_MAX_FRAMES = 300;
export const PREVIEW_RANGE_TICKS_PER_SECOND = 120_000;
// Keeps the eager Rust/WASM schedule comfortably below the 2 MiB manifest
// boundary, while allowing explicit runs far beyond the production default.
export const PREVIEW_RANGE_OPERATIONAL_MAX_FRAMES = 10_000;

export interface PreviewRangeLimits {
	maxDurationSeconds: number;
	maxDurationTicks: number;
	maxFrames: number;
}

export function readPreviewRangeLimits(
	environment: Record<string, string | undefined> = process.env,
): PreviewRangeLimits {
	const maxDurationSeconds = positiveNumber(
		environment.OPENCUT_PREVIEW_RANGE_MAX_DURATION_SECONDS,
		DEFAULT_PREVIEW_RANGE_MAX_DURATION_SECONDS,
		"OPENCUT_PREVIEW_RANGE_MAX_DURATION_SECONDS",
	);
	const maxFrames = positiveInteger(
		environment.OPENCUT_PREVIEW_RANGE_MAX_FRAMES,
		DEFAULT_PREVIEW_RANGE_MAX_FRAMES,
		"OPENCUT_PREVIEW_RANGE_MAX_FRAMES",
	);
	const maxDurationTicks = Math.round(
		maxDurationSeconds * PREVIEW_RANGE_TICKS_PER_SECOND,
	);
	if (!Number.isSafeInteger(maxDurationTicks) || maxDurationTicks <= 0) {
		throw new Error(
			"preview range duration limit is outside the safe tick range",
		);
	}
	return { maxDurationSeconds, maxDurationTicks, maxFrames };
}

function positiveNumber(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = z.coerce.number().finite().positive().safeParse(value);
	if (!parsed.success) throw new Error(`${name} must be a positive number`);
	return parsed.data;
}

function positiveInteger(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = z.coerce
		.number()
		.int()
		.positive()
		.max(PREVIEW_RANGE_OPERATIONAL_MAX_FRAMES)
		.safeParse(value);
	if (!parsed.success) throw new Error(`${name} must be a positive integer`);
	return parsed.data;
}
