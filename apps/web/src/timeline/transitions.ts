import type { ClipTransition, TimelineElement, TimelineTrack } from "./types";

export interface TrackTransitionState {
	transition: ClipTransition;
	fromElement: TimelineElement | null;
	toElement: TimelineElement;
	isAdjacent: boolean;
}

function sortedElements({
	track,
}: {
	track: TimelineTrack;
}): TimelineElement[] {
	return track.elements
		.slice()
		.sort(
			(left, right) =>
				left.startTime - right.startTime || left.id.localeCompare(right.id),
		);
}

export function getTrackTransitionStates({
	track,
}: {
	track: TimelineTrack;
}): TrackTransitionState[] {
	const elements = sortedElements({ track });
	return elements.flatMap((toElement, index) => {
		const transition = toElement.transitionIn;
		if (!transition) return [];
		const fromElement =
			elements.find((element) => element.id === transition.fromElementId) ??
			null;
		const previousElement = elements[index - 1] ?? null;
		return [
			{
				transition,
				fromElement,
				toElement,
				isAdjacent:
					fromElement !== null &&
					previousElement?.id === fromElement.id &&
					fromElement.startTime + fromElement.duration === toElement.startTime,
			},
		];
	});
}

export function findTrackTransition({
	track,
	transitionId,
}: {
	track: TimelineTrack;
	transitionId: string;
}): TrackTransitionState | null {
	return (
		getTrackTransitionStates({ track }).find(
			(state) => state.transition.id === transitionId,
		) ?? null
	);
}
