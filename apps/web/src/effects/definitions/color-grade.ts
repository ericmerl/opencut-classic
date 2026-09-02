import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const COLOR_GRADE_SHADER = "color-grade";

export const SIMPLE_MEDIA_REALISTIC_PRESET = {
	temperature: -3,
	tint: 2,
	saturation: -6,
	exposure: -3,
	contrast: 12,
	highlights: -35,
	shadows: 18,
	fade: 6,
} as const;

const ADJUSTMENT_MIN = -100;
const ADJUSTMENT_MAX = 100;

function readAdjustment({
	effectParams,
	key,
}: {
	effectParams: ParamValues;
	key: keyof typeof SIMPLE_MEDIA_REALISTIC_PRESET;
}): number {
	const raw = effectParams[key];
	const parsed = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	if (!Number.isFinite(parsed)) return 0;
	return Math.min(ADJUSTMENT_MAX, Math.max(ADJUSTMENT_MIN, parsed));
}

export function buildColorGradePass({
	effectParams,
}: {
	effectParams: ParamValues;
}): EffectPass {
	return {
		shader: COLOR_GRADE_SHADER,
		uniforms: {
			u_temperature: readAdjustment({ effectParams, key: "temperature" }),
			u_tint: readAdjustment({ effectParams, key: "tint" }),
			u_saturation: readAdjustment({ effectParams, key: "saturation" }),
			u_exposure: readAdjustment({ effectParams, key: "exposure" }),
			u_contrast: readAdjustment({ effectParams, key: "contrast" }),
			u_highlights: readAdjustment({ effectParams, key: "highlights" }),
			u_shadows: readAdjustment({ effectParams, key: "shadows" }),
			u_fade: readAdjustment({ effectParams, key: "fade" }),
		},
	};
}

const adjustmentParams: EffectDefinition["params"] = [
	["temperature", "Temperature"],
	["tint", "Tint"],
	["saturation", "Saturation"],
	["exposure", "Exposure"],
	["contrast", "Contrast"],
	["highlights", "Highlights"],
	["shadows", "Shadows"],
	["fade", "Fade"],
].map(([key, label]) => ({
	key,
	label,
	type: "number" as const,
	default: 0,
	min: ADJUSTMENT_MIN,
	max: ADJUSTMENT_MAX,
	step: 1,
}));

export const colorGradeEffectDefinition: EffectDefinition = {
	type: "color-grade",
	name: "Color Grade",
	keywords: ["color", "grade", "adjustment", "temperature", "exposure"],
	params: adjustmentParams,
	presets: [
		{
			id: "simple-media-realistic",
			name: "Simple Media Realistic",
			params: SIMPLE_MEDIA_REALISTIC_PRESET,
		},
	],
	renderer: {
		passes: [
			{
				shader: COLOR_GRADE_SHADER,
				uniforms: ({ effectParams }) =>
					buildColorGradePass({ effectParams }).uniforms,
			},
		],
	},
};
