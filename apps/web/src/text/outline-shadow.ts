/**
 * Text outline and drop shadow. Widths, offsets, and blur are fractions of the
 * rendered font size so the treatment keeps its weight across canvas sizes
 * and font sizes; Rust owns the defaults and bounds (`edit-plan` text params).
 */
export interface TextOutline {
	enabled: boolean;
	color: string;
	/** Stroke width as a fraction of the font size. */
	width: number;
}

export interface TextShadow {
	enabled: boolean;
	color: string;
	/** Horizontal offset as a fraction of the font size; positive is right. */
	offsetX: number;
	/** Vertical offset as a fraction of the font size; positive is down. */
	offsetY: number;
	/** Blur radius as a fraction of the font size. */
	blur: number;
}

/** The outline in canvas pixels for one rendered font size. */
export interface ResolvedTextOutline {
	enabled: boolean;
	color: string;
	widthPx: number;
}

/** The shadow in canvas pixels for one rendered font size. */
export interface ResolvedTextShadow {
	enabled: boolean;
	color: string;
	offsetXPx: number;
	offsetYPx: number;
	blurPx: number;
}

export interface TextDecorationExtents {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export function resolveTextOutline({
	outline,
	scaledFontSize,
}: {
	outline: TextOutline;
	scaledFontSize: number;
}): ResolvedTextOutline {
	return {
		enabled: outline.enabled,
		color: outline.color,
		widthPx: outline.enabled ? outline.width * scaledFontSize : 0,
	};
}

export function resolveTextShadow({
	shadow,
	scaledFontSize,
}: {
	shadow: TextShadow;
	scaledFontSize: number;
}): ResolvedTextShadow {
	return {
		enabled: shadow.enabled,
		color: shadow.color,
		offsetXPx: shadow.enabled ? shadow.offsetX * scaledFontSize : 0,
		offsetYPx: shadow.enabled ? shadow.offsetY * scaledFontSize : 0,
		blurPx: shadow.enabled ? shadow.blur * scaledFontSize : 0,
	};
}

/**
 * How far past the glyph boxes the outline and shadow reach on each side, in
 * pixels. The stroke is centred on the glyph edge, so half of it lies outside;
 * the shadow is cast by the stroked glyphs, so it carries that half width too.
 */
export function textDecorationExtents({
	outline,
	shadow,
}: {
	outline: ResolvedTextOutline;
	shadow: ResolvedTextShadow;
}): TextDecorationExtents {
	const half = outline.enabled ? outline.widthPx / 2 : 0;
	if (!shadow.enabled) {
		return { left: half, top: half, right: half, bottom: half };
	}
	const reach = (offset: number) =>
		Math.max(half, half + shadow.blurPx + offset);
	return {
		left: reach(-shadow.offsetXPx),
		right: reach(shadow.offsetXPx),
		top: reach(-shadow.offsetYPx),
		bottom: reach(shadow.offsetYPx),
	};
}
