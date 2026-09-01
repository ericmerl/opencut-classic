import type { Command } from "@/commands/base-command";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { isLeafChannelData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import { collectAudibleCandidates } from "@/media/audio";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, TimelineElement } from "@/timeline";
import {
	getElementVolume,
	isElementMuted,
	type AudioCapableElement,
} from "@/timeline/audio-state";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";

export interface AudioGainRange {
	minimumGainDb: number;
	maximumGainDb: number;
	affectedElementCount: number;
}

function getTargetElements({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Array<{ trackId: string; element: AudioCapableElement }> {
	const candidateIds = new Set(
		collectAudibleCandidates({ tracks, mediaAssets })
			.map(({ element }) => element)
			.filter((element) => !isElementMuted({ element }))
			.map((element) => element.id),
	);
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	return allTracks.flatMap((track) =>
		track.elements.flatMap((element) => {
			if (!candidateIds.has(element.id)) return [];
			if (element.type !== "audio" && element.type !== "video") return [];
			return [{ trackId: track.id, element }];
		}),
	);
}

function getVolumeValues({
	element,
}: {
	element: AudioCapableElement;
}): number[] {
	const values = [getElementVolume({ element })];
	const volumeData = element.animations?.volume;
	if (
		volumeData &&
		isLeafChannelData(volumeData) &&
		isScalarChannel(volumeData)
	) {
		values.push(...volumeData.keys.map((key) => key.value));
	}
	return values;
}

export function getUniformAudioGainRange({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): AudioGainRange {
	const targets = getTargetElements({ tracks, mediaAssets });
	if (targets.length === 0) {
		return {
			minimumGainDb: 0,
			maximumGainDb: 0,
			affectedElementCount: 0,
		};
	}
	let minimumGainDb = Number.NEGATIVE_INFINITY;
	let maximumGainDb = Number.POSITIVE_INFINITY;
	for (const { element } of targets) {
		for (const value of getVolumeValues({ element })) {
			minimumGainDb = Math.max(minimumGainDb, VOLUME_DB_MIN - value);
			maximumGainDb = Math.min(maximumGainDb, VOLUME_DB_MAX - value);
		}
	}
	return { minimumGainDb, maximumGainDb, affectedElementCount: targets.length };
}

function shiftElementVolume({
	element,
	gainDb,
}: {
	element: AudioCapableElement;
	gainDb: number;
}): Partial<TimelineElement> {
	const params = {
		...element.params,
		volume: getElementVolume({ element }) + gainDb,
	};
	const volumeData = element.animations?.volume;
	if (
		!volumeData ||
		!isLeafChannelData(volumeData) ||
		!isScalarChannel(volumeData)
	) {
		return { params };
	}
	return {
		params,
		animations: {
			...element.animations,
			volume: {
				...volumeData,
				keys: volumeData.keys.map((key) => ({
					...key,
					value: key.value + gainDb,
				})),
			},
		},
	};
}

export function buildAudioMixGainCommand({
	tracks,
	mediaAssets,
	gainDb,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	gainDb: number;
}): Command {
	if (!Number.isFinite(gainDb)) {
		throw new Error("audio mix gain must be finite");
	}
	const range = getUniformAudioGainRange({ tracks, mediaAssets });
	if (range.affectedElementCount === 0) {
		throw new Error("project has no audible timeline elements");
	}
	if (gainDb < range.minimumGainDb || gainDb > range.maximumGainDb) {
		throw new Error(
			`audio mix gain must be between ${range.minimumGainDb} and ${range.maximumGainDb} dB for the current mix`,
		);
	}
	const targets = getTargetElements({ tracks, mediaAssets });
	return new UpdateElementsCommand({
		updates: targets.map(({ trackId, element }) => ({
			trackId,
			elementId: element.id,
			patch: shiftElementVolume({ element, gainDb }),
		})),
	});
}
