/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TextElement } from "@/timeline";

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
	media: { getAssets: () => [] },
	project: { getActive: () => null },
};

mock.module("@/core", () => ({
	EditorCore: { getInstance: () => editor },
}));

const { InsertElementCommand } = await import("./insert-element");
const { mediaTime } = await import("@/wasm");

describe("resolved element insertion", () => {
	test("uses the evaluator-provided element and auto-track IDs", () => {
		activeTracks = tracksWithOccupiedTextLayer();
		const command = new InsertElementCommand({
			elementId: "inserted-title",
			newTrackId: "resolved-text-track",
			placement: { mode: "auto" },
			element: textElement({ id: "candidate", startTime: 0, duration: 120000 }),
		});

		command.execute();

		const track = activeTracks.overlay.find(
			(candidate) => candidate.id === "resolved-text-track",
		);
		expect(track?.type).toBe("text");
		expect(track?.elements.map((element) => element.id)).toEqual([
			"inserted-title",
		]);
		expect(command.getTrackId()).toBe("resolved-text-track");
	});

	test("fails without mutating when the resolved track ID already exists", () => {
		activeTracks = tracksWithOccupiedTextLayer();
		const before = structuredClone(activeTracks);
		const command = new InsertElementCommand({
			elementId: "inserted-title",
			newTrackId: "occupied-text-track",
			placement: { mode: "auto" },
			element: textElement({ id: "candidate", startTime: 0, duration: 120000 }),
		});

		expect(command.execute()).toBeUndefined();
		expect(activeTracks).toEqual(before);
	});
});

function tracksWithOccupiedTextLayer(): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		overlay: [
			{
				id: "occupied-text-track",
				name: "Text",
				type: "text",
				hidden: false,
				elements: [
					textElement({ id: "existing", startTime: 0, duration: 120000 }),
				],
			},
		],
		audio: [],
	};
}

function textElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): TextElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { content: id },
	};
}
