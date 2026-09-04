/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { TScene, VideoElement } from "@/timeline";
import type { MediaTime } from "@/wasm";

let assets: MediaAsset[];
let scenes: TScene[];
const saved: MediaAsset[] = [];
const deleted: string[] = [];
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			media: {
				getAssets: () => assets,
				setAssets: ({ assets: next }: { assets: MediaAsset[] }) => {
					assets = next;
				},
			},
			scenes: {
				getScenes: () => scenes,
				getActiveScene: () => scenes[0]!,
				setScenes: ({ scenes: next }: { scenes: TScene[] }) => {
					scenes = next;
				},
			},
			timeline: {
				deleteElements: () => {},
				updateTracks: (tracks: TScene["tracks"]) => {
					scenes = [{ ...scenes[0]!, tracks }, ...scenes.slice(1)];
				},
			},
		}),
	},
}));
mock.module("@/services/storage/service", () => ({
	storageService: {
		saveMediaAsset: async ({ mediaAsset }: { mediaAsset: MediaAsset }) => {
			saved.push(mediaAsset);
		},
		deleteMediaAsset: async ({ id }: { id: string }) => {
			deleted.push(id);
		},
	},
}));
mock.module("@/services/video-cache/service", () => ({
	videoCache: { clearVideo: () => {} },
}));
mock.module("@/services/waveform-cache/service", () => ({
	waveformCache: { clearSource: () => {} },
}));
mock.module("@/commands/timeline", () => ({
	UpdateElementsCommand: class {
		execute() {}
	},
}));
(globalThis as { URL: typeof URL }).URL.createObjectURL ??= () => "blob:test";
(globalThis as { URL: typeof URL }).URL.revokeObjectURL ??= () => {};

const { RenameMediaAssetCommand } = await import("./rename-media-asset");
const { RelinkMediaAssetCommand, compareMediaAssets } =
	await import("./relink-media-asset");
const { RemoveMediaAssetCommand } = await import("./remove-media-asset");

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array(4)], `${id}.mp4`),
		url: `blob:${id}`,
		width: 1920,
		height: 1080,
		duration: 10_000_000 as MediaTime,
		fps: 30,
		hasAudio: true,
		...overrides,
	} as MediaAsset;
}

function videoElement(
	id: string,
	mediaId: string,
	extra: Partial<VideoElement> = {},
): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: 0 as MediaTime,
		duration: 10 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		params: {},
		...extra,
	};
}

function fixtureScenes(): TScene[] {
	return [
		{
			id: "scene-a",
			name: "A",
			isMain: true,
			tracks: {
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [videoElement("el-1", "asset-1")],
					muted: false,
					hidden: false,
				},
				overlay: [
					{
						id: "overlay",
						name: "Overlay",
						type: "video",
						elements: [
							videoElement("el-2", "asset-2", {
								matte: { assetId: "asset-1", mode: "luma" } as never,
							}),
							{
								id: "compound",
								type: "compound",
								name: "compound",
								startTime: 20 as MediaTime,
								duration: 10 as MediaTime,
								trimStart: 0 as MediaTime,
								trimEnd: 0 as MediaTime,
								tracks: {
									main: {
										id: "c-main",
										name: "c",
										type: "video",
										elements: [videoElement("el-3", "asset-1")],
										muted: false,
										hidden: false,
									},
									overlay: [],
									audio: [],
								},
							} as never,
						],
						muted: false,
						hidden: false,
					},
				],
				audio: [],
			},
			bookmarks: [],
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		{
			id: "scene-b",
			name: "B",
			isMain: false,
			tracks: {
				main: {
					id: "b-main",
					name: "Main",
					type: "video",
					elements: [videoElement("el-4", "asset-1")],
					muted: false,
					hidden: false,
				},
				overlay: [],
				audio: [],
			},
			bookmarks: [],
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
	];
}

describe("media lifecycle commands", () => {
	test("rename trims, validates, persists, and undoes", async () => {
		assets = [asset("asset-1"), asset("asset-2")];
		saved.length = 0;
		const command = new RenameMediaAssetCommand({
			projectId: "p",
			assetId: "asset-2",
			name: " B-roll ",
		});
		command.execute();
		expect(assets[1]!.name).toBe("B-roll");
		await command.preparePersistence();
		expect(saved.map((candidate) => candidate.name)).toEqual(["B-roll"]);
		command.undo();
		expect(assets[1]!.name).toBe("asset-2.mp4");
		expect(() =>
			new RenameMediaAssetCommand({
				projectId: "p",
				assetId: "nope",
				name: "x",
			}).execute(),
		).toThrow(/not found/);
	});

	test("relink keeps the asset id, reports differences, and rejects type changes by default", () => {
		assets = [asset("asset-1")];
		const { id: _id, ...replacement } = asset("new", {
			width: 1280,
			height: 720,
			hasAudio: false,
		});
		expect(
			compareMediaAssets({ current: assets[0]!, replacement }).differences.map(
				(d) => d.field,
			),
		).toEqual(["width", "height", "hasAudio"]);
		const command = new RelinkMediaAssetCommand({
			projectId: "p",
			assetId: "asset-1",
			replacement,
		});
		command.execute();
		expect(assets[0]).toMatchObject({
			id: "asset-1",
			width: 1280,
			height: 720,
			hasAudio: false,
		});
		expect(command.getDifferences()).toHaveLength(3);
		command.undo();
		expect(assets[0]!.width).toBe(1920);
		const { id: _imageId, ...image } = asset("img", { type: "image" });
		expect(() =>
			new RelinkMediaAssetCommand({
				projectId: "p",
				assetId: "asset-1",
				replacement: image,
			}).execute(),
		).toThrow(/is a image asset/);
		new RelinkMediaAssetCommand({
			projectId: "p",
			assetId: "asset-1",
			replacement: image,
			allowIncompatible: true,
		}).execute();
		expect(assets[0]!.type).toBe("image");
	});

	test("remove with unused-only refuses referenced assets and cascade strips every scene", async () => {
		assets = [asset("asset-1"), asset("asset-2"), asset("asset-3")];
		scenes = fixtureScenes();
		deleted.length = 0;
		expect(() =>
			new RemoveMediaAssetCommand({
				projectId: "p",
				assetId: "asset-1",
				policy: "unused-only",
			}).execute(),
		).toThrow(/still referenced 4 time/);
		expect(() =>
			new RemoveMediaAssetCommand({
				projectId: "p",
				assetId: "missing",
				policy: "unused-only",
			}).execute(),
		).toThrow(/not found/);
		const unused = new RemoveMediaAssetCommand({
			projectId: "p",
			assetId: "asset-3",
			policy: "unused-only",
		});
		unused.execute();
		expect(assets.map((candidate) => candidate.id)).toEqual([
			"asset-1",
			"asset-2",
		]);
		await unused.preparePersistence();
		expect(deleted).toEqual(["asset-3"]);

		const cascade = new RemoveMediaAssetCommand({
			projectId: "p",
			assetId: "asset-1",
			policy: "cascade",
		});
		cascade.execute();
		expect(assets.map((candidate) => candidate.id)).toEqual(["asset-2"]);
		expect(scenes[0]!.tracks.main.elements).toEqual([]);
		const overlay = scenes[0]!.tracks.overlay[0]!;
		expect(overlay.elements.map((element) => element.id)).toEqual([
			"el-2",
			"compound",
		]);
		expect((overlay.elements[0] as VideoElement).matte).toBeUndefined();
		expect(
			(overlay.elements[1] as { tracks: TScene["tracks"] }).tracks.main
				.elements,
		).toEqual([]);
		expect(scenes[1]!.tracks.main.elements).toEqual([]);
		cascade.undo();
		expect(assets.map((candidate) => candidate.id)).toEqual([
			"asset-1",
			"asset-2",
		]);
		expect(
			scenes[0]!.tracks.main.elements.map((element) => element.id),
		).toEqual(["el-1"]);
		expect(
			scenes[1]!.tracks.main.elements.map((element) => element.id),
		).toEqual(["el-4"]);
	});
});
