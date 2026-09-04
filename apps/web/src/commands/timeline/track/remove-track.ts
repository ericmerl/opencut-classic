import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { findTrack } from "@/timeline/track-clone";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";

/**
 * What to do when the removed track still carries elements.
 * - `reject`: refuse to remove an occupied track (the default).
 * - `delete`: remove the track together with its elements.
 * - `move`: move every element to `targetTrackId`, which must be a track of
 *   the same type with room for every element's time span.
 * - `cascade`: remove the track and the Rust-resolved transitive group/link
 *   relationship expansion, including elements on other tracks.
 */
export type RemoveTrackOccupiedPolicy =
	| { occupied: "reject" }
	| { occupied: "delete" }
	| { occupied: "move"; targetTrackId: string }
	| { occupied: "cascade"; elementIds: string[] };

export class RemoveTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private trackId: string,
		private policy: RemoveTrackOccupiedPolicy = { occupied: "reject" },
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		if (tracks.main.id === this.trackId) {
			throw new Error(
				"the main track cannot be removed; promote another video track first",
			);
		}
		const track = findTrack(tracks, this.trackId);
		if (!track) throw new Error(`track not found: ${this.trackId}`);
		let moved: { targetTrackId: string; elements: TimelineElement[] } | null =
			null;
		if (track.elements.length > 0) {
			if (this.policy.occupied === "reject") {
				throw new Error(
					`track ${this.trackId} still holds ${track.elements.length} element(s); pass an occupied policy of delete, move, or cascade`,
				);
			}
			if (this.policy.occupied === "move") {
				const target = findTrack(tracks, this.policy.targetTrackId);
				if (!target) {
					throw new Error(
						`target track not found: ${this.policy.targetTrackId}`,
					);
				}
				if (target.id === track.id) {
					throw new Error("a track cannot receive its own elements");
				}
				if (target.type !== track.type) {
					throw new Error(
						`${track.type} elements cannot move onto a ${target.type} track`,
					);
				}
				const spans = track.elements.map((element) => ({
					startTime: element.startTime,
					duration: element.duration,
				}));
				if (!canPlaceTimeSpansOnTrack({ track: target, timeSpans: spans })) {
					throw new Error(
						`target track ${target.id} does not have room for every element on ${track.id}`,
					);
				}
				moved = { targetTrackId: target.id, elements: track.elements };
			}
		}
		this.savedState = tracks;
		const withoutTrack: SceneTracks = {
			main: tracks.main,
			overlay: tracks.overlay.filter(
				(candidate) => candidate.id !== this.trackId,
			),
			audio: tracks.audio.filter((candidate) => candidate.id !== this.trackId),
		};
		const updated: SceneTracks = moved
			? appendElements(withoutTrack, moved.targetTrackId, moved.elements)
			: this.policy.occupied === "cascade"
				? stripElements(withoutTrack, new Set(this.policy.elementIds))
				: withoutTrack;
		editor.timeline.updateTracks(updated);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}

function stripElements(
	tracks: SceneTracks,
	elementIds: Set<string>,
): SceneTracks {
	const stripTrack = <T extends { elements: TimelineElement[] }>(
		track: T,
	): T => ({
		...track,
		elements: track.elements
			.filter((element) => !elementIds.has(element.id))
			.map((element) => stripElement(element, elementIds)),
	});
	return {
		main: stripTrack(tracks.main) as SceneTracks["main"],
		overlay: tracks.overlay.map(stripTrack) as SceneTracks["overlay"],
		audio: tracks.audio.map(stripTrack) as SceneTracks["audio"],
	};
}

function stripElement(
	element: TimelineElement,
	elementIds: Set<string>,
): TimelineElement {
	// The key is dropped rather than set to undefined so the persisted
	// element matches the canonical state Rust predicted.
	const { transitionIn, ...rest } = element;
	const keepsTransition =
		transitionIn !== undefined &&
		!elementIds.has(transitionIn.fromElementId);
	const base = keepsTransition ? { ...rest, transitionIn } : rest;
	if (base.type === "compound") {
		return {
			...base,
			tracks: stripElements(base.tracks, elementIds),
		};
	}
	return base;
}

function appendElements(
	tracks: SceneTracks,
	targetTrackId: string,
	elements: TimelineElement[],
): SceneTracks {
	const append = <T extends { id: string; elements: TimelineElement[] }>(
		track: T,
	): T =>
		track.id === targetTrackId
			? ({
					...track,
					elements: [...track.elements, ...elements].sort(
						(left, right) => left.startTime - right.startTime,
					),
				} as T)
			: track;
	return {
		main: append(tracks.main) as SceneTracks["main"],
		overlay: tracks.overlay.map(append) as SceneTracks["overlay"],
		audio: tracks.audio.map(append) as SceneTracks["audio"],
	};
}
