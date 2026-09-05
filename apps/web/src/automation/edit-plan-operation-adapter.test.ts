/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { AutomationEditOperation } from "./types";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));

const { mediaTime } = await import("@/wasm");
const { toAutomationResolvedOperation, toNativeEditOperations } =
	await import("./edit-plan-operation-adapter");

const tick = (ticks: number) => mediaTime({ ticks });
const ref = { trackId: "video-track", elementId: "video-element" };

describe("edit-plan operation WASM adapter", () => {
	test("translates every public operation family through the generated union", () => {
		const operations = allOperations();
		const native = toNativeEditOperations(operations);

		expect(native).toHaveLength(51);
		expect(new Set(native.map((operation) => operation.kind)).size).toBe(51);
		expect(native.map((operation) => operation.kind)).toEqual(
			operations.map((operation) => operation.kind),
		);
	});

	test("materializes defaults that are semantic in the native evaluator", () => {
		const native = toNativeEditOperations([
			{ kind: "delete", ...ref },
			{ kind: "duplicate_elements", elements: [ref] },
			{
				kind: "move",
				...ref,
				startTime: tick(2),
			},
			{
				kind: "trim",
				...ref,
				trimStart: tick(1),
				trimEnd: tick(2),
			},
			{ kind: "split", ...ref, splitTime: tick(3) },
		]);

		expect(native).toEqual([
			expect.objectContaining({ ripple: false, relationshipScope: "all" }),
			expect.objectContaining({ relationshipScope: "all" }),
			expect.objectContaining({ relationshipScope: "all" }),
			expect.objectContaining({ ripple: false }),
			expect.objectContaining({ ripple: false }),
		]);
	});

	test("converts every resolved native operation back to branded browser times", () => {
		const native = toNativeEditOperations(allOperations());
		const browser = native.map(toAutomationResolvedOperation);

		expect(browser).toHaveLength(51);
		expect(browser.map((operation) => operation.kind)).toEqual(
			native.map((operation) => operation.kind),
		);
		expect(
			browser.find((operation) => operation.kind === "duck_audio"),
		).toEqual(
			expect.objectContaining({
				attackDuration: tick(1),
				releaseDuration: tick(1),
				regions: [{ startTime: tick(0), duration: tick(10) }],
			}),
		);
	});

	test("preserves exact auto-track allocations for every insertion family", () => {
		const insertions = allOperations()
			.slice(0, 4)
			.map((operation, index) => ({
				...operation,
				elementId: `element-${index}`,
				autoTrackId: `track-${index}`,
				resolvedAllocations: [
					{
						role: "element-auto-track" as const,
						sourceId: `element-${index}`,
						resolvedId: `track-${index}`,
					},
				],
			}));
		const resolved = toNativeEditOperations(insertions).map(
			toAutomationResolvedOperation,
		);

		expect(resolved).toEqual(insertions);
	});

	test("round-trips receipt-pinned caption layout evidence", () => {
		const operation: AutomationEditOperation = {
			kind: "insert_captions",
			trackId: "caption-track",
			captions: [
				{
					elementId: "caption-1",
					text: "Raw caption",
					startTime: tick(0),
					duration: tick(10),
					resolvedName: "Caption 1",
					resolvedContent: "Raw\ncaption",
					resolvedParams: {
						content: "Raw\ncaption",
						fontSize: 5,
						"transform.positionY": 700,
					},
					resolvedLayoutVersion: "opencut.caption-layout.v1",
					resolvedLayoutEngine: "browser-canvas-2d",
				},
			],
		};
		const [native] = toNativeEditOperations([operation]);
		if (!native) throw new Error("missing native caption operation");

		expect(toAutomationResolvedOperation(native)).toEqual(operation);
	});
});

function allOperations(): AutomationEditOperation[] {
	return [
		{
			kind: "insert_text",
			content: "Title",
			startTime: tick(0),
			duration: tick(10),
			style: {
				outline: { color: "#abcdef", width: 2, join: "round" },
				shadow: {
					color: "#00000099",
					offsetX: 2,
					offsetY: 3,
					blur: 4,
				},
			},
		},
		{
			kind: "insert_graphic",
			definitionId: "shape",
			startTime: tick(0),
			duration: tick(10),
		},
		{
			kind: "insert_sticker",
			stickerId: "sticker",
			startTime: tick(0),
			duration: tick(10),
		},
		{
			kind: "insert_adjustment_layer",
			effectType: "grade",
			startTime: tick(0),
			duration: tick(10),
		},
		{ kind: "add_track", trackType: "video", trackId: "new-track" },
		{ kind: "set_track_state", trackId: ref.trackId, muted: true },
		{ kind: "rename_track", trackId: ref.trackId, name: "Renamed" },
		{ kind: "reorder_tracks", overlayTrackIds: [ref.trackId] },
		{ kind: "remove_track", trackId: ref.trackId, occupied: "delete" },
		{ kind: "duplicate_track", trackId: ref.trackId },
		{ kind: "set_main_track", trackId: ref.trackId },
		{ kind: "add_bookmark", time: tick(4), note: "hook" },
		{ kind: "update_bookmark", bookmarkId: "bookmark-1", clear: ["note"] },
		{ kind: "move_bookmark", bookmarkId: "bookmark-1", time: tick(8) },
		{ kind: "remove_bookmark", bookmarkId: "bookmark-1" },
		{ kind: "instantiate_asset", assetId: "asset-1", startTime: tick(0) },
		{
			kind: "set_project_settings",
			canvasSize: { width: 1080, height: 1920 },
		},
		{
			kind: "insert_captions",
			captions: [{ text: "Caption", startTime: tick(0), duration: tick(10) }],
		},
		{
			kind: "update_caption",
			...ref,
			text: "Corrected",
			style: {
				outline: { color: "#abcdef", width: 2, join: "round" },
			},
			resolvedParams: {
				"outline.color": "#abcdef",
				"outline.width": 2,
				"outline.join": "round",
			},
		},
		{ kind: "delete", ...ref },
		{ kind: "duplicate_elements", elements: [ref] },
		{
			kind: "create_compound",
			compoundId: "compound",
			elements: [ref, { trackId: ref.trackId, elementId: "second" }],
		},
		{ kind: "break_apart_compound", ...ref },
		{
			kind: "set_group",
			groupId: "group",
			elements: [ref, { ...ref, elementId: "second" }],
		},
		{ kind: "clear_group", groupId: "group" },
		{
			kind: "set_link",
			linkId: "link",
			elements: [ref, { ...ref, elementId: "second" }],
		},
		{ kind: "clear_link", linkId: "link" },
		{ kind: "move", ...ref, startTime: tick(5) },
		{ kind: "set_params", ...ref, params: { opacity: 0.5 } },
		{ kind: "set_reframe", ...ref, mode: "fit" },
		{ kind: "set_audio", ...ref, volumeDb: -3 },
		{ kind: "separate_source_audio", ...ref },
		{
			kind: "duck_audio",
			...ref,
			regions: [{ startTime: tick(0), duration: tick(10) }],
			reductionDb: -8,
			attackDuration: tick(1),
			releaseDuration: tick(1),
		},
		{ kind: "adjust_mix_gain", gainDb: -2 },
		{
			kind: "upsert_effect",
			...ref,
			effectId: "effect",
			effectType: "blur",
		},
		{ kind: "remove_effect", ...ref, effectId: "effect" },
		{ kind: "reorder_effects", ...ref, effectIds: ["effect"] },
		{
			kind: "upsert_keyframe",
			...ref,
			propertyPath: "opacity",
			time: tick(1),
			value: 0.5,
		},
		{
			kind: "remove_keyframe",
			...ref,
			propertyPath: "opacity",
			keyframeId: "keyframe",
		},
		{
			kind: "retime_keyframe",
			...ref,
			propertyPath: "opacity",
			keyframeId: "keyframe",
			time: tick(2),
		},
		{
			kind: "upsert_transition",
			trackId: ref.trackId,
			transitionId: "transition",
			fromElementId: "first",
			toElementId: "second",
			transitionType: "crossfade",
			duration: tick(3),
		},
		{
			kind: "remove_transition",
			trackId: ref.trackId,
			transitionId: "transition",
		},
		{ kind: "set_retime", ...ref, rate: 1.25 },
		{ kind: "trim", ...ref, trimStart: tick(1), trimEnd: tick(1) },
		{ kind: "split", ...ref, splitTime: tick(5) },
		{ kind: "set_matte_state", ...ref, enabled: false },
		{ kind: "remove_matte", ...ref },
		{
			kind: "set_mask",
			...ref,
			maskId: "mask",
			maskType: "rectangle",
		},
		{ kind: "remove_mask", ...ref, maskId: "mask" },
		{ kind: "set_audio_replacement_state", ...ref, enabled: false },
		{ kind: "remove_audio_replacement", ...ref },
	];
}
