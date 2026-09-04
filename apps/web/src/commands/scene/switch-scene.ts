import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";

/**
 * Switches the current scene as an undoable, dirtying command so the change
 * reaches the persisted project like every other scene mutation.
 */
export class SwitchSceneCommand extends Command {
	private previousSceneId: string | null = null;

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
		this.previousSceneId = editor.scenes.getActiveSceneOrNull()?.id ?? null;
		editor.scenes.setScenes({ scenes, activeSceneId: this.sceneId });
		return undefined;
	}

	undo(): void {
		if (this.previousSceneId) {
			const editor = EditorCore.getInstance();
			editor.scenes.setScenes({
				scenes: editor.scenes.getScenes(),
				activeSceneId: this.previousSceneId,
			});
		}
	}
}
