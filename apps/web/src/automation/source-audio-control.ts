import { BatchCommand } from "@/commands/batch-command";
import type { Command } from "@/commands/base-command";
import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline/element/toggle-source-audio-separation";
import type { MediaAsset } from "@/media/types";
import {
	canExtractSourceAudio,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import type { TimelineElement } from "@/timeline";
import type { ObjectIdAllocation } from "opencut-wasm";

export function buildSourceAudioSeparationCommand({
	element,
	trackId,
	mediaAsset,
	resolvedIds,
}: {
	element: TimelineElement;
	trackId: string;
	mediaAsset: MediaAsset | null;
	resolvedIds?: {
		audioTrackId: string;
		audioElementId: string;
		linkId: string;
		resolvedAllocations?: ObjectIdAllocation[];
	};
}): Command {
	if (element.type !== "video") {
		throw new Error("source audio can only be separated from video elements");
	}
	if (isSourceAudioSeparated({ element })) {
		return new BatchCommand([]);
	}
	if (!canExtractSourceAudio(element, mediaAsset)) {
		throw new Error("video source does not contain extractable audio");
	}
	if (element.duration <= 0) {
		throw new Error("video element duration must be positive");
	}
	return new ToggleSourceAudioSeparationCommand({
		trackId,
		elementId: element.id,
		...resolvedIds,
	});
}
