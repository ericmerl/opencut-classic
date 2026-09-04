/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import type { MediaTime } from "@/wasm";

let tracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ id: "scene-1", tracks }) },
			timeline: {
				updateTracks: (next: SceneTracks) => {
					tracks = next;
				},
			},
		}),
	},
}));

const { RenameTrackCommand } = await import("./rename-track");
const { ReorderTracksCommand } = await import("./reorder-tracks");
const { DuplicateTrackCommand } = await import("./duplicate-track");
const { SetMainTrackCommand } = await import("./set-main-track");
const { RemoveTrackCommand } = await import("./remove-track");

function element(id: string, startTime: number, duration = 10): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "asset-1",
		startTime: startTime as MediaTime,
		duration: duration as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		params: {},
	};
}

function videoTrack(id: string, elements: VideoElement[] = []): VideoTrack {
	return { id, name: id, type: "video", elements, muted: false, hidden: false };
}

function fixture(): SceneTracks {
	return {
		main: videoTrack("main", [element("m-1", 0)]),
		overlay: [
			videoTrack("overlay-a", [
				{ ...element("a-1", 0), transitionIn: undefined },
				{
					...element("a-2", 10),
					transitionIn: {
						id: "t-1",
						type: "crossfade",
						duration: 2 as MediaTime,
						fromElementId: "a-1",
					},
				},
			]),
			{
				id: "text-b",
				name: "text-b",
				type: "text",
				elements: [],
				hidden: false,
			},
		],
		audio: [
			{
				id: "audio-c",
				name: "audio-c",
				type: "audio",
				elements: [],
				muted: false,
			},
			{
				id: "audio-d",
				name: "audio-d",
				type: "audio",
				elements: [],
				muted: false,
			},
		],
	};
}

describe("track lifecycle commands", () => {
	test("rename validates the name and undo restores the previous tracks", () => {
		tracks = fixture();
		const command = new RenameTrackCommand({
			trackId: "text-b",
			name: "  Titles ",
		});
		command.execute();
		expect(tracks.overlay[1]!.name).toBe("Titles");
		command.undo();
		expect(tracks.overlay[1]!.name).toBe("text-b");
		expect(() =>
			new RenameTrackCommand({ trackId: "missing", name: "x" }).execute(),
		).toThrow(/not found/);
		expect(() =>
			new RenameTrackCommand({ trackId: "main", name: " " }).execute(),
		).toThrow(/required/);
	});

	test("reorder requires each track exactly once per role", () => {
		tracks = fixture();
		new ReorderTracksCommand({
			overlayTrackIds: ["text-b", "overlay-a"],
			audioTrackIds: ["audio-d", "audio-c"],
		}).execute();
		expect(tracks.overlay.map((track) => track.id)).toEqual([
			"text-b",
			"overlay-a",
		]);
		expect(tracks.audio.map((track) => track.id)).toEqual([
			"audio-d",
			"audio-c",
		]);
		expect(() =>
			new ReorderTracksCommand({ overlayTrackIds: ["overlay-a"] }).execute(),
		).toThrow(/exactly once/);
		expect(() =>
			new ReorderTracksCommand({
				audioTrackIds: ["audio-c", "audio-c"],
			}).execute(),
		).toThrow(/exactly once/);
		expect(() => new ReorderTracksCommand({}).execute()).toThrow(/required/);
	});

	test("duplicate copies elements and transitions with fresh ids after the source", () => {
		tracks = fixture();
		tracks.overlay[0]!.trackMatte = {
			sourceTrackId: "main",
			mode: "alpha",
			inverted: false,
			enabled: true,
		};
		const command = new DuplicateTrackCommand({ trackId: "overlay-a" });
		command.execute();
		const copyId = command.getTrackId();
		expect(tracks.overlay.map((track) => track.id)).toEqual([
			"overlay-a",
			copyId,
			"text-b",
		]);
		const copy = tracks.overlay[1] as VideoTrack;
		expect(copy.trackMatte).toBeUndefined();
		expect(copy.name).toBe("overlay-a copy");
		expect(copy.elements.map((candidate) => candidate.name)).toEqual([
			"a-1 (copy)",
			"a-2 (copy)",
		]);
		expect(new Set(copy.elements.map((candidate) => candidate.id)).size).toBe(
			2,
		);
		expect(
			copy.elements.some(
				(candidate) => candidate.id === "a-1" || candidate.id === "a-2",
			),
		).toBe(false);
		expect(copy.elements[1]!.transitionIn).toMatchObject({
			fromElementId: copy.elements[0]!.id,
		});
		expect(copy.elements[1]!.transitionIn?.id).not.toBe("t-1");
		expect(
			tracks.overlay[0]!.elements.map((candidate) => candidate.id),
		).toEqual(["a-1", "a-2"]);
		// Resolved allocations pin every copied identity.
		tracks = fixture();
		const pinned = new DuplicateTrackCommand({
			trackId: "overlay-a",
			newTrackId: "pinned-track",
			resolvedAllocations: [
				{
					role: "duplicate-track",
					sourceId: "overlay-a",
					resolvedId: "pinned-track",
				},
				{
					role: "duplicate-element",
					sourceId: "a-1",
					resolvedId: "pinned-a-1",
				},
				{
					role: "duplicate-element",
					sourceId: "a-2",
					resolvedId: "pinned-a-2",
				},
				{
					role: "duplicate-transition",
					sourceId: "t-1",
					resolvedId: "pinned-t-1",
				},
			],
		});
		pinned.execute();
		expect(
			(tracks.overlay[1] as VideoTrack).elements.map(
				(candidate) => candidate.id,
			),
		).toEqual(["pinned-a-1", "pinned-a-2"]);
		expect(
			(tracks.overlay[1] as VideoTrack).elements[1]!.transitionIn,
		).toMatchObject({
			id: "pinned-t-1",
			fromElementId: "pinned-a-1",
		});
		// The main track duplicates to the top of the overlay stack.
		new DuplicateTrackCommand({
			trackId: "main",
			newTrackId: "main-copy",
		}).execute();
		expect(tracks.overlay[0]!.id).toBe("main-copy");
		expect(tracks.main.id).toBe("main");
		expect(() =>
			new DuplicateTrackCommand({
				trackId: "main",
				newTrackId: "main-copy",
			}).execute(),
		).toThrow(/already exists/);
	});

	test("set-main promotes an overlay video track and demotes the previous main", () => {
		tracks = fixture();
		new SetMainTrackCommand({ trackId: "overlay-a" }).execute();
		expect(tracks.main.id).toBe("overlay-a");
		expect(tracks.main.name).toBe("Main Track");
		expect(tracks.overlay.map((track) => track.id)).toEqual(["main", "text-b"]);
		expect(() =>
			new SetMainTrackCommand({ trackId: "text-b" }).execute(),
		).toThrow(/cannot become/);
		expect(() =>
			new SetMainTrackCommand({ trackId: "audio-c" }).execute(),
		).toThrow(/not an overlay track/);
	});

	test("remove enforces the occupied policy and can move elements", () => {
		tracks = fixture();
		expect(() => new RemoveTrackCommand("main").execute()).toThrow(
			/main track/,
		);
		expect(() => new RemoveTrackCommand("overlay-a").execute()).toThrow(
			/occupied policy/,
		);
		new RemoveTrackCommand("text-b").execute();
		expect(tracks.overlay.map((track) => track.id)).toEqual(["overlay-a"]);
		tracks = fixture();
		expect(() =>
			new RemoveTrackCommand("overlay-a", {
				occupied: "move",
				targetTrackId: "text-b",
			}).execute(),
		).toThrow(/cannot move onto/);
		tracks = {
			...fixture(),
			overlay: [
				...fixture().overlay,
				videoTrack("overlay-e", [element("e-1", 0)]),
			],
		};
		expect(() =>
			new RemoveTrackCommand("overlay-a", {
				occupied: "move",
				targetTrackId: "overlay-e",
			}).execute(),
		).toThrow(/does not have room/);
		tracks = {
			...fixture(),
			overlay: [
				...fixture().overlay,
				videoTrack("overlay-e", [element("e-1", 40)]),
			],
		};
		const moved = new RemoveTrackCommand("overlay-a", {
			occupied: "move",
			targetTrackId: "overlay-e",
		});
		moved.execute();
		expect(tracks.overlay.map((track) => track.id)).toEqual([
			"text-b",
			"overlay-e",
		]);
		expect(
			tracks.overlay[1]!.elements.map((candidate) => candidate.id),
		).toEqual(["a-1", "a-2", "e-1"]);
		moved.undo();
		expect(tracks.overlay.map((track) => track.id)).toEqual([
			"overlay-a",
			"text-b",
			"overlay-e",
		]);
		new RemoveTrackCommand("overlay-a", { occupied: "delete" }).execute();
		expect(tracks.overlay.map((track) => track.id)).toEqual([
			"text-b",
			"overlay-e",
		]);
	});

	test("cascade removes the Rust-resolved relationship expansion", () => {
		tracks = fixture();
		tracks.main.elements[0] = {
			...tracks.main.elements[0]!,
			groupId: "shared-group",
		};
		tracks.overlay[0]!.elements[0] = {
			...tracks.overlay[0]!.elements[0]!,
			groupId: "shared-group",
		};
		tracks.overlay.push(
			videoTrack("overlay-e", [
				{
					...element("e-1", 40),
					transitionIn: {
						id: "t-external",
						type: "crossfade",
						duration: 2 as MediaTime,
						fromElementId: "a-1",
					},
				},
			]),
		);

		const command = new RemoveTrackCommand("overlay-a", {
			occupied: "cascade",
			elementIds: ["a-1", "a-2", "m-1"],
		});
		command.execute();
		expect(tracks.main.elements).toEqual([]);
		expect(tracks.overlay.map((track) => track.id)).toEqual([
			"text-b",
			"overlay-e",
		]);
		expect(tracks.overlay[1]!.elements[0]!.transitionIn).toBeUndefined();
		command.undo();
		expect(tracks.main.elements[0]!.id).toBe("m-1");
		expect(tracks.overlay[0]!.id).toBe("overlay-a");
	});
});
