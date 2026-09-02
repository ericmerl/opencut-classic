import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { cloneAnimations } from "@/animation";
import type { MediaTime } from "@/wasm";

interface DuplicateElementsParams {
	elements: { trackId: string; elementId: string }[];
}

export class DuplicateElementsCommand extends Command {
	private duplicatedElements: { trackId: string; elementId: string }[] = [];
	private savedState: SceneTracks | null = null;
	private elements: DuplicateElementsParams["elements"];

	constructor({ elements }: DuplicateElementsParams) {
		super();
		this.elements = elements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		this.duplicatedElements = [];

		let updatedTracks = this.savedState;
		const sourceElements = [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		].flatMap((track) => {
			const selectedIds = new Set(
				this.elements
					.filter((entry) => entry.trackId === track.id)
					.map((entry) => entry.elementId),
			);
			return track.elements.filter((element) => selectedIds.has(element.id));
		});
		const duplicateGroupIds = buildDuplicateRelationshipIds({
			elements: sourceElements,
			property: "groupId",
		});
		const duplicateLinkIds = buildDuplicateRelationshipIds({
			elements: sourceElements,
			property: "linkId",
		});

		for (const track of [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		]) {
			const elementsToDuplicate = this.elements.filter(
				(elementEntry) => elementEntry.trackId === track.id,
			);

			if (elementsToDuplicate.length === 0) {
				continue;
			}

			const elementIdsToDuplicate = new Set(
				elementsToDuplicate.map((element) => element.elementId),
			);
			const newTrackElements: TimelineElement[] = [];

			for (const element of track.elements) {
				if (!elementIdsToDuplicate.has(element.id)) {
					continue;
				}

				const newId = generateUUID();
				newTrackElements.push(
					buildDuplicateElement({
						element,
						id: newId,
						startTime: element.startTime,
						groupId: element.groupId
							? duplicateGroupIds.get(element.groupId)
							: undefined,
						linkId: element.linkId
							? duplicateLinkIds.get(element.linkId)
							: undefined,
					}),
				);
			}

			const placementResult = resolveTrackPlacement({
				tracks: updatedTracks,
				trackType: track.type,
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "highest" },
			});
			if (!placementResult || placementResult.kind !== "newTrack") {
				continue;
			}

			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				elements: newTrackElements,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;

			for (const element of newTrackElements) {
				this.duplicatedElements.push({
					trackId: applied.targetTrackId,
					elementId: element.id,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		if (this.duplicatedElements.length > 0) {
			return createElementSelectionResult(this.duplicatedElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getDuplicatedElements(): { trackId: string; elementId: string }[] {
		return this.duplicatedElements;
	}
}

function buildDuplicateElement({
	element,
	id,
	startTime,
	groupId,
	linkId,
}: {
	element: TimelineElement;
	id: string;
	startTime: MediaTime;
	groupId: string | undefined;
	linkId: string | undefined;
}): TimelineElement {
	return {
		...element,
		id,
		name: `${element.name} (copy)`,
		startTime,
		groupId,
		linkId,
		animations: cloneAnimations({
			animations: element.animations,
			shouldRegenerateKeyframeIds: true,
		}),
	};
}

function buildDuplicateRelationshipIds({
	elements,
	property,
}: {
	elements: TimelineElement[];
	property: "groupId" | "linkId";
}): Map<string, string> {
	const counts = new Map<string, number>();
	for (const element of elements) {
		const relationshipId = element[property];
		if (relationshipId) {
			counts.set(relationshipId, (counts.get(relationshipId) ?? 0) + 1);
		}
	}
	return new Map(
		[...counts]
			.filter(([, count]) => count >= 2)
			.map(([relationshipId]) => [relationshipId, generateUUID()]),
	);
}
