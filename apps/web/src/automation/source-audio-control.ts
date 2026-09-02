import { BatchCommand, type Command } from "@/commands";
import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline";
import type { MediaAsset } from "@/media/types";
import {
	canExtractSourceAudio,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import type { TimelineElement } from "@/timeline";

export function buildSourceAudioSeparationCommand({
	element,
	trackId,
	mediaAsset,
}: {
	element: TimelineElement;
	trackId: string;
	mediaAsset: MediaAsset | null;
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
	});
}
