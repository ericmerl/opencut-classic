import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TScene } from "@/timeline";
import {
	cloneSceneTracksWithNewIds,
	type IdAllocator,
} from "@/timeline/track-clone";
import { generateUUID } from "@/utils/id";

/**
 * Copies a scene with fresh scene, track, element, and bookmark identities and
 * inserts the copy directly after the source. The copy is never the main
 * scene. Media assets are shared by content identity.
 */
export class CloneSceneCommand extends Command {
	private savedScenes: TScene[] | null = null;
	private readonly newSceneId: string;

	constructor({
		sceneId,
		newSceneId,
		name,
		allocate = generateUUID,
	}: {
		sceneId: string;
		newSceneId?: string;
		name?: string;
		allocate?: IdAllocator;
	}) {
		super();
		this.sceneId = sceneId;
		this.newSceneId = newSceneId ?? allocate();
		this.name = name;
		this.allocate = allocate;
	}

	private sceneId: string;
	private name?: string;
	private allocate: IdAllocator;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const scenes = editor.scenes.getScenes();
		const index = scenes.findIndex((scene) => scene.id === this.sceneId);
		if (index < 0) throw new Error(`scene not found: ${this.sceneId}`);
		if (scenes.some((scene) => scene.id === this.newSceneId)) {
			throw new Error(`scene already exists: ${this.newSceneId}`);
		}
		const source = scenes[index]!;
		const now = new Date();
		const copy: TScene = {
			id: this.newSceneId,
			name: this.name ?? `${source.name} Copy`,
			isMain: false,
			tracks: cloneSceneTracksWithNewIds({
				tracks: source.tracks,
				allocate: this.allocate,
			}),
			bookmarks: source.bookmarks.map((bookmark) => ({
				...bookmark,
				id: this.allocate(),
			})),
			createdAt: now,
			updatedAt: now,
		};
		this.savedScenes = [...scenes];
		editor.scenes.setScenes({
			scenes: [...scenes.slice(0, index + 1), copy, ...scenes.slice(index + 1)],
		});
		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			EditorCore.getInstance().scenes.setScenes({ scenes: this.savedScenes });
		}
	}

	getSceneId(): string {
		return this.newSceneId;
	}
}
