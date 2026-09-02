/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
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
let mediaAssets: MediaAsset[] = [];
const editor = {
	scenes: { getActiveScene: () => ({ tracks: activeTracks }) },
	timeline: {
		updateTracks: (tracks: SceneTracks) => {
			activeTracks = tracks;
		},
	},
	media: { getAssets: () => mediaAssets },
};

mock.module("@/core", () => ({
	EditorCore: { getInstance: () => editor },
}));

const { DuplicateElementsCommand, ToggleSourceAudioSeparationCommand } =
	await import("@/commands/timeline");
const { mediaTime } = await import("@/wasm");
const {
	buildRelationshipControlCommand,
	buildRelationshipMoves,
	expandElementRelationships,
} = await import("./relationship-control");

function baseElement({ id, startTime }: { id: string; startTime: number }) {
	return {
		id,
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function video({
	id,
	startTime,
}: {
	id: string;
	startTime: number;
}): VideoElement {
	return {
		...baseElement({ id, startTime }),
		type: "video",
		mediaId: `media-${id}`,
	};
}

function text({
	id,
	startTime,
}: {
	id: string;
	startTime: number;
}): TextElement {
	return { ...baseElement({ id, startTime }), type: "text" };
}

function audio({
	id,
	startTime,
}: {
	id: string;
	startTime: number;
}): AudioElement {
	return {
		...baseElement({ id, startTime }),
		type: "audio",
		sourceType: "upload",
		mediaId: `media-${id}`,
	};
}

function buildTracks({
	main = video({ id: "video-1", startTime: 100 }),
	overlay = text({ id: "text-1", startTime: 200 }),
	audioElement = audio({ id: "audio-1", startTime: 50 }),
}: {
	main?: VideoElement;
	overlay?: TextElement;
	audioElement?: AudioElement;
} = {}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main Track",
			type: "video",
			muted: false,
			hidden: false,
			elements: [main],
		},
		overlay: [
			{
				id: "text-track",
				name: "Text Track",
				type: "text",
				hidden: false,
				elements: [overlay],
			},
		],
		audio: [
			{
				id: "audio-track",
				name: "Audio Track",
				type: "audio",
				muted: false,
				elements: [audioElement],
			},
		],
	};
}

function allElements(): TimelineElement[] {
	const elements: TimelineElement[] = [...activeTracks.main.elements];
	for (const track of activeTracks.overlay) {
		for (const element of track.elements) elements.push(element);
	}
	for (const track of activeTracks.audio) {
		for (const element of track.elements) elements.push(element);
	}
	return elements;
}

describe("persistent element relationships", () => {
	test("sets exact group membership, prunes singletons, and clears groups", () => {
		activeTracks = buildTracks({
			main: {
				...video({ id: "video-1", startTime: 100 }),
				groupId: "old-group",
			},
			audioElement: {
				...audio({ id: "audio-1", startTime: 50 }),
				groupId: "old-group",
			},
		});
		buildRelationshipControlCommand({
			tracks: activeTracks,
			operation: {
				kind: "set_group",
				groupId: "group-1",
				elements: [
					{ trackId: "main", elementId: "video-1" },
					{ trackId: "text-track", elementId: "text-1" },
				],
			},
		}).execute();

		expect(allElements().map(({ id, groupId }) => ({ id, groupId }))).toEqual([
			{ id: "video-1", groupId: "group-1" },
			{ id: "text-1", groupId: "group-1" },
			{ id: "audio-1", groupId: undefined },
		]);

		buildRelationshipControlCommand({
			tracks: activeTracks,
			operation: { kind: "clear_group", groupId: "group-1" },
		}).execute();
		expect(
			allElements().every((element) => element.groupId === undefined),
		).toBe(true);
	});

	test("expands transitive group and link relationships by requested scope", () => {
		activeTracks = buildTracks({
			main: {
				...video({ id: "video-1", startTime: 100 }),
				groupId: "group-1",
			},
			overlay: {
				...text({ id: "text-1", startTime: 200 }),
				groupId: "group-1",
				linkId: "link-1",
			},
			audioElement: {
				...audio({ id: "audio-1", startTime: 50 }),
				linkId: "link-1",
			},
		});
		const anchor = [{ trackId: "main", elementId: "video-1" }];

		expect(
			expandElementRelationships({
				tracks: activeTracks,
				refs: anchor,
				scope: "all",
			}).map((entry) => entry.elementId),
		).toEqual(["video-1", "text-1", "audio-1"]);
		expect(
			expandElementRelationships({
				tracks: activeTracks,
				refs: anchor,
				scope: "group",
			}).map((entry) => entry.elementId),
		).toEqual(["video-1", "text-1"]);
		expect(
			expandElementRelationships({
				tracks: activeTracks,
				refs: anchor,
				scope: "element",
			}).map((entry) => entry.elementId),
		).toEqual(["video-1"]);
	});

	test("builds relationship-aware moves that preserve relative timing", () => {
		activeTracks = buildTracks({
			main: {
				...video({ id: "video-1", startTime: 100 }),
				groupId: "group-1",
			},
			overlay: {
				...text({ id: "text-1", startTime: 200 }),
				groupId: "group-1",
			},
		});
		const moves = buildRelationshipMoves({
			tracks: activeTracks,
			anchor: { trackId: "main", elementId: "video-1" },
			startTime: mediaTime({ ticks: 300 }),
			targetTrackId: "main",
			scope: "all",
		});

		expect(
			moves.map(({ elementId, newStartTime }) => ({
				elementId,
				newStartTime: Number(newStartTime),
			})),
		).toEqual([
			{ elementId: "video-1", newStartTime: 300 },
			{ elementId: "text-1", newStartTime: 400 },
		]);
	});

	test("duplicates complete relationships with fresh persistent IDs", () => {
		activeTracks = buildTracks({
			main: {
				...video({ id: "video-1", startTime: 100 }),
				groupId: "group-1",
				linkId: "link-1",
			},
			overlay: {
				...text({ id: "text-1", startTime: 200 }),
				groupId: "group-1",
				linkId: "link-1",
			},
		});
		new DuplicateElementsCommand({
			elements: [
				{ trackId: "main", elementId: "video-1" },
				{ trackId: "text-track", elementId: "text-1" },
			],
		}).execute();

		const copies = allElements().filter((element) =>
			element.name.endsWith("(copy)"),
		);
		expect(copies).toHaveLength(2);
		expect(copies[0]?.groupId).toBeTruthy();
		expect(copies[0]?.groupId).toBe(copies[1]?.groupId);
		expect(copies[0]?.groupId).not.toBe("group-1");
		expect(copies[0]?.linkId).toBe(copies[1]?.linkId);
		expect(copies[0]?.linkId).not.toBe("link-1");
	});

	test("links separated source audio to its video automatically", () => {
		activeTracks = buildTracks({
			main: video({ id: "video-1", startTime: 100 }),
		});
		mediaAssets = [
			{
				id: "media-video-1",
				name: "video-1.mp4",
				type: "video",
				file: new File([], "video-1.mp4", { type: "video/mp4" }),
				hasAudio: true,
			},
		];
		new ToggleSourceAudioSeparationCommand({
			trackId: "main",
			elementId: "video-1",
		}).execute();

		const separatedVideo = activeTracks.main.elements[0];
		const separatedAudio = activeTracks.audio
			.flatMap((track) => track.elements)
			.find((element) => element.id !== "audio-1");
		expect(separatedVideo?.linkId).toBeTruthy();
		expect(separatedAudio?.linkId).toBe(separatedVideo?.linkId);
	});
});
