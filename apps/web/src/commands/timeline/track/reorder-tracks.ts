import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";

/**
 * Sets the canonical order of overlay tracks and audio tracks. The main track
 * is not part of either list. Every track of the affected role must appear
 * exactly once so the reorder can never drop or duplicate a track.
 */
export class ReorderTracksCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({
		overlayTrackIds,
		audioTrackIds,
	}: {
		overlayTrackIds?: string[];
		audioTrackIds?: string[];
	}) {
		super();
		this.overlayTrackIds = overlayTrackIds;
		this.audioTrackIds = audioTrackIds;
	}

	private overlayTrackIds?: string[];
	private audioTrackIds?: string[];

	execute(): CommandResult | undefined {
		if (!this.overlayTrackIds && !this.audioTrackIds) {
			throw new Error("a track order is required");
		}
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		this.savedState = tracks;
		editor.timeline.updateTracks({
			main: tracks.main,
			overlay: this.overlayTrackIds
				? reorder(tracks.overlay, this.overlayTrackIds, "overlay")
				: tracks.overlay,
			audio: this.audioTrackIds
				? reorder(tracks.audio, this.audioTrackIds, "audio")
				: tracks.audio,
		});
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}

function reorder<T extends { id: string }>(
	tracks: T[],
	order: string[],
	role: string,
): T[] {
	const byId = new Map(tracks.map((track) => [track.id, track]));
	if (order.length !== tracks.length || new Set(order).size !== order.length) {
		throw new Error(
			`${role} track order must list each of the ${tracks.length} ${role} tracks exactly once`,
		);
	}
	return order.map((id) => {
		const track = byId.get(id);
		if (!track) throw new Error(`${role} track not found: ${id}`);
		return track;
	});
}
