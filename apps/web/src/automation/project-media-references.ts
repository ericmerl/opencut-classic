import { hasMediaId } from "@/timeline/element-utils";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline/types";

export function countProjectAssetReferences({
	projectScenes,
	assetId,
}: {
	projectScenes: readonly TScene[];
	assetId: string;
}): number {
	return projectScenes.reduce(
		(count, scene) =>
			count + countSceneAssetReferences({ tracks: scene.tracks, assetId }),
		0,
	);
}

export function countSceneAssetReferences({
	tracks,
	assetId,
}: {
	tracks: SceneTracks;
	assetId: string;
}): number {
	return orderedElements(tracks).reduce(
		(count, element) => count + countElementReferences({ element, assetId }),
		0,
	);
}

function countElementReferences({
	element,
	assetId,
}: {
	element: TimelineElement;
	assetId: string;
}): number {
	let count = hasMediaId(element) && element.mediaId === assetId ? 1 : 0;
	if (element.type === "video" && element.matte?.assetId === assetId) count += 1;
	if (
		(element.type === "video" || element.type === "audio") &&
		element.audioReplacement?.assetId === assetId
	) {
		count += 1;
	}
	if (element.type === "compound") {
		count += countSceneAssetReferences({ tracks: element.tracks, assetId });
	}
	return count;
}

function orderedElements(tracks: SceneTracks): TimelineElement[] {
	const elements: TimelineElement[] = [...tracks.main.elements];
	for (const track of tracks.overlay) elements.push(...track.elements);
	for (const track of tracks.audio) elements.push(...track.elements);
	return elements;
}
