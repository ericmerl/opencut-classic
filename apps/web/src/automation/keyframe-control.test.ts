/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { VideoElement } from "@/timeline";

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
mock.module("@/core", () => ({
	EditorCore: { getInstance: () => null },
}));

const { upsertPathKeyframe } = await import("@/animation");
const { resolveAnimationTarget } = await import("@/timeline/animation-targets");
const { mediaTime } = await import("@/wasm");
const { buildKeyframeCommand } = await import("./keyframe-control");

function buildVideoElement(): VideoElement {
	return {
		id: "video-1",
		name: "fixture.mp4",
		type: "video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 480000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: mediaTime({ ticks: 480000 }),
		params: { opacity: 1 },
	};
}

function withOpacityKeyframe(element: VideoElement): VideoElement {
	const target = resolveAnimationTarget({ element, path: "opacity" });
	if (!target) throw new Error("opacity target missing from test fixture");
	return {
		...element,
		animations: upsertPathKeyframe({
			animations: element.animations,
			propertyPath: "opacity",
			time: mediaTime({ ticks: 0 }),
			value: 0,
			interpolation: "linear",
			keyframeId: "opacity-start",
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		}),
	};
}

describe("buildKeyframeCommand", () => {
	test("builds native create, retime, and remove commands", () => {
		const element = buildVideoElement();
		const create = buildKeyframeCommand({
			element,
			operation: {
				kind: "upsert_keyframe",
				trackId: "track-1",
				elementId: element.id,
				propertyPath: "opacity",
				time: mediaTime({ ticks: 0 }),
				value: 0,
				interpolation: "linear",
				keyframeId: "opacity-start",
			},
		});
		const animatedElement = withOpacityKeyframe(element);
		const retime = buildKeyframeCommand({
			element: animatedElement,
			operation: {
				kind: "retime_keyframe",
				trackId: "track-1",
				elementId: element.id,
				propertyPath: "opacity",
				keyframeId: "opacity-start",
				time: mediaTime({ ticks: 120000 }),
			},
		});
		const remove = buildKeyframeCommand({
			element: animatedElement,
			operation: {
				kind: "remove_keyframe",
				trackId: "track-1",
				elementId: element.id,
				propertyPath: "opacity",
				keyframeId: "opacity-start",
			},
		});

		expect(create.constructor.name).toBe("UpsertKeyframeCommand");
		expect(retime.constructor.name).toBe("RetimeKeyframeCommand");
		expect(remove.constructor.name).toBe("RemoveKeyframeCommand");
	});

	test("rejects unsupported paths and invalid values", () => {
		const element = buildVideoElement();
		expect(() =>
			buildKeyframeCommand({
				element,
				operation: {
					kind: "upsert_keyframe",
					trackId: "track-1",
					elementId: element.id,
					propertyPath: "unknown",
					time: mediaTime({ ticks: 0 }),
					value: 0,
				},
			}),
		).toThrow("property unknown cannot be keyframed");
		expect(() =>
			buildKeyframeCommand({
				element,
				operation: {
					kind: "upsert_keyframe",
					trackId: "track-1",
					elementId: element.id,
					propertyPath: "opacity",
					time: mediaTime({ ticks: 0 }),
					value: "opaque",
				},
			}),
		).toThrow("invalid keyframe value for opacity");
	});

	test("rejects out-of-range times and unknown keyframe IDs", () => {
		const element = buildVideoElement();
		expect(() =>
			buildKeyframeCommand({
				element,
				operation: {
					kind: "upsert_keyframe",
					trackId: "track-1",
					elementId: element.id,
					propertyPath: "opacity",
					time: mediaTime({ ticks: 480001 }),
					value: 1,
				},
			}),
		).toThrow("keyframe time must be between 0 and 480000 ticks");
		expect(() =>
			buildKeyframeCommand({
				element,
				operation: {
					kind: "remove_keyframe",
					trackId: "track-1",
					elementId: element.id,
					propertyPath: "opacity",
					keyframeId: "missing",
				},
			}),
		).toThrow("keyframe not found: opacity/missing");
	});

	test("accepts normalized reframe properties", () => {
		const element = buildVideoElement();
		const target = resolveAnimationTarget({
			element,
			path: "reframe.focalX",
		});
		expect(target?.numericRanges).toEqual({
			value: { min: 0, max: 0.999, step: 0.01 },
		});
		expect(
			buildKeyframeCommand({
				element,
				operation: {
					kind: "upsert_keyframe",
					trackId: "track-1",
					elementId: element.id,
					propertyPath: "reframe.focalX",
					time: mediaTime({ ticks: 120000 }),
					value: 0.75,
					interpolation: "linear",
					keyframeId: "focal-x-1",
				},
			}).constructor.name,
		).toBe("UpsertKeyframeCommand");
	});
});
