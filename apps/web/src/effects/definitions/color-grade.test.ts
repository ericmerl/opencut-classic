import { describe, expect, test } from "bun:test";
import {
	buildColorGradePass,
	COLOR_GRADE_SHADER,
	SIMPLE_MEDIA_REALISTIC_PRESET,
} from "./color-grade";

describe("color grade effect", () => {
	test("maps the complete realistic preset to renderer uniforms", () => {
		expect(
			buildColorGradePass({ effectParams: SIMPLE_MEDIA_REALISTIC_PRESET }),
		).toEqual({
			shader: COLOR_GRADE_SHADER,
			uniforms: {
				u_temperature: -3,
				u_tint: 2,
				u_saturation: -6,
				u_exposure: -3,
				u_contrast: 12,
				u_highlights: -35,
				u_shadows: 18,
				u_fade: 6,
			},
		});
	});

	test("uses neutral values for missing or invalid adjustments", () => {
		const pass = buildColorGradePass({
			effectParams: { temperature: "invalid", contrast: 12 },
		});
		expect(pass.uniforms).toMatchObject({
			u_temperature: 0,
			u_tint: 0,
			u_contrast: 12,
			u_fade: 0,
		});
	});

	test("clamps renderer inputs to the published control range", () => {
		const pass = buildColorGradePass({
			effectParams: { highlights: -500, shadows: 500 },
		});
		expect(pass.uniforms.u_highlights).toBe(-100);
		expect(pass.uniforms.u_shadows).toBe(100);
	});
});
