import type { Command } from "@/commands/base-command";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import {
	findTrackTransition,
	getTrackTransitionStates,
	type TimelineTrack,
} from "@/timeline";
import type { AutomationEditOperation } from "./types";

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
	if (track.type !== "video") {
		throw new Error("transitions require a video track");
	}
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
	if (fromElement.type === "compound" || toElement.type === "compound") {
		throw new Error("compound clip transitions are not supported");
	}
	if (
		!Number.isSafeInteger(operation.duration) ||
		operation.duration <= 0 ||
		operation.duration > fromElement.duration ||
		operation.duration > toElement.duration
	) {
		throw new Error(
			"transition duration must be positive and no longer than either clip",
		);
	}
	const existing = toElement.transitionIn;
	if (existing && existing.id !== operation.transitionId) {
		throw new Error(
			`incoming clip already has transition ${existing.id}; update that ID or remove it first`,
		);
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
	const validationTrack = {
		...track,
		elements: track.elements.map((element) =>
			element.id === candidate.id ? candidate : element,
		),
	} as TimelineTrack;
	const state = getTrackTransitionStates({ track: validationTrack }).find(
		(item) => item.transition.id === operation.transitionId,
	);
	if (!state?.isAdjacent) {
		throw new Error("transition clips must be consecutive and edge-adjacent");
	}
	if (
		operation.transitionType === "wipe" &&
		"masks" in toElement &&
		toElement.masks?.length
	) {
		throw new Error(
			"wipe transitions do not yet support masked incoming clips",
		);
	}

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
