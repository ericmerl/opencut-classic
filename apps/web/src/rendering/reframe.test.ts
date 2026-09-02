/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
	computeReframeGeometry,
	DEFAULT_REFRAME,
	type ReframeConfig,
} from "./reframe";

const transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

describe("reframe geometry", () => {
	test("contains a landscape source inside a portrait canvas", () => {
		const geometry = computeReframeGeometry({
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			transform,
			reframe: DEFAULT_REFRAME,
		});

		expect(geometry).toMatchObject({
			centerX: 540,
			centerY: 960,
			width: 1080,
			height: 607.5,
			sourceRect: { x: 0, y: 0, width: 1, height: 1 },
		});
	});

	test("covers the canvas by cropping around the focal point", () => {
		const geometry = computeReframeGeometry({
			canvasWidth: 1080,
			canvasHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			transform,
			reframe: config({ mode: "cover", focalPoint: { x: 1, y: 0.5 } }),
		});

		expect(geometry.width).toBe(1080);
		expect(geometry.height).toBe(1920);
		expect(geometry.sourceRect.width).toBeCloseTo(0.31640625);
		expect(geometry.sourceRect.x).toBeCloseTo(0.68359375);
	});

	test("places contained content inside a custom picture-in-picture target", () => {
		const geometry = computeReframeGeometry({
			canvasWidth: 1000,
			canvasHeight: 1000,
			sourceWidth: 1920,
			sourceHeight: 1080,
			transform: {
				...transform,
				position: { x: 10, y: 20 },
				scaleX: 0.5,
				scaleY: 0.5,
			},
			reframe: config({
				targetRect: { x: 0.6, y: 0.05, width: 0.35, height: 0.3 },
			}),
		});

		expect(geometry.centerX).toBe(785);
		expect(geometry.centerY).toBe(220);
		expect(geometry.width).toBe(175);
		expect(geometry.height).toBeCloseTo(98.4375);
	});

	test("applies an explicit source crop before cover", () => {
		const geometry = computeReframeGeometry({
			canvasWidth: 1000,
			canvasHeight: 1000,
			sourceWidth: 2000,
			sourceHeight: 1000,
			transform,
			reframe: config({
				mode: "cover",
				crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
			}),
		});

		expect(geometry.sourceRect).toEqual({
			x: 0.25,
			y: 0,
			width: 0.5,
			height: 1,
		});
	});
});

function config(overrides: Partial<ReframeConfig>): ReframeConfig {
	return {
		...DEFAULT_REFRAME,
		...overrides,
		crop: overrides.crop ?? DEFAULT_REFRAME.crop,
		focalPoint: overrides.focalPoint ?? DEFAULT_REFRAME.focalPoint,
		targetRect: overrides.targetRect ?? DEFAULT_REFRAME.targetRect,
	};
}
