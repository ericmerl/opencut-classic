/// <reference types="bun" />

import { beforeEach, describe, expect, mock, test } from "bun:test";

const buildSubtitleTextElement = mock(
	({
		index,
		caption,
	}: {
		index: number;
		caption: { text: string; startTime: number; duration: number };
	}) => ({
		type: "text" as const,
		name: `Caption ${index + 1}`,
		startTime: caption.startTime * 120_000,
		duration: caption.duration * 120_000,
		trimStart: 0,
		trimEnd: 0,
		params: {
			content: `${caption.text}\nwrapped`,
			fontSize: 5,
			"transform.positionX": 0,
			"transform.positionY": 700,
		},
	}),
);

mock.module("@/subtitles/build-subtitle-text-element", () => ({
	buildSubtitleTextElement,
}));
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	TICKS_PER_SECOND: 120_000,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	roundMediaTime: ({ time }: { time: number }) => time,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
}));

const { mediaTime } = await import("@/wasm");
const {
	CAPTION_LAYOUT_ENGINE,
	CAPTION_LAYOUT_VERSION,
	buildCaptionElementForNativeApply,
	materializeEditPlanCaptions,
} = await import("./edit-plan-caption-materialization");

const caption = {
	text: "A very long caption",
	startTime: mediaTime({ ticks: 120_000 }),
	duration: mediaTime({ ticks: 240_000 }),
};

describe("edit-plan caption materialization", () => {
	beforeEach(() => buildSubtitleTextElement.mockClear());

	test("pins browser layout bytes and provenance on the resolved operation", () => {
		const operations = materializeEditPlanCaptions({
			operations: [{ kind: "insert_captions", captions: [caption] }],
			canvasSize: { width: 1080, height: 1920 },
		});

		expect(operations).toEqual([
			{
				kind: "insert_captions",
				captions: [
					{
						...caption,
						resolvedName: "Caption 1",
						resolvedContent: "A very long caption\nwrapped",
						resolvedParams: {
							content: "A very long caption\nwrapped",
							fontSize: 5,
							"transform.positionX": 0,
							"transform.positionY": 700,
						},
						resolvedLayoutVersion: CAPTION_LAYOUT_VERSION,
						resolvedLayoutEngine: CAPTION_LAYOUT_ENGINE,
					},
				],
			},
		]);
		expect(buildSubtitleTextElement).toHaveBeenCalledTimes(1);
	});

	test("uses the canvas established by earlier operations in the same plan", () => {
		materializeEditPlanCaptions({
			operations: [
				{
					kind: "set_project_settings",
					canvasSize: { width: 720, height: 1280 },
				},
				{ kind: "insert_captions", captions: [caption] },
			],
			canvasSize: { width: 1920, height: 1080 },
		});
		expect(buildSubtitleTextElement).toHaveBeenCalledWith(
			expect.objectContaining({ canvasSize: { width: 720, height: 1280 } }),
		);
	});

	test("does not accept caller-supplied resolved layout in public operations", () => {
		expect(() =>
			materializeEditPlanCaptions({
				operations: [
					{
						kind: "insert_captions",
						captions: [{ ...caption, resolvedName: "Injected" }],
					},
				],
				canvasSize: { width: 1080, height: 1920 },
			}),
		).toThrow("cannot provide resolved layout fields");
	});

	test("native apply consumes pinned values without measuring again", () => {
		const resolvedCaption = {
			...caption,
			resolvedName: "Caption 1",
			resolvedContent: "Pinned\nlayout",
			resolvedParams: {
				content: "Pinned\nlayout",
				fontSize: 8,
				"transform.positionY": 612.5,
			},
			resolvedLayoutVersion: CAPTION_LAYOUT_VERSION,
			resolvedLayoutEngine: CAPTION_LAYOUT_ENGINE,
		};
		const element = buildCaptionElementForNativeApply({
			caption: resolvedCaption,
			index: 0,
			style: { fontSize: 99 },
			canvasSize: { width: 1080, height: 1920 },
		});

		expect(element).toMatchObject({
			name: "Caption 1",
			startTime: caption.startTime,
			duration: caption.duration,
			params: resolvedCaption.resolvedParams,
		});
		expect(buildSubtitleTextElement).not.toHaveBeenCalled();
	});

	test("rejects partial, untrusted, or internally inconsistent evidence", () => {
		expect(() =>
			buildCaptionElementForNativeApply({
				caption: { ...caption, resolvedName: "Caption 1" },
				index: 0,
				style: undefined,
				canvasSize: { width: 1080, height: 1920 },
			}),
		).toThrow("must provide all fields");
		expect(() =>
			buildCaptionElementForNativeApply({
				caption: {
					...caption,
					resolvedName: "Caption 1",
					resolvedContent: "Pinned",
					resolvedParams: { content: "Different" },
					resolvedLayoutVersion: CAPTION_LAYOUT_VERSION,
					resolvedLayoutEngine: CAPTION_LAYOUT_ENGINE,
				},
				index: 0,
				style: undefined,
				canvasSize: { width: 1080, height: 1920 },
			}),
		).toThrow("does not match content");
		expect(() =>
			buildCaptionElementForNativeApply({
				caption: {
					...caption,
					resolvedName: "Caption 1",
					resolvedContent: "Pinned",
					resolvedParams: { content: "Pinned" },
					resolvedLayoutVersion: CAPTION_LAYOUT_VERSION,
					resolvedLayoutEngine: "untrusted-engine",
				},
				index: 0,
				style: undefined,
				canvasSize: { width: 1080, height: 1920 },
			}),
		).toThrow("unsupported resolved caption layout engine");
	});

	test("retains the legacy measurement path for V1 operations", () => {
		const element = buildCaptionElementForNativeApply({
			caption,
			index: 0,
			style: undefined,
			canvasSize: { width: 1080, height: 1920 },
		});
		expect(element.params.content).toBe("A very long caption\nwrapped");
		expect(buildSubtitleTextElement).toHaveBeenCalledTimes(1);
	});
});
