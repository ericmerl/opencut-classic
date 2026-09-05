import type { Command } from "@/commands/base-command";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { findTrackTransition, type TimelineTrack } from "@/timeline";
import type { AutomationEditOperation } from "./types";
import { evaluateTransition } from "opencut-wasm";

type TransitionOperation = Extract<
	AutomationEditOperation,
	{ kind: "upsert_transition" | "remove_transition" }
>;

export function buildTransitionCommand({
	track,
	operation,
}: {
	track: TimelineTrack;
	operation: TransitionOperation;
}): Command {
	if (operation.kind === "remove_transition") {
		const state = findTrackTransition({
			track,
			transitionId: operation.transitionId,
		});
		if (!state) {
			throw new Error(`transition not found: ${operation.transitionId}`);
		}
		return new UpdateElementsCommand({
			updates: [
				{
					trackId: track.id,
					elementId: state.toElement.id,
					patch: { transitionIn: undefined },
				},
			],
		});
	}

	const fromElement = track.elements.find(
		(element) => element.id === operation.fromElementId,
	);
	const toElement = track.elements.find(
		(element) => element.id === operation.toElementId,
	);
	if (!fromElement || !toElement) {
		throw new Error("transition elements must exist on the requested track");
	}
	const validation = evaluateTransition({
		transitionId: operation.transitionId,
		transitionType: operation.transitionType,
		trackType: track.type,
		fromElement: transitionBoundary(fromElement),
		toElement: transitionBoundary(toElement),
		duration: operation.duration,
		existingIncomingTransitionId: toElement.transitionIn?.id,
	});
	if (validation.status === "rejected") {
		throw new Error(validation.reason);
	}
	const candidate = {
		...toElement,
		transitionIn: {
			id: operation.transitionId,
			type: operation.transitionType,
			duration: operation.duration,
			fromElementId: operation.fromElementId,
		},
	};
	return new UpdateElementsCommand({
		updates: [
			{
				trackId: track.id,
				elementId: toElement.id,
				patch: { transitionIn: candidate.transitionIn },
			},
		],
	});
}

function transitionBoundary(element: TimelineTrack["elements"][number]) {
	return {
		id: element.id,
		type: element.type,
		startTime: element.startTime,
		duration: element.duration,
		hasMasks: "masks" in element && Boolean(element.masks?.length),
	};
}
