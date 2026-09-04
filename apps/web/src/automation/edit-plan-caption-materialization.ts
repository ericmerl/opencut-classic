import type { ParamValues } from "@/params";
import {
	buildSubtitleTextElement,
	createCaptionMeasurementContext,
	measureSubtitleCaption,
	resolveSubtitleFontParams,
} from "@/subtitles/build-subtitle-text-element";
import type { SubtitleStyleOverrides } from "@/subtitles/types";
import {
	CAPTION_GEOMETRY_VERSION,
	CAPTION_MEASUREMENT_FUNCTION,
} from "@/text/caption-layout";
import type { TextCanvasContext } from "@/text/layout";
import { DEFAULTS } from "@/timeline/defaults";
import type { CreateTextElement } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";
import {
	fontDescriptorFromParams,
	waitForFontDescriptors,
	type FontDescriptorRequest,
} from "./preview-font-readiness";
import { sha256Bytes } from "./preview-render-common";
import { canonicalSerialize } from "./project-content-hash";
import type {
	AutomationCaptionLayoutEvidence,
	AutomationEditOperation,
} from "./types";

export const CAPTION_LAYOUT_VERSION = "opencut.caption-layout.v1";
export const CAPTION_LAYOUT_ENGINE = "browser-canvas-2d";

type CaptionOperation = Extract<
	AutomationEditOperation,
	{ kind: "insert_captions" }
>;
type Caption = CaptionOperation["captions"][number];

export interface MaterializedEditPlanCaptions {
	operations: AutomationEditOperation[];
	/** Present when the plan inserts captions; null otherwise. */
	captionLayout: AutomationCaptionLayoutEvidence | null;
}

/**
 * Resolves every caption in the plan to the exact element the editor will
 * insert. The fonts each caption names are loaded and verified first through
 * the shared readiness procedure, then wrapping and placement run through the
 * renderer's measurement function, and the resulting per-line geometry is
 * returned as evidence bound to the plan by hash.
 */
export async function materializeEditPlanCaptions({
	operations,
	canvasSize,
	createContext = createCaptionMeasurementContext,
	waitForFonts = waitForFontDescriptors,
}: {
	operations: readonly AutomationEditOperation[];
	canvasSize: { width: number; height: number };
	createContext?: () => TextCanvasContext | null;
	waitForFonts?: typeof waitForFontDescriptors;
}): Promise<MaterializedEditPlanCaptions> {
	const captionOperations = operations.filter(
		(operation) => operation.kind === "insert_captions",
	);
	if (captionOperations.length === 0) {
		return { operations: [...operations], captionLayout: null };
	}
	for (const operation of captionOperations) {
		if (operation.captions.some(hasMaterializationField)) {
			throw new Error(
				"public caption operations cannot provide resolved layout fields",
			);
		}
	}
	const descriptors = new Map<string, FontDescriptorRequest>();
	for (const operation of captionOperations) {
		const descriptor = fontDescriptorFromParams(
			resolveSubtitleFontParams({ style: operation.style }),
		);
		descriptors.set(descriptor.css, descriptor);
	}
	const fontReadiness = await waitForFonts(
		[...descriptors.values()].sort((left, right) =>
			left.css.localeCompare(right.css),
		),
	);
	const ctx = createContext();
	if (!ctx) {
		throw new Error("caption layout requires a Canvas 2D measurement context");
	}
	const captions: AutomationCaptionLayoutEvidence["captions"] = [];
	let currentCanvasSize = canvasSize;
	const materialized = operations.map((operation, operationIndex) => {
		if (operation.kind === "set_project_settings" && operation.canvasSize) {
			currentCanvasSize = operation.canvasSize;
			return operation;
		}
		if (operation.kind !== "insert_captions") return operation;
		const fontDescriptorCss = fontDescriptorFromParams(
			resolveSubtitleFontParams({ style: operation.style }),
		).css;
		return {
			...operation,
			captions: operation.captions.map((caption, captionIndex) => {
				const measured = measureSubtitleCaption({
					index: captionIndex,
					caption: {
						text: caption.text,
						startTime: mediaTimeToSeconds({ time: caption.startTime }),
						duration: mediaTimeToSeconds({ time: caption.duration }),
						style: operation.style,
					},
					canvasSize: currentCanvasSize,
					ctx,
				});
				const resolvedContent = measured.element.params.content;
				if (typeof resolvedContent !== "string") {
					throw new Error("resolved caption content must be a string");
				}
				captions.push({
					operationIndex,
					captionIndex,
					elementName: measured.element.name,
					fontDescriptorCss,
					geometry: measured.geometry,
				});
				return {
					...caption,
					resolvedName: measured.element.name,
					resolvedContent,
					resolvedParams: measured.element.params,
					resolvedLayoutVersion: CAPTION_LAYOUT_VERSION,
					resolvedLayoutEngine: CAPTION_LAYOUT_ENGINE,
				};
			}),
		};
	});
	return {
		operations: materialized,
		captionLayout: {
			layoutVersion: CAPTION_LAYOUT_VERSION,
			layoutEngine: CAPTION_LAYOUT_ENGINE,
			geometryVersion: CAPTION_GEOMETRY_VERSION,
			measurement: CAPTION_MEASUREMENT_FUNCTION,
			fontReadiness,
			captions,
			geometrySha256: await sha256Bytes(
				new TextEncoder().encode(canonicalSerialize(captions)),
			),
		},
	};
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
