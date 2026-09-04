import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import {
	measureCaptionLocalLayout,
	placeCaptionGeometry,
	wrapTextToWidth,
	type CaptionGeometry,
	type CaptionLocalLayout,
	type Rect,
} from "@/text/caption-layout";
import type { TextCanvasContext } from "@/text/layout";
import { DEFAULTS } from "@/timeline/defaults";
import { mediaTimeFromSeconds } from "@/wasm";
import type { CreateTextElement } from "@/timeline";
import type { TextBackground } from "@/text/background";
import type { TextHighlight } from "@/text/highlight";
import type {
	TextAlign,
	TextDecoration,
	TextFontStyle,
	TextFontWeight,
	TextLayoutParams,
} from "@/text/primitives";
import { applyCaptionStylePreset } from "./caption-presets";
import type { SubtitleCue, SubtitleStyleOverrides } from "./types";

const SUBTITLE_MAX_WIDTH_RATIO = 0.8;
const SUBTITLE_BOTTOM_MARGIN_RATIO = 0.05;
const SUBTITLE_FONT_SIZE = 5;
const MEASUREMENT_CANVAS_SIZE = 4096;

/** A large scratch context; captions are measured, never drawn, on it. */
export function createCaptionMeasurementContext(): CanvasRenderingContext2D | null {
	const canvas = document.createElement("canvas");
	canvas.width = MEASUREMENT_CANVAS_SIZE;
	canvas.height = MEASUREMENT_CANVAS_SIZE;
	return canvas.getContext("2d");
}

/** The font a caption style resolves to, before anything is measured. */
export function resolveSubtitleFontParams({
	style,
}: {
	style: SubtitleStyleOverrides | undefined;
}): { fontFamily: string; fontWeight: TextFontWeight; fontStyle: TextFontStyle } {
	const resolved = resolveSubtitleStyle({ style });
	return {
		fontFamily: resolved.fontFamily,
		fontWeight: resolved.fontWeight,
		fontStyle: resolved.fontStyle,
	};
}

type ResolvedSubtitleStyle = {
	fontFamily: string;
	fontSize: number;
	color: string;
	textAlign: TextAlign;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textDecoration: TextDecoration;
	letterSpacing: number;
	lineHeight: number;
	background: TextBackground;
	highlight: TextHighlight;
	placement: NonNullable<SubtitleStyleOverrides["placement"]>;
};

function resolveSubtitleStyle({
	style: requested,
}: {
	style: SubtitleStyleOverrides | undefined;
}): ResolvedSubtitleStyle {
	const style = applyCaptionStylePreset(requested);
	const fontSize =
		style?.fontSizeRatioOfPlayHeight != null
			? style.fontSizeRatioOfPlayHeight * FONT_SIZE_SCALE_REFERENCE
			: (style?.fontSize ?? SUBTITLE_FONT_SIZE);

	return {
		fontFamily: style?.fontFamily ?? "Arial",
		fontSize,
		color: style?.color ?? "#ffffff",
		textAlign: style?.textAlign ?? "center",
		fontWeight: style?.fontWeight ?? "bold",
		fontStyle: style?.fontStyle ?? "normal",
		textDecoration: style?.textDecoration ?? "none",
		letterSpacing: style?.letterSpacing ?? DEFAULTS.text.letterSpacing,
		lineHeight: style?.lineHeight ?? DEFAULTS.text.lineHeight,
		background: {
			...DEFAULTS.text.background,
			enabled: false,
			...(style?.background ?? {}),
		},
		highlight: {
			enabled: style?.highlight?.enabled ?? DEFAULTS.text.highlight.enabled,
			color: style?.highlight?.color ?? DEFAULTS.text.highlight.color,
		},
		placement: {
			verticalAlign: style?.placement?.verticalAlign ?? "bottom",
			marginLeftRatio: style?.placement?.marginLeftRatio,
			marginRightRatio: style?.placement?.marginRightRatio,
			marginVerticalRatio: style?.placement?.marginVerticalRatio,
		},
	};
}

function resolveHorizontalMargins({
	placement,
}: {
	placement: ResolvedSubtitleStyle["placement"];
}): { leftRatio: number; rightRatio: number } {
	const leftRatio = placement.marginLeftRatio ?? 0;
	const rightRatio = placement.marginRightRatio ?? 0;
	if (leftRatio > 0 || rightRatio > 0) return { leftRatio, rightRatio };
	const sideRatio = (1 - SUBTITLE_MAX_WIDTH_RATIO) / 2;
	return { leftRatio: sideRatio, rightRatio: sideRatio };
}

function resolveTargetWidth({
	canvasWidth,
	placement,
}: {
	canvasWidth: number;
	placement: ResolvedSubtitleStyle["placement"];
}): number {
	const { leftRatio, rightRatio } = resolveHorizontalMargins({ placement });
	return Math.max(0, canvasWidth * (1 - leftRatio - rightRatio));
}

/**
 * The area the caption's own placement policy keeps it inside: the horizontal
 * margins it wraps within and the vertical margin it sits away from the edge,
 * mirrored to the opposite edge. Geometry evidence reports intersections with
 * this box rather than with a zone the browser would have to invent.
 */
function resolveSafeZone({
	canvasSize,
	placement,
}: {
	canvasSize: { width: number; height: number };
	placement: ResolvedSubtitleStyle["placement"];
}): Rect {
	const { leftRatio, rightRatio } = resolveHorizontalMargins({ placement });
	const verticalRatio =
		placement.marginVerticalRatio ?? SUBTITLE_BOTTOM_MARGIN_RATIO;
	return {
		left: canvasSize.width * leftRatio,
		top: canvasSize.height * verticalRatio,
		width: Math.max(0, canvasSize.width * (1 - leftRatio - rightRatio)),
		height: Math.max(0, canvasSize.height * (1 - 2 * verticalRatio)),
	};
}

function resolvePositionX({
	canvasWidth,
	textAlign,
	placement,
	visualRect,
}: {
	canvasWidth: number;
	textAlign: TextAlign;
	placement: ResolvedSubtitleStyle["placement"];
	visualRect: { left: number; width: number };
}): number {
	const leftMargin = canvasWidth * (placement.marginLeftRatio ?? 0);
	const rightMargin = canvasWidth * (placement.marginRightRatio ?? 0);
	const canvasCenterX = canvasWidth / 2;

	if (textAlign === "left") {
		return leftMargin - visualRect.left - canvasCenterX;
	}

	if (textAlign === "right") {
		return (
			canvasWidth -
			rightMargin -
			(visualRect.left + visualRect.width) -
			canvasCenterX
		);
	}

	const availableWidth = canvasWidth - leftMargin - rightMargin;
	const targetCenterX = leftMargin + availableWidth / 2;
	return (
		targetCenterX - (visualRect.left + visualRect.width / 2) - canvasCenterX
	);
}

function resolvePositionY({
	canvasHeight,
	placement,
	visualRect,
}: {
	canvasHeight: number;
	placement: ResolvedSubtitleStyle["placement"];
	visualRect: { top: number; height: number };
}): number {
	const margin =
		canvasHeight *
		(placement.marginVerticalRatio ?? SUBTITLE_BOTTOM_MARGIN_RATIO);
	const canvasCenterY = canvasHeight / 2;

	if (placement.verticalAlign === "top") {
		return margin - visualRect.top - canvasCenterY;
	}

	if (placement.verticalAlign === "middle") {
		const targetCenterY = canvasHeight / 2;
		return (
			targetCenterY - (visualRect.top + visualRect.height / 2) - canvasCenterY
		);
	}

	return (
		canvasHeight - margin - (visualRect.top + visualRect.height) - canvasCenterY
	);
}

function buildElement({
	index,
	caption,
	style,
	content,
	positionX,
	positionY,
}: {
	index: number;
	caption: SubtitleCue;
	style: ResolvedSubtitleStyle;
	content: string;
	positionX: number;
	positionY: number;
}): CreateTextElement {
	return {
		...DEFAULTS.text.element,
		name: `Caption ${index + 1}`,
		duration: mediaTimeFromSeconds({ seconds: caption.duration }),
		startTime: mediaTimeFromSeconds({ seconds: caption.startTime }),
		params: {
			...DEFAULTS.text.element.params,
			content,
			fontSize: style.fontSize,
			fontFamily: style.fontFamily,
			color: style.color,
			textAlign: style.textAlign,
			fontWeight: style.fontWeight,
			fontStyle: style.fontStyle,
			textDecoration: style.textDecoration,
			letterSpacing: style.letterSpacing,
			lineHeight: style.lineHeight,
			"background.enabled": style.background.enabled,
			"background.color": style.background.color,
			"background.perLine":
				style.background.perLine ?? DEFAULTS.text.background.perLine,
			"background.cornerRadius":
				style.background.cornerRadius ?? DEFAULTS.text.background.cornerRadius,
			"background.paddingX":
				style.background.paddingX ?? DEFAULTS.text.background.paddingX,
			"background.paddingY":
				style.background.paddingY ?? DEFAULTS.text.background.paddingY,
			"background.offsetX":
				style.background.offsetX ?? DEFAULTS.text.background.offsetX,
			"background.offsetY":
				style.background.offsetY ?? DEFAULTS.text.background.offsetY,
			"highlight.enabled": style.highlight.enabled,
			"highlight.color": style.highlight.color,
			...(caption.speaker ? { "caption.speaker": caption.speaker } : {}),
			"transform.positionX": positionX,
			"transform.positionY": positionY,
		},
	};
}

export interface MeasuredSubtitleCaption {
	element: CreateTextElement;
	/** The font the element will be drawn with, in text-param form. */
	fontParams: {
		fontFamily: string;
		fontWeight: TextFontWeight;
		fontStyle: TextFontStyle;
	};
	local: CaptionLocalLayout;
	geometry: CaptionGeometry;
}

/**
 * Wraps, measures, and places one caption through the renderer's own
 * measurement function, returning the element together with the geometry the
 * renderer will reproduce when it draws that element.
 */
export function measureSubtitleCaption({
	index,
	caption,
	canvasSize,
	ctx,
}: {
	index: number;
	caption: SubtitleCue;
	canvasSize: { width: number; height: number };
	ctx: TextCanvasContext;
}): MeasuredSubtitleCaption {
	const style = resolveSubtitleStyle({ style: caption.style });
	const text: TextLayoutParams = {
		content: caption.text,
		fontSize: style.fontSize,
		fontFamily: style.fontFamily,
		fontWeight: style.fontWeight,
		fontStyle: style.fontStyle,
		textAlign: style.textAlign,
		textDecoration: style.textDecoration,
		letterSpacing: style.letterSpacing,
		lineHeight: style.lineHeight,
	};
	const content = wrapTextToWidth({
		text,
		canvasHeight: canvasSize.height,
		maxWidth: resolveTargetWidth({
			canvasWidth: canvasSize.width,
			placement: style.placement,
		}),
		ctx,
	});
	const local = measureCaptionLocalLayout({
		text: { ...text, content },
		background: style.background,
		canvasHeight: canvasSize.height,
		ctx,
	});
	const positionX = resolvePositionX({
		canvasWidth: canvasSize.width,
		textAlign: style.textAlign,
		placement: style.placement,
		visualRect: local.visual,
	});
	const positionY = resolvePositionY({
		canvasHeight: canvasSize.height,
		placement: style.placement,
		visualRect: local.visual,
	});
	const geometry = placeCaptionGeometry({
		local,
		canvasSize,
		position: { x: positionX, y: positionY },
		safeZone: resolveSafeZone({ canvasSize, placement: style.placement }),
	});
	return {
		element: buildElement({
			index,
			caption,
			style,
			content,
			positionX,
			positionY,
		}),
		fontParams: {
			fontFamily: style.fontFamily,
			fontWeight: style.fontWeight,
			fontStyle: style.fontStyle,
		},
		local,
		geometry,
	};
}

export function buildSubtitleTextElement({
	index,
	caption,
	canvasSize,
	requireMeasurement = false,
}: {
	index: number;
	caption: SubtitleCue;
	canvasSize: { width: number; height: number };
	requireMeasurement?: boolean;
}): CreateTextElement {
	const ctx = createCaptionMeasurementContext();
	if (requireMeasurement && !ctx) {
		throw new Error("caption layout requires a Canvas 2D measurement context");
	}
	if (ctx) {
		return measureSubtitleCaption({ index, caption, canvasSize, ctx }).element;
	}
	// Without a measurement context the caption keeps its source text and the
	// default placement; callers that need exact layout pass requireMeasurement.
	const style = resolveSubtitleStyle({ style: caption.style });
	return buildElement({
		index,
		caption,
		style,
		content: caption.text,
		positionX: 0,
		positionY: 0,
	});
}
