import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Bookmark, TScene } from "@/timeline";
import {
	findBookmarkIndexById,
	getFrameTime,
	sortBookmarks,
} from "@/timeline/bookmarks/index";
import { updateSceneInArray } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";
import type { MediaTime } from "@/wasm";

/**
 * Bookmark commands addressed by stable id rather than by frame time. They
 * operate on the active scene, so callers scope them with SceneScopedCommand.
 */
abstract class BookmarkCommand extends Command {
	private savedScenes: TScene[] | null = null;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeScene = editor.scenes.getActiveScene();
		const activeProject = editor.project.getActive();
		if (!activeProject) throw new Error("No active project");
		const scenes = editor.scenes.getScenes();
		const bookmarks = this.apply({
			bookmarks: activeScene.bookmarks,
			frameTime: (time) =>
				getFrameTime({ time, fps: activeProject.settings.fps }),
		});
		this.savedScenes = [...scenes];
		editor.scenes.setScenes({
			scenes: updateSceneInArray({
				scenes,
				sceneId: activeScene.id,
				updates: { bookmarks: sortBookmarks(bookmarks), updatedAt: new Date() },
			}),
		});
		return undefined;
	}

	undo(): void {
		if (this.savedScenes) {
			EditorCore.getInstance().scenes.setScenes({ scenes: this.savedScenes });
		}
	}

	protected abstract apply(context: {
		bookmarks: Bookmark[];
		frameTime: (time: MediaTime) => MediaTime;
	}): Bookmark[];
}

export class AddBookmarkCommand extends BookmarkCommand {
	private readonly bookmarkId: string;

	constructor({
		bookmarkId,
		time,
		duration,
		note,
		color,
	}: {
		bookmarkId?: string;
		time: MediaTime;
		duration?: MediaTime;
		note?: string;
		color?: string;
	}) {
		super();
		this.bookmarkId = bookmarkId ?? generateUUID();
		this.time = time;
		this.duration = duration;
		this.note = note;
		this.color = color;
	}

	private time: MediaTime;
	private duration?: MediaTime;
	private note?: string;
	private color?: string;

	protected apply({
		bookmarks,
		frameTime,
	}: {
		bookmarks: Bookmark[];
		frameTime: (time: MediaTime) => MediaTime;
	}): Bookmark[] {
		if (!Number.isSafeInteger(this.time) || this.time < 0) {
			throw new Error("bookmark time must be non-negative ticks");
		}
		if (
			this.duration !== undefined &&
			(!Number.isSafeInteger(this.duration) || this.duration <= 0)
		) {
			throw new Error("bookmark duration must be positive ticks");
		}
		if (
			findBookmarkIndexById({ bookmarks, bookmarkId: this.bookmarkId }) >= 0
		) {
			throw new Error(`bookmark already exists: ${this.bookmarkId}`);
		}
		return [
			...bookmarks,
			{
				id: this.bookmarkId,
				time: frameTime(this.time),
				...(this.duration === undefined ? {} : { duration: this.duration }),
				...(this.note === undefined ? {} : { note: this.note }),
				...(this.color === undefined ? {} : { color: this.color }),
			},
		];
	}

	getBookmarkId(): string {
		return this.bookmarkId;
	}
}

export class UpdateBookmarkByIdCommand extends BookmarkCommand {
	constructor({
		bookmarkId,
		updates,
	}: {
		bookmarkId: string;
		updates: {
			note?: string | null;
			color?: string | null;
			duration?: MediaTime | null;
		};
	}) {
		super();
		this.bookmarkId = bookmarkId;
		this.updates = updates;
	}

	private bookmarkId: string;
	private updates: {
		note?: string | null;
		color?: string | null;
		duration?: MediaTime | null;
	};

	protected apply({ bookmarks }: { bookmarks: Bookmark[] }): Bookmark[] {
		const index = findBookmarkIndexById({
			bookmarks,
			bookmarkId: this.bookmarkId,
		});
		if (index < 0) throw new Error(`bookmark not found: ${this.bookmarkId}`);
		const current = bookmarks[index]!;
		const next: Bookmark = { id: current.id, time: current.time };
		const note =
			this.updates.note === undefined ? current.note : this.updates.note;
		const color =
			this.updates.color === undefined ? current.color : this.updates.color;
		const duration =
			this.updates.duration === undefined
				? current.duration
				: this.updates.duration;
		if (note != null) next.note = note;
		if (color != null) next.color = color;
		if (duration != null) next.duration = duration;
		return bookmarks.map((bookmark, candidate) =>
			candidate === index ? next : bookmark,
		);
	}
}

export class MoveBookmarkByIdCommand extends BookmarkCommand {
	constructor({ bookmarkId, time }: { bookmarkId: string; time: MediaTime }) {
		super();
		this.bookmarkId = bookmarkId;
		this.time = time;
	}

	private bookmarkId: string;
	private time: MediaTime;

	protected apply({
		bookmarks,
		frameTime,
	}: {
		bookmarks: Bookmark[];
		frameTime: (time: MediaTime) => MediaTime;
	}): Bookmark[] {
		const index = findBookmarkIndexById({
			bookmarks,
			bookmarkId: this.bookmarkId,
		});
		if (index < 0) throw new Error(`bookmark not found: ${this.bookmarkId}`);
		return bookmarks.map((bookmark, candidate) =>
			candidate === index
				? { ...bookmark, time: frameTime(this.time) }
				: bookmark,
		);
	}
}

export class RemoveBookmarkByIdCommand extends BookmarkCommand {
	constructor({ bookmarkId }: { bookmarkId: string }) {
		super();
		this.bookmarkId = bookmarkId;
	}

	private bookmarkId: string;

	protected apply({ bookmarks }: { bookmarks: Bookmark[] }): Bookmark[] {
		const index = findBookmarkIndexById({
			bookmarks,
			bookmarkId: this.bookmarkId,
		});
		if (index < 0) throw new Error(`bookmark not found: ${this.bookmarkId}`);
		return bookmarks.filter((_, candidate) => candidate !== index);
	}
}
