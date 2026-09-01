/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { calculateNormalizationGain } from "./audio-normalization";

describe("calculateNormalizationGain", () => {
	test("reaches the target when headroom is available", () => {
		expect(
			calculateNormalizationGain({
				integratedLufs: -20,
				estimatedTruePeakDbtp: -8,
				targetLufs: -14,
				maxTruePeakDbtp: -1,
				maxGainDb: 20,
				minimumGainDb: -48,
				maximumGainDb: 20,
			}),
		).toEqual({ appliedGainDb: 6, limitedBy: "target_loudness" });
	});

	test("limits gain at the true-peak ceiling", () => {
		expect(
			calculateNormalizationGain({
				integratedLufs: -20,
				estimatedTruePeakDbtp: -3,
				targetLufs: -14,
				maxTruePeakDbtp: -1,
				maxGainDb: 20,
				minimumGainDb: -48,
				maximumGainDb: 20,
			}),
		).toEqual({ appliedGainDb: 2, limitedBy: "true_peak_ceiling" });
	});

	test("respects boost and volume-control bounds", () => {
		expect(
			calculateNormalizationGain({
				integratedLufs: -35,
				estimatedTruePeakDbtp: -30,
				targetLufs: -14,
				maxTruePeakDbtp: -1,
				maxGainDb: 10,
				minimumGainDb: -40,
				maximumGainDb: 4,
			}),
		).toEqual({ appliedGainDb: 4, limitedBy: "volume_bounds" });
	});
});
