import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "./background";
import type { TextBackground } from "./background";
import {
	getMetricAscent,
	getMetricDescent,
	getTextBackgroundRect,
	getTextLineBackgroundRects,
	getTextRect,
	getTextVisualRect,
	type TextCanvasContext,
} from "./layout";
import {
	resolveTextOutline,
	resolveTextShadow,
	textDecorationExtents,
	type TextOutline,
	type TextShadow,
} from "./outline-shadow";
import {
	measureTextLayout,
	type MeasuredTextLayout,
	type TextLayoutParams,
} from "./primitives";
import { clamp } from "@/utils/math";

/**
 * The one measurement function both the caption materializer and the renderer
 * call. Preflight evidence names it so a reader can verify that the geometry
 * it reports was produced by the renderer's own measurement, not a look-alike.
 */
export const CAPTION_MEASUREMENT_FUNCTION = "opencut.text.measureTextLayout";
export const CAPTION_GEOMETRY_VERSION = "opencut.caption-geometry.v1";

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CaptionBubbleRect extends Rect {
	/** Radius in pixels, resolved exactly as the renderer rounds the bubble. */
	cornerRadius: number;
}

/**
 * One drawn line. The renderer anchors every line at `anchorY` with the canvas
 * `middle` baseline, so the box spans the measured ascent above and descent
 * below that anchor.
 */
export interface CaptionLineGeometry {
	index: number;
	text: string;
	width: number;
	ascent: number;
	descent: number;
	anchorY: number;
	box: Rect;
}

/** Geometry relative to the element anchor, before it is placed on a canvas. */
export interface CaptionLocalLayout {
	layout: MeasuredTextLayout;
	lines: CaptionLineGeometry[];
	block: Rect;
	/** The block bubble, or null when no background is drawn. */
	bubble: CaptionBubbleRect | null;
	/** One bubble per line when the background is per-line; null otherwise. */
	lineBubbles: CaptionBubbleRect[] | null;
	visual: Rect;
}

export interface EdgeOverflow {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Geometry placed in canvas pixel space, origin at the top-left corner. */
export interface CaptionGeometry {
	version: typeof CAPTION_GEOMETRY_VERSION;
	measurement: typeof CAPTION_MEASUREMENT_FUNCTION;
	canvas: { width: number; height: number };
	position: { x: number; y: number };
	lineCount: number;
	lines: CaptionLineGeometry[];
	block: Rect;
	bubble: CaptionBubbleRect | null;
	lineBubbles: CaptionBubbleRect[] | null;
	visual: Rect;
	/** Pixels of the visual rect that fall outside the canvas on each edge. */
	overflow: EdgeOverflow;
	clipped: boolean;
	safeZone: { rect: Rect; inside: boolean; overflow: EdgeOverflow };
}

/**
 * Greedy word wrap that measures each candidate line with the shared
 * measurement function, so the lines it produces are the lines the renderer
 * will measure again at draw time.
 */
export function wrapTextToWidth({
	text,
	canvasHeight,
	maxWidth,
	ctx,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
	maxWidth: number;
	ctx: TextCanvasContext;
}): string {
	const measureWidth = (content: string) =>
		measureTextLayout({ text: { ...text, content }, canvasHeight, ctx }).block
			.maxWidth;
	const normalized = text.content.trim().replace(/\r\n/g, "\n");
	const wrappedParagraphs: string[] = [];
	for (const paragraph of normalized.split("\n")) {
		const trimmed = paragraph.trim();
		if (!trimmed) {
			wrappedParagraphs.push("");
			continue;
		}
		const words = trimmed.split(/\s+/);
		let currentLine = words[0] ?? "";
		const lines: string[] = [];
		for (let index = 1; index < words.length; index++) {
			const candidate = `${currentLine} ${words[index]}`;
			if (measureWidth(candidate) <= maxWidth) {
				currentLine = candidate;
				continue;
			}
			lines.push(currentLine);
			currentLine = words[index] ?? "";
		}
		lines.push(currentLine);
		wrappedParagraphs.push(lines.join("\n"));
	}
	return wrappedParagraphs.join("\n");
}

/**
 * Measures already-wrapped caption text exactly as the renderer will: the same
 * function, the same context configuration, the same block, bubble, and
 * visual rectangles, plus the per-line boxes the renderer never had to name.
 */
export function measureCaptionLocalLayout({
	text,
	background,
	outline,
	shadow,
	canvasHeight,
	ctx,
}: {
	text: TextLayoutParams;
	background: TextBackground;
	/** Outline and shadow widen the visual rect; omitted means bare glyphs. */
	outline?: TextOutline;
	shadow?: TextShadow;
	canvasHeight: number;
	ctx: TextCanvasContext;
}): CaptionLocalLayout {
	const layout = measureTextLayout({ text, canvasHeight, ctx });
	const extents =
		outline || shadow
			? textDecorationExtents({
					outline: resolveTextOutline({
						outline: outline ?? { enabled: false, color: "", width: 0 },
						scaledFontSize: layout.scaledFontSize,
					}),
					shadow: resolveTextShadow({
						shadow: shadow ?? {
							enabled: false,
							color: "",
							offsetX: 0,
							offsetY: 0,
							blur: 0,
						},
						scaledFontSize: layout.scaledFontSize,
					}),
				})
			: undefined;
	const block = getTextRect({
		textAlign: layout.textAlign,
		block: layout.block,
	});
	const bubbleRect = getTextBackgroundRect({
		textAlign: layout.textAlign,
		block: layout.block,
		background,
		fontSizeRatio: layout.fontSizeRatio,
	});
	const radiusRatio =
		clamp({
			value: background.cornerRadius ?? CORNER_RADIUS_MIN,
			min: CORNER_RADIUS_MIN,
			max: CORNER_RADIUS_MAX,
		}) / 100;
	const withRadius = (rect: Rect): CaptionBubbleRect => ({
		...rect,
		cornerRadius: (Math.min(rect.width, rect.height) / 2) * radiusRatio,
	});
	const bubble = bubbleRect ? withRadius(bubbleRect) : null;
	const lineBubbles =
		bubbleRect && background.perLine
			? getTextLineBackgroundRects({
					textAlign: layout.textAlign,
					lineMetrics: layout.lineMetrics,
					lineHeightPx: layout.lineHeightPx,
					block: layout.block,
					background,
					fontSizeRatio: layout.fontSizeRatio,
				}).map(withRadius)
			: null;
	const visual = getTextVisualRect({
		textAlign: layout.textAlign,
		block: layout.block,
		background,
		fontSizeRatio: layout.fontSizeRatio,
		extents,
	});
	const lines = layout.lines.map((line, index) => {
		const metrics = layout.lineMetrics[index]!;
		const anchorY =
			index * layout.lineHeightPx - layout.block.visualCenterOffset;
		const ascent = getMetricAscent({
			metrics,
			fallbackFontSize: layout.scaledFontSize,
		});
		const descent = getMetricDescent({
			metrics,
			fallbackFontSize: layout.scaledFontSize,
		});
		const left =
			layout.textAlign === "left"
				? 0
				: layout.textAlign === "right"
					? -metrics.width
					: -metrics.width / 2;
		return {
			index,
			text: line,
			width: metrics.width,
			ascent,
			descent,
			anchorY,
			box: {
				left,
				top: anchorY - ascent,
				width: metrics.width,
				height: ascent + descent,
			},
		};
	});
	return { layout, lines, block, bubble, lineBubbles, visual };
}

/** Places a local layout at a canvas-centred position, as the renderer does. */
export function placeCaptionGeometry({
	local,
	canvasSize,
	position,
	safeZone,
}: {
	local: CaptionLocalLayout;
	canvasSize: { width: number; height: number };
	position: { x: number; y: number };
	safeZone: Rect;
}): CaptionGeometry {
	const originX = canvasSize.width / 2 + position.x;
	const originY = canvasSize.height / 2 + position.y;
	const place = (rect: Rect): Rect => ({
		left: rect.left + originX,
		top: rect.top + originY,
		width: rect.width,
		height: rect.height,
	});
	const visual = place(local.visual);
	const canvasRect = {
		left: 0,
		top: 0,
		width: canvasSize.width,
		height: canvasSize.height,
	};
	const overflow = edgeOverflow(visual, canvasRect);
	const safeZoneOverflow = edgeOverflow(visual, safeZone);
	return {
		version: CAPTION_GEOMETRY_VERSION,
		measurement: CAPTION_MEASUREMENT_FUNCTION,
		canvas: { width: canvasSize.width, height: canvasSize.height },
		position: { x: position.x, y: position.y },
		lineCount: local.lines.length,
		lines: local.lines.map((line) => ({
			...line,
			anchorY: line.anchorY + originY,
			box: place(line.box),
		})),
		block: place(local.block),
		bubble: local.bubble
			? { ...place(local.bubble), cornerRadius: local.bubble.cornerRadius }
			: null,
		lineBubbles: local.lineBubbles
			? local.lineBubbles.map((rect) => ({
					...place(rect),
					cornerRadius: rect.cornerRadius,
				}))
			: null,
		visual,
		overflow,
		clipped: Object.values(overflow).some((value) => value > 0),
		safeZone: {
			rect: safeZone,
			inside: Object.values(safeZoneOverflow).every((value) => value === 0),
			overflow: safeZoneOverflow,
		},
	};
}

function edgeOverflow(inner: Rect, outer: Rect): EdgeOverflow {
	return {
		left: Math.max(0, outer.left - inner.left),
		top: Math.max(0, outer.top - inner.top),
		right: Math.max(0, inner.left + inner.width - (outer.left + outer.width)),
		bottom: Math.max(0, inner.top + inner.height - (outer.top + outer.height)),
	};
}
