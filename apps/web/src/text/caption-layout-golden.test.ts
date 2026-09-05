/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import type { TextElement } from "@/timeline";
import type { SubtitleCue } from "@/subtitles/types";
import type { TextCanvasContext } from "./layout";
import { getMetricAscent, getMetricDescent } from "./layout";
import { measureTextElement } from "./measure-element";
import {
	drawMeasuredTextLayout,
	locateTextWord,
	measureTextWordSpan,
} from "./primitives";
import { measureSubtitleCaption } from "@/subtitles/build-subtitle-text-element";
import {
	CAPTION_GEOMETRY_VERSION,
	CAPTION_MEASUREMENT_FUNCTION,
} from "./caption-layout";

// The golden comparison runs on the bundled faces so the measurement is the
// one production text uses, not whatever the host happens to have installed.
const BUNDLED = join(import.meta.dir, "../../public/fonts/bundled");
GlobalFonts.registerFromPath(
	join(BUNDLED, "tiktok-sans/TikTokSans[opsz,slnt,wdth,wght].ttf"),
	"TikTok Sans",
);
GlobalFonts.registerFromPath(
	join(BUNDLED, "montserrat/Montserrat[wght].ttf"),
	"Montserrat",
);
GlobalFonts.registerFromPath(
	join(BUNDLED, "montserrat/Montserrat-Italic[wght].ttf"),
	"Montserrat",
);

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

const FIXTURES: Array<{
	name: string;
	caption: SubtitleCue;
	canvasSize: { width: number; height: number };
	expectWrap: boolean;
}> = [
	{
		name: "short bold TikTok Sans caption at the bottom",
		caption: {
			text: "They don't want you to know",
			startTime: 0,
			duration: 2,
			style: { fontFamily: "TikTok Sans", fontWeight: "bold" },
		},
		canvasSize: PORTRAIT,
		expectWrap: false,
	},
	{
		name: "long TikTok Sans sentence that wraps",
		caption: {
			text: "This is the part of the video where the hook has to land in the first three seconds or the viewer scrolls straight past it",
			startTime: 1,
			duration: 3,
			style: { fontFamily: "TikTok Sans", fontWeight: "bold", fontSize: 6 },
		},
		canvasSize: PORTRAIT,
		expectWrap: true,
	},
	{
		name: "Montserrat italic left-aligned bubble with margins",
		caption: {
			text: "Quiet morning routine, no music, just the kettle and the light coming through the blinds over the sink",
			startTime: 2,
			duration: 2,
			style: {
				fontFamily: "Montserrat",
				fontStyle: "italic",
				fontWeight: "normal",
				textAlign: "left",
				fontSize: 4,
				background: {
					enabled: true,
					color: "#ff2d55",
					paddingX: 24,
					paddingY: 12,
					cornerRadius: 40,
				},
				placement: {
					verticalAlign: "bottom",
					marginLeftRatio: 0.12,
					marginRightRatio: 0.3,
					marginVerticalRatio: 0.08,
				},
			},
		},
		canvasSize: LANDSCAPE,
		expectWrap: true,
	},
	{
		name: "two paragraphs, right-aligned at the top with letter spacing",
		caption: {
			text: "Step one\nPreheat the pan until the oil shimmers and moves freely",
			startTime: 3,
			duration: 2,
			style: {
				fontFamily: "Montserrat",
				fontWeight: "bold",
				textAlign: "right",
				letterSpacing: 2,
				lineHeight: 1.4,
				placement: { verticalAlign: "top" },
			},
		},
		canvasSize: PORTRAIT,
		expectWrap: true,
	},
	{
		name: "unbreakable word that overflows the safe zone",
		caption: {
			text: "Supercalifragilisticexpialidociousness",
			startTime: 4,
			duration: 1,
			style: { fontFamily: "TikTok Sans", fontWeight: "bold", fontSize: 9 },
		},
		canvasSize: PORTRAIT,
		expectWrap: false,
	},
];

function measurementContext(): TextCanvasContext {
	return createCanvas(4096, 4096).getContext(
		"2d",
	) as unknown as TextCanvasContext;
}

describe("caption geometry golden", () => {
	for (const fixture of FIXTURES) {
		test(`materialized geometry equals renderer measurement: ${fixture.name}`, () => {
			const ctx = measurementContext();
			const measured = measureSubtitleCaption({
				index: 0,
				caption: fixture.caption,
				canvasSize: fixture.canvasSize,
				ctx,
			});
			const element = {
				...measured.element,
				id: "caption-golden",
			} as TextElement;

			// The renderer measures the element it is handed with the same
			// function on an identically configured context.
			const rendered = measureTextElement({
				element,
				canvasHeight: fixture.canvasSize.height,
				localTime: 0,
				ctx: measurementContext(),
			});

			expect(rendered.lines).toEqual(measured.local.layout.lines);
			expect(rendered.fontString).toBe(measured.local.layout.fontString);
			expect(rendered.block).toEqual(measured.local.layout.block);
			expect(rendered.visualRect).toEqual(measured.local.visual);
			expect(rendered.lineMetrics.map((metrics) => metrics.width)).toEqual(
				measured.local.lines.map((line) => line.width),
			);
			rendered.lineMetrics.forEach((metrics, index) => {
				const anchorY =
					index * rendered.lineHeightPx - rendered.block.visualCenterOffset;
				const ascent = getMetricAscent({
					metrics,
					fallbackFontSize: rendered.scaledFontSize,
				});
				const descent = getMetricDescent({
					metrics,
					fallbackFontSize: rendered.scaledFontSize,
				});
				expect(measured.local.lines[index]).toEqual({
					index,
					text: rendered.lines[index]!,
					width: metrics.width,
					ascent,
					descent,
					anchorY,
					box: {
						left:
							rendered.textAlign === "left"
								? 0
								: rendered.textAlign === "right"
									? -metrics.width
									: -metrics.width / 2,
						top: anchorY - ascent,
						width: metrics.width,
						height: ascent + descent,
					},
				});
			});

			// Placement translates the local geometry by the canvas centre plus
			// the element position, exactly as the renderer positions the node.
			const { geometry } = measured;
			const originX =
				fixture.canvasSize.width / 2 +
				Number(measured.element.params["transform.positionX"]);
			const originY =
				fixture.canvasSize.height / 2 +
				Number(measured.element.params["transform.positionY"]);
			expect(geometry.version).toBe(CAPTION_GEOMETRY_VERSION);
			expect(geometry.measurement).toBe(CAPTION_MEASUREMENT_FUNCTION);
			expect(geometry.visual).toEqual({
				...measured.local.visual,
				left: measured.local.visual.left + originX,
				top: measured.local.visual.top + originY,
			});
			expect(geometry.lineCount).toBe(rendered.lines.length);
			expect(geometry.lines.map((line) => line.anchorY)).toEqual(
				measured.local.lines.map((line) => line.anchorY + originY),
			);
			expect(geometry.bubble === null).toBe(measured.local.bubble === null);
			if (fixture.expectWrap) {
				expect(geometry.lineCount).toBeGreaterThan(1);
			}
		});
	}

	test("wrapped lines never exceed the caption's target width", () => {
		const fixture = FIXTURES[1]!;
		const measured = measureSubtitleCaption({
			index: 0,
			caption: fixture.caption,
			canvasSize: fixture.canvasSize,
			ctx: measurementContext(),
		});
		const maxWidth = fixture.canvasSize.width * 0.8;
		for (const line of measured.local.lines) {
			expect(line.width).toBeLessThanOrEqual(maxWidth);
		}
		expect(measured.geometry.clipped).toBe(false);
		expect(measured.geometry.safeZone.inside).toBe(true);
	});

	test("an unbreakable word reports its safe-zone overflow", () => {
		const fixture = FIXTURES[4]!;
		const measured = measureSubtitleCaption({
			index: 0,
			caption: fixture.caption,
			canvasSize: fixture.canvasSize,
			ctx: measurementContext(),
		});
		expect(measured.geometry.lineCount).toBe(1);
		expect(measured.geometry.safeZone.inside).toBe(false);
		expect(
			measured.geometry.safeZone.overflow.left +
				measured.geometry.safeZone.overflow.right,
		).toBeGreaterThan(0);
	});

	test("outline and shadow expand every measured line and safe-zone visual", () => {
		const measured = measureSubtitleCaption({
			index: 0,
			caption: {
				text: "Effect extents",
				startTime: 0,
				duration: 2,
				style: {
					fontFamily: "TikTok Sans",
					fontWeight: "bold",
					outline: { color: "#000000", width: 2, join: "round" },
					shadow: {
						color: "#00000099",
						offsetX: 2,
						offsetY: 3,
						blur: 3,
					},
				},
			},
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});

		expect(measured.geometry.version).toBe("opencut.caption-geometry.v2");
		expect(measured.geometry.textEffects.outline.join).toBe("round");
		expect(measured.geometry.textEffects.outline.width).toBeCloseTo(42.6667, 3);
		expect(measured.geometry.textEffects.shadow.offsetX).toBeCloseTo(
			42.6667,
			3,
		);
		expect(measured.geometry.textEffects.shadow.offsetY).toBe(64);
		expect(measured.geometry.textEffects.shadow.blur).toBe(64);
		expect(measured.geometry.textEffects.extents.left).toBeCloseTo(21.3333, 3);
		expect(measured.geometry.textEffects.extents.top).toBeCloseTo(21.3333, 3);
		expect(measured.local.lines[0]!.box.width).toBeGreaterThan(
			measured.local.lines[0]!.width,
		);
		expect(measured.local.visual.width).toBeGreaterThan(
			measured.local.block.width,
		);
	});

	test("shared measured-text drawing paints outline and shadow pixels", () => {
		const measured = measureSubtitleCaption({
			index: 0,
			caption: {
				text: "Title",
				startTime: 0,
				duration: 2,
				style: {
					fontFamily: "TikTok Sans",
					fontWeight: "bold",
					fontSize: 8,
					outline: { color: "#ff0000", width: 1, join: "bevel" },
					shadow: {
						color: "#0000ff",
						offsetX: 2,
						offsetY: 2,
						blur: 0,
					},
				},
			},
			canvasSize: { width: 500, height: 200 },
			ctx: measurementContext(),
		});
		const canvas = createCanvas(500, 200);
		const ctx = canvas.getContext("2d") as unknown as TextCanvasContext;
		(ctx as unknown as CanvasRenderingContext2D).translate(250, 100);
		drawMeasuredTextLayout({
			ctx,
			layout: measured.local.layout,
			textColor: "#ffffff",
			textEffects: measured.local.textEffects,
		});
		const pixels = (ctx as unknown as CanvasRenderingContext2D).getImageData(
			0,
			0,
			500,
			200,
		).data;
		let red = 0;
		let blue = 0;
		for (let offset = 0; offset < pixels.length; offset += 4) {
			const [r, g, b, a] = [
				pixels[offset]!,
				pixels[offset + 1]!,
				pixels[offset + 2]!,
				pixels[offset + 3]!,
			];
			if (a < 200) continue;
			if (r > 180 && g < 80 && b < 80) red += 1;
			if (b > 180 && r < 80 && g < 80) blue += 1;
		}
		expect(red).toBeGreaterThan(0);
		expect(blue).toBeGreaterThan(0);
	});

	test("the bubble follows the renderer's padding and corner rounding", () => {
		const fixture = FIXTURES[2]!;
		const measured = measureSubtitleCaption({
			index: 0,
			caption: fixture.caption,
			canvasSize: fixture.canvasSize,
			ctx: measurementContext(),
		});
		const bubble = measured.local.bubble;
		if (!bubble) throw new Error("expected a bubble");
		const fontSizeRatio = 4 / 15;
		expect(bubble.width).toBeCloseTo(
			measured.local.layout.block.maxWidth + 2 * 24 * fontSizeRatio,
			6,
		);
		expect(bubble.height).toBeCloseTo(
			measured.local.layout.block.height + 2 * 12 * fontSizeRatio,
			6,
		);
		expect(bubble.cornerRadius).toBeCloseTo(
			(Math.min(bubble.width, bubble.height) / 2) * 0.4,
			6,
		);
		// Bottom placement with an 8% vertical margin in a 1080 px tall canvas.
		const bottom =
			measured.geometry.visual.top + measured.geometry.visual.height;
		expect(bottom).toBeCloseTo(LANDSCAPE.height * (1 - 0.08), 6);
		expect(measured.geometry.visual.left).toBeCloseTo(
			LANDSCAPE.width * 0.12,
			6,
		);
	});

	test("per-line bubbles cover each wrapped line and tile the block bubble", () => {
		const fixture = FIXTURES[1]!;
		const measured = measureSubtitleCaption({
			index: 0,
			caption: {
				...fixture.caption,
				style: {
					...fixture.caption.style,
					background: {
						enabled: true,
						color: "#000000",
						perLine: true,
						paddingX: 16,
						paddingY: 8,
						cornerRadius: 50,
					},
				},
			},
			canvasSize: fixture.canvasSize,
			ctx: measurementContext(),
		});
		const { lineBubbles, bubble, lines, layout } = measured.local;
		if (!lineBubbles || !bubble) throw new Error("expected per-line bubbles");
		expect(lineBubbles).toHaveLength(lines.length);
		expect(lines.length).toBeGreaterThan(1);
		const ratio = layout.fontSizeRatio;
		lineBubbles.forEach((lineBubble, index) => {
			expect(lineBubble.width).toBeCloseTo(
				lines[index]!.width + 2 * 16 * ratio,
				6,
			);
			expect(lineBubble.height).toBeCloseTo(
				layout.lineHeightPx + 2 * 8 * ratio,
				6,
			);
			expect(lineBubble.cornerRadius).toBeCloseTo(
				(Math.min(lineBubble.width, lineBubble.height) / 2) * 0.5,
				6,
			);
		});
		// The line bubbles tile the block bubble's vertical extent exactly and
		// the widest one matches the block bubble's width.
		const top = Math.min(...lineBubbles.map((rect) => rect.top));
		const bottom = Math.max(
			...lineBubbles.map((rect) => rect.top + rect.height),
		);
		expect(top).toBeCloseTo(bubble.top, 6);
		expect(bottom).toBeCloseTo(bubble.top + bubble.height, 6);
		expect(Math.max(...lineBubbles.map((rect) => rect.width))).toBeCloseTo(
			bubble.width,
			6,
		);
		expect(measured.geometry.lineBubbles).toHaveLength(lines.length);
		expect(measured.element.params["background.perLine"]).toBe(true);
	});

	test("word highlight paints only the spoken word", () => {
		const measured = measureSubtitleCaption({
			index: 0,
			caption: {
				text: "hello there world",
				startTime: 0,
				duration: 3,
				style: {
					fontFamily: "TikTok Sans",
					fontWeight: "bold",
					fontSize: 6,
					highlight: { enabled: true, color: "#ffd400" },
				},
			},
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		const element = {
			...measured.element,
			id: "caption-karaoke",
		} as TextElement;
		expect(element.params["highlight.enabled"]).toBe(true);
		const canvas = createCanvas(PORTRAIT.width, 400);
		const ctx = canvas.getContext("2d") as unknown as TextCanvasContext;
		// Half way through, character share puts "there" (5 of 15) on screen.
		const layout = measureTextElement({
			element,
			canvasHeight: PORTRAIT.height,
			localTime: element.duration / 2,
			ctx: ctx as unknown as CanvasRenderingContext2D,
		});
		expect(layout.highlight).toMatchObject({
			enabled: true,
			color: "#ffd400",
			wordIndex: 1,
		});
		const span = locateTextWord({ layout, wordIndex: 1 });
		if (!span) throw new Error("expected the second word");
		expect(layout.lines[span.lineIndex]!.slice(span.start, span.end)).toBe(
			"there",
		);
		const extent = measureTextWordSpan({ ctx, layout, span });
		const origin = { x: PORTRAIT.width / 2, y: 200 };
		(ctx as unknown as CanvasRenderingContext2D).translate(origin.x, origin.y);
		drawMeasuredTextLayout({
			ctx,
			layout,
			textColor: "#ffffff",
			background: null,
			highlight: { color: "#ffd400", wordIndex: 1 },
		});
		const { data, width, height } = (
			ctx as unknown as CanvasRenderingContext2D
		).getImageData(0, 0, PORTRAIT.width, 400);
		let yellow = 0;
		let white = 0;
		let strayYellow = 0;
		const left = origin.x + extent.x - 2;
		const right = origin.x + extent.x + extent.width + 2;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const offset = (y * width + x) * 4;
				const [r, g, b, a] = [
					data[offset]!,
					data[offset + 1]!,
					data[offset + 2]!,
					data[offset + 3]!,
				];
				if (a < 200) continue;
				if (r > 240 && g > 190 && b < 60) {
					yellow += 1;
					if (x < left || x > right) strayYellow += 1;
				} else if (r > 240 && g > 240 && b > 240) {
					white += 1;
				}
			}
		}
		expect(yellow).toBeGreaterThan(0);
		expect(white).toBeGreaterThan(0);
		expect(strayYellow).toBe(0);
	});

	test("measurement is deterministic across contexts", () => {
		const first = measureSubtitleCaption({
			index: 0,
			caption: FIXTURES[1]!.caption,
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		const second = measureSubtitleCaption({
			index: 0,
			caption: FIXTURES[1]!.caption,
			canvasSize: PORTRAIT,
			ctx: measurementContext(),
		});
		expect(second.geometry).toEqual(first.geometry);
		expect(second.element).toEqual(first.element);
	});
});
