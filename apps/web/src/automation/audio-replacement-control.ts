import { BatchCommand, type Command } from "@/commands";
import { RemoveMediaAssetCommand } from "@/commands/media";
import { UpdateElementsCommand } from "@/commands/timeline";
import type { MediaAsset } from "@/media/types";
import type {
	ClipAudioReplacementAttachment,
	SceneTracks,
	TimelineElement,
} from "@/timeline";
import type {
	AutomationAudioReplacementSnapshot,
	AutomationEditOperation,
} from "./types";

type AudioCapableElement = Extract<
	TimelineElement,
	{ type: "audio" | "video" }
>;

export function buildAudioReplacementControlCommand({
	operation,
	projectId,
	tracks,
}: {
	operation: Extract<
		AutomationEditOperation,
		{ kind: "set_audio_replacement_state" | "remove_audio_replacement" }
	>;
	projectId: string;
	tracks: SceneTracks;
}): Command {
	const element = findAudioCapableElement({
		tracks,
		trackId: operation.trackId,
		elementId: operation.elementId,
	});
	if (!element.audioReplacement) {
		throw new Error("element has no attached audio replacement");
	}
	if (operation.kind === "set_audio_replacement_state") {
		return updateAudioReplacement({
			trackId: operation.trackId,
			element,
			audioReplacement: {
				...element.audioReplacement,
				enabled: operation.enabled,
			},
		});
	}

	const commands: Command[] = [
		updateAudioReplacement({
			trackId: operation.trackId,
			element,
			audioReplacement: undefined,
		}),
	];
	if (
		countAudioReplacementReferences({
			tracks,
			assetId: element.audioReplacement.assetId,
		}) === 1
	) {
		commands.push(
			new RemoveMediaAssetCommand({
				projectId,
				assetId: element.audioReplacement.assetId,
			}),
		);
	}
	return new BatchCommand(commands);
}

export function validateAudioReplacementAsset({
	source,
	replacement,
}: {
	source: MediaAsset;
	replacement: Omit<MediaAsset, "id">;
}): void {
	if (source.type !== "audio" && source.type !== "video") {
		throw new Error("audio replacement source must be audio or video");
	}
	if (source.type === "video" && source.hasAudio === false) {
		throw new Error("source video does not contain audio");
	}
	if (replacement.type !== "audio") {
		throw new Error("cleaned audio artifact must be an audio file");
	}
	if (source.duration == null || replacement.duration == null) {
		throw new Error("source and cleaned audio durations must be available");
	}
	if (replacement.duration + 0.05 < source.duration) {
		throw new Error(
			`cleaned audio duration ${replacement.duration.toFixed(3)}s does not cover source duration ${source.duration.toFixed(3)}s`,
		);
	}
}

export function buildAudioReplacementAttachment({
	assetId,
	source,
	artifactHash,
	artifactFingerprint,
	modelId,
	modelVersion,
}: {
	assetId: string;
	source: MediaAsset;
	artifactHash: string;
	artifactFingerprint: string;
	modelId: string;
	modelVersion: string;
}): ClipAudioReplacementAttachment {
	return {
		assetId,
		sourceMediaId: source.id,
		sourceFingerprint: source.sourceFingerprint ?? null,
		artifactHash,
		artifactFingerprint,
		modelId,
		modelVersion,
		enabled: true,
	};
}

export function buildAudioReplacementSnapshot({
	audioReplacement,
	assets,
	source,
}: {
	audioReplacement: ClipAudioReplacementAttachment;
	assets: MediaAsset[];
	source: MediaAsset | undefined;
}): AutomationAudioReplacementSnapshot {
	const artifact = assets.find(
		(asset) => asset.id === audioReplacement.assetId,
	);
	const stale = source?.sourceFingerprint
		? source.sourceFingerprint !== audioReplacement.sourceFingerprint
		: null;
	return {
		...audioReplacement,
		assetType: artifact?.type === "audio" ? "audio" : null,
		duration: artifact?.duration ?? null,
		stale,
	};
}

export function countAudioReplacementReferences({
	tracks,
	assetId,
}: {
	tracks: SceneTracks;
	assetId: string;
}): number {
	return allElements(tracks).filter(
		(element) =>
			(element.type === "audio" || element.type === "video") &&
			element.audioReplacement?.assetId === assetId,
	).length;
}

export function findAudioCapableElement({
	tracks,
	trackId,
	elementId,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
}): AudioCapableElement {
	const track = [tracks.main, ...tracks.overlay, ...tracks.audio].find(
		(candidate) => candidate.id === trackId,
	);
	if (!track) throw new Error(`track not found: ${trackId}`);
	const element = track.elements.find(
		(candidate) => candidate.id === elementId,
	);
	if (!element) throw new Error(`element not found: ${elementId}`);
	if (element.type !== "audio" && element.type !== "video") {
		throw new Error(
			"cleaned audio can only be attached to audio or video elements",
		);
	}
	return element;
}

function updateAudioReplacement({
	trackId,
	element,
	audioReplacement,
}: {
	trackId: string;
	element: AudioCapableElement;
	audioReplacement: ClipAudioReplacementAttachment | undefined;
}): UpdateElementsCommand {
	return new UpdateElementsCommand({
		updates: [
			{
				trackId,
				elementId: element.id,
				patch: { audioReplacement },
			},
		],
	});
}

function allElements(tracks: SceneTracks): TimelineElement[] {
	const elements: TimelineElement[] = [...tracks.main.elements];
	for (const track of tracks.overlay) elements.push(...track.elements);
	for (const track of tracks.audio) elements.push(...track.elements);
	return elements;
}
