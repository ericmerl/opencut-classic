import { getKeyframeById } from "@/animation";
import type { Command } from "@/commands/base-command";
import { RemoveKeyframeCommand } from "@/commands/timeline/element/keyframes/remove-keyframe";
import { RetimeKeyframeCommand } from "@/commands/timeline/element/keyframes/retime-keyframe";
import { UpsertKeyframeCommand } from "@/commands/timeline/element/keyframes/upsert-keyframe";
import type { TimelineElement } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type { AutomationEditOperation } from "./types";

type KeyframeOperation = Extract<
	AutomationEditOperation,
	{ kind: "upsert_keyframe" | "remove_keyframe" | "retime_keyframe" }
>;

function assertLocalTime({
	time,
	duration,
}: {
	time: number;
	duration: number;
}): void {
	if (!Number.isSafeInteger(time) || time < 0 || time > duration) {
		throw new Error(`keyframe time must be between 0 and ${duration} ticks`);
	}
}

export function buildKeyframeCommand({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: KeyframeOperation;
}): Command {
	const target = resolveAnimationTarget({
		element,
		path: operation.propertyPath,
	});
	if (!target) {
		throw new Error(
			`property ${operation.propertyPath} cannot be keyframed on ${element.type} elements`,
		);
	}

	if (operation.kind === "upsert_keyframe") {
		assertLocalTime({ time: operation.time, duration: element.duration });
		const value = target.coerceValue({ value: operation.value });
		if (value === null) {
			throw new Error(`invalid keyframe value for ${operation.propertyPath}`);
		}
		if (
			typeof value !== "number" &&
			operation.interpolation !== undefined &&
			operation.interpolation !== "hold"
		) {
			throw new Error("discrete keyframes only support hold interpolation");
		}
		return new UpsertKeyframeCommand({
			trackId: operation.trackId,
			elementId: operation.elementId,
			propertyPath: operation.propertyPath,
			time: operation.time,
			value,
			interpolation: operation.interpolation,
			keyframeId: operation.keyframeId,
		});
	}

	const keyframe = getKeyframeById({
		animations: element.animations,
		propertyPath: operation.propertyPath,
		keyframeId: operation.keyframeId,
	});
	if (!keyframe) {
		throw new Error(
			`keyframe not found: ${operation.propertyPath}/${operation.keyframeId}`,
		);
	}
	if (operation.kind === "remove_keyframe") {
		return new RemoveKeyframeCommand({
			trackId: operation.trackId,
			elementId: operation.elementId,
			propertyPath: operation.propertyPath,
			keyframeId: operation.keyframeId,
			valueAtPlayhead: null,
		});
	}

	assertLocalTime({ time: operation.time, duration: element.duration });
	return new RetimeKeyframeCommand({
		trackId: operation.trackId,
		elementId: operation.elementId,
		propertyPath: operation.propertyPath,
		keyframeId: operation.keyframeId,
		nextTime: operation.time,
	});
}
