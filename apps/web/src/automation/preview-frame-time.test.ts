import { describe, expect, mock, test } from "bun:test";

mock.module("@/wasm", () => ({ TICKS_PER_SECOND: 120_000 }));

const { resolvePreviewFrameTime } = await import("./preview-frame-time");

describe("exact preview frame time", () => {
	test("matches integral Rust frame durations and half-to-next nearest rounding", () => {
		expect(
			resolvePreviewFrameTime({
				time: { kind: "media-time", ticks: 22_022, rounding: "nearest" },
				fps: { numerator: 30_000, denominator: 1_001 },
			}),
		).toMatchObject({
			status: "ok",
			ticksPerFrame: 4_004,
			frameIndex: 6,
			resolvedTicks: 24_024,
		});
	});

	test("implements exact, floor, and ceil without floating-point seconds", () => {
		expect(
			resolvePreviewFrameTime({
				time: { kind: "media-time", ticks: 4_001, rounding: "exact" },
				fps: { numerator: 30, denominator: 1 },
			}),
		).toMatchObject({ status: "error", code: "TIME_ALIGNMENT_REQUIRED" });
		expect(
			resolvePreviewFrameTime({
				time: { kind: "media-time", ticks: 4_001, rounding: "floor" },
				fps: { numerator: 30, denominator: 1 },
			}),
		).toMatchObject({ frameIndex: 1, resolvedTicks: 4_000 });
		expect(
			resolvePreviewFrameTime({
				time: { kind: "media-time", ticks: 4_001, rounding: "ceil" },
				fps: { numerator: 30, denominator: 1 },
			}),
		).toMatchObject({ frameIndex: 2, resolvedTicks: 8_000 });
	});

	test("rejects the same unsupported nonintegral rate as Rust", () => {
		expect(
			resolvePreviewFrameTime({
				time: { kind: "frame-index", frameIndex: 1 },
				fps: { numerator: 7, denominator: 3 },
			}),
		).toMatchObject({ status: "error", code: "UNSUPPORTED_FRAME_RATE" });
	});

	test("matches Rust ticks-per-frame vectors for every standard rate", () => {
		for (const [numerator, denominator, ticksPerFrame] of [
			[24_000, 1_001, 5_005],
			[24, 1, 5_000],
			[25, 1, 4_800],
			[30_000, 1_001, 4_004],
			[30, 1, 4_000],
			[48, 1, 2_500],
			[50, 1, 2_400],
			[60_000, 1_001, 2_002],
			[60, 1, 2_000],
			[120, 1, 1_000],
		] as const) {
			expect(
				resolvePreviewFrameTime({
					time: { kind: "frame-index", frameIndex: 3 },
					fps: { numerator, denominator },
				}),
			).toMatchObject({
				status: "ok",
				ticksPerFrame,
				frameIndex: 3,
				resolvedTicks: ticksPerFrame * 3,
			});
		}
	});
});
