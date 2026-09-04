import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import type { SubtitleCue, SubtitleStyleOverrides } from "./types";

/**
 * One feature the export could not carry into the target format, with the
 * number of cues it affected. A structured report replaces free-text
 * warnings so a caller can decide per feature whether the loss matters.
 */
export interface SubtitleExportLoss {
	feature: string;
	cueCount: number;
	reason: string;
}

export interface SubtitleLossReport {
	format: "ass";
	supported: string[];
	dropped: SubtitleExportLoss[];
}

/** The style features an ASS document round-trips through `parseAss`. */
export const ASS_SUPPORTED_FEATURES = [
	"fontFamily",
	"fontSize",
	"color",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"textAlign",
	"verticalAlign",
	"margins",
	"backgroundColor",
] as const;

const ASS_STYLE_FORMAT = [
	"Name",
	"Fontname",
	"Fontsize",
	"PrimaryColour",
	"SecondaryColour",
	"OutlineColour",
	"BackColour",
	"Bold",
	"Italic",
	"Underline",
	"StrikeOut",
	"ScaleX",
	"ScaleY",
	"Spacing",
	"Angle",
	"BorderStyle",
	"Outline",
	"Shadow",
	"Alignment",
	"MarginL",
	"MarginR",
	"MarginV",
	"Encoding",
] as const;

const ALIGNMENT_CODES: Record<string, Record<string, number>> = {
	bottom: { left: 1, center: 2, right: 3 },
	middle: { left: 4, center: 5, right: 6 },
	top: { left: 7, center: 8, right: 9 },
};

interface AssStyleRow {
	name: string;
	fields: string[];
}

/**
 * Serializes captions to an ASS (SubStation Alpha v4+) document sized to the
 * project canvas. Each distinct mappable style becomes one `Style:` row;
 * anything the format cannot express is counted in the loss report rather
 * than silently dropped.
 */
export function serializeAss({
	captions,
	playRes,
}: {
	captions: SubtitleCue[];
	playRes: { width: number; height: number };
}): { content: string; lossReport: SubtitleLossReport } {
	const losses = new Map<string, SubtitleExportLoss>();
	const countLoss = (feature: string, reason: string) => {
		const entry = losses.get(feature) ?? { feature, cueCount: 0, reason };
		entry.cueCount += 1;
		losses.set(feature, entry);
	};
	const styles: AssStyleRow[] = [];
	const styleNames = new Map<string, string>();
	const events = captions.map((caption) => {
		const style = caption.style ?? {};
		reportUnmappable(style, countLoss);
		const fields = mapStyleFields({ style, playRes });
		const key = fields.join(",");
		let name = styleNames.get(key);
		if (!name) {
			name = styles.length === 0 ? "Default" : `Style${styles.length + 1}`;
			styleNames.set(key, name);
			styles.push({ name, fields });
		}
		const start = formatAssTimestamp(caption.startTime);
		const end = formatAssTimestamp(caption.startTime + caption.duration);
		const text = caption.text
			.trim()
			.replace(/\r\n?/g, "\n")
			.replace(/\n/g, "\\N");
		return `Dialogue: 0,${start},${end},${name},,0,0,0,,${text}`;
	});
	const lines = [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${Math.round(playRes.width)}`,
		`PlayResY: ${Math.round(playRes.height)}`,
		"WrapStyle: 0",
		"ScaledBorderAndShadow: yes",
		"",
		"[V4+ Styles]",
		`Format: ${ASS_STYLE_FORMAT.join(", ")}`,
		...styles.map((style) => `Style: ${[style.name, ...style.fields].join(",")}`),
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		...events,
	];
	return {
		content: `${lines.join("\n")}\n`,
		lossReport: {
			format: "ass",
			supported: [...ASS_SUPPORTED_FEATURES],
			dropped: [...losses.values()].sort((left, right) =>
				left.feature.localeCompare(right.feature),
			),
		},
	};
}

function mapStyleFields({
	style,
	playRes,
}: {
	style: SubtitleStyleOverrides;
	playRes: { width: number; height: number };
}): string[] {
	const fontSizeRatio =
		style.fontSizeRatioOfPlayHeight ??
		(style.fontSize !== undefined
			? style.fontSize / FONT_SIZE_SCALE_REFERENCE
			: undefined);
	const primary = toAssColor(style.color ?? "#ffffff");
	const background =
		style.background?.enabled && style.background.color !== "transparent"
			? toAssColor(style.background.color)
			: null;
	const verticalAlign = style.placement?.verticalAlign ?? "bottom";
	const textAlign = style.textAlign ?? "center";
	const alignment = ALIGNMENT_CODES[verticalAlign]?.[textAlign] ?? 2;
	const margin = (ratio: number | undefined, extent: number) =>
		ratio === undefined ? 0 : Math.round(ratio * extent);
	return [
		style.fontFamily ?? "Arial",
		String(
			fontSizeRatio === undefined
				? Math.round((5 / FONT_SIZE_SCALE_REFERENCE) * playRes.height)
				: Math.round(fontSizeRatio * playRes.height),
		),
		primary,
		primary,
		"&H00000000",
		background ?? "&H00000000",
		style.fontWeight === "bold" ? "-1" : "0",
		style.fontStyle === "italic" ? "-1" : "0",
		style.textDecoration === "underline" ? "-1" : "0",
		style.textDecoration === "line-through" ? "-1" : "0",
		"100",
		"100",
		String(style.letterSpacing ?? 0),
		"0",
		background ? "3" : "1",
		"0",
		"0",
		String(alignment),
		String(margin(style.placement?.marginLeftRatio, playRes.width)),
		String(margin(style.placement?.marginRightRatio, playRes.width)),
		String(margin(style.placement?.marginVerticalRatio, playRes.height)),
		"1",
	];
}

function reportUnmappable(
	style: SubtitleStyleOverrides,
	countLoss: (feature: string, reason: string) => void,
): void {
	if (style.lineHeight !== undefined) {
		countLoss("lineHeight", "ASS styles have no line-height field");
	}
	const background = style.background;
	if (background?.enabled) {
		if (background.cornerRadius) {
			countLoss(
				"background.cornerRadius",
				"ASS opaque boxes (BorderStyle 3) are rectangular",
			);
		}
		if (background.paddingX !== undefined || background.paddingY !== undefined) {
			countLoss(
				"background.padding",
				"ASS opaque boxes take their size from the text, not from padding",
			);
		}
		if (background.offsetX || background.offsetY) {
			countLoss("background.offset", "ASS opaque boxes cannot be offset");
		}
	}
}

/** CSS `#rrggbb`, `#rrggbbaa`, or `rgba()` to ASS `&HAABBGGRR`. */
export function toAssColor(input: string): string {
	const hex = input.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
	if (hex) {
		const rgb = hex[1]!.toLowerCase();
		const alpha = hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1;
		return assColor({
			red: Number.parseInt(rgb.slice(0, 2), 16),
			green: Number.parseInt(rgb.slice(2, 4), 16),
			blue: Number.parseInt(rgb.slice(4, 6), 16),
			alpha,
		});
	}
	const rgba = input
		.trim()
		.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
	if (rgba) {
		return assColor({
			red: Number(rgba[1]),
			green: Number(rgba[2]),
			blue: Number(rgba[3]),
			alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
		});
	}
	throw new Error(`unsupported colour for ASS export: ${input}`);
}

function assColor({
	red,
	green,
	blue,
	alpha,
}: {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}): string {
	const byte = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0")
			.toUpperCase();
	return `&H${byte((1 - alpha) * 255)}${byte(blue)}${byte(green)}${byte(red)}`;
}

function formatAssTimestamp(seconds: number): string {
	const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
	const hours = Math.floor(totalCentiseconds / 360_000);
	const minutes = Math.floor((totalCentiseconds % 360_000) / 6_000);
	const wholeSeconds = Math.floor((totalCentiseconds % 6_000) / 100);
	const centiseconds = totalCentiseconds % 100;
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}
