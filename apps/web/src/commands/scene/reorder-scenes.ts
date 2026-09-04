import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TScene } from "@/timeline";

/** Sets the canonical scene order. Every scene must appear exactly once. */
export class ReorderScenesCommand extends Command {
	private savedScenes: TScene[] | null = null;

	constructor({ sceneIds }: { sceneIds: string[] }) {
		super();
		this.sceneIds = sceneIds;
	}

	private sceneIds: string[];

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const scenes = editor.scenes.getScenes();
		if (
			this.sceneIds.length !== scenes.length ||
			new Set(this.sceneIds).size !== this.sceneIds.length
		) {
			throw new Error(
				`scene order must list each of the ${scenes.length} scenes exactly once`,
			);
		}
		const byId = new Map(scenes.map((scene) => [scene.id, scene]));
		const ordered = this.sceneIds.map((id) => {
			const scene = byId.get(id);
			if (!scene) throw new Error(`scene not found: ${id}`);
			return scene;
		});
		this.savedScenes = [...scenes];
		editor.scenes.setScenes({ scenes: ordered });
		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			EditorCore.getInstance().scenes.setScenes({ scenes: this.savedScenes });
		}
	}
}
