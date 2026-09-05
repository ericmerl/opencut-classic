import type { TextCanvasContext, TextBlockMeasurement } from "@/text/layout";
import { DEFAULTS } from "@/timeline/defaults";
import { clamp } from "@/utils/math";
import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "./background";
import {
	drawTextDecoration,
	getTextBackgroundRect,
	getTextLineBackgroundRects,
	measureTextBlock,
	setCanvasLetterSpacing,
} from "./layout";
import type { ResolvedTextOutline, ResolvedTextShadow } from "./outline-shadow";
import { FONT_SIZE_SCALE_REFERENCE } from "./typography";

export type TextAlign = "left" | "center" | "right";
export type TextFontWeight = "normal" | "bold";
export type TextFontStyle = "normal" | "italic";
export type TextDecoration = "none" | "underline" | "line-through";

export interface TextLayoutParams {
	content: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
}

export interface ResolvedTextLayout {
	scaledFontSize: number;
	fontString: string;
	letterSpacing: number;
	lineHeightPx: number;
	fontSizeRatio: number;
	textAlign: TextAlign;
	textDecoration: TextDecoration;
}

export interface MeasuredTextLayout extends ResolvedTextLayout {
	lines: string[];
	lineMetrics: TextMetrics[];
	block: TextBlockMeasurement;
}

export interface ResolvedTextBackgroundLike {
	enabled: boolean;
	color: string;
	perLine?: boolean;
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

export function quoteFontFamily({
	fontFamily,
}: {
	fontFamily: string;
}): string {
	return `"${fontFamily.replace(/"/g, '\\"')}"`;
}

export function buildTextFontString({
	fontFamily,
	fontWeight,
	fontStyle,
	scaledFontSize,
}: {
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	scaledFontSize: number;
}): string {
	return `${fontStyle} ${fontWeight} ${scaledFontSize}px ${quoteFontFamily({ fontFamily })}, sans-serif`;
}

export function resolveTextLayout({
	text,
	canvasHeight,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
}): ResolvedTextLayout {
	const scaledFontSize =
		text.fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
	const fontWeight = text.fontWeight === "bold" ? "bold" : "normal";
	const fontStyle = text.fontStyle === "italic" ? "italic" : "normal";
	const letterSpacing = text.letterSpacing ?? DEFAULTS.text.letterSpacing;
	const lineHeightPx =
		scaledFontSize * (text.lineHeight ?? DEFAULTS.text.lineHeight);
	const fontSizeRatio = text.fontSize / 15;

	return {
		scaledFontSize,
		fontString: buildTextFontString({
			fontFamily: text.fontFamily,
			fontWeight,
			fontStyle,
			scaledFontSize,
		}),
		letterSpacing,
		lineHeightPx,
		fontSizeRatio,
		textAlign: text.textAlign,
		textDecoration: text.textDecoration ?? "none",
	};
}

export function measureTextLayout({
	text,
	canvasHeight,
	ctx,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
	ctx: TextCanvasContext;
}): MeasuredTextLayout {
	const resolvedLayout = resolveTextLayout({ text, canvasHeight });
	const lines = text.content.split("\n");

	ctx.save();
	ctx.font = resolvedLayout.fontString;
	ctx.textBaseline = "middle";
	setCanvasLetterSpacing({
		ctx,
		letterSpacingPx: resolvedLayout.letterSpacing,
	});
	const lineMetrics = lines.map((line) => ctx.measureText(line));
	ctx.restore();

	const block = measureTextBlock({
		lineMetrics,
		lineHeightPx: resolvedLayout.lineHeightPx,
	});

	return {
		...resolvedLayout,
		lines,
		lineMetrics,
		block,
	};
}

/** A word located inside the wrapped lines by character offsets. */
export interface TextWordSpan {
	lineIndex: number;
	start: number;
	end: number;
}

/**
 * Finds word `wordIndex`, counting whitespace-separated words across the
 * wrapped lines in reading order, so a caption's word index maps onto the
 * line the renderer actually draws it on.
 */
export function locateTextWord({
	layout,
	wordIndex,
}: {
	layout: Pick<MeasuredTextLayout, "lines">;
	wordIndex: number;
}): TextWordSpan | null {
	let seen = 0;
	for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
		for (const match of layout.lines[lineIndex]!.matchAll(/\S+/g)) {
			if (seen === wordIndex) {
				return {
					lineIndex,
					start: match.index,
					end: match.index + match[0].length,
				};
			}
			seen += 1;
		}
	}
	return null;
}

function lineStartX({
	textAlign,
	lineWidth,
}: {
	textAlign: TextAlign;
	lineWidth: number;
}): number {
	if (textAlign === "left") return 0;
	if (textAlign === "right") return -lineWidth;
	return -lineWidth / 2;
}

/**
 * The horizontal extent a word occupies on its line, in the layout's local
 * space, measured with the same font and letter spacing the line is drawn
 * with.
 */
export function measureTextWordSpan({
	ctx,
	layout,
	span,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	span: TextWordSpan;
}): { x: number; width: number } {
	ctx.font = layout.fontString;
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });
	const line = layout.lines[span.lineIndex]!;
	const start = lineStartX({
		textAlign: layout.textAlign,
		lineWidth: layout.lineMetrics[span.lineIndex]!.width,
	});
	const prefixWidth =
		span.start === 0 ? 0 : ctx.measureText(line.slice(0, span.start)).width;
	const width = ctx.measureText(line.slice(span.start, span.end)).width;
	return { x: start + prefixWidth, width };
}

export function drawMeasuredTextLayout({
	ctx,
	layout,
	textColor,
	background,
	backgroundColor,
	highlight,
	outline,
	shadow,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	background?: ResolvedTextBackgroundLike | null;
	backgroundColor?: string;
	/** The word to paint in `color` instead of `textColor`, if any. */
	highlight?: { color: string; wordIndex: number } | null;
	/** Stroke around every glyph, painted behind the fill. */
	outline?: ResolvedTextOutline | null;
	/** Drop shadow cast by the (stroked) glyphs, painted first. */
	shadow?: ResolvedTextShadow | null;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.fillStyle = textColor;
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	if (
		background?.enabled &&
		backgroundColor &&
		backgroundColor !== "transparent" &&
		layout.lines.length > 0
	) {
		const coloured = { ...background, color: backgroundColor };
		const rects = background.perLine
			? getTextLineBackgroundRects({
					textAlign: layout.textAlign,
					lineMetrics: layout.lineMetrics,
					lineHeightPx: layout.lineHeightPx,
					block: layout.block,
					background: coloured,
					fontSizeRatio: layout.fontSizeRatio,
				})
			: [
					getTextBackgroundRect({
						textAlign: layout.textAlign,
						block: layout.block,
						background: coloured,
						fontSizeRatio: layout.fontSizeRatio,
					}),
				];
		const p =
			clamp({
				value: background.cornerRadius,
				min: CORNER_RADIUS_MIN,
				max: CORNER_RADIUS_MAX,
			}) / 100;
		ctx.fillStyle = backgroundColor;
		for (const rect of rects) {
			if (!rect) continue;
			const radius = (Math.min(rect.width, rect.height) / 2) * p;
			ctx.beginPath();
			ctx.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
			ctx.fill();
		}
		ctx.fillStyle = textColor;
	}

	const lineYAt = (index: number) =>
		index * layout.lineHeightPx - layout.block.visualCenterOffset;
	const strokeLines = () => {
		ctx.strokeStyle = outline!.color;
		ctx.lineWidth = outline!.widthPx;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		for (let index = 0; index < layout.lines.length; index++) {
			ctx.strokeText(layout.lines[index], 0, lineYAt(index));
		}
	};
	const hasOutline = Boolean(outline?.enabled && outline.widthPx > 0);

	// The shadow is cast once by the stroked glyphs, then the outline and the
	// fill are painted sharp on top so neither carries a second shadow.
	if (shadow?.enabled) {
		ctx.save();
		ctx.shadowColor = shadow.color;
		ctx.shadowOffsetX = shadow.offsetXPx;
		ctx.shadowOffsetY = shadow.offsetYPx;
		ctx.shadowBlur = shadow.blurPx;
		if (hasOutline) strokeLines();
		for (let index = 0; index < layout.lines.length; index++) {
			ctx.fillText(layout.lines[index], 0, lineYAt(index));
		}
		ctx.restore();
	}
	if (hasOutline) strokeLines();

	const highlighted = highlight
		? locateTextWord({ layout, wordIndex: highlight.wordIndex })
		: null;
	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = lineYAt(index);
		if (highlight && highlighted && highlighted.lineIndex === index) {
			drawHighlightedLine({
				ctx,
				layout,
				span: highlighted,
				lineY,
				color: highlight.color,
				textColor,
			});
		} else {
			ctx.fillText(layout.lines[index], 0, lineY);
		}
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[index].width,
			lineY,
			metrics: layout.lineMetrics[index],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	}
}

/**
 * Draws one line as three runs (before, word, after) so the highlighted word
 * is painted once in its own colour rather than over the plain line, which
 * would fringe its edges with the underlying colour.
 */
function drawHighlightedLine({
	ctx,
	layout,
	span,
	lineY,
	color,
	textColor,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	span: TextWordSpan;
	lineY: number;
	color: string;
	textColor: string;
}): void {
	const line = layout.lines[span.lineIndex]!;
	const { x, width } = measureTextWordSpan({ ctx, layout, span });
	const start = lineStartX({
		textAlign: layout.textAlign,
		lineWidth: layout.lineMetrics[span.lineIndex]!.width,
	});
	const previousAlign = ctx.textAlign;
	ctx.textAlign = "left";
	const prefix = line.slice(0, span.start);
	if (prefix) ctx.fillText(prefix, start, lineY);
	ctx.fillStyle = color;
	ctx.fillText(line.slice(span.start, span.end), x, lineY);
	ctx.fillStyle = textColor;
	const suffix = line.slice(span.end);
	if (suffix) ctx.fillText(suffix, x + width, lineY);
	ctx.textAlign = previousAlign;
}

export function strokeMeasuredTextLayout({
	ctx,
	layout,
	strokeColor,
	strokeWidth,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	strokeColor: string;
	strokeWidth: number;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.strokeStyle = strokeColor;
	ctx.lineWidth = strokeWidth;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.strokeText(layout.lines[index], 0, lineY);
	}
}
