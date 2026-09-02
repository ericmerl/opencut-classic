import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { PlannedElementMove } from "@/timeline/group-move";
import { updateElementInSceneTracks } from "@/timeline/track-element-update";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import { mediaTime, type MediaTime } from "@/wasm";
import type {
	AutomationEditOperation,
	AutomationRelationshipScope,
} from "./types";

type RelationshipOperation = Extract<
	AutomationEditOperation,
	{ kind: "set_group" | "clear_group" | "set_link" | "clear_link" }
>;

interface ElementEntry extends ElementRef {
	element: TimelineElement;
}

function refKey({ trackId, elementId }: ElementRef): string {
	return `${trackId}\u0000${elementId}`;
}

function allElementEntries(tracks: SceneTracks): ElementEntry[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
		track.elements.map((element) => ({
			trackId: track.id,
			elementId: element.id,
			element,
		})),
	);
}

function requireDistinctEntries({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): ElementEntry[] {
	if (refs.length === 0) throw new Error("at least one element is required");
	const requestedKeys = refs.map(refKey);
	if (new Set(requestedKeys).size !== requestedKeys.length) {
		throw new Error("duplicate element references are not allowed");
	}
	const entriesByKey = new Map(
		allElementEntries(tracks).map((entry) => [refKey(entry), entry]),
	);
	return refs.map((ref) => {
		const entry = entriesByKey.get(refKey(ref));
		if (!entry) {
			throw new Error(`element not found: ${ref.trackId}/${ref.elementId}`);
		}
		return entry;
	});
}

export function expandElementRelationships({
	tracks,
	refs,
	scope = "all",
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
	scope?: AutomationRelationshipScope;
}): ElementEntry[] {
	if (!["element", "group", "link", "all"].includes(scope)) {
		throw new Error(`unsupported relationship scope: ${scope}`);
	}
	const seeds = requireDistinctEntries({ tracks, refs });
	if (scope === "element") return seeds;

	const allEntries = allElementEntries(tracks);
	const includedKeys = new Set(seeds.map(refKey));
	const queue = [...seeds];
	for (let index = 0; index < queue.length; index += 1) {
		const current = queue[index];
		for (const candidate of allEntries) {
			const sameGroup =
				(scope === "group" || scope === "all") &&
				current.element.groupId !== undefined &&
				candidate.element.groupId === current.element.groupId;
			const sameLink =
				(scope === "link" || scope === "all") &&
				current.element.linkId !== undefined &&
				candidate.element.linkId === current.element.linkId;
			if (!sameGroup && !sameLink) continue;
			const key = refKey(candidate);
			if (includedKeys.has(key)) continue;
			includedKeys.add(key);
			queue.push(candidate);
		}
	}

	return allEntries.filter((entry) => includedKeys.has(refKey(entry)));
}

export function buildRelationshipControlCommand({
	tracks,
	operation,
}: {
	tracks: SceneTracks;
	operation: RelationshipOperation;
}): Command {
	const relationshipId =
		operation.kind === "set_group" || operation.kind === "clear_group"
			? operation.groupId
			: operation.linkId;
	if (!relationshipId.trim()) throw new Error("relationship ID is required");
	if (operation.kind === "set_group" || operation.kind === "set_link") {
		if (operation.elements.length < 2) {
			throw new Error("a relationship requires at least two elements");
		}
		requireDistinctEntries({ tracks, refs: operation.elements });
	}
	return new RelationshipControlCommand(operation);
}

class RelationshipControlCommand extends Command {
	private before: SceneTracks | null = null;

	constructor(private operation: RelationshipOperation) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.before = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks(
			applyRelationshipControl({
				tracks: this.before,
				operation: this.operation,
			}),
		);
		return undefined;
	}

	undo(): void {
		if (this.before)
			EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}

function applyRelationshipControl({
	tracks,
	operation,
}: {
	tracks: SceneTracks;
	operation: RelationshipOperation;
}): SceneTracks {
	const property =
		operation.kind === "set_group" || operation.kind === "clear_group"
			? "groupId"
			: "linkId";
	const relationshipId =
		operation.kind === "set_group" || operation.kind === "clear_group"
			? operation.groupId
			: operation.linkId;
	let after = tracks;

	if (operation.kind === "set_group" || operation.kind === "set_link") {
		const selected = requireDistinctEntries({
			tracks,
			refs: operation.elements,
		});
		const selectedKeys = new Set(selected.map(refKey));
		after = mapElements({
			tracks,
			update: ({ trackId, element }) => {
				const selectedElement = selectedKeys.has(
					refKey({ trackId, elementId: element.id }),
				);
				if (selectedElement) {
					return setRelationship({ element, property, relationshipId });
				}
				return element[property] === relationshipId
					? clearRelationship({ element, property })
					: element;
			},
		});
	} else {
		after = mapElements({
			tracks,
			update: ({ element }) =>
				element[property] === relationshipId
					? clearRelationship({ element, property })
					: element,
		});
	}

	after = pruneSingletonRelationships({ tracks: after, property });
	return after;
}

class DeferredRelationshipCommand extends Command {
	private activeCommand: Command | null = null;

	constructor(private build: (tracks: SceneTracks) => Command) {
		super();
	}

	execute(): CommandResult | undefined {
		const tracks = EditorCore.getInstance().scenes.getActiveScene().tracks;
		this.activeCommand = this.build(tracks);
		return this.activeCommand.execute();
	}

	undo(): void {
		this.activeCommand?.undo();
	}
}

export function deferRelationshipCommand(
	build: (tracks: SceneTracks) => Command,
): Command {
	return new DeferredRelationshipCommand(build);
}

export function buildRelationshipMoves({
	tracks,
	anchor,
	startTime,
	targetTrackId,
	scope,
}: {
	tracks: SceneTracks;
	anchor: ElementRef;
	startTime: MediaTime;
	targetTrackId?: string;
	scope?: AutomationRelationshipScope;
}): PlannedElementMove[] {
	const [anchorEntry] = requireDistinctEntries({ tracks, refs: [anchor] });
	const delta = startTime - anchorEntry.element.startTime;
	return expandElementRelationships({ tracks, refs: [anchor], scope }).map(
		(entry) => {
			const newStartTime = entry.element.startTime + delta;
			if (newStartTime < 0) {
				throw new Error("related element movement cannot start before zero");
			}
			const isAnchor = refKey(entry) === refKey(anchor);
			return {
				sourceTrackId: entry.trackId,
				targetTrackId:
					isAnchor && targetTrackId ? targetTrackId : entry.trackId,
				elementId: entry.elementId,
				newStartTime: mediaTime({ ticks: newStartTime }),
			};
		},
	);
}

function mapElements({
	tracks,
	update,
}: {
	tracks: SceneTracks;
	update: (entry: ElementEntry) => TimelineElement;
}): SceneTracks {
	let nextTracks = tracks;
	for (const entry of allElementEntries(tracks)) {
		nextTracks = updateElementInSceneTracks({
			tracks: nextTracks,
			trackId: entry.trackId,
			elementId: entry.elementId,
			update: (element) => update({ ...entry, element }),
		});
	}
	return nextTracks;
}

function setRelationship({
	element,
	property,
	relationshipId,
}: {
	element: TimelineElement;
	property: "groupId" | "linkId";
	relationshipId: string;
}): TimelineElement {
	return property === "groupId"
		? { ...element, groupId: relationshipId }
		: { ...element, linkId: relationshipId };
}

function clearRelationship({
	element,
	property,
}: {
	element: TimelineElement;
	property: "groupId" | "linkId";
}): TimelineElement {
	return property === "groupId"
		? { ...element, groupId: undefined }
		: { ...element, linkId: undefined };
}

function pruneSingletonRelationships({
	tracks,
	property,
}: {
	tracks: SceneTracks;
	property: "groupId" | "linkId";
}): SceneTracks {
	const counts = new Map<string, number>();
	for (const { element } of allElementEntries(tracks)) {
		const relationshipId = element[property];
		if (relationshipId) {
			counts.set(relationshipId, (counts.get(relationshipId) ?? 0) + 1);
		}
	}
	return mapElements({
		tracks,
		update: ({ element }) => {
			const relationshipId = element[property];
			return relationshipId && counts.get(relationshipId) === 1
				? clearRelationship({ element, property })
				: element;
		},
	});
}
