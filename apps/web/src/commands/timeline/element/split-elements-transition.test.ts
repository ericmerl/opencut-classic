/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement } from "@/timeline";

let tracks: SceneTracks;
mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks }) },
			timeline: {
				updateTracks: (updated: SceneTracks) => {
					tracks = updated;
				},
			},
		}),
	},
}));

const { mediaTime, ZERO_MEDIA_TIME } = await import("@/wasm");
const { SplitElementsCommand } = await import("./split-elements");

function video({
	id,
	startTime,
}: {
	id: string;
	startTime: number;
}): VideoElement {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		mediaId: `media-${id}`,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 240_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 240_000 }),
		params: {},
	};
}

describe("SplitElementsCommand transition integrity", () => {
	test("remaps an outgoing transition when retain-right replaces its source", () => {
		const before = {
			overlay: [],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					video({ id: "left-source", startTime: 0 }),
					{
						...video({ id: "next", startTime: 240_000 }),
						transitionIn: {
							id: "transition",
							type: "crossfade",
							duration: mediaTime({ ticks: 30_000 }),
							fromElementId: "left-source",
						},
					},
				],
			},
			audio: [],
		} satisfies SceneTracks;
		tracks = before;
		const command = new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "left-source" }],
			splitTime: mediaTime({ ticks: 120_000 }),
			retainSide: "right",
			rightElementIds: ["right-replacement"],
		});

		command.execute();
		expect(tracks.main.elements.map(({ id }) => id)).toEqual([
			"right-replacement",
			"next",
		]);
		expect(tracks.main.elements[1]?.transitionIn?.fromElementId).toBe(
			"right-replacement",
		);

		command.undo();
		expect(tracks).toBe(before);
	});

	test("removes an outgoing transition when retain-left creates a gap", () => {
		const before = {
			overlay: [],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					video({ id: "left-source", startTime: 0 }),
					{
						...video({ id: "next", startTime: 240_000 }),
						transitionIn: {
							id: "transition",
							type: "crossfade",
							duration: mediaTime({ ticks: 30_000 }),
							fromElementId: "left-source",
						},
					},
				],
			},
			audio: [],
		} satisfies SceneTracks;
		tracks = before;

		new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "left-source" }],
			splitTime: mediaTime({ ticks: 120_000 }),
			retainSide: "left",
		}).execute();

		expect(tracks.main.elements[1]?.transitionIn).toBeUndefined();
	});

	test("remaps an outgoing transition to the right half when retaining both", () => {
		const before = {
			overlay: [],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					video({ id: "left-source", startTime: 0 }),
					{
						...video({ id: "next", startTime: 240_000 }),
						transitionIn: {
							id: "transition",
							type: "crossfade",
							duration: mediaTime({ ticks: 30_000 }),
							fromElementId: "left-source",
						},
					},
				],
			},
			audio: [],
		} satisfies SceneTracks;
		tracks = before;

		new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "left-source" }],
			splitTime: mediaTime({ ticks: 120_000 }),
			retainSide: "both",
			rightElementIds: ["right-replacement"],
		}).execute();

		expect(tracks.main.elements.map(({ id }) => id)).toEqual([
			"left-source",
			"right-replacement",
			"next",
		]);
		expect(tracks.main.elements[2]?.transitionIn?.fromElementId).toBe(
			"right-replacement",
		);
	});
});
