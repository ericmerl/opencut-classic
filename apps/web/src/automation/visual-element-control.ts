import type { Command } from "@/commands/base-command";
import { InsertElementCommand } from "@/commands/timeline";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { getGraphicDefinition } from "@/graphics";
import {
	coerceParamValue,
	type ParamDefinition,
	type ParamValues,
} from "@/params";
import { getBuiltInElementParams } from "@/params/registry";
import { resolveStickerId } from "@/stickers";
import { parseShapeStickerId } from "@/stickers/providers/shapes";
import type { TimelineElement } from "@/timeline";
import {
	buildEffectElement,
	buildGraphicElement,
	buildStickerElement,
} from "@/timeline/element-utils";
import type { AutomationEditOperation } from "./types";
import { resolveElementAutoTrackId } from "./resolved-object-ids";

type VisualInsertionOperation = Extract<
	AutomationEditOperation,
	{
		kind: "insert_graphic" | "insert_sticker" | "insert_adjustment_layer";
	}
>;

function coerceRequestedParams({
	definitions,
	requested,
}: {
	definitions: readonly ParamDefinition[];
	requested: Record<string, string | number | boolean> | undefined;
}): ParamValues {
	const result: ParamValues = {};
	for (const [key, requestedValue] of Object.entries(requested ?? {})) {
		const definition = definitions.find((candidate) => candidate.key === key);
		if (!definition) throw new Error(`unsupported parameter: ${key}`);
		const value = coerceParamValue({
			param: definition,
			value: requestedValue,
		});
		if (value === null) throw new Error(`invalid value for parameter ${key}`);
		result[key] = value;
	}
	return result;
}

function placement(operation: VisualInsertionOperation) {
	return operation.trackId
		? ({ mode: "explicit", trackId: operation.trackId } as const)
		: ({ mode: "auto" } as const);
}

export function buildVisualInsertionCommand({
	operation,
}: {
	operation: VisualInsertionOperation;
}): Command {
	if (!Number.isSafeInteger(operation.startTime) || operation.startTime < 0) {
		throw new Error("startTime must be a non-negative integer tick value");
	}
	if (!Number.isSafeInteger(operation.duration) || operation.duration <= 0) {
		throw new Error("duration must be a positive integer tick value");
	}
	const newTrackId = resolveElementAutoTrackId({
		elementId: operation.elementId,
		autoTrackId: operation.autoTrackId,
		resolvedAllocations: operation.resolvedAllocations,
	});

	if (operation.kind === "insert_graphic") {
		const graphic = getGraphicDefinition({
			definitionId: operation.definitionId,
		});
		const params = coerceRequestedParams({
			definitions: [
				...getBuiltInElementParams({ type: "graphic" }),
				...graphic.params,
			],
			requested: operation.params,
		});
		return new InsertElementCommand({
			placement: placement(operation),
			elementId: operation.elementId,
			newTrackId,
			element: {
				...buildGraphicElement({
					definitionId: operation.definitionId,
					name: operation.name,
					startTime: operation.startTime,
					params,
				}),
				duration: operation.duration,
			},
		});
	}

	if (operation.kind === "insert_sticker") {
		const shape = parseShapeStickerId({ stickerId: operation.stickerId });
		if (shape) {
			const graphic = getGraphicDefinition({
				definitionId: shape.definitionId,
			});
			const params = coerceRequestedParams({
				definitions: [
					...getBuiltInElementParams({ type: "graphic" }),
					...graphic.params,
				],
				requested: operation.params,
			});
			return new InsertElementCommand({
				placement: placement(operation),
				elementId: operation.elementId,
				newTrackId,
				element: {
					...buildGraphicElement({
						definitionId: shape.definitionId,
						name: operation.name ?? shape.name,
						startTime: operation.startTime,
						params: { ...shape.params, ...params },
					}),
					duration: operation.duration,
				},
			});
		}

		resolveStickerId({ stickerId: operation.stickerId });
		const params = coerceRequestedParams({
			definitions: getBuiltInElementParams({ type: "sticker" }),
			requested: operation.params,
		});
		const element = buildStickerElement({
			stickerId: operation.stickerId,
			name: operation.name,
			startTime: operation.startTime,
		});
		return new InsertElementCommand({
			placement: placement(operation),
			elementId: operation.elementId,
			newTrackId,
			element: {
				...element,
				duration: operation.duration,
				params: { ...element.params, ...params },
			},
		});
	}

	registerDefaultEffects();
	const definition = effectsRegistry.get(operation.effectType);
	const params = coerceRequestedParams({
		definitions: definition.params,
		requested: operation.params,
	});
	const element = buildEffectElement({
		effectType: operation.effectType,
		startTime: operation.startTime,
		duration: operation.duration,
	});
	return new InsertElementCommand({
		placement: placement(operation),
		elementId: operation.elementId,
		newTrackId,
		element: {
			...element,
			name: operation.name ?? element.name,
			params: { ...element.params, ...params },
		},
	});
}

export function buildDefinitionParamPatch({
	element,
	requested,
}: {
	element: TimelineElement;
	requested: Record<string, string | number | boolean>;
}): Partial<TimelineElement> | null {
	const specializedDefinitions =
		element.type === "graphic"
			? getGraphicDefinition({ definitionId: element.definitionId }).params
			: element.type === "effect"
				? (() => {
						registerDefaultEffects();
						return effectsRegistry.get(element.effectType).params;
					})()
				: null;
	if (!specializedDefinitions) return null;
	const definitions = [
		...getBuiltInElementParams({ type: element.type }),
		...specializedDefinitions,
	];
	const params = coerceRequestedParams({
		definitions,
		requested,
	});
	return {
		params: { ...element.params, ...params },
	} as Partial<TimelineElement>;
}
