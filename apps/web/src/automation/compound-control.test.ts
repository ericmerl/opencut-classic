/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	SceneTracks,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/timeline";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));

let activeTracks: SceneTracks;
const editor = {
	scenes: { getActiveScene: () => ({ tracks: activeTracks }) },
	timeline: {
		updateTracks: (tracks: SceneTracks) => {
			activeTracks = tracks;
		},
	},
};

mock.module("@/core", () => ({
	EditorCore: { getInstance: () => editor },
}));

const { buildCompoundCommand } = await import("./compound-control");
const { SplitElementsCommand } = await import("@/commands/timeline");
const { mediaTime } = await import("@/wasm");

function base({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}) {
	return {
		id,
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: mediaTime({ ticks: duration }),
		params: {},
	};
}

function buildTracks(): SceneTracks {
	const video: VideoElement = {
		...base({ id: "video-1", startTime: 100, duration: 100 }),
		type: "video",
		mediaId: "media-video",
	};
	const text: TextElement = {
		...base({ id: "text-1", startTime: 150, duration: 100 }),
		type: "text",
	};
	const audio: AudioElement = {
		...base({ id: "audio-1", startTime: 80, duration: 50 }),
		type: "audio",
		sourceType: "upload",
		mediaId: "media-audio",
	};
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [video],
		},
		overlay: [
			{
				id: "text-track",
				name: "Text",
				type: "text",
				hidden: false,
				elements: [text],
			},
		],
		audio: [
			{
				id: "audio-track",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [audio],
			},
		],
	};
}

describe("compound clip control", () => {
	test("nests selected tracks relative to one source span and restores them", () => {
		activeTracks = buildTracks();
		buildCompoundCommand({
			tracks: activeTracks,
			operation: {
				kind: "create_compound",
				compoundId: "compound-1",
				name: "Sequence A",
				elements: [
					{ trackId: "main", elementId: "video-1" },
					{ trackId: "text-track", elementId: "text-1" },
					{ trackId: "audio-track", elementId: "audio-1" },
				],
			},
		}).execute();

		const compoundTrack = activeTracks.overlay.find((track) =>
			track.elements.some((element) => element.id === "compound-1"),
		);
		const compound = compoundTrack?.elements.find(
			(element) => element.id === "compound-1",
		);
		expect(compound?.type).toBe("compound");
		if (!compound || compound.type !== "compound" || !compoundTrack) return;
		expect(compound).toMatchObject({
			name: "Sequence A",
			startTime: 80,
			duration: 170,
			sourceDuration: 170,
		});
		expect(compound.tracks.main.elements[0]?.startTime).toBe(
			mediaTime({ ticks: 20 }),
		);
		expect(compound.tracks.overlay[0]?.elements[0]?.startTime).toBe(
			mediaTime({ ticks: 70 }),
		);
		expect(compound.tracks.audio[0]?.elements[0]?.startTime).toBe(
			mediaTime({ ticks: 0 }),
		);
		expect(activeTracks.main.elements).toHaveLength(0);

		compound.startTime = mediaTime({ ticks: 200 });
		compound.trimStart = mediaTime({ ticks: 20 });
		compound.duration = mediaTime({ ticks: 150 });
		compound.trimEnd = mediaTime({ ticks: 0 });
		buildCompoundCommand({
			tracks: activeTracks,
			operation: {
				kind: "break_apart_compound",
				trackId: compoundTrack.id,
				elementId: compound.id,
			},
		}).execute();

		expect(activeTracks.main.elements[0]?.startTime).toBe(
			mediaTime({ ticks: 200 }),
		);
		expect(
			activeTracks.overlay
				.flatMap((track) => [...track.elements] as TimelineElement[])
				.find((element) => element.id === "text-1")?.startTime,
		).toBe(mediaTime({ ticks: 250 }));
		expect(activeTracks.audio[0]?.elements[0]?.startTime).toBe(
			mediaTime({ ticks: 180 }),
		);
		expect(
			activeTracks.overlay.some((track) =>
				track.elements.some((element) => element.id === "compound-1"),
			),
		).toBe(false);
	});

	test("rejects duplicate compound IDs", () => {
		activeTracks = buildTracks();
		expect(() =>
			buildCompoundCommand({
				tracks: activeTracks,
				operation: {
					kind: "create_compound",
					compoundId: "video-1",
					elements: [
						{ trackId: "main", elementId: "video-1" },
						{ trackId: "text-track", elementId: "text-1" },
					],
				},
			}),
		).toThrow("element ID already exists");
	});

	test("gives a split compound half an independent nested identity graph", () => {
		activeTracks = buildTracks();
		buildCompoundCommand({
			tracks: activeTracks,
			operation: {
				kind: "create_compound",
				compoundId: "compound-1",
				elements: [
					{ trackId: "main", elementId: "video-1" },
					{ trackId: "text-track", elementId: "text-1" },
				],
			},
		}).execute();
		const track = activeTracks.overlay.find((candidate) =>
			candidate.elements.some((element) => element.id === "compound-1"),
		);
		if (!track) throw new Error("compound track is missing");
		new SplitElementsCommand({
			elements: [{ trackId: track.id, elementId: "compound-1" }],
			splitTime: mediaTime({ ticks: 150 }),
		}).execute();
		const halves = trackElements({
			tracks: activeTracks,
			trackId: track.id,
		}).filter((element) => element.type === "compound");
		expect(halves).toHaveLength(2);
		if (halves[0]?.type !== "compound" || halves[1]?.type !== "compound") {
			return;
		}
		const leftIds = new Set(
			[
				...halves[0].tracks.main.elements,
				...halves[0].tracks.overlay.flatMap(
					(nested) => [...nested.elements] as TimelineElement[],
				),
			].map((element) => element.id),
		);
		const rightIds = [
			...halves[1].tracks.main.elements,
			...halves[1].tracks.overlay.flatMap(
				(nested) => [...nested.elements] as TimelineElement[],
			),
		].map((element) => element.id);
		expect(rightIds.every((id) => !leftIds.has(id))).toBe(true);
	});
});

function trackElements({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineElement[] {
	return (
		[...tracks.overlay, tracks.main, ...tracks.audio].find(
			(track) => track.id === trackId,
		)?.elements ?? []
	);
}
