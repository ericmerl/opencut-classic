import { describe, expect, test } from "bun:test";
import { nativeComparison, planComparison } from "./native-comparison";

describe("native comparison", () => {
	test("uses Rust for shared planning and rejects silent canvas normalization", () => {
		const source = {
			canvas: { width: 2, height: 2 },
			rate: { numerator: 30, denominator: 1 },
			sceneDurationTicks: 120_000,
			rendererSettingsDigest: "a".repeat(64),
		};
		expect(
			planComparison({
				before: source,
				after: source,
				range: {
					kind: "frame-index",
					startFrameIndex: 0,
					endFrameIndexExclusive: 1,
				},
				limits: { maxDurationTicks: 1_200_000, maxFrames: 300 },
			}),
		).toMatchObject({
			status: "planned",
			plan: { normalizationPolicy: "exact-no-normalization" },
		});
		expect(
			planComparison({
				before: source,
				after: { ...source, canvas: { width: 4, height: 2 } },
				range: {
					kind: "frame-index",
					startFrameIndex: 0,
					endFrameIndexExclusive: 1,
				},
				limits: { maxDurationTicks: 1_200_000, maxFrames: 300 },
			}),
		).toMatchObject({ status: "rejected", code: "CANVAS_MISMATCH" });
	});

	test("returns exact RGBA metrics, regions, diff, aggregate, and compositions", () => {
		const before = Uint8Array.from([0, 0, 0, 255, 5, 5, 5, 255]);
		const after = Uint8Array.from([4, 0, 0, 255, 12, 5, 5, 255]);
		const result = nativeComparison.compareRgba({
			before,
			after,
			width: 2,
			height: 1,
			pixelTolerance: 4,
			maxRegions: 8,
		});
		expect(result).toMatchObject({
			metrics: { pixelCount: 2, exceedingPixelCount: 1, absoluteDeltaSum: 11 },
			regions: { connectivity: "4-connected-row-major", totalRegionCount: 1 },
		});
		expect([...result.diffRgba]).toEqual([4, 0, 0, 0, 7, 0, 0, 0]);
		expect(
			nativeComparison.aggregateFrameMetrics([result.metrics]),
		).toMatchObject({
			pixelCount: 2,
			exceedingPixelCount: 1,
		});
		expect(
			nativeComparison.composeRgba({
				before,
				after,
				width: 2,
				height: 1,
				mode: "side-by-side",
			}),
		).toMatchObject({ width: 4, height: 1 });
		expect(
			nativeComparison.composeRgba({
				before,
				after,
				width: 2,
				height: 1,
				mode: "wipe",
				wipePosition: 0.5,
			}),
		).toMatchObject({
			width: 2,
			height: 1,
			rgba: Uint8Array.from([0, 0, 0, 255, 12, 5, 5, 255]),
		});
	});

	test("compares aligned PCM and rejects shape mismatch", () => {
		expect(
			nativeComparison.comparePcmI16({
				before: Int16Array.from([0, 10, 20, 30]),
				after: Int16Array.from([0, 14, 10, 30]),
				channels: 2,
				sampleRate: 44_100,
				sampleTolerance: 4,
			}),
		).toMatchObject({
			sampleCount: 4,
			exceedingSampleCount: 1,
			maxAbsoluteDelta: 10,
		});
		expect(() =>
			nativeComparison.comparePcmI16({
				before: Int16Array.from([0, 1]),
				after: Int16Array.from([0]),
				channels: 1,
				sampleRate: 44_100,
				sampleTolerance: 0,
			}),
		).toThrow("SHAPE_MISMATCH");
	});
});
