import type { Command } from "@/commands/base-command";
import { UpdateElementsCommand } from "@/commands/timeline";
import {
	buildDefaultMaskInstance,
	getMaskDefinition,
	registerDefaultMasks,
} from "@/masks";
import type { FreeformPathPoint } from "@/masks/freeform/path";
import type { MaskableElement, TimelineElement } from "@/timeline";
import { isMaskableElement } from "@/timeline/element-utils";
import { coerceParamValue } from "@/params";
import type {
	AutomationEditOperation,
	AutomationMaskParamValue,
} from "./types";

type MaskOperation = Extract<
	AutomationEditOperation,
	{ kind: "set_mask" | "remove_mask" }
>;

function validatePath(value: AutomationMaskParamValue): FreeformPathPoint[] {
	if (!Array.isArray(value)) throw new Error("mask path must be an array");
	const ids = new Set<string>();
	for (const point of value) {
		if (!point.id.trim()) throw new Error("mask path point ID is required");
		if (ids.has(point.id))
			throw new Error(`duplicate mask path point: ${point.id}`);
		ids.add(point.id);
		for (const coordinate of [
			point.x,
			point.y,
			point.inX,
			point.inY,
			point.outX,
			point.outY,
		]) {
			if (!Number.isFinite(coordinate)) {
				throw new Error("mask path coordinates must be finite numbers");
			}
		}
	}
	return value;
}

function buildMask({
	operation,
}: {
	operation: Extract<MaskOperation, { kind: "set_mask" }>;
}): Mask {
	registerDefaultMasks();
	const definition = getMaskDefinition(operation.maskType);
	const defaultMask = buildDefaultMaskInstance({
		maskType: operation.maskType,
	});
	const params: Record<string, unknown> = {};
	for (const [key, requestedValue] of Object.entries(operation.params ?? {})) {
		if (key === "inverted") {
			if (typeof requestedValue !== "boolean") {
				throw new Error("mask inverted must be a boolean");
			}
			params.inverted = requestedValue;
			continue;
		}
		if (key === "strokeAlign") {
			if (
				typeof requestedValue !== "string" ||
				!["inside", "center", "outside"].includes(requestedValue)
			) {
				throw new Error("mask strokeAlign must be inside, center, or outside");
			}
			params.strokeAlign = requestedValue;
			continue;
		}
		if (key === "path") {
			if (operation.maskType !== "freeform") {
				throw new Error("only freeform masks accept path points");
			}
			params.path = validatePath(requestedValue);
			continue;
		}
		if (key === "closed") {
			if (operation.maskType !== "freeform") {
				throw new Error("only freeform masks accept closed");
			}
			if (typeof requestedValue !== "boolean") {
				throw new Error("mask closed must be a boolean");
			}
			params.closed = requestedValue;
			continue;
		}
		const param = definition.params.find((candidate) => candidate.key === key);
		if (!param)
			throw new Error(`mask ${operation.maskType} has no parameter ${key}`);
		const value = coerceParamValue({ param, value: requestedValue });
		if (value === null)
			throw new Error(`invalid value for mask parameter ${key}`);
		params[key] = value;
	}
	Object.assign(defaultMask.params, params);
	if (
		defaultMask.type === "freeform" &&
		defaultMask.params.closed &&
		defaultMask.params.path.length < 3
	) {
		throw new Error("a closed freeform mask requires at least three points");
	}
	return {
		...defaultMask,
		id: operation.maskId,
	};
}

export function buildAuthoredMaskCommand({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: MaskOperation;
}): Command {
	const patch = buildAuthoredMaskPatch({ element, operation });
	return new UpdateElementsCommand({
		updates: [
			{
				trackId: operation.trackId,
				elementId: operation.elementId,
				patch,
			},
		],
	});
}

export function buildAuthoredMaskPatch({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: MaskOperation;
}): Partial<MaskableElement> {
	if (!isMaskableElement(element)) {
		throw new Error(
			"authored masks require a video, image, or graphic element",
		);
	}
	if (operation.kind === "remove_mask") {
		if (!element.masks?.some((mask) => mask.id === operation.maskId)) {
			throw new Error(`mask not found: ${operation.maskId}`);
		}
		return { masks: [] };
	}
	return { masks: [buildMask({ operation })] };
}
