import { mediaTime, type MediaTime } from "@/wasm";
import type {
	AutomationElementSnapshot,
	AutomationProjectSnapshot,
	AutomationTrackSnapshot,
} from "./types";

export interface AutomationTimelineQueryRequest {
	projectId: string;
	expectedRevision: number;
	startTime?: number;
	endTime?: number;
	trackIds?: string[];
	elementTypes?: string[];
}

export interface AutomationTimelineQueryElement {
	elementId: string;
	type: string;
	name: string;
	startTime: MediaTime;
	endTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration: MediaTime;
	mediaId?: string;
	hidden?: boolean;
}

export interface AutomationTimelineQueryGap {
	startTime: MediaTime;
	endTime: MediaTime;
	duration: MediaTime;
}

export interface AutomationTimelineQueryOverlap {
	firstElementId: string;
	secondElementId: string;
	startTime: MediaTime;
	endTime: MediaTime;
	duration: MediaTime;
}

export interface AutomationTimelineQueryRelationship {
	fromElementId: string;
	toElementId: string;
	kind: "cut" | "gap" | "overlap";
	fromEndTime: MediaTime;
	toStartTime: MediaTime;
	duration: MediaTime;
	transition?: {
		transitionId: string;
		type: string;
		duration: MediaTime;
		valid: boolean;
	};
}

export interface AutomationTimelineQueryTrack {
	trackId: string;
	name: string;
	type: string;
	role: AutomationTrackSnapshot["role"];
	muted?: boolean;
	hidden?: boolean;
	elements: AutomationTimelineQueryElement[];
	gaps: AutomationTimelineQueryGap[];
	overlaps: AutomationTimelineQueryOverlap[];
	relationships: AutomationTimelineQueryRelationship[];
}

export type AutomationTimelineQueryResult =
	| {
			status: "queried";
			projectId: string;
			sceneId: string;
			revision: number;
			projectDuration: MediaTime;
			range: { startTime: MediaTime; endTime: MediaTime };
			filters: { trackIds?: string[]; elementTypes?: string[] };
			tracks: AutomationTimelineQueryTrack[];
	  }
	| {
			status: "conflict";
			projectId: string;
			sceneId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| {
			status: "rejected";
			projectId: string;
			sceneId: string;
			activeProjectId?: string;
			reason: string;
	  };

function elementEnd(element: AutomationElementSnapshot): MediaTime {
	return mediaTime({ ticks: element.startTime + element.duration });
}

function compareElements({
	left,
	right,
}: {
	left: AutomationElementSnapshot;
	right: AutomationElementSnapshot;
}): number {
	return (
		left.startTime - right.startTime ||
		elementEnd(left) - elementEnd(right) ||
		left.elementId.localeCompare(right.elementId)
	);
}

function intersectsRange({
	element,
	startTime,
	endTime,
}: {
	element: AutomationElementSnapshot;
	startTime: MediaTime;
	endTime: MediaTime;
}): boolean {
	const elementEndTime = elementEnd(element);
	return startTime === endTime
		? element.startTime <= startTime && elementEndTime >= endTime
		: element.startTime < endTime && elementEndTime > startTime;
}

function buildGaps({
	elements,
	startTime,
	endTime,
}: {
	elements: AutomationElementSnapshot[];
	startTime: MediaTime;
	endTime: MediaTime;
}): AutomationTimelineQueryGap[] {
	if (startTime === endTime) return [];
	const gaps: AutomationTimelineQueryGap[] = [];
	let cursor = startTime;
	for (const element of elements) {
		const intervalStart = Math.max(startTime, element.startTime);
		const intervalEnd = Math.min(endTime, elementEnd(element));
		if (intervalEnd <= cursor) continue;
		if (intervalStart > cursor) {
			gaps.push({
				startTime: cursor,
				endTime: mediaTime({ ticks: intervalStart }),
				duration: mediaTime({ ticks: intervalStart - cursor }),
			});
		}
		cursor = mediaTime({ ticks: Math.max(cursor, intervalEnd) });
		if (cursor >= endTime) break;
	}
	if (cursor < endTime) {
		gaps.push({
			startTime: cursor,
			endTime,
			duration: mediaTime({ ticks: endTime - cursor }),
		});
	}
	return gaps;
}

function buildOverlaps({
	elements,
	startTime,
	endTime,
}: {
	elements: AutomationElementSnapshot[];
	startTime: MediaTime;
	endTime: MediaTime;
}): AutomationTimelineQueryOverlap[] {
	const overlaps: AutomationTimelineQueryOverlap[] = [];
	for (let leftIndex = 0; leftIndex < elements.length; leftIndex += 1) {
		const left = elements[leftIndex];
		if (!left) continue;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < elements.length;
			rightIndex += 1
		) {
			const right = elements[rightIndex];
			if (!right || right.startTime >= elementEnd(left)) break;
			const overlapStart = Math.max(startTime, left.startTime, right.startTime);
			const overlapEnd = Math.min(endTime, elementEnd(left), elementEnd(right));
			if (overlapEnd <= overlapStart) continue;
			overlaps.push({
				firstElementId: left.elementId,
				secondElementId: right.elementId,
				startTime: mediaTime({ ticks: overlapStart }),
				endTime: mediaTime({ ticks: overlapEnd }),
				duration: mediaTime({ ticks: overlapEnd - overlapStart }),
			});
		}
	}
	return overlaps;
}

function buildRelationships({
	snapshot,
	trackId,
	elements,
}: {
	snapshot: AutomationProjectSnapshot;
	trackId: string;
	elements: AutomationElementSnapshot[];
}): AutomationTimelineQueryRelationship[] {
	return elements.slice(1).map((element, index) => {
		const previous = elements[index];
		if (!previous) throw new Error("timeline relationship is missing a source");
		const delta = element.startTime - elementEnd(previous);
		const kind = delta === 0 ? "cut" : delta > 0 ? "gap" : "overlap";
		const transition = snapshot.transitions.find(
			(candidate) =>
				candidate.trackId === trackId &&
				candidate.fromElementId === previous.elementId &&
				candidate.toElementId === element.elementId,
		);
		return {
			fromElementId: previous.elementId,
			toElementId: element.elementId,
			kind,
			fromEndTime: elementEnd(previous),
			toStartTime: element.startTime,
			duration: mediaTime({ ticks: Math.abs(delta) }),
			...(transition
				? {
						transition: {
							transitionId: transition.transitionId,
							type: transition.type,
							duration: transition.duration,
							valid: transition.valid,
						},
					}
				: {}),
		};
	});
}

function toQueryElement(
	element: AutomationElementSnapshot,
): AutomationTimelineQueryElement {
	return {
		elementId: element.elementId,
		type: element.type,
		name: element.name,
		startTime: element.startTime,
		endTime: elementEnd(element),
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		sourceDuration: element.sourceDuration,
		...(element.mediaId ? { mediaId: element.mediaId } : {}),
		...(element.hidden === undefined ? {} : { hidden: element.hidden }),
	};
}

function isValidTick(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

export function queryTimelineSnapshot({
	snapshot,
	request,
}: {
	snapshot: AutomationProjectSnapshot;
	request: AutomationTimelineQueryRequest;
}): AutomationTimelineQueryResult {
	if (request.projectId !== snapshot.projectId) {
		return {
			status: "rejected",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			activeProjectId: snapshot.projectId,
			reason: "projectId does not match active project",
		};
	}
	if (request.expectedRevision !== snapshot.revision) {
		return {
			status: "conflict",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			expectedRevision: request.expectedRevision,
			actualRevision: snapshot.revision,
		};
	}
	const projectDuration = mediaTime({
		ticks: snapshot.elements.reduce(
			(maximum, element) => Math.max(maximum, elementEnd(element)),
			0,
		),
	});
	const requestedStart = request.startTime ?? 0;
	const requestedEnd = request.endTime ?? projectDuration;
	if (!isValidTick(requestedStart) || !isValidTick(requestedEnd)) {
		return {
			status: "rejected",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			reason: "startTime and endTime must be non-negative safe integer ticks",
		};
	}
	if (requestedEnd < requestedStart) {
		return {
			status: "rejected",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			reason: "endTime must not precede startTime",
		};
	}
	if (request.trackIds?.length === 0 || request.elementTypes?.length === 0) {
		return {
			status: "rejected",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			reason: "query filters must not be empty",
		};
	}
	if (
		(request.trackIds &&
			new Set(request.trackIds).size !== request.trackIds.length) ||
		(request.elementTypes &&
			new Set(request.elementTypes).size !== request.elementTypes.length)
	) {
		return {
			status: "rejected",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			reason: "query filters must not contain duplicates",
		};
	}
	const unknownTrackIds =
		request.trackIds?.filter(
			(trackId) => !snapshot.tracks.some((track) => track.trackId === trackId),
		) ?? [];
	if (unknownTrackIds.length > 0) {
		return {
			status: "rejected",
			projectId: request.projectId,
			sceneId: snapshot.sceneId,
			reason: `unknown trackIds: ${unknownTrackIds.join(", ")}`,
		};
	}
	const startTime = mediaTime({ ticks: requestedStart });
	const endTime = mediaTime({ ticks: requestedEnd });
	const selectedTracks = snapshot.tracks.filter(
		(track) => !request.trackIds || request.trackIds.includes(track.trackId),
	);
	const tracks = selectedTracks.map((track) => {
		const elements = snapshot.elements
			.filter(
				(element) =>
					element.trackId === track.trackId &&
					(!request.elementTypes ||
						request.elementTypes.includes(element.type)) &&
					intersectsRange({ element, startTime, endTime }),
			)
			.sort((...pair) => compareElements({ left: pair[0]!, right: pair[1]! }));
		return {
			trackId: track.trackId,
			name: track.name,
			type: track.type,
			role: track.role,
			...(track.muted === undefined ? {} : { muted: track.muted }),
			...(track.hidden === undefined ? {} : { hidden: track.hidden }),
			elements: elements.map(toQueryElement),
			gaps: buildGaps({ elements, startTime, endTime }),
			overlaps: buildOverlaps({ elements, startTime, endTime }),
			relationships: buildRelationships({
				snapshot,
				trackId: track.trackId,
				elements,
			}),
		};
	});
	return {
		status: "queried",
		projectId: snapshot.projectId,
		sceneId: snapshot.sceneId,
		revision: snapshot.revision,
		projectDuration,
		range: { startTime, endTime },
		filters: {
			...(request.trackIds ? { trackIds: request.trackIds } : {}),
			...(request.elementTypes ? { elementTypes: request.elementTypes } : {}),
		},
		tracks,
	};
}
