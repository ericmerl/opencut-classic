import { Command, type CommandResult } from "@/commands/base-command";
import {
	buildDuplicateElement,
	buildDuplicateRelationshipIds,
} from "@/commands/timeline/element/duplicate-elements";
import { EditorCore } from "@/core";
import { ResolvedObjectIds } from "@/automation/resolved-object-ids";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import {
	findTrack,
	isAudioTrack,
	isOverlayTrack,
} from "@/timeline/track-clone";
import { generateUUID } from "@/utils/id";
import type { ObjectIdAllocation } from "opencut-wasm";

/**
 * Copies a track and every element on it with fresh identities, inserting the
 * copy directly after the source in its role list. The main track is copied
 * as an overlay video track because a scene has exactly one main track.
 *
 * Identity allocation follows the same roles as DuplicateElementsCommand so a
 * Rust-resolved edit plan can pin every copied id.
 */
export class DuplicateTrackCommand extends Command {
	private savedState: SceneTracks | null = null;
	private newTrackId: string | null = null;

	constructor({
		trackId,
		newTrackId,
		name,
		resolvedAllocations,
	}: {
		trackId: string;
		newTrackId?: string;
		name?: string;
		resolvedAllocations?: readonly ObjectIdAllocation[];
	}) {
		super();
		this.trackId = trackId;
		this.requestedTrackId = newTrackId;
		this.name = name;
		this.resolvedIds = new ResolvedObjectIds(resolvedAllocations);
	}

	private readonly trackId: string;
	private readonly requestedTrackId: string | undefined;
	private readonly name: string | undefined;
	private readonly resolvedIds: ResolvedObjectIds;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		const source = findTrack(tracks, this.trackId);
		if (!source) throw new Error(`track not found: ${this.trackId}`);
		const newTrackId = this.resolvedIds.take({
			role: "duplicate-track",
			sourceId: source.id,
			fallback: () => this.requestedTrackId ?? generateUUID(),
		});
		if (this.requestedTrackId && this.requestedTrackId !== newTrackId) {
			throw new Error("newTrackId does not match its resolved allocation");
		}
		if (findTrack(tracks, newTrackId)) {
			throw new Error(`track already exists: ${newTrackId}`);
		}
		const copy = this.cloneTrack({ source, newTrackId });
		this.resolvedIds.assertExhausted();
		this.savedState = tracks;
		this.newTrackId = newTrackId;
		if (isAudioTrack(copy)) {
			const index = tracks.audio.findIndex((track) => track.id === source.id);
			editor.timeline.updateTracks({
				...tracks,
				audio: [
					...tracks.audio.slice(0, index + 1),
					copy,
					...tracks.audio.slice(index + 1),
				],
			});
		} else if (isOverlayTrack(copy)) {
			const index = tracks.overlay.findIndex((track) => track.id === source.id);
			// The main track duplicates onto the top of the overlay stack.
			const insertAt = index < 0 ? 0 : index + 1;
			editor.timeline.updateTracks({
				...tracks,
				overlay: [
					...tracks.overlay.slice(0, insertAt),
					copy,
					...tracks.overlay.slice(insertAt),
				],
			});
		}
		return undefined;
	}

	private cloneTrack<T extends TimelineTrack>({
		source,
		newTrackId,
	}: {
		source: T;
		newTrackId: string;
	}): T {
		const elements = source.elements as TimelineElement[];
		const elementIds = new Map(
			elements.map((element) => [
				element.id,
				this.resolvedIds.take({
					role: "duplicate-element",
					sourceId: element.id,
					fallback: generateUUID,
				}),
			]),
		);
		const groupIds = buildDuplicateRelationshipIds({
			elements,
			property: "groupId",
			role: "duplicate-group",
			resolvedIds: this.resolvedIds,
		});
		const linkIds = buildDuplicateRelationshipIds({
			elements,
			property: "linkId",
			role: "duplicate-link",
			resolvedIds: this.resolvedIds,
		});
		return {
			...source,
			id: newTrackId,
			name: this.name ?? `${source.name} copy`,
			// A copied destination must not silently share the source track's
			// compositing dependency. Callers can establish a new route explicitly.
			trackMatte: undefined,
			elements: elements.map((element) =>
				buildDuplicateElement({
					element,
					id: elementIds.get(element.id)!,
					startTime: element.startTime,
					groupId: element.groupId ? groupIds.get(element.groupId) : undefined,
					linkId: element.linkId ? linkIds.get(element.linkId) : undefined,
					resolvedIds: this.resolvedIds,
					elementIds,
				}),
			),
		} as T;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string {
		if (!this.newTrackId) throw new Error("track has not been duplicated yet");
		return this.newTrackId;
	}
}
