/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	SceneTracks,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import { isLeafChannelData } from "@/animation/channel-data";
import { nativeWasm } from "../../test/native-wasm";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	resolveSplitTransition: (options: unknown) =>
		nativeWasm().resolveSplitTransition(options),
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
const { DuplicateElementsCommand, SplitElementsCommand } =
	await import("@/commands/timeline");
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

	test("consumes exact native IDs for compound placement and break-apart", () => {
		activeTracks = buildTracks();
		buildCompoundCommand({
			tracks: activeTracks,
			operation: {
				kind: "create_compound",
				compoundId: "compound-strict",
				elements: [
					{ trackId: "text-track", elementId: "text-1" },
					{ trackId: "audio-track", elementId: "audio-1" },
				],
				autoTrackId: "compound-output-track",
				emptyMainTrackId: "compound-empty-main",
				resolvedAllocations: [
					{
						role: "compound-auto-track",
						sourceId: "",
						resolvedId: "compound-output-track",
					},
					{
						role: "compound-empty-main-track",
						sourceId: "",
						resolvedId: "compound-empty-main",
					},
				],
			},
		}).execute();
		const output = activeTracks.overlay.find(
			(track) => track.id === "compound-output-track",
		);
		const compound = output?.elements.find(
			(element) => element.id === "compound-strict",
		);
		expect(compound?.type).toBe("compound");
		if (!compound || compound.type !== "compound" || !output) return;
		expect(compound.tracks.main.id).toBe("compound-empty-main");

		buildCompoundCommand({
			tracks: activeTracks,
			operation: {
				kind: "break_apart_compound",
				trackId: output.id,
				elementId: compound.id,
				restoredElementIds: ["restored-text", "restored-audio"],
				resolvedAllocations: [
					{
						role: "break-apart-element",
						sourceId: "text-1",
						resolvedId: "restored-text",
					},
					{
						role: "break-apart-element",
						sourceId: "audio-1",
						resolvedId: "restored-audio",
					},
				],
			},
		}).execute();
		expect(
			trackElements({ tracks: activeTracks, trackId: "text-track" }).map(
				(element) => element.id,
			),
		).toContain("restored-text");
		expect(
			activeTracks.audio[0]?.elements.map((element) => element.id),
		).toContain("restored-audio");
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
		const sourceCompound = track.elements.find(
			(element) => element.id === "compound-1",
		);
		if (sourceCompound?.type !== "compound") {
			throw new Error("compound element is missing");
		}
		const nestedTracks = [
			sourceCompound.tracks.main,
			...sourceCompound.tracks.overlay,
			...sourceCompound.tracks.audio,
		];
		const nestedElements = nestedTracks.flatMap((nested) => [
			...(nested.elements as TimelineElement[]),
		]);
		const animatedNested = nestedElements[0];
		if (!animatedNested) throw new Error("nested element fixture is missing");
		animatedNested.animations = {
			opacity: {
				keys: [
					{
						id: "nested-keyframe",
						time: mediaTime({ ticks: 0 }),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		};
		new SplitElementsCommand({
			elements: [{ trackId: track.id, elementId: "compound-1" }],
			splitTime: mediaTime({ ticks: 150 }),
			rightElementIds: ["compound-right"],
			resolvedAllocations: [
				...nestedTracks.map((nested) => ({
					role: "split-nested-track" as const,
					sourceId: nested.id,
					resolvedId: `right-${nested.id}`,
				})),
				...nestedElements.map((element) => ({
					role: "split-nested-element" as const,
					sourceId: element.id,
					resolvedId: `right-${element.id}`,
				})),
				{
					role: "split-nested-keyframe",
					sourceId: "nested-keyframe",
					resolvedId: "right-nested-keyframe",
				},
			],
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
		expect(rightIds).toEqual(
			nestedElements.map((element) => `right-${element.id}`),
		);
		expect(rightIds.every((id) => !leftIds.has(id))).toBe(true);
		expect(halves[1].id).toBe("compound-right");
		const rightNested = [
			...halves[1].tracks.main.elements,
			...halves[1].tracks.overlay.flatMap(
				(nested) => [...nested.elements] as TimelineElement[],
			),
		].find((element) => element.id === `right-${animatedNested.id}`);
		const rightNestedOpacity = rightNested?.animations?.opacity;
		if (!isLeafChannelData(rightNestedOpacity)) {
			throw new Error("right nested animation is missing");
		}
		expect(rightNestedOpacity.keys.map((key) => key.id)).toEqual([
			"right-nested-keyframe",
		]);
	});

	test("consumes exact split identity and animation-boundary allocations", () => {
		activeTracks = buildTracks();
		const source = activeTracks.main.elements[0];
		if (source?.type !== "video") throw new Error("video fixture is missing");
		source.groupId = "group-1";
		source.linkId = "link-1";
		source.effects = [
			{ id: "effect-1", type: "color-grade", enabled: true, params: {} },
		];
		source.masks = [
			{
				id: "mask-1",
				type: "ellipse",
				params: {
					feather: 0,
					inverted: false,
					strokeColor: "#ffffff",
					strokeWidth: 0,
					strokeAlign: "center",
					centerX: 0.5,
					centerY: 0.5,
					width: 0.5,
					height: 0.5,
					rotation: 0,
					scale: 1,
				},
			},
		];
		source.animations = {
			opacity: {
				keys: [
					{
						id: "key-left",
						time: mediaTime({ ticks: 0 }),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: "key-right",
						time: mediaTime({ ticks: 100 }),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		};
		new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "video-1" }],
			splitTime: mediaTime({ ticks: 150 }),
			rightElementIds: ["video-right"],
			resolvedAllocations: [
				{
					role: "split-left-boundary-keyframe",
					sourceId: "opacity",
					resolvedId: "key-boundary-left",
				},
				{
					role: "split-right-boundary-keyframe",
					sourceId: "opacity",
					resolvedId: "key-boundary-right",
				},
				{ role: "split-group", sourceId: "group-1", resolvedId: "group-right" },
				{ role: "split-link", sourceId: "link-1", resolvedId: "link-right" },
				{
					role: "split-effect",
					sourceId: "effect-1",
					resolvedId: "effect-right",
				},
				{ role: "split-mask", sourceId: "mask-1", resolvedId: "mask-right" },
			],
		}).execute();

		const left = activeTracks.main.elements.find(
			(element) => element.id === "video-1",
		);
		const right = activeTracks.main.elements.find(
			(element) => element.id === "video-right",
		);
		if (left?.type !== "video" || right?.type !== "video") {
			throw new Error("split result is incomplete");
		}
		expect({ groupId: left.groupId, linkId: left.linkId }).toEqual({
			groupId: "group-1",
			linkId: "link-1",
		});
		expect({ groupId: right.groupId, linkId: right.linkId }).toEqual({
			groupId: "group-right",
			linkId: "link-right",
		});
		expect(right.effects?.[0]?.id).toBe("effect-right");
		expect(right.masks?.[0]?.id).toBe("mask-right");
		const leftKeys = left.animations?.opacity;
		const rightKeys = right.animations?.opacity;
		if (!isLeafChannelData(leftKeys) || !isLeafChannelData(rightKeys)) {
			throw new Error("split animations are missing");
		}
		expect(leftKeys.keys.map((key) => key.id)).toEqual([
			"key-left",
			"key-boundary-left",
		]);
		expect(rightKeys.keys.map((key) => key.id)).toEqual([
			"key-boundary-right",
			"key-right",
		]);
	});

	test("uses the nested-keyframe role when duplicating a compound", () => {
		activeTracks = buildTracks();
		buildCompoundCommand({
			tracks: activeTracks,
			operation: {
				kind: "create_compound",
				compoundId: "compound-source",
				elements: [
					{ trackId: "main", elementId: "video-1" },
					{ trackId: "text-track", elementId: "text-1" },
				],
			},
		}).execute();
		const sourceTrack = activeTracks.overlay.find((track) =>
			track.elements.some((element) => element.id === "compound-source"),
		);
		const source = sourceTrack?.elements.find(
			(element) => element.id === "compound-source",
		);
		if (!sourceTrack || source?.type !== "compound") {
			throw new Error("compound source is missing");
		}
		const nestedTracks = [
			source.tracks.main,
			...source.tracks.overlay,
			...source.tracks.audio,
		];
		const nestedElements = nestedTracks.flatMap((track) => [
			...(track.elements as TimelineElement[]),
		]);
		const animated = nestedElements[0];
		if (!animated) throw new Error("nested source element is missing");
		animated.animations = {
			opacity: {
				keys: [
					{
						id: "nested-source-key",
						time: mediaTime({ ticks: 0 }),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		};
		new DuplicateElementsCommand({
			elements: [{ trackId: sourceTrack.id, elementId: source.id }],
			duplicateIds: ["compound-copy"],
			resolvedAllocations: [
				{
					role: "duplicate-track",
					sourceId: sourceTrack.id,
					resolvedId: "duplicate-host-track",
				},
				...nestedTracks.map((track) => ({
					role: "duplicate-nested-track" as const,
					sourceId: track.id,
					resolvedId: `copy-${track.id}`,
				})),
				...nestedElements.map((element) => ({
					role: "duplicate-nested-element" as const,
					sourceId: element.id,
					resolvedId: `copy-${element.id}`,
				})),
				{
					role: "duplicate-nested-keyframe",
					sourceId: "nested-source-key",
					resolvedId: "nested-copy-key",
				},
			],
		}).execute();

		const duplicateHost = activeTracks.overlay.find(
			(track) => track.id === "duplicate-host-track",
		);
		const duplicate = duplicateHost?.elements.find(
			(element) => element.id === "compound-copy",
		);
		if (duplicate?.type !== "compound") {
			throw new Error("compound duplicate is missing");
		}
		const copiedNested = [
			...duplicate.tracks.main.elements,
			...duplicate.tracks.overlay.flatMap(
				(track) => [...track.elements] as TimelineElement[],
			),
		].find((element) => element.id === `copy-${animated.id}`);
		const copiedOpacity = copiedNested?.animations?.opacity;
		if (!isLeafChannelData(copiedOpacity)) {
			throw new Error("copied nested animation is missing");
		}
		expect(copiedOpacity.keys.map((key) => key.id)).toEqual([
			"nested-copy-key",
		]);
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
