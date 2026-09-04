import type { EditOperation, ResolvedEditOperation } from "opencut-wasm";
import type { SubtitleStyleOverrides } from "@/subtitles/types";
import { mediaTime } from "@/wasm";
import type { AutomationEditOperation } from "./types";

export function toNativeEditOperations(
	operations: readonly AutomationEditOperation[],
): EditOperation[] {
	return operations.map(toNativeEditOperation);
}

export function toAutomationResolvedOperation(
	operation: EditOperation | ResolvedEditOperation,
): AutomationEditOperation {
	switch (operation.kind) {
		case "insert_text":
			return {
				...operation,
				elementId: optional(operation.elementId),
				startTime: mediaTime({ ticks: operation.startTime }),
				duration: mediaTime({ ticks: operation.duration }),
				autoTrackId: optional(operation.autoTrackId),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "insert_graphic":
		case "insert_sticker":
		case "insert_adjustment_layer":
			return {
				...operation,
				elementId: optional(operation.elementId),
				name: optional(operation.name),
				trackId: optional(operation.trackId),
				params: optional(operation.params),
				startTime: mediaTime({ ticks: operation.startTime }),
				duration: mediaTime({ ticks: operation.duration }),
				autoTrackId: optional(operation.autoTrackId),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "add_track":
			return operation;
		case "set_track_state":
			return {
				...operation,
				muted: optional(operation.muted),
				hidden: optional(operation.hidden),
			};
		case "rename_track":
		case "set_main_track":
		case "remove_bookmark":
			return operation;
		case "reorder_tracks":
			return {
				...operation,
				overlayTrackIds: optional(operation.overlayTrackIds),
				audioTrackIds: optional(operation.audioTrackIds),
			};
		case "remove_track":
			return {
				...operation,
				occupied: optional(operation.occupied),
				targetTrackId: optional(operation.targetTrackId),
				resolvedCascadeElementIds: optional(
					operation.resolvedCascadeElementIds,
				),
			};
		case "duplicate_track":
			return {
				...operation,
				newTrackId: optional(operation.newTrackId),
				name: optional(operation.name),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "add_bookmark":
			return {
				...operation,
				bookmarkId: optional(operation.bookmarkId),
				time: mediaTime({ ticks: operation.time }),
				duration: optionalMediaTime(operation.duration),
				note: optional(operation.note),
				color: optional(operation.color),
			};
		case "update_bookmark":
			return {
				...operation,
				note: optional(operation.note),
				color: optional(operation.color),
				duration: optionalMediaTime(operation.duration),
				clear: optional(operation.clear),
			};
		case "move_bookmark":
			return {
				...operation,
				time: mediaTime({ ticks: operation.time }),
			};
		case "instantiate_asset":
			return {
				...operation,
				elementId: optional(operation.elementId),
				name: optional(operation.name),
				startTime: mediaTime({ ticks: operation.startTime }),
				duration: optionalMediaTime(operation.duration),
				trackId: optional(operation.trackId),
				autoTrackId: optional(operation.autoTrackId),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "set_project_settings":
			return {
				...operation,
				fps: optional(operation.fps),
				canvasSize: optional(operation.canvasSize),
				background: optional(operation.background),
			};
		case "insert_captions":
			return {
				...operation,
				captions: operation.captions.map((caption) => ({
					...caption,
					elementId: optional(caption.elementId),
					startTime: mediaTime({ ticks: caption.startTime }),
					duration: mediaTime({ ticks: caption.duration }),
					resolvedName: optional(caption.resolvedName),
					resolvedContent: optional(caption.resolvedContent),
					resolvedParams: optional(caption.resolvedParams),
					resolvedLayoutVersion: optional(caption.resolvedLayoutVersion),
					resolvedLayoutEngine: optional(caption.resolvedLayoutEngine),
				})),
				trackId: optional(operation.trackId),
				style: resolvedSubtitleStyle(operation.style),
			};
		case "update_caption":
			return {
				...operation,
				text: optional(operation.text),
				startTime: optionalMediaTime(operation.startTime),
				duration: optionalMediaTime(operation.duration),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "delete":
			return operation;
		case "duplicate_elements":
			return {
				...operation,
				duplicateIds: optional(operation.duplicateIds),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "create_compound":
			return {
				...operation,
				name: optional(operation.name),
				targetTrackId: optional(operation.targetTrackId),
				autoTrackId: optional(operation.autoTrackId),
				emptyMainTrackId: optional(operation.emptyMainTrackId),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "break_apart_compound":
			return {
				...operation,
				restoredElementIds: optional(operation.restoredElementIds),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "set_group":
		case "clear_group":
		case "set_link":
		case "clear_link":
		case "set_params":
			return operation;
		case "set_reframe":
			return {
				...operation,
				mode: optional(operation.mode),
				crop: optional(operation.crop),
				focalPoint: optional(operation.focalPoint),
				targetRect: optional(operation.targetRect),
				layout: optional(operation.layout),
			};
		case "move":
			return {
				...operation,
				targetTrackId: optional(operation.targetTrackId),
				startTime: mediaTime({ ticks: operation.startTime }),
			};
		case "set_audio":
			return {
				...operation,
				fade: operation.fade
					? {
							...operation.fade,
							inDuration: mediaTime({ ticks: operation.fade.inDuration }),
							outDuration: mediaTime({ ticks: operation.fade.outDuration }),
						}
					: undefined,
				volumeDb: optional(operation.volumeDb),
				muted: optional(operation.muted),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "separate_source_audio":
			return {
				...operation,
				audioTrackId: optional(operation.audioTrackId),
				audioElementId: optional(operation.audioElementId),
				linkId: optional(operation.linkId),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "adjust_mix_gain":
		case "remove_effect":
		case "reorder_effects":
			return operation;
		case "upsert_effect":
			return {
				...operation,
				params: optional(operation.params),
				enabled: optional(operation.enabled),
			};
		case "duck_audio":
			return {
				...operation,
				regions: operation.regions.map((region) => ({
					startTime: mediaTime({ ticks: region.startTime }),
					duration: mediaTime({ ticks: region.duration }),
				})),
				attackDuration: mediaTime({ ticks: operation.attackDuration }),
				releaseDuration: mediaTime({ ticks: operation.releaseDuration }),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "upsert_keyframe":
			return {
				...operation,
				interpolation: optional(operation.interpolation),
				keyframeId: optional(operation.keyframeId),
				time: mediaTime({ ticks: operation.time }),
			};
		case "remove_keyframe":
		case "remove_transition":
			return operation;
		case "set_retime":
			return {
				...operation,
				maintainPitch: optional(operation.maintainPitch),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "set_matte_state":
		case "remove_matte":
		case "remove_mask":
		case "set_audio_replacement_state":
		case "remove_audio_replacement":
			return operation;
		case "retime_keyframe":
			return {
				...operation,
				time: mediaTime({ ticks: operation.time }),
			};
		case "upsert_transition":
			return {
				...operation,
				duration: mediaTime({ ticks: operation.duration }),
			};
		case "trim":
			return {
				...operation,
				startTime: optionalMediaTime(operation.startTime),
				duration: optionalMediaTime(operation.duration),
				trimStart: mediaTime({ ticks: operation.trimStart }),
				trimEnd: mediaTime({ ticks: operation.trimEnd }),
				resolvedAllocations: optional(operation.resolvedAllocations),
			};
		case "split":
			return {
				...operation,
				rightElementId: optional(operation.rightElementId),
				retainSide: optional(operation.retainSide),
				resolvedAllocations: optional(operation.resolvedAllocations),
				splitTime: mediaTime({ ticks: operation.splitTime }),
			};
		case "set_mask":
			return {
				...operation,
				params: optional(operation.params),
			};
		default:
			return unreachable(operation);
	}
}

function optionalMediaTime(value: number | null | undefined) {
	return value == null ? undefined : mediaTime({ ticks: value });
}

function optional<T>(value: T | null | undefined): T | undefined {
	return value ?? undefined;
}

function resolvedSubtitleStyle(
	style:
		| Extract<ResolvedEditOperation, { kind: "insert_captions" }>["style"]
		| Extract<EditOperation, { kind: "insert_captions" }>["style"],
): SubtitleStyleOverrides | undefined {
	if (!style) return undefined;
	return {
		fontSize: optional(style.fontSize),
		fontSizeRatioOfPlayHeight: optional(style.fontSizeRatioOfPlayHeight),
		fontFamily: optional(style.fontFamily),
		color: optional(style.color),
		background: style.background
			? {
					enabled: style.background.enabled,
					color: style.background.color,
					cornerRadius: optional(style.background.cornerRadius),
					paddingX: optional(style.background.paddingX),
					paddingY: optional(style.background.paddingY),
					offsetX: optional(style.background.offsetX),
					offsetY: optional(style.background.offsetY),
				}
			: undefined,
		textAlign: optional(style.textAlign),
		fontWeight: optional(style.fontWeight),
		fontStyle: optional(style.fontStyle),
		textDecoration: optional(style.textDecoration),
		letterSpacing: optional(style.letterSpacing),
		lineHeight: optional(style.lineHeight),
		placement: style.placement
			? {
					verticalAlign: optional(style.placement.verticalAlign),
					marginLeftRatio: optional(style.placement.marginLeftRatio),
					marginRightRatio: optional(style.placement.marginRightRatio),
					marginVerticalRatio: optional(style.placement.marginVerticalRatio),
				}
			: undefined,
	};
}

function toNativeEditOperation(
	operation: AutomationEditOperation,
): EditOperation {
	switch (operation.kind) {
		case "insert_text":
			return {
				kind: operation.kind,
				elementId: operation.elementId,
				content: operation.content,
				startTime: operation.startTime,
				duration: operation.duration,
				autoTrackId: operation.autoTrackId,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "insert_graphic":
			return {
				...operation,
				elementId: operation.elementId,
				name: operation.name,
				trackId: operation.trackId,
				params: operation.params,
			};
		case "insert_sticker":
			return {
				...operation,
				elementId: operation.elementId,
				name: operation.name,
				trackId: operation.trackId,
				params: operation.params,
			};
		case "insert_adjustment_layer":
			return {
				...operation,
				elementId: operation.elementId,
				name: operation.name,
				trackId: operation.trackId,
				params: operation.params,
			};
		case "add_track":
			return operation;
		case "set_track_state":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				muted: operation.muted,
				hidden: operation.hidden,
			};
		case "rename_track":
		case "set_main_track":
		case "remove_bookmark":
			return operation;
		case "reorder_tracks":
			return {
				kind: operation.kind,
				overlayTrackIds: operation.overlayTrackIds,
				audioTrackIds: operation.audioTrackIds,
			};
		case "remove_track":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				occupied: operation.occupied ?? "reject",
				targetTrackId: operation.targetTrackId,
				resolvedCascadeElementIds: operation.resolvedCascadeElementIds,
			};
		case "duplicate_track":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				newTrackId: operation.newTrackId,
				name: operation.name,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "add_bookmark":
			return {
				kind: operation.kind,
				bookmarkId: operation.bookmarkId,
				time: operation.time,
				duration: operation.duration,
				note: operation.note,
				color: operation.color,
			};
		case "update_bookmark":
			return {
				kind: operation.kind,
				bookmarkId: operation.bookmarkId,
				note: operation.note,
				color: operation.color,
				duration: operation.duration,
				clear: [...(operation.clear ?? [])],
			};
		case "move_bookmark":
			return {
				kind: operation.kind,
				bookmarkId: operation.bookmarkId,
				time: operation.time,
			};
		case "instantiate_asset":
			return {
				kind: operation.kind,
				assetId: operation.assetId,
				elementId: operation.elementId,
				name: operation.name,
				startTime: operation.startTime,
				duration: operation.duration,
				trackId: operation.trackId,
				autoTrackId: operation.autoTrackId,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "set_project_settings":
			return {
				kind: operation.kind,
				fps: operation.fps,
				canvasSize: operation.canvasSize,
				background: operation.background,
			};
		case "insert_captions":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				captions: operation.captions.map((caption) => ({
					elementId: caption.elementId,
					text: caption.text,
					startTime: caption.startTime,
					duration: caption.duration,
					resolvedName: caption.resolvedName,
					resolvedContent: caption.resolvedContent,
					resolvedParams: caption.resolvedParams,
					resolvedLayoutVersion: caption.resolvedLayoutVersion,
					resolvedLayoutEngine: caption.resolvedLayoutEngine,
				})),
				style: operation.style,
			};
		case "update_caption":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				elementId: operation.elementId,
				text: operation.text,
				startTime: operation.startTime,
				duration: operation.duration,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "delete":
			return {
				...operation,
				ripple: operation.ripple ?? false,
				relationshipScope: operation.relationshipScope ?? "all",
			};
		case "duplicate_elements":
			return {
				...operation,
				duplicateIds: operation.duplicateIds,
				relationshipScope: operation.relationshipScope ?? "all",
			};
		case "create_compound":
			return {
				...operation,
				name: operation.name,
				targetTrackId: operation.targetTrackId,
				relationshipScope: operation.relationshipScope ?? "all",
			};
		case "break_apart_compound":
			return { ...operation, restoredElementIds: operation.restoredElementIds };
		case "set_group":
		case "clear_group":
		case "set_link":
		case "clear_link":
			return operation;
		case "move":
			return {
				...operation,
				targetTrackId: operation.targetTrackId,
				relationshipScope: operation.relationshipScope ?? "all",
			};
		case "set_params":
			return operation;
		case "set_reframe":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				elementId: operation.elementId,
				mode: operation.mode,
				crop: operation.crop,
				focalPoint: operation.focalPoint,
				targetRect: operation.targetRect,
				layout: operation.layout,
			};
		case "set_audio":
			return {
				kind: operation.kind,
				trackId: operation.trackId,
				elementId: operation.elementId,
				volumeDb: operation.volumeDb,
				muted: operation.muted,
				fade: operation.fade,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "separate_source_audio":
			return {
				...operation,
				audioTrackId: operation.audioTrackId,
				audioElementId: operation.audioElementId,
				linkId: operation.linkId,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "duck_audio":
			return {
				...operation,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "adjust_mix_gain":
			return operation;
		case "upsert_effect":
			return {
				...operation,
				params: operation.params,
				enabled: operation.enabled,
			};
		case "remove_effect":
		case "reorder_effects":
			return operation;
		case "upsert_keyframe":
			return {
				...operation,
				interpolation: operation.interpolation,
				keyframeId: operation.keyframeId,
			};
		case "remove_keyframe":
		case "retime_keyframe":
		case "upsert_transition":
		case "remove_transition":
			return operation;
		case "set_retime":
			return {
				...operation,
				maintainPitch: operation.maintainPitch,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "trim":
			return {
				...operation,
				startTime: operation.startTime,
				duration: operation.duration,
				ripple: operation.ripple ?? false,
				resolvedAllocations: operation.resolvedAllocations,
			};
		case "split":
			return {
				...operation,
				rightElementId: operation.rightElementId,
				retainSide: operation.retainSide,
				ripple: operation.ripple ?? false,
			};
		case "set_matte_state":
		case "remove_matte":
			return operation;
		case "set_mask":
			return { ...operation, params: operation.params };
		case "remove_mask":
		case "set_audio_replacement_state":
		case "remove_audio_replacement":
			return operation;
		default:
			return unreachable(operation);
	}
}

function unreachable(value: never): never {
	throw new Error(`Unsupported edit operation: ${String(value)}`);
}
