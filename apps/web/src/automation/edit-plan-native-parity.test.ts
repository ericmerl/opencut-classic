/// <reference types="bun" />

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type {
	CompoundElement,
	SceneTracks,
	TScene,
	TextElement,
	UploadAudioElement,
	VideoElement,
} from "@/timeline";
import type {
	EditPlanEvaluationResponse,
	EvaluateEditPlanOptions,
} from "opencut-wasm";
import type { AutomationEditOperation } from "./types";
import { nativeWasm } from "../../test/native-wasm";

let activeEditor: EditorCore;
mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	evaluateEditPlan: () => {
		throw new Error("native parity tests use the Rust JSON evaluator");
	},
	evaluateTransition: (options: unknown) =>
		nativeWasm().evaluateTransition(options),
	evaluateStoredTransition: (options: unknown) =>
		nativeWasm().evaluateStoredTransition(options),
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	resolveMediaTreatment: (options: unknown) =>
		nativeWasm().resolveMediaTreatment(options),
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => activeEditor },
}));
mock.module("@/services/renderer/canvas-renderer", () => ({
	CanvasRenderer: class {},
}));
mock.module("@/services/renderer/scene-builder", () => ({
	buildScene: () => ({}),
}));

const { mediaTime } = await import("@/wasm");
const { EditorAutomation } = await import("./editor-automation");
const { CommandManager } = await import("@/core/managers/commands");
const { buildEditorProjectContentInput } =
	await import("./project-content-identity");
const { buildCanonicalProjectState, canonicalSerialize } =
	await import("./project-content-hash");
const { normalizeEditPlanFingerprintOperations } =
	await import("./edit-plan-preflight-receipt");
const { diffProjectSnapshots } =
	await import("./edit-plan-evaluation-integrity");
const { toAutomationResolvedOperation, toNativeEditOperations } =
	await import("./edit-plan-operation-adapter");
const { SceneScopedCommand, SequentialEditPlanCommand } =
	await import("./sequential-edit-plan-command");
const { buildElementFromMedia, buildTextElement } =
	await import("@/timeline/element-utils");
const { buildDefaultMaskInstance, registerDefaultMasks } =
	await import("@/masks");

interface NativeParityCase {
	name: string;
	operation: AutomationEditOperation;
	state?: () => NativeState;
}

const parityCases: NativeParityCase[] = [
	{
		name: "insert_text defaults",
		operation: {
			kind: "insert_text",
			content: "Predicted title",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "insert_graphic defaults",
		operation: {
			kind: "insert_graphic",
			definitionId: "rectangle",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "insert_sticker shape defaults",
		operation: {
			kind: "insert_sticker",
			stickerId: "shapes:rectangle",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "insert_adjustment_layer defaults",
		operation: {
			kind: "insert_adjustment_layer",
			effectType: "blur",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "add_track default name and placement",
		operation: {
			kind: "add_track",
			trackType: "audio",
			trackId: "new-audio-track",
		},
	},
	{
		name: "set_project_settings custom canvas metadata",
		operation: {
			kind: "set_project_settings",
			canvasSize: { width: 720, height: 1280 },
		},
	},
	{
		name: "insert_captions materialized defaults",
		operation: {
			kind: "insert_captions",
			captions: [
				{
					text: "Caption",
					startTime: mediaTime({ ticks: 0 }),
					duration: mediaTime({ ticks: 120_000 }),
					resolvedName: "Caption 1",
					resolvedContent: "Caption",
					resolvedParams: { content: "Caption" },
					resolvedLayoutVersion: "opencut.caption-layout.v1",
					resolvedLayoutEngine: "browser-canvas-2d",
				},
			],
		},
	},
	{
		name: "set_track_state validation",
		state: richState,
		operation: {
			kind: "set_track_state",
			trackId: "scene-target-main",
			muted: true,
		},
	},
	{
		name: "set_params built-in coercion",
		state: richState,
		operation: {
			kind: "set_params",
			trackId: "scene-target-main",
			elementId: "video-1",
			params: { opacity: 0.5 },
		},
	},
	{
		name: "set_retime omitted maintainPitch",
		state: richStateWithoutTransition,
		operation: {
			kind: "set_retime",
			trackId: "scene-target-main",
			elementId: "video-1",
			rate: 1.25,
		},
	},
	{
		name: "set_key chroma controls",
		state: richState,
		operation: {
			kind: "set_key",
			trackId: "scene-target-main",
			elementId: "video-1",
			key: {
				type: "chroma",
				keyColor: "#00ff00",
				similarity: 0.2,
				softness: 0.1,
				spillSuppression: 0.8,
				enabled: true,
			},
		},
	},
	{
		name: "remove_key restores unkeyed rendering",
		state: keyedRichState,
		operation: {
			kind: "remove_key",
			trackId: "scene-target-main",
			elementId: "video-1",
		},
	},
	{
		name: "set_track_matte uses stable source identity",
		state: richState,
		operation: {
			kind: "set_track_matte",
			trackId: "scene-target-main",
			routing: {
				sourceTrackId: "compound-target",
				mode: "luma",
				inverted: true,
				enabled: true,
			},
		},
	},
	{
		name: "remove_track_matte restores independent track rendering",
		state: routedRichState,
		operation: { kind: "remove_track_matte", trackId: "scene-target-main" },
	},
	{
		name: "upsert_effect omitted defaults",
		state: richState,
		operation: {
			kind: "upsert_effect",
			trackId: "scene-target-main",
			elementId: "video-1",
			effectId: "effect-new",
			effectType: "blur",
		},
	},
	{
		name: "set_mask omitted defaults",
		state: richState,
		operation: {
			kind: "set_mask",
			trackId: "scene-target-main",
			elementId: "video-1",
			maskId: "mask-new",
			maskType: "rectangle",
		},
	},
	{
		name: "set_matte_state preserves provenance",
		state: richState,
		operation: {
			kind: "set_matte_state",
			trackId: "scene-target-main",
			elementId: "video-1",
			enabled: false,
		},
	},
	{
		name: "set_audio_replacement_state preserves provenance",
		state: richState,
		operation: {
			kind: "set_audio_replacement_state",
			trackId: "scene-target-main",
			elementId: "video-1",
			enabled: false,
		},
	},
	{
		name: "adjust_mix_gain all audible elements",
		state: richState,
		operation: { kind: "adjust_mix_gain", gainDb: -2 },
	},
	{
		name: "shift_captions moves the selected caption",
		operation: {
			kind: "shift_captions",
			trackId: "text-track",
			delta: mediaTime({ ticks: 12_000 }),
			elementIds: ["caption-second"],
		},
		state: withPlainCaptions,
	},
	{
		name: "merge_captions joins captions in timeline order",
		operation: {
			kind: "merge_captions",
			trackId: "text-track",
			elementIds: ["caption-third", "caption-second"],
			separator: " / ",
		},
		state: withPlainCaptions,
	},
	{
		name: "split_caption shares duration by text length",
		operation: {
			kind: "split_caption",
			trackId: "text-track",
			elementId: "caption-second",
			splitIndex: 6,
		},
		state: withPlainCaptions,
	},
	{
		name: "restyle_captions applies Rust-resolved preset params",
		operation: {
			kind: "restyle_captions",
			trackId: "text-track",
			elementIds: ["caption-second"],
			style: { preset: "tiktok-classic", color: "#ffff00" },
		},
		state: withPlainCaptions,
	},
	{
		name: "restyle_captions applies Rust-resolved outline and shadow params",
		operation: {
			kind: "restyle_captions",
			trackId: "text-track",
			elementIds: ["caption-second"],
			style: {
				outline: { enabled: true, color: "#000000", width: 0.1 },
				shadow: {
					enabled: true,
					color: "rgba(0, 0, 0, 0.8)",
					offsetX: 0.05,
					offsetY: 0.05,
					blur: 0.1,
				},
			},
		},
		state: withPlainCaptions,
	},
	{
		name: "restyle_captions selects captions by speaker",
		operation: {
			kind: "restyle_captions",
			trackId: "text-track",
			speaker: "guest",
			style: { color: "#00ff00" },
		},
		state: withSpeakerCaptions,
	},
	{
		name: "rechunk_captions replays Rust-resolved word-timed chunks",
		operation: {
			kind: "rechunk_captions",
			trackId: "text-track",
			elementIds: ["caption-second", "caption-third"],
			maxChars: 8,
		},
		state: withPlainCaptions,
	},
	{
		name: "repair_caption_overlaps shortens the earlier caption",
		operation: {
			kind: "repair_caption_overlaps",
			trackId: "text-track",
			minGap: mediaTime({ ticks: 6_000 }),
		},
		state: withOverlappingCaptions,
	},
	{
		name: "update_caption preserves text defaults",
		state: richState,
		operation: {
			kind: "update_caption",
			trackId: "text-track",
			elementId: "caption-existing",
			text: "Corrected caption",
			duration: mediaTime({ ticks: 60_000 }),
		},
	},
	{
		name: "delete element scope",
		state: richState,
		operation: {
			kind: "delete",
			trackId: "text-track",
			elementId: "caption-existing",
			relationshipScope: "element",
		},
	},
	{
		name: "duplicate_elements names and owned identities",
		state: richState,
		operation: {
			kind: "duplicate_elements",
			elements: [{ trackId: "scene-target-main", elementId: "video-1" }],
			relationshipScope: "element",
		},
	},
	{
		name: "create_compound default name",
		state: richState,
		operation: {
			kind: "create_compound",
			compoundId: "compound-new",
			elements: [
				{ trackId: "scene-target-main", elementId: "video-1" },
				{ trackId: "scene-target-main", elementId: "video-2" },
			],
			relationshipScope: "element",
			targetTrackId: "compound-target",
		},
	},
	{
		name: "break_apart_compound restores names and timing",
		state: compoundState,
		operation: {
			kind: "break_apart_compound",
			trackId: "scene-target-main",
			elementId: "compound-existing",
		},
	},
	{
		name: "set_group replaces prior membership",
		state: richState,
		operation: {
			kind: "set_group",
			groupId: "group-new",
			elements: [
				{ trackId: "scene-target-main", elementId: "video-1" },
				{ trackId: "scene-target-main", elementId: "video-2" },
			],
		},
	},
	{
		name: "clear_group prunes exact membership",
		state: richState,
		operation: { kind: "clear_group", groupId: "group-existing" },
	},
	{
		name: "set_link replaces prior membership",
		state: richState,
		operation: {
			kind: "set_link",
			linkId: "link-new",
			elements: [
				{ trackId: "scene-target-main", elementId: "video-1" },
				{ trackId: "scene-target-main", elementId: "video-2" },
			],
		},
	},
	{
		name: "clear_link prunes exact membership",
		state: richState,
		operation: { kind: "clear_link", linkId: "link-existing" },
	},
	{
		name: "move element scope",
		state: richStateWithoutTransition,
		operation: {
			kind: "move",
			trackId: "scene-target-main",
			elementId: "video-2",
			startTime: mediaTime({ ticks: 600_000 }),
			relationshipScope: "element",
		},
	},
	{
		name: "set_reframe normalized defaults",
		state: richState,
		operation: {
			kind: "set_reframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			mode: "cover",
		},
	},
	{
		name: "set_audio partial control",
		state: richState,
		operation: {
			kind: "set_audio",
			trackId: "audio-track",
			elementId: "audio-1",
			volumeDb: -3,
		},
	},
	{
		name: "separate_source_audio deterministic identities",
		state: richState,
		operation: {
			kind: "separate_source_audio",
			trackId: "scene-target-main",
			elementId: "video-1",
		},
	},
	{
		name: "duck_audio deterministic keyframes",
		state: richState,
		operation: {
			kind: "duck_audio",
			trackId: "audio-track",
			elementId: "audio-1",
			regions: [
				{
					startTime: mediaTime({ ticks: 120_000 }),
					duration: mediaTime({ ticks: 120_000 }),
				},
			],
			reductionDb: 6,
			attackDuration: mediaTime({ ticks: 12_000 }),
			releaseDuration: mediaTime({ ticks: 12_000 }),
		},
	},
	{
		name: "remove_effect removes owned animations",
		state: richState,
		operation: {
			kind: "remove_effect",
			trackId: "scene-target-main",
			elementId: "video-1",
			effectId: "effect-blur",
		},
	},
	{
		name: "reorder_effects exact permutation",
		state: richState,
		operation: {
			kind: "reorder_effects",
			trackId: "scene-target-main",
			elementId: "video-1",
			effectIds: ["effect-blur-2", "effect-blur"],
		},
	},
	{
		name: "upsert_keyframe omitted interpolation",
		state: richState,
		operation: {
			kind: "upsert_keyframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			propertyPath: "opacity",
			time: mediaTime({ ticks: 120_000 }),
			value: 0.5,
		},
	},
	{
		name: "remove_keyframe exact identity",
		state: richState,
		operation: {
			kind: "remove_keyframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			propertyPath: "opacity",
			keyframeId: "keyframe-opacity",
		},
	},
	{
		name: "retime_keyframe exact identity",
		state: richState,
		operation: {
			kind: "retime_keyframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			propertyPath: "opacity",
			keyframeId: "keyframe-opacity",
			time: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "upsert_transition updates existing edge",
		state: richState,
		operation: {
			kind: "upsert_transition",
			trackId: "scene-target-main",
			transitionId: "transition-existing",
			fromElementId: "video-1",
			toElementId: "video-2",
			transitionType: "wipe",
			duration: mediaTime({ ticks: 30_000 }),
		},
	},
	{
		name: "remove_transition exact identity",
		state: richState,
		operation: {
			kind: "remove_transition",
			trackId: "scene-target-main",
			transitionId: "transition-existing",
		},
	},
	{
		name: "trim explicit source span",
		state: richStateWithoutTransition,
		operation: {
			kind: "trim",
			trackId: "scene-target-main",
			elementId: "video-1",
			startTime: mediaTime({ ticks: 10_000 }),
			duration: mediaTime({ ticks: 220_000 }),
			trimStart: mediaTime({ ticks: 10_000 }),
			trimEnd: mediaTime({ ticks: 10_000 }),
		},
	},
	{
		name: "split names and owned identities",
		state: richState,
		operation: {
			kind: "split",
			trackId: "scene-target-main",
			elementId: "video-1",
			splitTime: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "remove_matte detaches and cleans sole artifact",
		state: richState,
		operation: {
			kind: "remove_matte",
			trackId: "scene-target-main",
			elementId: "video-1",
		},
	},
	{
		name: "remove_mask exact identity",
		state: richState,
		operation: {
			kind: "remove_mask",
			trackId: "scene-target-main",
			elementId: "video-1",
			maskId: "mask-existing",
		},
	},
	{
		name: "remove_audio_replacement detaches and cleans sole artifact",
		state: richState,
		operation: {
			kind: "remove_audio_replacement",
			trackId: "scene-target-main",
			elementId: "video-1",
		},
	},
	{
		name: "rename_track trims and applies the name",
		state: richState,
		operation: { kind: "rename_track", trackId: "text-track", name: "Titles" },
	},
	{
		name: "reorder_tracks overlay order",
		state: richState,
		operation: {
			kind: "reorder_tracks",
			overlayTrackIds: ["text-track", "graphic-track", "compound-target"],
		},
	},
	{
		name: "remove_track deletes an occupied track",
		state: richState,
		operation: {
			kind: "remove_track",
			trackId: "text-track",
			occupied: "delete",
		},
	},
	{
		name: "duplicate_track copies the main track with its transition",
		state: richState,
		operation: { kind: "duplicate_track", trackId: "scene-target-main" },
	},
	{
		name: "set_main_track promotes an overlay video track",
		state: richState,
		operation: { kind: "set_main_track", trackId: "compound-target" },
	},
	{
		name: "add_bookmark with identity and note",
		state: bookmarkState,
		operation: {
			kind: "add_bookmark",
			bookmarkId: "bookmark-new",
			time: mediaTime({ ticks: 8_000 }),
			note: "call to action",
		},
	},
	{
		name: "update_bookmark sets color and clears note",
		state: bookmarkState,
		operation: {
			kind: "update_bookmark",
			bookmarkId: "bookmark-1",
			color: "#ff0000",
			clear: ["note"],
		},
	},
	{
		name: "move_bookmark to a later frame",
		state: bookmarkState,
		operation: {
			kind: "move_bookmark",
			bookmarkId: "bookmark-1",
			time: mediaTime({ ticks: 12_000 }),
		},
	},
	{
		name: "remove_bookmark by id",
		state: bookmarkState,
		operation: { kind: "remove_bookmark", bookmarkId: "bookmark-1" },
	},
	{
		name: "instantiate_asset places a bin video with its intrinsic duration",
		state: richState,
		operation: {
			kind: "instantiate_asset",
			assetId: "media-video-2",
			startTime: mediaTime({ ticks: 480_000 }),
		},
	},
];

const optionalParityCases: NativeParityCase[] = [
	{
		name: "insert_sticker explicit provider sticker, params, name, and track",
		state: richState,
		operation: {
			kind: "insert_sticker",
			stickerId: "flags:US",
			trackId: "graphic-track",
			name: "United States flag",
			params: { opacity: 0.75 },
			startTime: mediaTime({ ticks: 30_000 }),
			duration: mediaTime({ ticks: 120_000 }),
		},
	},
	{
		name: "upsert_effect partial merge preserves enabled and existing params",
		state: effectMergeState,
		operation: {
			kind: "upsert_effect",
			trackId: "scene-target-main",
			elementId: "video-1",
			effectId: "effect-grade",
			effectType: "color-grade",
			params: { contrast: 33 },
		},
	},
	{
		name: "set_project_settings preset canvas metadata",
		operation: {
			kind: "set_project_settings",
			canvasSize: { width: 1920, height: 1080 },
		},
	},
	{
		name: "set_track_state combines muted and hidden",
		state: richState,
		operation: {
			kind: "set_track_state",
			trackId: "scene-target-main",
			muted: true,
			hidden: true,
		},
	},
	{
		name: "set_reframe crop",
		state: richState,
		operation: {
			kind: "set_reframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			crop: { x: 0.1, y: 0.15, width: 0.8, height: 0.7 },
		},
	},
	{
		name: "set_reframe focal point",
		state: richState,
		operation: {
			kind: "set_reframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			focalPoint: { x: 0.25, y: 0.75 },
		},
	},
	{
		name: "set_reframe target rectangle",
		state: richState,
		operation: {
			kind: "set_reframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			targetRect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
		},
	},
	{
		name: "set_reframe named layout",
		state: richState,
		operation: {
			kind: "set_reframe",
			trackId: "scene-target-main",
			elementId: "video-1",
			layout: "pip-bottom-right",
		},
	},
	{
		name: "set_audio muted and fade",
		state: richState,
		operation: {
			kind: "set_audio",
			trackId: "audio-track",
			elementId: "audio-1",
			muted: true,
			fade: {
				inDuration: mediaTime({ ticks: 12_000 }),
				outDuration: mediaTime({ ticks: 24_000 }),
				floorDb: -60,
			},
		},
	},
	{
		name: "separate_source_audio explicit existing track and link",
		state: richState,
		operation: {
			kind: "separate_source_audio",
			trackId: "scene-target-main",
			elementId: "video-1",
			audioTrackId: "audio-track",
			audioElementId: "source-audio-explicit",
			linkId: "source-link-explicit",
		},
	},
	{
		name: "upsert_transition creates a slide edge",
		state: richStateWithoutTransition,
		operation: {
			kind: "upsert_transition",
			trackId: "scene-target-main",
			transitionId: "transition-new",
			fromElementId: "video-1",
			toElementId: "video-2",
			transitionType: "slide",
			duration: mediaTime({ ticks: 30_000 }),
		},
	},
	{
		name: "upsert_transition changes an existing edge type",
		state: richState,
		operation: {
			kind: "upsert_transition",
			trackId: "scene-target-main",
			transitionId: "transition-existing",
			fromElementId: "video-1",
			toElementId: "video-2",
			transitionType: "fade-through-black",
			duration: mediaTime({ ticks: 45_000 }),
		},
	},
	{
		name: "set_retime explicit maintainPitch with animated duration clamp",
		state: richStateWithoutTransition,
		operation: {
			kind: "set_retime",
			trackId: "scene-target-main",
			elementId: "video-1",
			rate: 2,
			maintainPitch: true,
		},
	},
	{
		name: "trim ripple with animated duration clamp",
		state: richState,
		operation: {
			kind: "trim",
			trackId: "scene-target-main",
			elementId: "video-1",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120_000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 120_000 }),
			ripple: true,
		},
	},
	{
		name: "split retimed clip retaining left",
		state: retimedState,
		operation: {
			kind: "split",
			trackId: "scene-target-main",
			elementId: "video-1",
			splitTime: mediaTime({ ticks: 60_000 }),
			retainSide: "left",
		},
	},
	{
		name: "split retimed clip retaining right",
		state: retimedState,
		operation: {
			kind: "split",
			trackId: "scene-target-main",
			elementId: "video-1",
			splitTime: mediaTime({ ticks: 60_000 }),
			retainSide: "right",
		},
	},
	{
		name: "set_mask freeform path",
		state: richState,
		operation: {
			kind: "set_mask",
			trackId: "scene-target-main",
			elementId: "video-1",
			maskId: "mask-freeform",
			maskType: "freeform",
			params: {
				closed: true,
				path: [
					{ id: "a", x: -0.2, y: -0.2, inX: 0, inY: 0, outX: 0, outY: 0 },
					{ id: "b", x: 0.2, y: -0.2, inX: 0, inY: 0, outX: 0, outY: 0 },
					{ id: "c", x: 0, y: 0.2, inX: 0, inY: 0, outX: 0, outY: 0 },
				],
			},
		},
	},
	{
		name: "set_mask text params",
		state: richState,
		operation: {
			kind: "set_mask",
			trackId: "scene-target-main",
			elementId: "video-1",
			maskId: "mask-text",
			maskType: "text",
			params: { content: "MASK", fontSize: 24, inverted: true },
		},
	},
	{
		name: "delete group scope with ripple",
		state: richState,
		operation: {
			kind: "delete",
			trackId: "scene-target-main",
			elementId: "video-1",
			relationshipScope: "group",
			ripple: true,
		},
	},
	{
		name: "move link scope",
		state: richState,
		operation: {
			kind: "move",
			trackId: "scene-target-main",
			elementId: "video-1",
			startTime: mediaTime({ ticks: 600_000 }),
			relationshipScope: "link",
		},
	},
];

const optionalInvalidCases: NativeParityCase[] = [
	{
		name: "upsert_effect rejects changing an existing effect type",
		state: effectMergeState,
		operation: {
			kind: "upsert_effect",
			trackId: "scene-target-main",
			elementId: "video-1",
			effectId: "effect-grade",
			effectType: "blur",
			params: { intensity: 20 },
		},
	},
];

let evaluations: EditPlanEvaluationResponse[] = [];
let invalidEvaluations: EditPlanEvaluationResponse[] = [];
let optionalEvaluations: EditPlanEvaluationResponse[] = [];
let optionalInvalidEvaluations: EditPlanEvaluationResponse[] = [];

describe("Rust prediction and native editor parity", () => {
	beforeAll(async () => {
		const validOptions = await Promise.all(
			parityCases.map(async ({ operation, state: buildState }) => {
				const state = buildState?.() ?? nativeState();
				return options({
					before: canonical(state),
					operations: toNativeEditOperations([operation]),
				});
			}),
		);
		const invalidOptions = await Promise.all(
			parityCases.map(async ({ operation, state: buildState }) => {
				const state = buildState?.() ?? nativeState();
				return options({
					before: canonical(state),
					operations: toNativeEditOperations([invalidOperation(operation)]),
				});
			}),
		);
		const optionalOptions = await Promise.all(
			optionalParityCases.map(async ({ operation, state: buildState }) => {
				const state = buildState?.() ?? nativeState();
				return options({
					before: canonical(state),
					operations: toNativeEditOperations([operation]),
				});
			}),
		);
		const optionalInvalidOptions = await Promise.all(
			optionalInvalidCases.map(async ({ operation, state: buildState }) => {
				const state = buildState?.() ?? nativeState();
				return options({
					before: canonical(state),
					operations: toNativeEditOperations([operation]),
				});
			}),
		);
		const responses = await evaluateRust([
			...validOptions,
			...invalidOptions,
			...optionalOptions,
			...optionalInvalidOptions,
		]);
		evaluations = responses.slice(0, parityCases.length);
		invalidEvaluations = responses.slice(
			parityCases.length,
			parityCases.length * 2,
		);
		optionalEvaluations = responses.slice(
			parityCases.length * 2,
			parityCases.length * 2 + optionalParityCases.length,
		);
		optionalInvalidEvaluations = responses.slice(
			parityCases.length * 2 + optionalParityCases.length,
		);
	});

	for (const [caseIndex, parityCase] of parityCases.entries()) {
		test(parityCase.name, () => {
			const evaluated = evaluations[caseIndex];
			if (!evaluated || evaluated.status !== "validated") {
				throw new Error(
					evaluated?.status === "rejected"
						? evaluated.error.message
						: "missing evaluation",
				);
			}
			const state = parityCase.state?.() ?? nativeState();
			activeEditor = buildEditor(state);
			const automation = new EditorAutomation(activeEditor);
			const before = canonical(state);
			const command = new SceneScopedCommand({
				editor: activeEditor,
				sceneId: "scene-target",
				command: new SequentialEditPlanCommand({
					operations: evaluated.result.resolvedOperations,
					buildCommand: ({ operation }) =>
						automation.buildNativeEditOperationCommand(
							toAutomationResolvedOperation(operation),
						),
					stateFingerprint: () => canonicalSerialize(canonical(state)),
				}),
			});

			command.execute();
			const actualAfter = canonical(state);
			if (
				canonicalSerialize(actualAfter) !==
				canonicalSerialize(evaluated.result.predictedAfter)
			) {
				throw new Error(
					`predicted/native mismatch: ${JSON.stringify(
						diffProjectSnapshots({
							before: evaluated.result.predictedAfter,
							after: actualAfter,
						}).slice(0, 12),
					)}`,
				);
			}
			expect(state.activeSceneId).toBe("scene-active");
			command.undo();
			if (canonicalSerialize(canonical(state)) !== canonicalSerialize(before)) {
				throw new Error(
					"native undo did not restore the canonical before state",
				);
			}
			expect(state.activeSceneId).toBe("scene-active");
		});

		test(`${parityCase.name} rejects invalid input without mutation`, () => {
			const evaluated = invalidEvaluations[caseIndex];
			if (!evaluated || evaluated.status !== "rejected") {
				throw new Error("Rust evaluator accepted the invalid operation");
			}
			const state = parityCase.state?.() ?? nativeState();
			activeEditor = buildEditor(state);
			const automation = new EditorAutomation(activeEditor);
			const before = canonicalSerialize(canonical(state));
			const command = new SceneScopedCommand({
				editor: activeEditor,
				sceneId: "scene-target",
				command: new SequentialEditPlanCommand({
					operations: [invalidOperation(parityCase.operation)],
					buildCommand: ({ operation }) =>
						automation.buildNativeEditOperationCommand(operation),
					stateFingerprint: () => canonicalSerialize(canonical(state)),
				}),
			});

			expect(() => command.execute()).toThrow();
			expect(canonicalSerialize(canonical(state))).toBe(before);
			expect(state.activeSceneId).toBe("scene-active");
		});
	}

	for (const [caseIndex, parityCase] of optionalParityCases.entries()) {
		test(`optional: ${parityCase.name}`, () => {
			expectNativeParity({
				parityCase,
				evaluated: optionalEvaluations[caseIndex],
			});
		});
	}

	for (const [caseIndex, parityCase] of optionalInvalidCases.entries()) {
		test(`optional invalid: ${parityCase.name}`, () => {
			expectNativeRejection({
				parityCase,
				evaluated: optionalInvalidEvaluations[caseIndex],
			});
		});
	}

	test("commits a multi-operation native plan as one undo entry", () => {
		const first = requireValidatedEvaluation(0);
		const second = requireValidatedEvaluation(4);
		const state = nativeState();
		activeEditor = buildEditor(state);
		const automation = new EditorAutomation(activeEditor);
		const before = canonicalSerialize(canonical(state));
		const command = new SceneScopedCommand({
			editor: activeEditor,
			sceneId: "scene-target",
			command: new SequentialEditPlanCommand({
				operations: [
					...first.result.resolvedOperations,
					...second.result.resolvedOperations,
				],
				buildCommand: ({ operation }) =>
					automation.buildNativeEditOperationCommand(
						toAutomationResolvedOperation(operation),
					),
				stateFingerprint: () => canonicalSerialize(canonical(state)),
			}),
		});

		activeEditor.command.execute({ command });
		expect(activeEditor.command.getHistorySnapshot().history).toHaveLength(1);
		activeEditor.command.undo();
		expect(canonicalSerialize(canonical(state))).toBe(before);
		expect(state.activeSceneId).toBe("scene-active");
	});

	test("track lifecycle plans preserve pre-existing overlays", async () => {
		const state = lifecycleTrackState();
		const operations: AutomationEditOperation[] = [
			{
				kind: "duplicate_track",
				trackId: "scene-target-main",
				newTrackId: "lifecycle-copy",
			},
			{
				kind: "duplicate_track",
				trackId: "scene-target-main",
				newTrackId: "lifecycle-secondary",
			},
			{ kind: "set_main_track", trackId: "lifecycle-copy" },
			{
				kind: "rename_track",
				trackId: "lifecycle-copy",
				name: "Lifecycle copy",
			},
			{
				kind: "reorder_tracks",
				overlayTrackIds: [
					"lifecycle-secondary",
					"scene-target-main",
					"pre-existing-overlay",
				],
			},
			{
				kind: "remove_track",
				trackId: "scene-target-main",
				occupied: "delete",
			},
			{
				kind: "add_bookmark",
				bookmarkId: "lifecycle-bookmark",
				time: mediaTime({ ticks: 0 }),
				note: "hook",
			},
			{
				kind: "move_bookmark",
				bookmarkId: "lifecycle-bookmark",
				time: mediaTime({ ticks: 8_000 }),
			},
			{
				kind: "update_bookmark",
				bookmarkId: "lifecycle-bookmark",
				color: "#ff0000",
				clear: ["note"],
			},
			{ kind: "remove_bookmark", bookmarkId: "lifecycle-bookmark" },
			{
				kind: "add_bookmark",
				bookmarkId: "lifecycle-bookmark-final",
				time: mediaTime({ ticks: 8_000 }),
				color: "#ff0000",
			},
			{
				kind: "instantiate_asset",
				assetId: "lifecycle-media",
				elementId: "lifecycle-instance",
				startTime: mediaTime({ ticks: 0 }),
			},
		];
		const nativeOperations = toNativeEditOperations(operations);
		const prefixEvaluations = await evaluateRust(
			await Promise.all(
				nativeOperations.map((_, index) =>
					options({
						before: canonical(state),
						operations: nativeOperations.slice(0, index + 1),
					}),
				),
			),
		);
		for (const [index, prefixEvaluation] of prefixEvaluations.entries()) {
			if (!prefixEvaluation || prefixEvaluation.status !== "validated")
				continue;
			const expectedPlanFingerprint = await hash({
				contractVersion: "opencut.edit-plan-preflight.v2",
				description: "native parity case",
				operations: normalizeEditPlanFingerprintOperations(
					operations.slice(0, index + 1),
				),
			});
			if (prefixEvaluation.result.planFingerprint !== expectedPlanFingerprint) {
				throw new Error(
					`plan fingerprint diverged after operation ${index} (${operations[index]?.kind})`,
				);
			}
		}
		const evaluated = prefixEvaluations.at(-1);

		if (!evaluated || evaluated.status !== "validated") {
			throw new Error(
				evaluated?.status === "rejected"
					? evaluated.error.message
					: "missing lifecycle track evaluation",
			);
		}
		const resolvedRemove = evaluated.result.resolvedOperations.find(
			(operation) => operation.kind === "remove_track",
		);
		expect(resolvedRemove?.resolvedCascadeElementIds).toEqual([]);
		expectNativeParity({
			parityCase: {
				name: "track lifecycle plan with a pre-existing overlay",
				operation: operations[0]!,
				state: lifecycleTrackState,
			},
			evaluated,
		});
	});

	test("rolls back earlier native operations when a later operation is invalid", () => {
		const first = requireValidatedEvaluation(0);
		const state = nativeState();
		activeEditor = buildEditor(state);
		const automation = new EditorAutomation(activeEditor);
		const before = canonicalSerialize(canonical(state));
		const operations: AutomationEditOperation[] = [
			...first.result.resolvedOperations.map(toAutomationResolvedOperation),
			invalidOperation(parityCases[0]!.operation),
		];
		const command = new SceneScopedCommand({
			editor: activeEditor,
			sceneId: "scene-target",
			command: new SequentialEditPlanCommand({
				operations,
				buildCommand: ({ operation }) =>
					automation.buildNativeEditOperationCommand(operation),
				stateFingerprint: () => canonicalSerialize(canonical(state)),
			}),
		});

		expect(() => activeEditor.command.execute({ command })).toThrow();
		expect(canonicalSerialize(canonical(state))).toBe(before);
		expect(activeEditor.command.getHistorySnapshot().history).toHaveLength(0);
		expect(state.activeSceneId).toBe("scene-active");
	});
});

function expectNativeParity({
	parityCase,
	evaluated,
}: {
	parityCase: NativeParityCase;
	evaluated: EditPlanEvaluationResponse | undefined;
}): void {
	if (!evaluated || evaluated.status !== "validated") {
		throw new Error(
			evaluated?.status === "rejected"
				? evaluated.error.message
				: "missing evaluation",
		);
	}
	const state = parityCase.state?.() ?? nativeState();
	activeEditor = buildEditor(state);
	const automation = new EditorAutomation(activeEditor);
	const before = canonical(state);
	const command = new SceneScopedCommand({
		editor: activeEditor,
		sceneId: "scene-target",
		command: new SequentialEditPlanCommand({
			operations: evaluated.result.resolvedOperations,
			buildCommand: ({ operation }) =>
				automation.buildNativeEditOperationCommand(
					toAutomationResolvedOperation(operation),
				),
			stateFingerprint: () => canonicalSerialize(canonical(state)),
		}),
	});

	command.execute();
	const actualAfter = canonical(state);
	if (
		canonicalSerialize(actualAfter) !==
		canonicalSerialize(evaluated.result.predictedAfter)
	) {
		throw new Error(
			`predicted/native mismatch: ${JSON.stringify(
				diffProjectSnapshots({
					before: evaluated.result.predictedAfter,
					after: actualAfter,
				}).slice(0, 12),
			)}`,
		);
	}
	expect(state.activeSceneId).toBe("scene-active");
	command.undo();
	if (canonicalSerialize(canonical(state)) !== canonicalSerialize(before)) {
		throw new Error("native undo did not restore the canonical before state");
	}
	expect(state.activeSceneId).toBe("scene-active");
}

function expectNativeRejection({
	parityCase,
	evaluated,
}: {
	parityCase: NativeParityCase;
	evaluated: EditPlanEvaluationResponse | undefined;
}): void {
	if (!evaluated || evaluated.status !== "rejected") {
		throw new Error("Rust evaluator accepted the invalid operation");
	}
	const state = parityCase.state?.() ?? nativeState();
	activeEditor = buildEditor(state);
	const automation = new EditorAutomation(activeEditor);
	const before = canonicalSerialize(canonical(state));
	const command = new SceneScopedCommand({
		editor: activeEditor,
		sceneId: "scene-target",
		command: new SequentialEditPlanCommand({
			operations: [parityCase.operation],
			buildCommand: ({ operation }) =>
				automation.buildNativeEditOperationCommand(operation),
			stateFingerprint: () => canonicalSerialize(canonical(state)),
		}),
	});

	expect(() => command.execute()).toThrow();
	expect(canonicalSerialize(canonical(state))).toBe(before);
	expect(state.activeSceneId).toBe("scene-active");
}

function requireValidatedEvaluation(index: number) {
	const evaluated = evaluations[index];
	if (!evaluated || evaluated.status !== "validated") {
		throw new Error(`missing validated evaluation at index ${index}`);
	}
	return evaluated;
}

function invalidOperation(
	operation: AutomationEditOperation,
): AutomationEditOperation {
	switch (operation.kind) {
		case "insert_text":
		case "insert_graphic":
		case "insert_sticker":
		case "insert_adjustment_layer":
			return { ...operation, duration: mediaTime({ ticks: 0 }) };
		case "insert_captions":
			return {
				...operation,
				captions: operation.captions.map((caption) => ({
					...caption,
					duration: mediaTime({ ticks: 0 }),
				})),
			};
		case "add_track":
			return { ...operation, trackId: "scene-target-main" };
		case "rename_track":
			return { ...operation, name: " " };
		case "reorder_tracks":
			return { ...operation, overlayTrackIds: ["missing-track"] };
		case "remove_track":
		case "duplicate_track":
		case "set_main_track":
			return { ...operation, trackId: "missing-track" };
		case "add_bookmark":
			return { ...operation, duration: mediaTime({ ticks: 0 }) };
		case "update_bookmark":
		case "move_bookmark":
		case "remove_bookmark":
			return { ...operation, bookmarkId: "missing-bookmark" };
		case "instantiate_asset":
			return { ...operation, assetId: "missing-asset" };
		case "set_project_settings":
			return {
				...operation,
				fps: { numerator: 0, denominator: 1 },
			};
		case "set_track_state":
			return { ...operation, trackId: "missing-track" };
		case "set_track_matte":
			return {
				...operation,
				routing: { ...operation.routing, sourceTrackId: "missing-track" },
			};
		case "remove_track_matte":
			return { ...operation, trackId: "missing-track" };
		case "adjust_mix_gain":
			return { ...operation, gainDb: 1_000 };
		case "duplicate_elements":
			return { ...operation, elements: [] };
		case "shift_captions":
			return { ...operation, delta: mediaTime({ ticks: 0 }) };
		case "merge_captions":
			return { ...operation, elementIds: [] };
		case "split_caption":
			return { ...operation, splitIndex: 0 };
		case "restyle_captions":
			return { ...operation, style: { fontSizeRatioOfPlayHeight: 0.1 } };
		case "rechunk_captions":
			return { ...operation, maxChars: 0 };
		case "repair_caption_overlaps":
			return { ...operation, minGap: mediaTime({ ticks: -1 }) };
		case "create_compound":
			return { ...operation, elements: operation.elements.slice(0, 1) };
		case "set_group":
		case "set_link":
			return { ...operation, elements: [] };
		case "clear_group":
			return { ...operation, groupId: "missing-group" };
		case "clear_link":
			return { ...operation, linkId: "missing-link" };
		case "upsert_transition":
			return { ...operation, fromElementId: "missing-element" };
		case "remove_transition":
			return { ...operation, transitionId: "missing-transition" };
		case "set_params":
		case "set_reframe":
		case "set_key":
		case "remove_key":
		case "set_audio":
		case "separate_source_audio":
		case "duck_audio":
		case "upsert_effect":
		case "remove_effect":
		case "reorder_effects":
		case "upsert_keyframe":
		case "remove_keyframe":
		case "retime_keyframe":
		case "set_retime":
		case "move":
		case "delete":
		case "split":
		case "trim":
		case "update_caption":
		case "set_mask":
		case "remove_mask":
		case "set_matte_state":
		case "remove_matte":
		case "set_audio_replacement_state":
		case "remove_audio_replacement":
		case "break_apart_compound":
			return { ...operation, elementId: "missing-element" };
	}
}

interface NativeState {
	project: TProject;
	activeSceneId: string;
	mediaAssets: MediaAsset[];
}

function nativeState(): NativeState {
	const timestamp = new Date("2026-09-02T00:00:00.000Z");
	const scene = ({ id, isMain }: { id: string; isMain: boolean }): TScene => ({
		id,
		name: id,
		isMain,
		tracks: emptyTracks(id),
		bookmarks: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	return {
		project: {
			metadata: {
				id: "project",
				name: "Native parity",
				duration: mediaTime({ ticks: 0 }),
				createdAt: timestamp,
				updatedAt: timestamp,
			},
			scenes: [
				scene({ id: "scene-active", isMain: true }),
				scene({ id: "scene-target", isMain: false }),
			],
			currentSceneId: "scene-active",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1080, height: 1920 },
				background: { type: "color", color: "#000000" },
			},
			version: 31,
		},
		activeSceneId: "scene-active",
		mediaAssets: [],
	};
}

function lifecycleTrackState(): NativeState {
	const state = nativeState();
	const asset = mediaAsset({
		id: "lifecycle-media",
		type: "video",
		duration: 2,
		hasAudio: true,
	});
	state.mediaAssets = [asset];
	state.project = {
		...state.project,
		scenes: state.project.scenes.map((scene) =>
			scene.id === "scene-target"
				? {
						...scene,
						tracks: {
							...scene.tracks,
							main: {
								...scene.tracks.main,
								elements: [
									videoElement({
										id: "lifecycle-video",
										asset,
										startTime: 0,
									}),
								],
							},
							overlay: [
								{
									id: "pre-existing-overlay",
									name: "Pre-existing overlay",
									type: "video",
									muted: false,
									hidden: false,
									elements: [],
								},
							],
						},
					}
				: scene,
		),
	};
	return state;
}

function richState(): NativeState {
	registerDefaultMasks();
	const state = nativeState();
	const videoAsset = mediaAsset({
		id: "media-video",
		type: "video",
		duration: 4,
		hasAudio: true,
	});
	const secondVideoAsset = mediaAsset({
		id: "media-video-2",
		type: "video",
		duration: 4,
		hasAudio: true,
	});
	const audioAsset = mediaAsset({
		id: "media-audio",
		type: "audio",
		duration: 4,
		hasAudio: true,
	});
	const first = videoElement({
		id: "video-1",
		asset: videoAsset,
		startTime: 0,
	});
	first.effects = [
		{
			id: "effect-blur",
			type: "blur",
			enabled: true,
			params: { intensity: 15 },
		},
		{
			id: "effect-blur-2",
			type: "blur",
			enabled: false,
			params: { intensity: 30 },
		},
	];
	first.animations = {
		opacity: {
			keys: [
				{
					id: "keyframe-opacity",
					time: mediaTime({ ticks: 60_000 }),
					value: 1,
					segmentToNext: "linear",
					tangentMode: "auto",
				},
				{
					id: "keyframe-opacity-end",
					time: mediaTime({ ticks: 240_000 }),
					value: 0,
					segmentToNext: "linear",
					tangentMode: "auto",
				},
			],
		},
	};
	first.masks = [
		{
			...buildDefaultMaskInstance({ maskType: "rectangle" }),
			id: "mask-existing",
		},
	];
	first.matte = {
		assetId: "media-matte",
		sourceMediaId: videoAsset.id,
		sourceFingerprint: "source-video",
		artifactHash: "matte-hash",
		artifactFingerprint: "matte-fingerprint",
		channel: "alpha",
		modelId: "matte-model",
		modelVersion: "1",
		enabled: true,
	};
	first.audioReplacement = {
		assetId: "media-clean-audio",
		sourceMediaId: videoAsset.id,
		sourceFingerprint: "source-video",
		artifactHash: "clean-hash",
		artifactFingerprint: "clean-fingerprint",
		modelId: "clean-model",
		modelVersion: "1",
		enabled: true,
	};
	const second = videoElement({
		id: "video-2",
		asset: secondVideoAsset,
		startTime: 240_000,
	});
	const promotionFirst = videoElement({
		id: "promotion-video-1",
		asset: videoAsset,
		startTime: 0,
	});
	const promotionSecond = videoElement({
		id: "promotion-video-2",
		asset: secondVideoAsset,
		startTime: 240_000,
	});
	first.groupId = "group-existing";
	second.groupId = "group-existing";
	first.linkId = "link-existing";
	second.linkId = "link-existing";
	second.transitionIn = {
		id: "transition-existing",
		type: "crossfade",
		duration: mediaTime({ ticks: 60_000 }),
		fromElementId: first.id,
	};
	const audio = audioElement({ id: "audio-1", asset: audioAsset });
	const caption = textElement();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	if (!target) throw new Error("target scene fixture missing");
	target.tracks = {
		main: { ...target.tracks.main, elements: [first, second] },
		overlay: [
			{
				id: "compound-target",
				name: "Compound target",
				type: "video",
				muted: false,
				hidden: false,
				elements: [promotionFirst, promotionSecond],
			},
			{
				id: "graphic-track",
				name: "Graphic track",
				type: "graphic",
				hidden: false,
				elements: [],
			},
			{
				id: "text-track",
				name: "Text track",
				type: "text",
				hidden: false,
				elements: [caption],
			},
		],
		audio: [
			{
				id: "audio-track",
				name: "Audio track",
				type: "audio",
				muted: false,
				elements: [audio],
			},
		],
	};
	state.mediaAssets = [
		videoAsset,
		secondVideoAsset,
		audioAsset,
		mediaAsset({ id: "media-matte", type: "image" }),
		mediaAsset({ id: "media-clean-audio", type: "audio", duration: 4 }),
	];
	return state;
}

function keyedRichState(): NativeState {
	const state = richState();
	const element = state.project.scenes
		.find((scene) => scene.id === "scene-target")
		?.tracks.main.elements.find((candidate) => candidate.id === "video-1");
	if (!element || element.type !== "video")
		throw new Error("key fixture missing");
	element.key = {
		type: "luma",
		low: 0.2,
		high: 0.8,
		softness: 0.1,
		inverted: false,
		enabled: true,
	};
	return state;
}

function routedRichState(): NativeState {
	const state = richState();
	const scene = state.project.scenes.find(
		(candidate) => candidate.id === "scene-target",
	);
	if (!scene) throw new Error("route fixture missing");
	scene.tracks.main.trackMatte = {
		sourceTrackId: "compound-target",
		mode: "alpha",
		inverted: false,
		enabled: true,
	};
	return state;
}

function bookmarkState(): NativeState {
	const state = richState();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	if (!target) throw new Error("target scene fixture missing");
	target.bookmarks = [
		{ id: "bookmark-1", time: mediaTime({ ticks: 4_000 }), note: "hook" },
		{ id: "bookmark-2", time: mediaTime({ ticks: 240_000 }), color: "#00ff00" },
	];
	return state;
}

function richStateWithoutTransition(): NativeState {
	const state = richState();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	if (!target) throw new Error("target scene fixture missing");
	const second = target.tracks.main.elements.find(
		(element) => element.id === "video-2",
	);
	if (!second || second.type !== "video") {
		throw new Error("second video fixture missing");
	}
	second.transitionIn = undefined;
	return state;
}

function effectMergeState(): NativeState {
	const state = richState();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	if (!target) throw new Error("target scene fixture missing");
	const first = target.tracks.main.elements.find(
		(element) => element.id === "video-1",
	);
	if (!first || first.type !== "video") {
		throw new Error("first video fixture missing");
	}
	first.effects = [
		{
			id: "effect-grade",
			type: "color-grade",
			enabled: false,
			params: { temperature: -3, saturation: -6, contrast: 12 },
		},
	];
	return state;
}

function retimedState(): NativeState {
	const state = richStateWithoutTransition();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	if (!target) throw new Error("target scene fixture missing");
	const first = target.tracks.main.elements.find(
		(element) => element.id === "video-1",
	);
	if (!first || first.type !== "video") {
		throw new Error("first video fixture missing");
	}
	first.duration = mediaTime({ ticks: 120_000 });
	first.retime = { rate: 2, maintainPitch: true };
	return state;
}

function compoundState(): NativeState {
	const state = richState();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	if (!target) throw new Error("target scene fixture missing");
	const members = target.tracks.main.elements;
	const compound: CompoundElement = {
		id: "compound-existing",
		name: "Compound clip",
		type: "compound",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 480_000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: mediaTime({ ticks: 480_000 }),
		params: {},
		hidden: false,
		tracks: {
			main: {
				id: "nested-main",
				name: "Video track",
				type: "video",
				muted: false,
				hidden: false,
				elements: members,
			},
			overlay: [],
			audio: [],
		},
	};
	target.tracks = {
		...target.tracks,
		main: { ...target.tracks.main, elements: [compound] },
	};
	return state;
}

function mediaAsset({
	id,
	type,
	duration,
	hasAudio,
}: {
	id: string;
	type: MediaAsset["type"];
	duration?: number;
	hasAudio?: boolean;
}): MediaAsset {
	return {
		id,
		name: `${id}.${type === "image" ? "png" : type === "audio" ? "wav" : "mp4"}`,
		type,
		file: new File([], id),
		width: type === "audio" ? undefined : 1080,
		height: type === "audio" ? undefined : 1920,
		duration,
		fps: type === "video" ? 30 : undefined,
		hasAudio,
		sourceFingerprint: `source-${id}`,
		role:
			id === "media-matte"
				? "matte"
				: id === "media-clean-audio"
					? "audio-replacement"
					: "timeline",
	};
}

function videoElement({
	id,
	asset,
	startTime,
}: {
	id: string;
	asset: MediaAsset;
	startTime: number;
}): VideoElement {
	const element = buildElementFromMedia({
		mediaId: asset.id,
		mediaType: "video",
		name: asset.name,
		duration: mediaTime({ ticks: 240_000 }),
		startTime: mediaTime({ ticks: startTime }),
	});
	if (element.type !== "video") throw new Error("video fixture changed type");
	return { ...element, id };
}

function audioElement({
	id,
	asset,
}: {
	id: string;
	asset: MediaAsset;
}): UploadAudioElement {
	const element = buildElementFromMedia({
		mediaId: asset.id,
		mediaType: "audio",
		name: asset.name,
		duration: mediaTime({ ticks: 480_000 }),
		startTime: mediaTime({ ticks: 0 }),
	});
	if (element.type !== "audio" || element.sourceType !== "upload") {
		throw new Error("audio fixture changed type");
	}
	return { ...element, id };
}

/** The parity state with two plain captions that carry no animations. */
function withPlainCaptions(): NativeState {
	const state = richState();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	const track = target?.tracks.overlay.find(
		(candidate) => candidate.id === "text-track",
	);
	if (!track) throw new Error("text track fixture missing");
	track.elements = [
		...(track.elements as TextElement[]),
		plainCaption({
			id: "caption-second",
			content: "Second caption text",
			startTicks: 150_000,
		}),
		plainCaption({
			id: "caption-third",
			content: "Third caption",
			startTicks: 300_000,
		}),
	] as TextElement[];
	return state;
}

/** The plain-caption state with the second caption tagged as a guest. */
function withSpeakerCaptions(): NativeState {
	const state = withPlainCaptions();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	const track = target?.tracks.overlay.find(
		(candidate) => candidate.id === "text-track",
	);
	const second = track?.elements.find(
		(element) => element.id === "caption-second",
	);
	if (!second) throw new Error("caption fixture missing");
	second.params = { ...second.params, "caption.speaker": "guest" };
	return state;
}

/** The plain-caption state with the third caption overlapping the second. */
function withOverlappingCaptions(): NativeState {
	const state = withPlainCaptions();
	const target = state.project.scenes.find(
		(scene) => scene.id === "scene-target",
	);
	const track = target?.tracks.overlay.find(
		(candidate) => candidate.id === "text-track",
	);
	const third = track?.elements.find(
		(element) => element.id === "caption-third",
	);
	if (!third) throw new Error("caption fixture missing");
	third.startTime = mediaTime({ ticks: 250_000 });
	return state;
}

function plainCaption({
	id,
	content,
	startTicks,
}: {
	id: string;
	content: string;
	startTicks: number;
}): TextElement {
	const element = buildTextElement({
		raw: { params: { content } },
		startTime: mediaTime({ ticks: startTicks }),
	});
	if (element.type !== "text") throw new Error("text fixture changed type");
	return { ...element, id, duration: mediaTime({ ticks: 120_000 }) };
}

function textElement(): TextElement {
	const element = buildTextElement({
		raw: { params: { content: "Existing caption" } },
		startTime: mediaTime({ ticks: 0 }),
	});
	if (element.type !== "text") throw new Error("text fixture changed type");
	return {
		...element,
		id: "caption-existing",
		duration: mediaTime({ ticks: 120_000 }),
		animations: {
			opacity: {
				keys: [
					{
						id: "caption-opacity-start",
						time: mediaTime({ ticks: 0 }),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "flat",
					},
					{
						id: "caption-opacity-end",
						time: mediaTime({ ticks: 120_000 }),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "flat",
					},
				],
			},
		},
	};
}

function emptyTracks(prefix: string): SceneTracks {
	return {
		main: {
			id: `${prefix}-main`,
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		overlay: [],
		audio: [],
	};
}

function buildEditor(state: NativeState): EditorCore {
	const updateActiveTracks = (tracks: SceneTracks) => {
		state.project = {
			...state.project,
			scenes: state.project.scenes.map((scene) =>
				scene.id === state.activeSceneId ? { ...scene, tracks } : scene,
			),
		};
	};
	const selection = {
		selectedElements: [],
		selectedKeyframes: [],
		keyframeSelectionAnchor: null,
		selectedMaskPoints: null,
	};
	const editor: EditorCore = Object.assign(Object.create(null), {
		project: {
			getActive: () => state.project,
			getActiveOrNull: () => state.project,
			setActiveProject: ({ project }: { project: TProject }) => {
				state.project = project;
			},
		},
		scenes: {
			getScenes: () => state.project.scenes,
			getActiveScene: () =>
				state.project.scenes.find((scene) => scene.id === state.activeSceneId),
			setScenes: ({
				scenes,
				activeSceneId,
			}: {
				scenes: TScene[];
				activeSceneId?: string;
			}) => {
				state.project = { ...state.project, scenes };
				if (activeSceneId) state.activeSceneId = activeSceneId;
			},
		},
		timeline: {
			updateTracks: updateActiveTracks,
		},
		media: {
			getAssets: () => state.mediaAssets,
			setAssets: ({ assets }: { assets: MediaAsset[] }) => {
				state.mediaAssets = assets;
			},
		},
		selection: {
			getSnapshot: () => selection,
			applySelectionPatch: () => selection,
			restoreSnapshot: () => undefined,
		},
		save: { markDirty: () => undefined },
	});
	Object.assign(editor, { command: new CommandManager(editor) });
	return editor;
}

function canonical(state: NativeState) {
	return buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: { ...state.project, scenes: state.project.scenes },
			mediaAssets: state.mediaAssets,
		}),
	);
}

async function options({
	before,
	operations,
}: {
	before: ReturnType<typeof canonical>;
	operations: EvaluateEditPlanOptions["operations"];
}): Promise<EvaluateEditPlanOptions> {
	const readiness = {
		editPlanReady: true,
		providerExecution: "forbidden" as const,
		cost: { status: "not-applicable" as const },
	};
	return {
		contractVersion: "opencut.edit-plan-preflight.v2",
		source: {
			connectionIdentity: {
				serverInstanceId: "server",
				editorInstanceId: "editor",
				editorSessionId: "session",
				connectionGeneration: 1,
				bridgeProtocolVersion: 2,
			},
			projectId: "project",
			sceneId: "scene-target",
			sessionRevision: 1,
			canonicalProjectHash: await hash(before),
			durableWriteVersion: 1,
			saveReceiptId: "receipt",
			saveOperationId: "save",
		},
		capabilitySnapshot: { ...readiness, hash: await hash(readiness) },
		policy: {
			warningPolicy: "allow",
			providerExecution: "forbidden",
			costPolicy: "require-exact",
		},
		description: "native parity case",
		operations,
		before,
	};
}

async function evaluateRust(
	inputs: EvaluateEditPlanOptions[],
): Promise<EditPlanEvaluationResponse[]> {
	const executable =
		globalThis.process.env.OPENCUT_TEST_CARGO_PATH?.trim() || "cargo";
	let process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		process = Bun.spawn(
			[
				executable,
				"run",
				"-q",
				"-p",
				"edit-plan",
				"--example",
				"evaluate_json",
			],
			{
				cwd: resolve(import.meta.dir, "../../../.."),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	} catch (error) {
		throw new Error(
			`Could not run cargo as "${executable}". Put cargo on PATH or set OPENCUT_TEST_CARGO_PATH to its full path. (${
				error instanceof Error ? error.message : String(error)
			})`,
		);
	}
	process.stdin.write(JSON.stringify(inputs));
	process.stdin.end();
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0)
		throw new Error(stderr || `Rust evaluator exited ${exitCode}`);
	return JSON.parse(stdout);
}

async function hash(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalSerialize(value)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
