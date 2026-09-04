import type {
	AudioTrack,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";

export interface IdAllocator {
	(): string;
}

/**
 * Deep-copies a track with fresh track and element identities. Transitions
 * that point at copied elements are remapped; compound elements are copied
 * recursively so nested tracks get their own identities too. Media asset ids
 * are shared by content identity and are therefore preserved.
 */
export function cloneTrackWithNewIds<T extends TimelineTrack>({
	track,
	trackId,
	name,
	allocate = generateUUID,
}: {
	track: T;
	trackId?: string;
	name?: string;
	allocate?: IdAllocator;
}): T {
	const elementIds = new Map<string, string>();
	for (const element of track.elements) {
		elementIds.set(element.id, allocate());
	}
	const elements = track.elements.map((element) =>
		cloneElementWithNewIds({
			element,
			elementId: elementIds.get(element.id)!,
			elementIds,
			allocate,
		}),
	);
	return {
		...track,
		id: trackId ?? allocate(),
		name: name ?? track.name,
		elements,
	} as T;
}

export function cloneSceneTracksWithNewIds({
	tracks,
	allocate = generateUUID,
}: {
	tracks: SceneTracks;
	allocate?: IdAllocator;
}): SceneTracks {
	return {
		main: cloneTrackWithNewIds({ track: tracks.main, allocate }),
		overlay: tracks.overlay.map((track) =>
			cloneTrackWithNewIds({ track, allocate }),
		),
		audio: tracks.audio.map((track) =>
			cloneTrackWithNewIds({ track, allocate }),
		),
	};
}

function cloneElementWithNewIds({
	element,
	elementId,
	elementIds,
	allocate,
}: {
	element: TimelineElement;
	elementId: string;
	elementIds: ReadonlyMap<string, string>;
	allocate: IdAllocator;
}): TimelineElement {
	const transitionIn = element.transitionIn
		? {
				...element.transitionIn,
				id: allocate(),
				fromElementId:
					elementIds.get(element.transitionIn.fromElementId) ??
					element.transitionIn.fromElementId,
			}
		: undefined;
	const base = {
		...element,
		id: elementId,
		...(transitionIn ? { transitionIn } : {}),
	};
	if (base.type === "compound") {
		return {
			...base,
			tracks: cloneSceneTracksWithNewIds({ tracks: base.tracks, allocate }),
		};
	}
	return base;
}

export function findTrack(
	tracks: SceneTracks,
	trackId: string,
): TimelineTrack | null {
	if (tracks.main.id === trackId) return tracks.main;
	return (
		tracks.overlay.find((track) => track.id === trackId) ??
		tracks.audio.find((track) => track.id === trackId) ??
		null
	);
}

export function isOverlayTrack(track: TimelineTrack): track is OverlayTrack {
	return track.type !== "audio";
}

export function isAudioTrack(track: TimelineTrack): track is AudioTrack {
	return track.type === "audio";
}

export function isVideoTrack(track: TimelineTrack): track is VideoTrack {
	return track.type === "video";
}
