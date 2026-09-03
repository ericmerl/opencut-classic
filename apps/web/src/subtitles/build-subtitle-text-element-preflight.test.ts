/// <reference types="bun" />

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));

const { buildSubtitleTextElement } = await import(
	"./build-subtitle-text-element"
);

describe("subtitle preflight measurement", () => {
	beforeAll(() => {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				createElement: () => ({
					width: 0,
					height: 0,
					getContext: () => null,
				}),
			},
		});
	});
	afterAll(() => {
		Reflect.deleteProperty(globalThis, "document");
	});

	test("fails closed when strict browser layout cannot obtain Canvas 2D", () => {
		expect(() =>
			buildSubtitleTextElement({
				index: 0,
				caption: { text: "Caption", startTime: 0, duration: 1 },
				canvasSize: { width: 1080, height: 1920 },
				requireMeasurement: true,
			}),
		).toThrow("requires a Canvas 2D measurement context");
	});

	test("preserves the legacy no-context fallback", () => {
		expect(
			buildSubtitleTextElement({
				index: 0,
				caption: { text: "Caption", startTime: 0, duration: 1 },
				canvasSize: { width: 1080, height: 1920 },
			}),
		).toMatchObject({
			name: "Caption 1",
			params: {
				content: "Caption",
				"transform.positionX": 0,
				"transform.positionY": 0,
			},
		});
	});
});
