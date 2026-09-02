/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { EffectElement, GraphicElement } from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => null },
}));

const { mediaTime } = await import("@/wasm");
const { listVisualAssetCatalog, searchAutomationStickers } =
	await import("./visual-asset-catalog");
const { buildDefinitionParamPatch, buildVisualInsertionCommand } =
	await import("./visual-element-control");

describe("visual asset automation", () => {
	test("publishes graphic, mask, and sticker catalogs", () => {
		const catalog = listVisualAssetCatalog();
		expect(catalog.graphics.map((entry) => entry.definitionId)).toEqual([
			"rectangle",
			"ellipse",
			"polygon",
			"star",
		]);
		expect(catalog.masks.map((entry) => entry.maskType)).toEqual([
			"split",
			"cinematic-bars",
			"rectangle",
			"ellipse",
			"heart",
			"diamond",
			"star",
			"text",
			"freeform",
		]);
		expect(catalog.stickerCategories).toEqual([
			{ id: "all", name: "All" },
			{ id: "flags", name: "Flags" },
			{ id: "shapes", name: "Shapes" },
		]);
	});

	test("searches stable shape sticker IDs", async () => {
		const result = await searchAutomationStickers({
			query: "circle",
			category: "shapes",
			limit: 10,
		});
		expect(result.items).toContainEqual(
			expect.objectContaining({
				stickerId: "shapes:ellipse",
				provider: "shapes",
				name: "Ellipse",
			}),
		);
	});

	test("validates graphic and adjustment-layer parameters", () => {
		const graphic: GraphicElement = {
			id: "graphic-1",
			name: "Rectangle",
			type: "graphic",
			definitionId: "rectangle",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 240000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: { fill: "#ffffff", opacity: 1 },
		};
		const effect: EffectElement = {
			id: "grade-1",
			name: "Color grade",
			type: "effect",
			effectType: "color-grade",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 240000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};

		expect(
			buildDefinitionParamPatch({
				element: graphic,
				requested: { fill: "#ff0000", opacity: 0.5 },
			}),
		).toMatchObject({ params: { fill: "#ff0000", opacity: 0.5 } });
		expect(
			buildDefinitionParamPatch({
				element: effect,
				requested: { contrast: 12, highlights: -35 },
			}),
		).toMatchObject({ params: { contrast: 12, highlights: -35 } });
		expect(() =>
			buildDefinitionParamPatch({
				element: effect,
				requested: { missing: 1 },
			}),
		).toThrow("unsupported parameter: missing");
	});

	test("builds native insertion commands and rejects invalid IDs", () => {
		expect(() =>
			buildVisualInsertionCommand({
				operation: {
					kind: "insert_graphic",
					definitionId: "rectangle",
					startTime: mediaTime({ ticks: 0 }),
					duration: mediaTime({ ticks: 120000 }),
					params: { fill: "#ff0000" },
				},
			}),
		).not.toThrow();
		expect(() =>
			buildVisualInsertionCommand({
				operation: {
					kind: "insert_adjustment_layer",
					effectType: "missing",
					startTime: mediaTime({ ticks: 0 }),
					duration: mediaTime({ ticks: 120000 }),
				},
			}),
		).toThrow("Unknown effect");
	});
});
