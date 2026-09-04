import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { cloneAnimations } from "@/animation";
import type { MediaTime } from "@/wasm";
import type { ObjectIdAllocation } from "opencut-wasm";
import { ResolvedObjectIds } from "@/automation/resolved-object-ids";

interface DuplicateElementsParams {
	elements: { trackId: string; elementId: string }[];
	duplicateIds?: string[];
	resolvedAllocations?: ObjectIdAllocation[];
}

export class DuplicateElementsCommand extends Command {
	private duplicatedElements: { trackId: string; elementId: string }[] = [];
	private savedState: SceneTracks | null = null;
	private elements: DuplicateElementsParams["elements"];
	private readonly duplicateIds: Map<string, string>;
	private readonly resolvedIds: ResolvedObjectIds;

	constructor({
		elements,
		duplicateIds,
		resolvedAllocations,
	}: DuplicateElementsParams) {
		super();
		this.elements = elements;
		if (duplicateIds && duplicateIds.length !== elements.length) {
			throw new Error("duplicate IDs must match duplicate elements");
		}
		this.duplicateIds = new Map(
			elements.map((element, index) => [
				entryKey({ trackId: element.trackId, elementId: element.elementId }),
				duplicateIds?.[index] ?? generateUUID(),
			]),
		);
		this.resolvedIds = new ResolvedObjectIds(resolvedAllocations);
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
			role: "duplicate-group",
			resolvedIds: this.resolvedIds,
		});
		const duplicateLinkIds = buildDuplicateRelationshipIds({
			elements: sourceElements,
			property: "linkId",
			role: "duplicate-link",
			resolvedIds: this.resolvedIds,
		});
		const duplicateElementIds = new Map(
			this.elements.map((entry) => [
				entry.elementId,
				this.requireDuplicateId({
					trackId: entry.trackId,
					elementId: entry.elementId,
				}),
			]),
		);

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

				const newId = this.requireDuplicateId({
					trackId: track.id,
					elementId: element.id,
				});
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
						resolvedIds: this.resolvedIds,
						elementIds: duplicateElementIds,
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
				newTrackId: this.resolvedIds.take({
					role: "duplicate-track",
					sourceId: track.id,
					fallback: generateUUID,
				}),
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
		this.resolvedIds.assertExhausted();

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

	private requireDuplicateId({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): string {
		const id = this.duplicateIds.get(entryKey({ trackId, elementId }));
		if (!id) throw new Error("missing resolved duplicate element ID");
		return id;
	}
}

export function buildDuplicateElement({
	element,
	id,
	startTime,
	groupId,
	linkId,
	resolvedIds,
	roles = duplicateTopRoles,
	elementIds,
}: {
	element: TimelineElement;
	id: string;
	startTime: MediaTime;
	groupId: string | undefined;
	linkId: string | undefined;
	resolvedIds: ResolvedObjectIds;
	roles?: CloneIdentityRoles;
	elementIds?: ReadonlyMap<string, string>;
}): TimelineElement {
	let duplicate: TimelineElement = {
		...element,
		id,
		name: `${element.name} (copy)`,
		startTime,
		groupId,
		linkId,
		animations: cloneAnimations({
			animations: element.animations,
			shouldRegenerateKeyframeIds: true,
			resolveKeyframeId: (sourceId) =>
				resolvedIds.take({
					role: roles.keyframe,
					sourceId,
					fallback: generateUUID,
				}),
		}),
	};
	if (
		duplicate.transitionIn &&
		elementIds?.has(duplicate.transitionIn.fromElementId)
	) {
		duplicate = {
			...duplicate,
			transitionIn: {
				...duplicate.transitionIn,
				id: resolvedIds.take({
					role: roles.transition,
					sourceId: duplicate.transitionIn.id,
					fallback: generateUUID,
				}),
				fromElementId:
					elementIds.get(duplicate.transitionIn.fromElementId) ??
					duplicate.transitionIn.fromElementId,
			},
		};
	} else if (duplicate.transitionIn && elementIds) {
		duplicate = { ...duplicate, transitionIn: undefined };
	}
	if ("effects" in duplicate && duplicate.effects) {
		duplicate = {
			...duplicate,
			effects: duplicate.effects.map((effect) => ({
				...effect,
				id: resolvedIds.take({
					role: roles.effect,
					sourceId: effect.id,
					fallback: generateUUID,
				}),
			})),
		};
	}
	if ("masks" in duplicate && duplicate.masks) {
		duplicate = {
			...duplicate,
			masks: duplicate.masks.map((mask) => ({
				...mask,
				id: resolvedIds.take({
					role: roles.mask,
					sourceId: mask.id,
					fallback: generateUUID,
				}),
			})),
		};
	}
	return duplicate.type === "compound"
		? {
				...duplicate,
				tracks: cloneCompoundTracks({
					tracks: duplicate.tracks,
					resolvedIds,
					prefix: roles.prefix,
				}),
			}
		: duplicate;
}

export function cloneCompoundTracks({
	tracks,
	resolvedIds = new ResolvedObjectIds(undefined),
	prefix = "duplicate",
}: {
	tracks: SceneTracks;
	resolvedIds?: ResolvedObjectIds;
	prefix?: "duplicate" | "split";
}): SceneTracks {
	const roles = nestedRoles(prefix);
	const elements: TimelineElement[] = [
		...tracks.main.elements,
		...tracks.overlay.flatMap((track) => [
			...(track.elements as TimelineElement[]),
		]),
		...tracks.audio.flatMap((track) => track.elements),
	];
	const elementIds = new Map(
		elements.map((element) => [
			element.id,
			resolvedIds.take({
				role: roles.element,
				sourceId: element.id,
				fallback: generateUUID,
			}),
		]),
	);
	const groupIds = buildDuplicateRelationshipIds({
		elements,
		property: "groupId",
		role: roles.group,
		resolvedIds,
	});
	const linkIds = buildDuplicateRelationshipIds({
		elements,
		property: "linkId",
		role: roles.link,
		resolvedIds,
	});
	const cloneTrack = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
		({
			...track,
			id: resolvedIds.take({
				role: roles.track,
				sourceId: track.id,
				fallback: generateUUID,
			}),
			elements: (track.elements as TimelineElement[]).map((element) => {
				const cloned = buildDuplicateElement({
					element,
					id: elementIds.get(element.id)!,
					startTime: element.startTime,
					groupId: element.groupId ? groupIds.get(element.groupId) : undefined,
					linkId: element.linkId ? linkIds.get(element.linkId) : undefined,
					resolvedIds,
					roles,
					elementIds,
				});
				return cloned.transitionIn
					? {
							...cloned,
							transitionIn: {
								...cloned.transitionIn,
								fromElementId:
									elementIds.get(cloned.transitionIn.fromElementId) ??
									cloned.transitionIn.fromElementId,
							},
						}
					: cloned;
			}),
		}) as TTrack;
	return {
		main: cloneTrack(tracks.main),
		overlay: tracks.overlay.map(cloneTrack),
		audio: tracks.audio.map(cloneTrack),
	};
}

export function buildDuplicateRelationshipIds({
	elements,
	property,
	role,
	resolvedIds,
}: {
	elements: TimelineElement[];
	property: "groupId" | "linkId";
	role: "duplicate-group" | "duplicate-link" | "split-group" | "split-link";
	resolvedIds: ResolvedObjectIds;
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
			.filter(([, count]) => count >= (resolvedIds.strict ? 1 : 2))
			.map(([relationshipId]) => [
				relationshipId,
				resolvedIds.take({
					role,
					sourceId: relationshipId,
					fallback: generateUUID,
				}),
			]),
	);
}

interface CloneIdentityRoles {
	prefix: "duplicate" | "split";
	track: "duplicate-nested-track" | "split-nested-track";
	element: "duplicate-nested-element" | "split-nested-element";
	transition:
		| "duplicate-transition"
		| "duplicate-nested-transition"
		| "split-nested-transition";
	group: "duplicate-group" | "split-group";
	link: "duplicate-link" | "split-link";
	effect: "duplicate-effect" | "split-effect";
	mask: "duplicate-mask" | "split-mask";
	keyframe:
		| "duplicate-keyframe"
		| "duplicate-nested-keyframe"
		| "split-nested-keyframe";
}

const duplicateTopRoles: CloneIdentityRoles = {
	prefix: "duplicate",
	track: "duplicate-nested-track",
	element: "duplicate-nested-element",
	transition: "duplicate-transition",
	group: "duplicate-group",
	link: "duplicate-link",
	effect: "duplicate-effect",
	mask: "duplicate-mask",
	keyframe: "duplicate-keyframe",
};

function nestedRoles(prefix: "duplicate" | "split"): CloneIdentityRoles {
	return prefix === "duplicate"
		? {
				...duplicateTopRoles,
				transition: "duplicate-nested-transition",
				keyframe: "duplicate-nested-keyframe",
			}
		: {
				prefix: "split",
				track: "split-nested-track",
				element: "split-nested-element",
				transition: "split-nested-transition",
				group: "split-group",
				link: "split-link",
				effect: "split-effect",
				mask: "split-mask",
				keyframe: "split-nested-keyframe",
			};
}

function entryKey({
	trackId,
	elementId,
}: {
	trackId: string;
	elementId: string;
}): string {
	return `${trackId}\0${elementId}`;
}
