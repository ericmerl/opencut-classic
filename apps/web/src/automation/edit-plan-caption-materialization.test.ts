/// <reference types="bun" />

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

const calls: string[] = [];

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

const geometryFixture = {
	version: "opencut.caption-geometry.v1",
	measurement: "opencut.text.measureTextLayout",
	canvas: { width: 1080, height: 1920 },
	position: { x: 0, y: 700 },
	lineCount: 2,
	lines: [],
	block: { left: -100, top: -40, width: 200, height: 80 },
	bubble: null,
	visual: { left: 440, top: 1620, width: 200, height: 80 },
	overflow: { left: 0, top: 0, right: 0, bottom: 0 },
	clipped: false,
	safeZone: {
		rect: { left: 108, top: 96, width: 864, height: 1728 },
		inside: true,
		overflow: { left: 0, top: 0, right: 0, bottom: 0 },
	},
};

const measureSubtitleCaption = mock(
	(input: {
		index: number;
		caption: { text: string; startTime: number; duration: number };
		canvasSize: { width: number; height: number };
	}) => {
		calls.push("measure");
		return {
			element: buildSubtitleTextElement(input),
			fontParams: { fontFamily: "Arial", fontWeight: "bold", fontStyle: "normal" },
			local: null,
			geometry: { ...geometryFixture, canvas: input.canvasSize },
		};
	},
);

mock.module("@/subtitles/build-subtitle-text-element", () => ({
	buildSubtitleTextElement,
	measureSubtitleCaption,
	createCaptionMeasurementContext: () => ({ fake: "context" }),
	resolveSubtitleFontParams: ({
		style,
	}: {
		style?: { fontFamily?: string; fontWeight?: string; fontStyle?: string };
	}) => ({
		fontFamily: style?.fontFamily ?? "Arial",
		fontWeight: style?.fontWeight ?? "bold",
		fontStyle: style?.fontStyle ?? "normal",
	}),
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
mock.module("./preview-render-common", () => ({
	sha256Bytes: async (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("hex"),
}));

const readinessFixture = {
	status: "ready" as const,
	families: ["Arial"],
	descriptors: [],
	descriptorsSha256: "f".repeat(64),
};
const waitForFonts = mock(async (descriptors: readonly { css: string }[]) => {
	calls.push(`fonts:${descriptors.map((descriptor) => descriptor.css).join("|")}`);
	return readinessFixture;
});

const { mediaTime } = await import("@/wasm");
const { canonicalSerialize } = await import("./project-content-hash");
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
	beforeEach(() => {
		buildSubtitleTextElement.mockClear();
		measureSubtitleCaption.mockClear();
		waitForFonts.mockClear();
		calls.length = 0;
	});

	test("pins browser layout, verifies fonts first, and returns hash-bound geometry evidence", async () => {
		const { operations, captionLayout } = await materializeEditPlanCaptions({
			operations: [{ kind: "insert_captions", captions: [caption] }],
			canvasSize: { width: 1080, height: 1920 },
			waitForFonts,
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
		expect(calls).toEqual(['fonts:normal bold 16px "Arial"', "measure"]);
		if (!captionLayout) throw new Error("expected caption layout evidence");
		expect(captionLayout).toMatchObject({
			layoutVersion: CAPTION_LAYOUT_VERSION,
			layoutEngine: CAPTION_LAYOUT_ENGINE,
			geometryVersion: "opencut.caption-geometry.v1",
			measurement: "opencut.text.measureTextLayout",
			fontReadiness: readinessFixture,
			captions: [
				{
					operationIndex: 0,
					captionIndex: 0,
					elementName: "Caption 1",
					fontDescriptorCss: 'normal bold 16px "Arial"',
					geometry: geometryFixture,
				},
			],
		});
		expect(captionLayout.geometrySha256).toBe(
			createHash("sha256")
				.update(canonicalSerialize(captionLayout.captions))
				.digest("hex"),
		);
	});

	test("uses the canvas established by earlier operations in the same plan", async () => {
		const { captionLayout } = await materializeEditPlanCaptions({
			operations: [
				{
					kind: "set_project_settings",
					canvasSize: { width: 720, height: 1280 },
				},
				{ kind: "insert_captions", captions: [caption] },
			],
			canvasSize: { width: 1920, height: 1080 },
			waitForFonts,
		});
		expect(measureSubtitleCaption).toHaveBeenCalledWith(
			expect.objectContaining({ canvasSize: { width: 720, height: 1280 } }),
		);
		expect(captionLayout?.captions[0]).toMatchObject({
			operationIndex: 1,
			geometry: { canvas: { width: 720, height: 1280 } },
		});
	});

	test("leaves plans without captions untouched and reads no fonts", async () => {
		const result = await materializeEditPlanCaptions({
			operations: [
				{
					kind: "set_project_settings",
					canvasSize: { width: 720, height: 1280 },
				},
			],
			canvasSize: { width: 1920, height: 1080 },
			waitForFonts,
		});
		expect(result.captionLayout).toBeNull();
		expect(waitForFonts).not.toHaveBeenCalled();
	});

	test("does not accept caller-supplied resolved layout in public operations", async () => {
		await expect(
			materializeEditPlanCaptions({
				operations: [
					{
						kind: "insert_captions",
						captions: [{ ...caption, resolvedName: "Injected" }],
					},
				],
				canvasSize: { width: 1080, height: 1920 },
				waitForFonts,
			}),
		).rejects.toThrow("cannot provide resolved layout fields");
		expect(waitForFonts).not.toHaveBeenCalled();
	});

	test("fails closed without a Canvas 2D measurement context", async () => {
		await expect(
			materializeEditPlanCaptions({
				operations: [{ kind: "insert_captions", captions: [caption] }],
				canvasSize: { width: 1080, height: 1920 },
				waitForFonts,
				createContext: () => null,
			}),
		).rejects.toThrow("requires a Canvas 2D measurement context");
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
