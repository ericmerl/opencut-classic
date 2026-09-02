import type { EditorCore } from "@/core";
import {
	AddTrackCommand,
	BatchCommand,
	InsertElementCommand,
} from "@/commands";
import { buildSubtitleTextElement } from "./build-subtitle-text-element";
import type { SubtitleCue } from "./types";

export interface CaptionTrackInsertion {
	command: BatchCommand;
	trackId: string;
	elementIds: string[];
}

export function buildCaptionTrackInsertion({
	editor,
	captions,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
}): CaptionTrackInsertion | null {
	if (captions.length === 0) return null;

	const addTrackCommand = new AddTrackCommand({ type: "text", index: 0 });
	const trackId = addTrackCommand.getTrackId();
	const canvasSize = editor.project.getActive().settings.canvasSize;
	const insertCommands = captions.map(
		(caption, index) =>
			new InsertElementCommand({
				placement: { mode: "explicit", trackId },
				element: buildSubtitleTextElement({ index, caption, canvasSize }),
			}),
	);
	return {
		command: new BatchCommand([addTrackCommand, ...insertCommands]),
		trackId,
		elementIds: insertCommands.map((command) => command.getElementId()),
	};
}

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
}): string | null {
	const insertion = buildCaptionTrackInsertion({ editor, captions });
	if (!insertion) return null;
	editor.command.execute({ command: insertion.command });
	return insertion.trackId;
}
