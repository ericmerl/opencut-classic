import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, VideoTrack } from "@/timeline";
import { MAIN_TRACK_NAME } from "@/timeline/placement/main-track";

/**
 * Promotes an overlay video track to be the scene's main track. The previous
 * main track becomes an overlay video track at the top of the overlay stack so
 * no element is lost; the scene duration follows the new main track.
 */
export class SetMainTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({ trackId }: { trackId: string }) {
		super();
		this.trackId = trackId;
	}

	private trackId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		if (tracks.main.id === this.trackId) return undefined;
		const index = tracks.overlay.findIndex(
			(track) => track.id === this.trackId,
		);
		if (index < 0) {
			throw new Error(
				`track ${this.trackId} is not an overlay track and cannot become the main track`,
			);
		}
		const candidate = tracks.overlay[index]!;
		if (candidate.type !== "video") {
			throw new Error(`${candidate.type} tracks cannot become the main track`);
		}
		this.savedState = tracks;
		const demoted: VideoTrack = {
			...tracks.main,
			name:
				tracks.main.name === MAIN_TRACK_NAME ? "Video Track" : tracks.main.name,
		};
		const promoted: VideoTrack = { ...candidate, name: MAIN_TRACK_NAME };
		editor.timeline.updateTracks({
			main: promoted,
			overlay: [
				demoted,
				...tracks.overlay.filter((track) => track.id !== this.trackId),
			],
			audio: tracks.audio,
		});
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
