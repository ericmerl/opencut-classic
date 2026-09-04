/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import type { TScene, VideoElement } from "@/timeline";
import type { MediaTime } from "@/wasm";

let scenes: TScene[];
let activeSceneId: string;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			project: {
				getActive: () => ({
					settings: { fps: { numerator: 30, denominator: 1 } },
				}),
			},
			scenes: {
				getScenes: () => scenes,
				getActiveScene: () =>
					scenes.find((scene) => scene.id === activeSceneId)!,
				getActiveSceneOrNull: () =>
					scenes.find((scene) => scene.id === activeSceneId) ?? null,
				setScenes: ({
					scenes: next,
					activeSceneId: nextActive,
				}: {
					scenes: TScene[];
					activeSceneId?: string;
				}) => {
					scenes = next;
					if (nextActive) activeSceneId = nextActive;
				},
			},
		}),
	},
}));
mock.module("@/timeline/bookmarks/index", () => ({
	findBookmarkIndexById: ({
		bookmarks,
		bookmarkId,
	}: {
		bookmarks: Array<{ id: string }>;
		bookmarkId: string;
	}) => bookmarks.findIndex((bookmark) => bookmark.id === bookmarkId),
	sortBookmarks: (bookmarks: Array<{ id: string; time: number }>) =>
		bookmarks
			.slice()
			.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
	getFrameTime: ({ time }: { time: number }) => Math.round(time / 4000) * 4000,
}));

const { SetMainSceneCommand } = await import("./set-main-scene");
const { ReorderScenesCommand } = await import("./reorder-scenes");
const { CloneSceneCommand } = await import("./clone-scene");
const { SwitchSceneCommand } = await import("./switch-scene");
const {
	AddBookmarkCommand,
	MoveBookmarkByIdCommand,
	RemoveBookmarkByIdCommand,
	UpdateBookmarkByIdCommand,
} = await import("./bookmark-by-id");

function scene(id: string, isMain: boolean): TScene {
	const element: VideoElement = {
		id: `${id}-element`,
		type: "video",
		name: "clip",
		mediaId: "asset-1",
		startTime: 0 as MediaTime,
		duration: 10 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		params: {},
	};
	return {
		id,
		name: id,
		isMain,
		tracks: {
			main: {
				id: `${id}-main`,
				name: "Main Track",
				type: "video",
				elements: [element],
				muted: false,
				hidden: false,
			},
			overlay: [],
			audio: [],
		},
		bookmarks: [
			{ id: `${id}-bookmark`, time: 8_000 as MediaTime, note: "hook" },
		],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

describe("scene lifecycle commands", () => {
	test("set-main demotes every other scene and undo restores", () => {
		scenes = [scene("a", true), scene("b", false)];
		activeSceneId = "a";
		const command = new SetMainSceneCommand({ sceneId: "b" });
		command.execute();
		expect(scenes.map((candidate) => candidate.isMain)).toEqual([false, true]);
		command.undo();
		expect(scenes.map((candidate) => candidate.isMain)).toEqual([true, false]);
		expect(() =>
			new SetMainSceneCommand({ sceneId: "missing" }).execute(),
		).toThrow(/not found/);
	});

	test("reorder requires every scene exactly once", () => {
		scenes = [scene("a", true), scene("b", false), scene("c", false)];
		activeSceneId = "a";
		new ReorderScenesCommand({ sceneIds: ["c", "a", "b"] }).execute();
		expect(scenes.map((candidate) => candidate.id)).toEqual(["c", "a", "b"]);
		expect(() =>
			new ReorderScenesCommand({ sceneIds: ["a", "b"] }).execute(),
		).toThrow(/exactly once/);
		expect(() =>
			new ReorderScenesCommand({ sceneIds: ["a", "b", "b"] }).execute(),
		).toThrow(/exactly once/);
	});

	test("clone copies tracks, elements, and bookmarks with fresh ids after the source", () => {
		scenes = [scene("a", true), scene("b", false)];
		activeSceneId = "a";
		let counter = 0;
		const command = new CloneSceneCommand({
			sceneId: "a",
			allocate: () => `id-${++counter}`,
		});
		command.execute();
		expect(scenes.map((candidate) => candidate.id)).toEqual(["a", "id-1", "b"]);
		const copy = scenes[1]!;
		expect(copy).toMatchObject({ name: "a Copy", isMain: false });
		expect(copy.tracks.main.id).not.toBe("a-main");
		expect(copy.tracks.main.elements[0]!.id).not.toBe("a-element");
		expect((copy.tracks.main.elements[0] as VideoElement).mediaId).toBe(
			"asset-1",
		);
		expect(copy.bookmarks[0]).toMatchObject({ time: 8_000, note: "hook" });
		expect(copy.bookmarks[0]!.id).not.toBe("a-bookmark");
		expect(command.getSceneId()).toBe("id-1");
		expect(() =>
			new CloneSceneCommand({ sceneId: "a", newSceneId: "b" }).execute(),
		).toThrow(/already exists/);
	});

	test("switch is undoable", () => {
		scenes = [scene("a", true), scene("b", false)];
		activeSceneId = "a";
		const command = new SwitchSceneCommand({ sceneId: "b" });
		command.execute();
		expect(activeSceneId).toBe("b");
		command.undo();
		expect(activeSceneId).toBe("a");
		expect(() =>
			new SwitchSceneCommand({ sceneId: "missing" }).execute(),
		).toThrow(/not found/);
	});

	test("bookmark commands address bookmarks by id and keep them sorted", () => {
		scenes = [scene("a", true)];
		activeSceneId = "a";
		const add = new AddBookmarkCommand({
			bookmarkId: "bm-2",
			time: 1_000 as MediaTime,
			color: "#00ff00",
		});
		add.execute();
		expect(scenes[0]!.bookmarks.map((bookmark) => bookmark.id)).toEqual([
			"bm-2",
			"a-bookmark",
		]);
		expect(scenes[0]!.bookmarks[0]).toEqual({
			id: "bm-2",
			time: 0 as MediaTime,
			color: "#00ff00",
		});
		expect(() =>
			new AddBookmarkCommand({
				bookmarkId: "bm-2",
				time: 0 as MediaTime,
			}).execute(),
		).toThrow(/already exists/);
		new UpdateBookmarkByIdCommand({
			bookmarkId: "bm-2",
			updates: { note: "cta", color: null, duration: 4_000 as MediaTime },
		}).execute();
		expect(scenes[0]!.bookmarks[0]).toEqual({
			id: "bm-2",
			time: 0 as MediaTime,
			note: "cta",
			duration: 4_000 as MediaTime,
		});
		new MoveBookmarkByIdCommand({
			bookmarkId: "bm-2",
			time: 12_000 as MediaTime,
		}).execute();
		expect(scenes[0]!.bookmarks.map((bookmark) => bookmark.id)).toEqual([
			"a-bookmark",
			"bm-2",
		]);
		const remove = new RemoveBookmarkByIdCommand({ bookmarkId: "a-bookmark" });
		remove.execute();
		expect(scenes[0]!.bookmarks.map((bookmark) => bookmark.id)).toEqual([
			"bm-2",
		]);
		remove.undo();
		expect(scenes[0]!.bookmarks).toHaveLength(2);
		expect(() =>
			new RemoveBookmarkByIdCommand({ bookmarkId: "missing" }).execute(),
		).toThrow(/not found/);
	});
});
