/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { TextElement, VideoElement } from "@/timeline";

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
mock.module("@/core", () => ({ EditorCore: { getInstance: () => null } }));

const { mediaTime } = await import("@/wasm");
const { buildCaptionCorrectionCommand, buildCaptionCorrectionPatch } =
	await import("./caption-control");

function captionElement(): TextElement {
	return {
		id: "caption-1",
		name: "Caption 1",
		type: "text",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 120000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { content: "Original" },
	};
}

describe("caption correction", () => {
	test("builds one native update for text and timing", () => {
		const element = captionElement();
		const operation = {
			kind: "update_caption",
			trackId: "captions",
			elementId: "caption-1",
			text: "Corrected",
			startTime: mediaTime({ ticks: 60000 }),
			duration: mediaTime({ ticks: 180000 }),
		} as const;
		const command = buildCaptionCorrectionCommand({ element, operation });
		const patch = buildCaptionCorrectionPatch({ element, operation });

		expect(command.constructor.name).toBe("UpdateElementsCommand");
		expect(patch).toEqual({
			params: { content: "Corrected" },
			startTime: mediaTime({ ticks: 60000 }),
			duration: mediaTime({ ticks: 180000 }),
		});
	});

	test("rejects non-text elements and empty corrections", () => {
		const video: VideoElement = {
			id: "video-1",
			name: "video.mp4",
			type: "video",
			mediaId: "media-1",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		};
		expect(() =>
			buildCaptionCorrectionCommand({
				element: video,
				operation: {
					kind: "update_caption",
					trackId: "main",
					elementId: "video-1",
					text: "Not a caption",
				},
			}),
		).toThrow("caption corrections require a text element");
		expect(() =>
			buildCaptionCorrectionCommand({
				element: captionElement(),
				operation: {
					kind: "update_caption",
					trackId: "captions",
					elementId: "caption-1",
				},
			}),
		).toThrow("at least one caption correction is required");
	});

	test("merges Rust-resolved style params without copying transport style", () => {
		const patch = buildCaptionCorrectionPatch({
			element: captionElement(),
			operation: {
				kind: "update_caption",
				trackId: "captions",
				elementId: "caption-1",
				style: {
					outline: { color: "#ABCDEF", width: 2, join: "round" },
				},
				resolvedParams: {
					"outline.color": "#abcdef",
					"outline.width": 2,
					"outline.join": "round",
				},
			},
		});

		expect(patch).toEqual({
			params: {
				content: "Original",
				"outline.color": "#abcdef",
				"outline.width": 2,
				"outline.join": "round",
			},
		});
	});
});
