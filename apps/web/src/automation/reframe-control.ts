import { UpdateElementsCommand } from "@/commands/timeline";
import {
	buildReframeFromParams,
	type NormalizedRect,
	type ReframeConfig,
} from "@/rendering";
import type { TimelineElement } from "@/timeline";
import type {
	AutomationEditOperation,
	AutomationReframeLayout,
	AutomationReframeSnapshot,
} from "./types";

const LAYOUT_RECTS: Record<AutomationReframeLayout, NormalizedRect> = {
	"full-frame": { x: 0, y: 0, width: 1, height: 1 },
	"split-left": { x: 0, y: 0, width: 0.5, height: 1 },
	"split-right": { x: 0.5, y: 0, width: 0.5, height: 1 },
	"split-top": { x: 0, y: 0, width: 1, height: 0.5 },
	"split-bottom": { x: 0, y: 0.5, width: 1, height: 0.5 },
	"pip-top-left": { x: 0.04, y: 0.04, width: 0.32, height: 0.32 },
	"pip-top-right": { x: 0.64, y: 0.04, width: 0.32, height: 0.32 },
	"pip-bottom-left": { x: 0.04, y: 0.64, width: 0.32, height: 0.32 },
	"pip-bottom-right": { x: 0.64, y: 0.64, width: 0.32, height: 0.32 },
};

type SetReframeOperation = Extract<
	AutomationEditOperation,
	{ kind: "set_reframe" }
>;

export function buildReframeControlCommand({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: SetReframeOperation;
}): UpdateElementsCommand {
	if (element.type !== "video" && element.type !== "image") {
		throw new Error("reframing is only supported for video and image elements");
	}
	const reframe = resolveReframe({
		current: buildReframeFromParams({ params: element.params }),
		operation,
	});
	return new UpdateElementsCommand({
		updates: [
			{
				trackId: operation.trackId,
				elementId: operation.elementId,
				patch: { params: { ...element.params, ...toParams(reframe) } },
			},
		],
	});
}

export function buildReframeSnapshot({
	element,
}: {
	element: TimelineElement;
}): AutomationReframeSnapshot | undefined {
	if (element.type !== "video" && element.type !== "image") return undefined;
	return buildReframeFromParams({ params: element.params });
}

export function resolveReframe({
	current,
	operation,
}: {
	current: ReframeConfig;
	operation: SetReframeOperation;
}): ReframeConfig {
	if (
		operation.mode === undefined &&
		operation.crop === undefined &&
		operation.focalPoint === undefined &&
		operation.targetRect === undefined &&
		operation.layout === undefined
	) {
		throw new Error("at least one reframe control is required");
	}
	if (operation.targetRect && operation.layout) {
		throw new Error("targetRect and layout cannot be combined");
	}
	const crop = operation.crop ?? current.crop;
	const targetRect =
		operation.targetRect ??
		(operation.layout ? LAYOUT_RECTS[operation.layout] : current.targetRect);
	assertRect(crop, "crop");
	assertRect(targetRect, "targetRect");
	const focalPoint = operation.focalPoint ?? current.focalPoint;
	assertUnit(focalPoint.x, "focalPoint.x");
	assertUnit(focalPoint.y, "focalPoint.y");
	return {
		mode: normalizeMode(operation.mode ?? current.mode),
		crop: { ...crop },
		focalPoint: { ...focalPoint },
		targetRect: { ...targetRect },
	};
}

function normalizeMode(
	mode: SetReframeOperation["mode"] | ReframeConfig["mode"],
): ReframeConfig["mode"] {
	if (mode === "fit") return "contain";
	if (mode === "fill") return "cover";
	return mode ?? "contain";
}

function assertRect(rect: NormalizedRect, label: string): void {
	assertUnit(rect.x, `${label}.x`);
	assertUnit(rect.y, `${label}.y`);
	if (!Number.isFinite(rect.width) || rect.width < 0.001) {
		throw new Error(`${label}.width must be at least 0.001`);
	}
	if (!Number.isFinite(rect.height) || rect.height < 0.001) {
		throw new Error(`${label}.height must be at least 0.001`);
	}
	if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
		throw new Error(`${label} must stay inside normalized bounds`);
	}
}

function assertUnit(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${label} must be between 0 and 1`);
	}
}

function toParams(reframe: ReframeConfig): Record<string, string | number> {
	return {
		"reframe.mode": reframe.mode,
		"reframe.cropX": reframe.crop.x,
		"reframe.cropY": reframe.crop.y,
		"reframe.cropWidth": reframe.crop.width,
		"reframe.cropHeight": reframe.crop.height,
		"reframe.focalX": reframe.focalPoint.x,
		"reframe.focalY": reframe.focalPoint.y,
		"reframe.targetX": reframe.targetRect.x,
		"reframe.targetY": reframe.targetRect.y,
		"reframe.targetWidth": reframe.targetRect.width,
		"reframe.targetHeight": reframe.targetRect.height,
	};
}
