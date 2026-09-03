/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { CommandResult } from "@/commands/base-command";
import type { SceneTracks, VideoElement } from "@/timeline";

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
let rippleEnabled = false;

const editor = {
	scenes: {
		getActiveScene: () => ({ tracks: activeTracks }),
	},
	timeline: {
		updateTracks: (tracks: SceneTracks) => {
			activeTracks = tracks;
		},
	},
	command: {
		get isRippleEnabled() {
			return rippleEnabled;
		},
	},
};

mock.module("@/core", () => ({
	EditorCore: { getInstance: () => editor },
}));

const { Command } = await import("@/commands/base-command");
const { mediaTime } = await import("@/wasm");
const { withRipple } = await import("./ripple-control");

function buildElement({
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
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function buildTracks(): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "Main Track",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				buildElement({ id: "clip-1", startTime: 0 }),
				buildElement({ id: "clip-2", startTime: 100 }),
				buildElement({ id: "clip-3", startTime: 200 }),
			],
		},
		audio: [],
	};
}

class DeleteMiddleCommand extends Command {
	private before: SceneTracks | null = null;

	execute(): CommandResult {
		this.before = activeTracks;
		activeTracks = {
			...activeTracks,
			main: {
				...activeTracks.main,
				elements: activeTracks.main.elements.filter(
					(element) => element.id !== "clip-2",
				),
			},
		};
		return { selection: { selectedElements: [] } };
	}

	undo(): void {
		if (this.before) activeTracks = this.before;
	}
}

describe("explicit automation ripple control", () => {
	test("closes vacated time and preserves the wrapped selection result", () => {
		activeTracks = buildTracks();
		rippleEnabled = false;
		const command = withRipple({
			command: new DeleteMiddleCommand(),
			enabled: true,
		});

		const result = command.execute();

		expect(
			activeTracks.main.elements.map(({ id, startTime }) => ({
				id,
				startTime: Number(startTime),
			})),
		).toEqual([
			{ id: "clip-1", startTime: 0 },
			{ id: "clip-3", startTime: 100 },
		]);
		expect(result).toEqual({ selection: { selectedElements: [] } });

		command.undo();
		expect(activeTracks.main.elements.map((element) => element.id)).toEqual([
			"clip-1",
			"clip-2",
			"clip-3",
		]);
	});

	test("does not apply ripple twice when the editor-wide mode is active", () => {
		activeTracks = buildTracks();
		rippleEnabled = true;
		const command = withRipple({
			command: new DeleteMiddleCommand(),
			enabled: true,
		});

		command.execute();

		expect(
			activeTracks.main.elements.map(({ id, startTime }) => ({
				id,
				startTime: Number(startTime),
			})),
		).toEqual([
			{ id: "clip-1", startTime: 0 },
			{ id: "clip-3", startTime: 200 },
		]);
	});

	test("returns the native command unchanged when ripple is disabled", () => {
		const nativeCommand = new DeleteMiddleCommand();
		expect(withRipple({ command: nativeCommand, enabled: false })).toBe(
			nativeCommand,
		);
	});
});
