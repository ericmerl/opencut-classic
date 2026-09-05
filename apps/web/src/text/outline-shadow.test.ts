/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import type { TextElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import type { TextCanvasContext } from "./layout";
import { measureTextElement } from "./measure-element";
import { drawMeasuredTextLayout } from "./primitives";

const CANVAS = { width: 640, height: 360 };

function element(
	params: Record<string, string | number | boolean>,
): TextElement {
	return {
		...DEFAULTS.text.element,
		id: "title",
		params: {
			...DEFAULTS.text.element.params,
			content: "OUTLINE",
			fontFamily: "sans-serif",
			fontWeight: "bold",
			fontSize: 20,
			color: "#ffffff",
			...params,
		},
	} as TextElement;
}

function context(): CanvasRenderingContext2D {
	return createCanvas(CANVAS.width, CANVAS.height).getContext(
		"2d",
	) as unknown as CanvasRenderingContext2D;
}

function paint(params: Record<string, string | number | boolean>) {
	const ctx = context();
	const layout = measureTextElement({
		element: element(params),
		canvasHeight: CANVAS.height,
		localTime: 0,
		ctx,
	});
	ctx.translate(CANVAS.width / 2, CANVAS.height / 2);
	drawMeasuredTextLayout({
		ctx: ctx as unknown as TextCanvasContext,
		layout,
		textColor: "#ffffff",
		background: null,
		outline: layout.outline,
		shadow: layout.shadow,
	});
	const { data, width, height } = ctx.getImageData(
		0,
		0,
		CANVAS.width,
		CANVAS.height,
	);
	const counts = { white: 0, dark: 0, darkRight: 0, darkLeft: 0 };
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 4;
			const [r, g, b, a] = [
				data[offset]!,
				data[offset + 1]!,
				data[offset + 2]!,
				data[offset + 3]!,
			];
			if (a < 40) continue;
			if (r > 230 && g > 230 && b > 230) counts.white += 1;
			else if (r < 60 && g < 60 && b < 60) {
				counts.dark += 1;
				if (x > width / 2) counts.darkRight += 1;
				else counts.darkLeft += 1;
			}
		}
	}
	return { layout, counts };
}

describe("text outline and drop shadow", () => {
	test("resolves outline and shadow from element params in font-size units", () => {
		const { layout } = paint({
			"outline.enabled": true,
			"outline.color": "#000000",
			"outline.width": 0.1,
			"shadow.enabled": true,
			"shadow.color": "#000000",
			"shadow.offsetX": 0.25,
			"shadow.offsetY": 0.25,
			"shadow.blur": 0,
		});
		// fontSize 20 on a 360-high canvas renders at 80 px, so 0.1 em is 8 px.
		expect(layout.outline).toEqual({
			enabled: true,
			color: "#000000",
			widthPx: 8,
		});
		expect(layout.shadow).toEqual({
			enabled: true,
			color: "#000000",
			offsetXPx: 20,
			offsetYPx: 20,
			blurPx: 0,
		});
	});

	test("paints the outline behind the fill and keeps the glyph fill white", () => {
		const plain = paint({});
		const outlined = paint({
			"outline.enabled": true,
			"outline.color": "#000000",
			"outline.width": 0.1,
		});
		expect(plain.counts.dark).toBe(0);
		expect(outlined.counts.dark).toBeGreaterThan(plain.counts.white / 4);
		// The fill is painted after the stroke, so the glyph interiors stay white.
		expect(outlined.counts.white).toBeGreaterThan(plain.counts.white * 0.6);
	});

	test("offsets the drop shadow in the requested direction", () => {
		const shadowed = paint({
			"shadow.enabled": true,
			"shadow.color": "#000000",
			"shadow.offsetX": 0.25,
			"shadow.offsetY": 0,
			"shadow.blur": 0,
		});
		expect(shadowed.counts.dark).toBeGreaterThan(0);
		// Shifted right, the shadow leaks past the right edge of the text more
		// than the left edge.
		expect(shadowed.counts.darkRight).toBeGreaterThan(shadowed.counts.darkLeft);
	});

	test("widens the visual rect by the outline and shadow extents", () => {
		const plain = paint({}).layout.visualRect;
		const styled = paint({
			"outline.enabled": true,
			"outline.width": 0.1,
			"shadow.enabled": true,
			"shadow.offsetX": 0.25,
			"shadow.offsetY": 0.25,
			"shadow.blur": 0.05,
		}).layout.visualRect;
		// Half the 8 px stroke on the left; on the right the shadow of the
		// stroked glyphs reaches 20 px offset + 4 px blur + 4 px half stroke.
		expect(styled.left).toBeCloseTo(plain.left - 4, 5);
		expect(styled.left + styled.width).toBeCloseTo(
			plain.left + plain.width + 28,
			5,
		);
		expect(styled.top).toBeCloseTo(plain.top - 4, 5);
		expect(styled.top + styled.height).toBeCloseTo(
			plain.top + plain.height + 28,
			5,
		);
	});
});
