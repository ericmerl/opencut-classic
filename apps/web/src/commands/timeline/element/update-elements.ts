import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import {
	findTrackInSceneTracks,
	updateElementInSceneTracks,
} from "@/timeline";
import { applyElementUpdate } from "@/timeline/update-pipeline";

export interface DurationClampBoundaryIds {
	resolveLeft: (propertyPath: string) => string;
	resolveRight: (propertyPath: string) => string;
	assertExhausted: () => void;
}

interface ElementUpdate {
	trackId: string;
	elementId: string;
	patch: Partial<TimelineElement>;
	durationClampBoundaryIds?: DurationClampBoundaryIds;
}

export class UpdateElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly updates: ElementUpdate[];

	constructor({
		updates,
	}: {
		updates: ElementUpdate[];
	}) {
		super();
		this.updates = updates;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let updatedTracks = this.savedState;

		for (const updateEntry of this.updates) {
			const currentTrack = findTrackInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
			});
			const currentElement = currentTrack?.elements.find(
				(element) => element.id === updateEntry.elementId,
			);
			if (!currentTrack || !currentElement) {
				continue;
			}

			const nextElement = applyElementUpdate({
				element: currentElement,
				patch: updateEntry.patch,
				context: {
					tracks: updatedTracks,
					trackId: updateEntry.trackId,
					resolveDurationClampLeftBoundaryId:
						updateEntry.durationClampBoundaryIds?.resolveLeft,
					resolveDurationClampRightBoundaryId:
						updateEntry.durationClampBoundaryIds?.resolveRight,
				},
			});
			updateEntry.durationClampBoundaryIds?.assertExhausted();

			updatedTracks = updateElementInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
				elementId: updateEntry.elementId,
				update: () => nextElement,
			});
		}

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
