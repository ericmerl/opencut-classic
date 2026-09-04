import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TScene } from "@/timeline";

/** Makes one scene the main scene; every other scene is demoted. */
export class SetMainSceneCommand extends Command {
	private savedScenes: TScene[] | null = null;

	constructor({ sceneId }: { sceneId: string }) {
		super();
		this.sceneId = sceneId;
	}

	private sceneId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const scenes = editor.scenes.getScenes();
		if (!scenes.some((scene) => scene.id === this.sceneId)) {
			throw new Error(`scene not found: ${this.sceneId}`);
		}
		this.savedScenes = [...scenes];
		const now = new Date();
		editor.scenes.setScenes({
			scenes: scenes.map((scene) =>
				scene.isMain === (scene.id === this.sceneId)
					? scene
					: { ...scene, isMain: scene.id === this.sceneId, updatedAt: now },
			),
		});
		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			EditorCore.getInstance().scenes.setScenes({ scenes: this.savedScenes });
		}
	}
}
