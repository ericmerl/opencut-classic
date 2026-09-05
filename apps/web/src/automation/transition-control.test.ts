/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { VideoElement, VideoTrack } from "@/timeline";
import { nativeWasm } from "../../test/native-wasm";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	evaluateTransition: (options: unknown) =>
		nativeWasm().evaluateTransition(options),
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => null },
}));

const { buildTransitionCommand } = await import("./transition-control");
const { mediaTime } = await import("@/wasm");

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
		duration: mediaTime({ ticks: 240000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function buildTrack({ gap = 0 }: { gap?: number } = {}): VideoTrack {
	return {
		id: "track-1",
		name: "Main Track",
		type: "video",
		muted: false,
		hidden: false,
		elements: [
			buildElement({ id: "clip-1", startTime: 0 }),
			buildElement({ id: "clip-2", startTime: 240000 + gap }),
		],
	};
}

describe("buildTransitionCommand", () => {
	test("builds a native update for adjacent clips", () => {
		const command = buildTransitionCommand({
			track: buildTrack(),
			operation: {
				kind: "upsert_transition",
				trackId: "track-1",
				transitionId: "transition-1",
				fromElementId: "clip-1",
				toElementId: "clip-2",
				transitionType: "crossfade",
				duration: mediaTime({ ticks: 60000 }),
			},
		});

		expect(command.constructor.name).toBe("UpdateElementsCommand");
	});

	test("applies the Rust compound-boundary policy", () => {
		const track = buildTrack();
		track.elements[1] = {
			id: "clip-2",
			name: "Compound",
			type: "compound",
			startTime: mediaTime({ ticks: 240000 }),
			duration: mediaTime({ ticks: 240000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
			tracks: {
				main: {
					id: "nested-main",
					name: "Nested main",
					type: "video",
					muted: false,
					hidden: false,
					elements: [],
				},
				overlay: [],
				audio: [],
			},
		};
		expect(
			buildTransitionCommand({
				track,
				operation: {
					kind: "upsert_transition",
					trackId: track.id,
					transitionId: "transition-1",
					fromElementId: "clip-1",
					toElementId: "clip-2",
					transitionType: "crossfade",
					duration: mediaTime({ ticks: 60000 }),
				},
			}).constructor.name,
		).toBe("UpdateElementsCommand");
		expect(() =>
			buildTransitionCommand({
				track,
				operation: {
					kind: "upsert_transition",
					trackId: track.id,
					transitionId: "transition-1",
					fromElementId: "clip-1",
					toElementId: "clip-2",
					transitionType: "wipe",
					duration: mediaTime({ ticks: 60000 }),
				},
			}),
		).toThrow("does not support compound boundaries");
	});

	test("rejects gaps and excessive durations", () => {
		expect(() =>
			buildTransitionCommand({
				track: buildTrack({ gap: 1 }),
				operation: {
					kind: "upsert_transition",
					trackId: "track-1",
					transitionId: "transition-1",
					fromElementId: "clip-1",
					toElementId: "clip-2",
					transitionType: "slide",
					duration: mediaTime({ ticks: 60000 }),
				},
			}),
		).toThrow("transition elements must be consecutive and edge-adjacent");
		expect(() =>
			buildTransitionCommand({
				track: buildTrack(),
				operation: {
					kind: "upsert_transition",
					trackId: "track-1",
					transitionId: "transition-1",
					fromElementId: "clip-1",
					toElementId: "clip-2",
					transitionType: "zoom",
					duration: mediaTime({ ticks: 240001 }),
				},
			}),
		).toThrow("transition duration must be positive");
	});

	test("removes transitions by stable ID", () => {
		const track = buildTrack();
		track.elements[1] = {
			...track.elements[1],
			transitionIn: {
				id: "transition-1",
				type: "wipe",
				duration: mediaTime({ ticks: 60000 }),
				fromElementId: "clip-1",
			},
		};
		const command = buildTransitionCommand({
			track,
			operation: {
				kind: "remove_transition",
				trackId: "track-1",
				transitionId: "transition-1",
			},
		});

		expect(command.constructor.name).toBe("UpdateElementsCommand");
	});
});
