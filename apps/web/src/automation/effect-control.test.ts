/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { VideoElement } from "@/timeline";

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
const { buildEffectControlPatch, listEffectCatalog } =
	await import("./effect-control");

function buildElement(): VideoElement {
	return {
		id: "clip-1",
		name: "clip.mp4",
		type: "video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 240000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

describe("effect control", () => {
	test("creates and updates a stable-ID effect with validated params", () => {
		const element = buildElement();
		const created = buildEffectControlPatch({
			element,
			operation: {
				kind: "upsert_effect",
				trackId: "main",
				elementId: element.id,
				effectId: "blur-1",
				effectType: "blur",
				params: { intensity: 37 },
			},
		});

		expect(created.effects?.[0]).toEqual({
			id: "blur-1",
			type: "blur",
			params: { intensity: 37 },
			enabled: true,
		});
		const updated = buildEffectControlPatch({
			element: { ...element, effects: created.effects },
			operation: {
				kind: "upsert_effect",
				trackId: "main",
				elementId: element.id,
				effectId: "blur-1",
				effectType: "blur",
				enabled: false,
			},
		});
		expect(updated.effects?.[0]?.enabled).toBe(false);
	});

	test("rejects unknown effect parameters", () => {
		const element = buildElement();
		expect(() =>
			buildEffectControlPatch({
				element,
				operation: {
					kind: "upsert_effect",
					trackId: "main",
					elementId: element.id,
					effectId: "blur-1",
					effectType: "blur",
					params: { missing: 5 },
				},
			}),
		).toThrow("effect blur has no parameter missing");
	});

	test("removes effect parameter automation with the effect", () => {
		const element: VideoElement = {
			...buildElement(),
			effects: [
				{
					id: "blur-1",
					type: "blur",
					params: { intensity: 15 },
					enabled: true,
				},
			],
			animations: {
				"effects.blur-1.params.intensity": {
					keys: [
						{
							id: "key-1",
							time: mediaTime({ ticks: 0 }),
							value: 15,
							segmentToNext: "linear",
							tangentMode: "auto",
						},
					],
				},
			},
		};
		const patch = buildEffectControlPatch({
			element,
			operation: {
				kind: "remove_effect",
				trackId: "main",
				elementId: element.id,
				effectId: "blur-1",
			},
		});

		expect(patch.effects).toEqual([]);
		expect(patch.animations).toBeUndefined();
	});

	test("lists registered parameter metadata", () => {
		expect(listEffectCatalog()).toContainEqual({
			effectType: "blur",
			name: "Blur",
			keywords: ["blur", "soft", "defocus"],
			params: [
				{
					key: "intensity",
					label: "Intensity",
					type: "number",
					default: 15,
					keyframable: true,
					min: 0,
					max: 100,
					step: 1,
				},
			],
		});
	});
});
