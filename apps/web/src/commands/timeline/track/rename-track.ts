import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";

export class RenameTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({ trackId, name }: { trackId: string; name: string }) {
		super();
		this.trackId = trackId;
		this.name = name;
	}

	private trackId: string;
	private name: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		const name = this.name.trim();
		if (!name) throw new Error("track name is required");
		const rename = <T extends { id: string; name: string }>(track: T): T =>
			track.id === this.trackId ? { ...track, name } : track;
		const found =
			tracks.main.id === this.trackId ||
			tracks.overlay.some((track) => track.id === this.trackId) ||
			tracks.audio.some((track) => track.id === this.trackId);
		if (!found) throw new Error(`track not found: ${this.trackId}`);
		this.savedState = tracks;
		editor.timeline.updateTracks({
			main: rename(tracks.main),
			overlay: tracks.overlay.map(rename),
			audio: tracks.audio.map(rename),
		});
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
