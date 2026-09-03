import type { ParamValues } from "@/params";
import { buildSubtitleTextElement } from "@/subtitles/build-subtitle-text-element";
import type { SubtitleStyleOverrides } from "@/subtitles/types";
import { DEFAULTS } from "@/timeline/defaults";
import type { CreateTextElement } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";
import type { AutomationEditOperation } from "./types";

export const CAPTION_LAYOUT_VERSION = "opencut.caption-layout.v1";
export const CAPTION_LAYOUT_ENGINE = "browser-canvas-2d";

type CaptionOperation = Extract<
	AutomationEditOperation,
	{ kind: "insert_captions" }
>;
type Caption = CaptionOperation["captions"][number];

export function materializeEditPlanCaptions({
	operations,
	canvasSize,
}: {
	operations: readonly AutomationEditOperation[];
	canvasSize: { width: number; height: number };
}): AutomationEditOperation[] {
	let currentCanvasSize = canvasSize;
	return operations.map((operation) => {
		if (operation.kind === "set_project_settings" && operation.canvasSize) {
			currentCanvasSize = operation.canvasSize;
			return operation;
		}
		if (operation.kind !== "insert_captions") return operation;
		return {
			...operation,
			captions: operation.captions.map((caption, index) => {
				if (hasMaterializationField(caption)) {
					throw new Error(
						"public caption operations cannot provide resolved layout fields",
					);
				}
				const element = buildLegacyCaptionElement({
					caption,
					index,
					style: operation.style,
					canvasSize: currentCanvasSize,
					requireMeasurement: true,
				});
				const resolvedContent = element.params.content;
				if (typeof resolvedContent !== "string") {
					throw new Error("resolved caption content must be a string");
				}
				return {
					...caption,
					resolvedName: element.name,
					resolvedContent,
					resolvedParams: element.params,
					resolvedLayoutVersion: CAPTION_LAYOUT_VERSION,
					resolvedLayoutEngine: CAPTION_LAYOUT_ENGINE,
				};
			}),
		};
	});
}

function hasMaterializationField(caption: Caption): boolean {
	return (
		caption.resolvedName !== undefined ||
		caption.resolvedContent !== undefined ||
		caption.resolvedParams !== undefined ||
		caption.resolvedLayoutVersion !== undefined ||
		caption.resolvedLayoutEngine !== undefined
	);
}

export function buildCaptionElementForNativeApply({
	caption,
	index,
	style,
	canvasSize,
}: {
	caption: Caption;
	index: number;
	style: SubtitleStyleOverrides | undefined;
	canvasSize: { width: number; height: number };
}): CreateTextElement {
	const materialization = readMaterialization(caption);
	if (!materialization) {
		return buildLegacyCaptionElement({ caption, index, style, canvasSize });
	}
	if (materialization.resolvedLayoutVersion !== CAPTION_LAYOUT_VERSION) {
		throw new Error("unsupported resolved caption layout version");
	}
	if (materialization.resolvedLayoutEngine !== CAPTION_LAYOUT_ENGINE) {
		throw new Error("unsupported resolved caption layout engine");
	}
	if (materialization.resolvedName !== `Caption ${index + 1}`) {
		throw new Error("resolved caption name does not match its ordinal");
	}
	if (!materialization.resolvedContent.trim()) {
		throw new Error("resolved caption content is required");
	}
	if (
		materialization.resolvedParams.content !== materialization.resolvedContent
	) {
		throw new Error("resolved caption params content does not match content");
	}

	return {
		...DEFAULTS.text.element,
		name: materialization.resolvedName,
		duration: caption.duration,
		startTime: caption.startTime,
		params: materialization.resolvedParams,
	};
}

function buildLegacyCaptionElement({
	caption,
	index,
	style,
	canvasSize,
	requireMeasurement = false,
}: {
	caption: Caption;
	index: number;
	style: SubtitleStyleOverrides | undefined;
	canvasSize: { width: number; height: number };
	requireMeasurement?: boolean;
}): CreateTextElement {
	return buildSubtitleTextElement({
		index,
		caption: {
			text: caption.text,
			startTime: mediaTimeToSeconds({ time: caption.startTime }),
			duration: mediaTimeToSeconds({ time: caption.duration }),
			style,
		},
		canvasSize,
		requireMeasurement,
	});
}

function readMaterialization(caption: Caption): {
	resolvedName: string;
	resolvedContent: string;
	resolvedParams: ParamValues;
	resolvedLayoutVersion: string;
	resolvedLayoutEngine: string;
} | null {
	const values = [
		caption.resolvedName,
		caption.resolvedContent,
		caption.resolvedParams,
		caption.resolvedLayoutVersion,
		caption.resolvedLayoutEngine,
	];
	const present = values.filter((value) => value !== undefined).length;
	if (present === 0) return null;
	if (present !== values.length) {
		throw new Error("resolved caption materialization must provide all fields");
	}
	if (
		typeof caption.resolvedName !== "string" ||
		typeof caption.resolvedContent !== "string" ||
		typeof caption.resolvedLayoutVersion !== "string" ||
		typeof caption.resolvedLayoutEngine !== "string" ||
		!isParamValues(caption.resolvedParams)
	) {
		throw new Error("resolved caption materialization is invalid");
	}
	return {
		resolvedName: caption.resolvedName,
		resolvedContent: caption.resolvedContent,
		resolvedParams: caption.resolvedParams,
		resolvedLayoutVersion: caption.resolvedLayoutVersion,
		resolvedLayoutEngine: caption.resolvedLayoutEngine,
	};
}

function isParamValues(value: unknown): value is ParamValues {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every(
		(entry) =>
			typeof entry === "string" ||
			typeof entry === "boolean" ||
			(typeof entry === "number" && Number.isFinite(entry)),
	);
}
