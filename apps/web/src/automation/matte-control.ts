import { BatchCommand, type Command } from "@/commands";
import { RemoveMediaAssetCommand } from "@/commands/media";
import { UpdateElementsCommand } from "@/commands/timeline";
import type { MediaAsset } from "@/media/types";
import type {
	ClipMatteAttachment,
	SceneTracks,
	TScene,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import type { AutomationEditOperation, AutomationMatteSnapshot } from "./types";
import {
	countProjectAssetReferences,
	countSceneAssetReferences,
} from "./project-media-references";

export function buildMatteControlCommand({
	operation,
	projectId,
	projectScenes,
	tracks,
}: {
	operation: Extract<
		AutomationEditOperation,
		{ kind: "set_matte_state" | "remove_matte" }
	>;
	projectId: string;
	projectScenes?: readonly TScene[];
	tracks: SceneTracks;
}): Command {
	const element = findVideoElement({
		tracks,
		trackId: operation.trackId,
		elementId: operation.elementId,
	});
	if (!element.matte) throw new Error("video element has no attached matte");

	if (operation.kind === "set_matte_state") {
		return updateMatte({
			trackId: operation.trackId,
			element,
			matte: { ...element.matte, enabled: operation.enabled },
		});
	}
	const matteAssetId = element.matte.assetId;

	const commands: Command[] = [
		updateMatte({
			trackId: operation.trackId,
			element,
			matte: undefined,
		}),
	];
	const referenceCount = projectScenes
		? countProjectAssetReferences({
				projectScenes,
				assetId: matteAssetId,
			})
		: countSceneAssetReferences({ tracks, assetId: matteAssetId });
	if (referenceCount === 1) {
		commands.push(
			new RemoveMediaAssetCommand({
				projectId,
				assetId: matteAssetId,
				deferPersistence: true,
			}),
		);
	}
	return new BatchCommand(commands);
}

export function validateMatteAsset({
	source,
	matte,
}: {
	source: MediaAsset;
	matte: Omit<MediaAsset, "id">;
}): void {
	if (matte.type !== "image" && matte.type !== "video") {
		throw new Error("matte artifact must be an image or video");
	}
	if (
		source.width == null ||
		source.height == null ||
		matte.width == null ||
		matte.height == null
	) {
		throw new Error("source and matte dimensions must be available");
	}
	const sourceAspect = source.width / source.height;
	const matteAspect = matte.width / matte.height;
	if (Math.abs(sourceAspect - matteAspect) > 0.001) {
		throw new Error(
			`matte aspect ratio ${matte.width}x${matte.height} does not match source ${source.width}x${source.height}`,
		);
	}
	if (
		matte.type === "video" &&
		(source.duration == null ||
			matte.duration == null ||
			matte.duration + 1 / Math.max(matte.fps ?? 30, 1) < source.duration)
	) {
		throw new Error("video matte must cover the full source media duration");
	}
}

export function buildMatteAttachment({
	assetId,
	source,
	artifactHash,
	artifactFingerprint,
	channel,
	modelId,
	modelVersion,
}: {
	assetId: string;
	source: MediaAsset;
	artifactHash: string;
	artifactFingerprint: string;
	channel: ClipMatteAttachment["channel"];
	modelId: string;
	modelVersion: string;
}): ClipMatteAttachment {
	return {
		assetId,
		sourceMediaId: source.id,
		sourceFingerprint: source.sourceFingerprint ?? null,
		artifactHash,
		artifactFingerprint,
		channel,
		modelId,
		modelVersion,
		enabled: true,
	};
}

export function buildMatteSnapshot({
	matte,
	assets,
	source,
}: {
	matte: ClipMatteAttachment;
	assets: MediaAsset[];
	source: MediaAsset | undefined;
}): AutomationMatteSnapshot {
	const artifact = assets.find((asset) => asset.id === matte.assetId);
	const stale = source?.sourceFingerprint
		? source.sourceFingerprint !== matte.sourceFingerprint
		: null;
	return {
		...matte,
		assetType:
			artifact?.type === "image" || artifact?.type === "video"
				? artifact.type
				: null,
		width: artifact?.width ?? null,
		height: artifact?.height ?? null,
		duration: artifact?.duration ?? null,
		fps: artifact?.fps ?? null,
		stale,
	};
}

export function countMatteReferences({
	tracks,
	assetId,
}: {
	tracks: SceneTracks;
	assetId: string;
}): number {
	return allElements(tracks).filter(
		(element) => element.type === "video" && element.matte?.assetId === assetId,
	).length;
}

export function countProjectMatteReferences({
	projectScenes,
	assetId,
}: {
	projectScenes: readonly TScene[];
	assetId: string;
}): number {
	return projectScenes.reduce(
		(count, scene) =>
			count + countMatteReferences({ tracks: scene.tracks, assetId }),
		0,
	);
}

export function findVideoElement({
	tracks,
	trackId,
	elementId,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
}): VideoElement {
	const track = [tracks.main, ...tracks.overlay, ...tracks.audio].find(
		(candidate) => candidate.id === trackId,
	);
	if (!track) throw new Error(`track not found: ${trackId}`);
	const element = track.elements.find(
		(candidate) => candidate.id === elementId,
	);
	if (!element) throw new Error(`element not found: ${elementId}`);
	if (element.type !== "video") {
		throw new Error("background mattes can only be attached to video elements");
	}
	return element;
}

function updateMatte({
	trackId,
	element,
	matte,
}: {
	trackId: string;
	element: VideoElement;
	matte: ClipMatteAttachment | undefined;
}): UpdateElementsCommand {
	return new UpdateElementsCommand({
		updates: [
			{
				trackId,
				elementId: element.id,
				patch: { matte },
			},
		],
	});
}

function allElements(tracks: SceneTracks): TimelineElement[] {
	const elements: TimelineElement[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		elements.push(...track.elements);
	}
	return elements;
}
