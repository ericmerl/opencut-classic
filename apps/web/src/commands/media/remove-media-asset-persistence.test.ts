/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";

const deleted: string[] = [];
const restored: string[] = [];
let activeEditor: {
	media: {
		getAssets: () => MediaAsset[];
		setAssets: (input: { assets: MediaAsset[] }) => void;
	};
	scenes: { getActiveScene: () => { tracks: unknown } };
	timeline: {
		deleteElements: () => void;
		updateTracks: () => void;
	};
};

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => activeEditor },
}));
mock.module("@/services/storage/service", () => ({
	storageService: {
		deleteMediaAsset: async ({ id }: { id: string }) => {
			deleted.push(id);
		},
		saveMediaAsset: async ({ mediaAsset }: { mediaAsset: MediaAsset }) => {
			restored.push(mediaAsset.id);
		},
	},
}));
mock.module("@/services/video-cache/service", () => ({
	videoCache: { clearVideo: () => undefined },
}));
mock.module("@/services/waveform-cache/service", () => ({
	waveformCache: { clearSource: () => undefined },
}));

const { RemoveMediaAssetCommand } = await import("./remove-media-asset");

describe("RemoveMediaAssetCommand persistence boundary", () => {
	test("defers durable deletion until verification and restores it on rollback", async () => {
		deleted.length = 0;
		restored.length = 0;
		const asset = mediaAsset();
		let assets = [asset];
		const tracks = {
			main: {
				id: "main",
				name: "Main",
				type: "video" as const,
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [],
			audio: [],
		};
		activeEditor = {
			media: {
				getAssets: () => assets,
				setAssets: ({ assets: next }: { assets: MediaAsset[] }) => {
					assets = next;
				},
			},
			scenes: { getActiveScene: () => ({ tracks }) },
			timeline: {
				deleteElements: () => undefined,
				updateTracks: () => undefined,
			},
		};
		const command = new RemoveMediaAssetCommand({
			projectId: "project",
			assetId: asset.id,
			deferPersistence: true,
		});

		command.execute();
		expect(assets).toEqual([]);
		expect(deleted).toEqual([]);

		await command.preparePersistence();
		expect(deleted).toEqual([asset.id]);

		command.undo();
		await command.rollbackPersistence();
		expect(assets.map(({ id }) => id)).toEqual([asset.id]);
		expect(restored).toEqual([asset.id]);
	});
});

function mediaAsset(): MediaAsset {
	return {
		id: "artifact",
		name: "artifact.png",
		type: "image",
		file: new File([], "artifact.png", { type: "image/png" }),
		width: 1080,
		height: 1920,
		role: "matte",
	};
}
