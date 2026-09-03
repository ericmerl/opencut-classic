import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PREVIEW_RANGE_MAX_DURATION_SECONDS,
	DEFAULT_PREVIEW_RANGE_MAX_FRAMES,
	PREVIEW_RANGE_OPERATIONAL_MAX_FRAMES,
	readPreviewRangeLimits,
} from "./range-preview-config";

describe("preview range configuration", () => {
	test("uses the bounded production defaults", () => {
		expect(readPreviewRangeLimits({})).toEqual({
			maxDurationSeconds: DEFAULT_PREVIEW_RANGE_MAX_DURATION_SECONDS,
			maxDurationTicks: 1_200_000,
			maxFrames: DEFAULT_PREVIEW_RANGE_MAX_FRAMES,
		});
	});

	test("accepts positive overrides and rejects unsafe configuration", () => {
		expect(
			readPreviewRangeLimits({
				OPENCUT_PREVIEW_RANGE_MAX_DURATION_SECONDS: "2.5",
				OPENCUT_PREVIEW_RANGE_MAX_FRAMES: "75",
			}),
		).toEqual({
			maxDurationSeconds: 2.5,
			maxDurationTicks: 300_000,
			maxFrames: 75,
		});
		expect(() =>
			readPreviewRangeLimits({ OPENCUT_PREVIEW_RANGE_MAX_FRAMES: "0" }),
		).toThrow();
		expect(
			readPreviewRangeLimits({
				OPENCUT_PREVIEW_RANGE_MAX_FRAMES: String(
					PREVIEW_RANGE_OPERATIONAL_MAX_FRAMES,
				),
			}).maxFrames,
		).toBe(PREVIEW_RANGE_OPERATIONAL_MAX_FRAMES);
		expect(() =>
			readPreviewRangeLimits({
				OPENCUT_PREVIEW_RANGE_MAX_FRAMES: String(
					PREVIEW_RANGE_OPERATIONAL_MAX_FRAMES + 1,
				),
			}),
		).toThrow();
	});
});
