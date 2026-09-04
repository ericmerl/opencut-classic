import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TScene } from "@/timeline";
import { buildDefaultScene } from "@/timeline/scenes";

export class CreateSceneCommand extends Command {
	private savedScenes: TScene[] | null = null;
	private createdScene: TScene | null = null;

	constructor({
		name,
		isMain = false,
		sceneId,
		mainTrackId,
	}: {
		name: string;
		isMain?: boolean;
		sceneId?: string;
		mainTrackId?: string;
	}) {
		super();
		this.name = name;
		this.isMain = isMain;
		this.sceneId = sceneId;
		this.mainTrackId = mainTrackId;
	}

	private name: string;
	private isMain: boolean;
	private sceneId?: string;
	private mainTrackId?: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedScenes = [...editor.scenes.getScenes()];

		this.createdScene = buildDefaultScene({
			name: this.name,
			isMain: this.isMain,
			sceneId: this.sceneId,
			mainTrackId: this.mainTrackId,
		});

		const updatedScenes = [...this.savedScenes, this.createdScene];
		editor.scenes.setScenes({ scenes: updatedScenes });
		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			const editor = EditorCore.getInstance();
			editor.scenes.setScenes({ scenes: this.savedScenes });
		}
	}

	getSceneId(): string {
		return this.createdScene?.id ?? "";
	}
}
