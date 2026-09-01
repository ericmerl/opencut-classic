import type { ElementAnimations } from "@/animation/types";
import type { Command } from "@/commands/base-command";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import type { Effect } from "@/effects/types";
import { coerceParamValue } from "@/params";
import { buildDefaultParamValues } from "@/params/registry";
import {
	isVisualElement,
	type TimelineElement,
	type VisualElement,
} from "@/timeline";
import type {
	AutomationEditOperation,
	AutomationEffectCatalogEntry,
} from "./types";

type EffectOperation = Extract<
	AutomationEditOperation,
	{ kind: "upsert_effect" | "remove_effect" | "reorder_effects" }
>;

function withoutEffectAnimations({
	animations,
	effectId,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const prefix = `effects.${effectId}.params.`;
	const retained = Object.fromEntries(
		Object.entries(animations).filter(([path]) => !path.startsWith(prefix)),
	);
	return Object.keys(retained).length > 0 ? retained : undefined;
}

function coerceEffectParams({
	effect,
	requestedParams,
}: {
	effect: Effect;
	requestedParams: Record<string, string | number | boolean> | undefined;
}): Effect {
	if (!requestedParams) return effect;
	const definition = effectsRegistry.get(effect.type);
	const params = { ...effect.params };
	for (const [key, requestedValue] of Object.entries(requestedParams)) {
		const param = definition.params.find((candidate) => candidate.key === key);
		if (!param)
			throw new Error(`effect ${effect.type} has no parameter ${key}`);
		const value = coerceParamValue({ param, value: requestedValue });
		if (value === null) {
			throw new Error(`invalid value for effect parameter ${key}`);
		}
		params[key] = value;
	}
	return { ...effect, params };
}

function buildUpsertPatch({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: Extract<EffectOperation, { kind: "upsert_effect" }>;
}): Partial<VisualElement> {
	if (!isVisualElement(element)) {
		throw new Error("clip effects require a visual timeline element");
	}
	registerDefaultEffects();
	const definition = effectsRegistry.get(operation.effectType);
	const existing = element.effects?.find(
		(effect) => effect.id === operation.effectId,
	);
	if (existing && existing.type !== operation.effectType) {
		throw new Error(
			`effect ${operation.effectId} already has type ${existing.type}`,
		);
	}
	let nextEffect: Effect = existing ?? {
		id: operation.effectId,
		type: operation.effectType,
		params: buildDefaultParamValues(definition.params),
		enabled: true,
	};
	nextEffect = coerceEffectParams({
		effect: nextEffect,
		requestedParams: operation.params,
	});
	if (operation.enabled !== undefined) {
		nextEffect = { ...nextEffect, enabled: operation.enabled };
	}
	return {
		effects: existing
			? element.effects?.map((effect) =>
					effect.id === operation.effectId ? nextEffect : effect,
				)
			: [...(element.effects ?? []), nextEffect],
	};
}

function buildRemovePatch({
	element,
	effectId,
}: {
	element: TimelineElement;
	effectId: string;
}): Partial<VisualElement> {
	if (!isVisualElement(element)) {
		throw new Error("clip effects require a visual timeline element");
	}
	if (!element.effects?.some((effect) => effect.id === effectId)) {
		throw new Error(`effect not found: ${effectId}`);
	}
	return {
		effects: element.effects.filter((effect) => effect.id !== effectId),
		animations: withoutEffectAnimations({
			animations: element.animations,
			effectId,
		}),
	};
}

function buildReorderPatch({
	element,
	effectIds,
}: {
	element: TimelineElement;
	effectIds: string[];
}): Partial<VisualElement> {
	if (!isVisualElement(element)) {
		throw new Error("clip effects require a visual timeline element");
	}
	const effects = element.effects ?? [];
	if (
		new Set(effectIds).size !== effectIds.length ||
		effectIds.length !== effects.length ||
		effectIds.some((id) => !effects.some((effect) => effect.id === id))
	) {
		throw new Error("effectIds must contain every clip effect exactly once");
	}
	const effectMap = new Map(effects.map((effect) => [effect.id, effect]));
	return { effects: effectIds.map((id) => effectMap.get(id)!) };
}

export function buildEffectControlCommand({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: EffectOperation;
}): Command {
	const patch = buildEffectControlPatch({ element, operation });
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

export function buildEffectControlPatch({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: EffectOperation;
}): Partial<VisualElement> {
	return operation.kind === "upsert_effect"
		? buildUpsertPatch({ element, operation })
		: operation.kind === "remove_effect"
			? buildRemovePatch({ element, effectId: operation.effectId })
			: buildReorderPatch({ element, effectIds: operation.effectIds });
}

export function listEffectCatalog(): AutomationEffectCatalogEntry[] {
	registerDefaultEffects();
	return effectsRegistry.getAll().map((definition) => ({
		effectType: definition.type,
		name: definition.name,
		keywords: definition.keywords,
		params: definition.params.map((param) => ({
			key: param.key,
			label: param.label,
			type: param.type,
			default: param.default,
			keyframable: param.keyframable !== false,
			...(param.type === "number"
				? { min: param.min, max: param.max, step: param.step }
				: {}),
			...(param.type === "select" ? { options: param.options } : {}),
		})),
	}));
}
