/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import type { TextCanvasContext } from "@/text/layout";
import { measureSubtitleCaption } from "./build-subtitle-text-element";

const PORTRAIT = { width: 1080, height: 1920 };

function measurementContext(): TextCanvasContext {
	return createCanvas(1024, 1024).getContext(
		"2d",
	) as unknown as TextCanvasContext;
}

describe("caption outline and shadow style", () => {
	test("materializes outline and shadow params on the inserted caption", () => {
		const measured = measureSubtitleCaption({
			index: 0,
			caption: {
				text: "Hook lands here",
				startTime: 0,
				duration: 2,
				style: {
					fontFamily: "sans-serif",
					outline: { enabled: true, color: "#101010", width: 0.12 },
					shadow: {
						enabled: true,
						color: "rgba(0, 0, 0, 0.6)",
						offsetX: 0.03,
						offsetY: 0.06,
						blur: 0.09,
					},
				},
			},
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		expect(measured.element.params).toMatchObject({
			"outline.enabled": true,
			"outline.color": "#101010",
			"outline.width": 0.12,
			"shadow.enabled": true,
			"shadow.color": "rgba(0, 0, 0, 0.6)",
			"shadow.offsetX": 0.03,
			"shadow.offsetY": 0.06,
			"shadow.blur": 0.09,
		});
	});

	test("leaves outline and shadow off with the shared defaults when unstyled", () => {
		const measured = measureSubtitleCaption({
			index: 0,
			caption: { text: "Plain", startTime: 0, duration: 1 },
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		expect(measured.element.params).toMatchObject({
			"outline.enabled": false,
			"outline.color": "#000000",
			"outline.width": 0.08,
			"shadow.enabled": false,
			"shadow.color": "#000000",
			"shadow.offsetX": 0.04,
			"shadow.offsetY": 0.04,
			"shadow.blur": 0.08,
		});
	});

	test("includes the outline and shadow in the caption geometry visual rect", () => {
		const plain = measureSubtitleCaption({
			index: 0,
			caption: { text: "Reach", startTime: 0, duration: 1 },
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		const styled = measureSubtitleCaption({
			index: 0,
			caption: {
				text: "Reach",
				startTime: 0,
				duration: 1,
				style: {
					outline: { enabled: true, width: 0.1 },
					shadow: { enabled: true, offsetX: 0.2, offsetY: 0.2, blur: 0 },
				},
			},
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		expect(styled.geometry.visual.width).toBeGreaterThan(
			plain.geometry.visual.width,
		);
		expect(styled.geometry.visual.height).toBeGreaterThan(
			plain.geometry.visual.height,
		);
		// The glyphs themselves do not move within the caption; only the visual
		// envelope (and therefore the safe-zone placement) grows.
		expect(styled.local.lines[0]?.box).toEqual(plain.local.lines[0]?.box);
	});
});
