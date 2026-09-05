import { describe, expect, test } from "bun:test";
import { parseAss } from "./ass";
import { serializeAss } from "./ass-export";
import type { SubtitleCue } from "./types";

const PLAY_RES = { width: 1080, height: 1920 };

const STYLED: SubtitleCue = {
	text: "First line\nSecond line",
	startTime: 0.5,
	duration: 1.75,
	style: {
		fontFamily: "TikTok Sans",
		fontSize: 6,
		color: "#ffff00",
		fontWeight: "bold",
		fontStyle: "italic",
		textDecoration: "underline",
		letterSpacing: 2,
		lineHeight: 1.4,
		textAlign: "left",
		background: {
			enabled: true,
			color: "#000000",
			cornerRadius: 8,
			paddingX: 16,
			paddingY: 8,
		},
		placement: {
			verticalAlign: "top",
			marginLeftRatio: 0.1,
			marginRightRatio: 0.2,
			marginVerticalRatio: 0.05,
		},
	},
};

const PLAIN: SubtitleCue = { text: "Plain", startTime: 3, duration: 2 };

describe("ASS export", () => {
	test("round-trips every supported style feature through the ASS parser", () => {
		const { content } = serializeAss({
			captions: [STYLED, PLAIN],
			playRes: PLAY_RES,
		});
		const parsed = parseAss({ input: content });

		expect(parsed.skippedCueCount).toBe(0);
		expect(parsed.captions).toHaveLength(2);
		const [styled, plain] = parsed.captions;
		expect(styled).toMatchObject({
			text: "First line\nSecond line",
			startTime: 0.5,
			duration: 1.75,
			style: {
				fontFamily: "TikTok Sans",
				color: "#ffff00",
				fontWeight: "bold",
				fontStyle: "italic",
				textDecoration: "underline",
				letterSpacing: 2,
				textAlign: "left",
				background: { enabled: true, color: "#000000" },
				placement: {
					verticalAlign: "top",
					marginLeftRatio: 0.1,
					marginRightRatio: 0.2,
					marginVerticalRatio: 0.05,
				},
			},
		});
		// Font size survives as a ratio of the play height: 6 app units on the
		// 90-unit reference is one fifteenth of the canvas.
		expect(styled?.style?.fontSizeRatioOfPlayHeight).toBeCloseTo(6 / 90, 3);
		expect(plain).toMatchObject({
			text: "Plain",
			startTime: 3,
			duration: 2,
			style: { fontFamily: "Arial", textAlign: "center" },
		});
		// The document itself declares nothing the parser must warn about.
		expect(parsed.warnings).toEqual([]);
	});

	test("reports what ASS cannot carry as a structured loss report", () => {
		const { lossReport } = serializeAss({
			captions: [STYLED, PLAIN, { ...STYLED, text: "Third" }],
			playRes: PLAY_RES,
		});
		expect(lossReport.format).toBe("ass");
		expect(lossReport.supported).toContain("backgroundColor");
		expect(lossReport.dropped).toEqual([
			{
				feature: "background.cornerRadius",
				cueCount: 2,
				reason: "ASS opaque boxes (BorderStyle 3) are rectangular",
			},
			{
				feature: "background.padding",
				cueCount: 2,
				reason:
					"ASS opaque boxes take their size from the text, not from padding",
			},
			{
				feature: "lineHeight",
				cueCount: 2,
				reason: "ASS styles have no line-height field",
			},
		]);
	});

	test("shares one style row between cues with identical styles", () => {
		const { content } = serializeAss({
			captions: [PLAIN, { ...PLAIN, text: "Again", startTime: 6 }, STYLED],
			playRes: PLAY_RES,
		});
		const styleRows = content
			.split("\n")
			.filter((line) => line.startsWith("Style: "));
		expect(styleRows).toHaveLength(2);
		expect(styleRows[0]).toMatch(/^Style: Default,Arial,107,/);
		expect(content).toContain(
			"Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,Plain",
		);
		expect(content).toContain(
			"Dialogue: 0,0:00:00.50,0:00:02.25,Style2,,0,0,0,,First line\\NSecond line",
		);
	});

	test("converts CSS colours to ASS BGR with inverted alpha", () => {
		const content = serializeAss({
			captions: [
				{ ...PLAIN, style: { color: "rgba(0, 128, 255, 0.5)" } },
			],
			playRes: PLAY_RES,
		}).content;
		expect(content).toContain("&H80ff8000,&H80ff8000");
		expect(() =>
			serializeAss({
				captions: [{ ...PLAIN, style: { color: "red" } }],
				playRes: PLAY_RES,
			}),
		).toThrow("unsupported colour");
	});

	test("imports ASS outline and shadow through the Rust style mapper", () => {
		const parsed = parseAss({
			input: `[Script Info]
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, BorderStyle, Outline, Shadow, Alignment
Style: FX,Arial,48,&H00FFFFFF,&H0000FF00,&H66000000,1,16,24,2

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:00.00,0:00:01.00,FX,Effects`,
		});

		expect(parsed.captions[0]?.style).toMatchObject({
			outline: { color: "#00ff00", width: 2, join: "round" },
			shadow: {
				color: "#00000099",
				offsetX: 3,
				offsetY: 3,
				blur: 0,
			},
		});
		expect(parsed.warnings).toEqual([]);
	});

	test("round-trips representable outline and shadow styles", () => {
		const caption: SubtitleCue = {
			...PLAIN,
			style: {
				outline: { color: "#00ff00", width: 2, join: "round" },
				shadow: {
					color: "#00000099",
					offsetX: 3,
					offsetY: 3,
					blur: 0,
				},
			},
		};
		const exported = serializeAss({ captions: [caption], playRes: PLAY_RES });
		const parsed = parseAss({ input: exported.content });

		expect(exported.lossReport.dropped).toEqual([]);
		expect(exported.lossReport.supported).toEqual(
			expect.arrayContaining(["outline", "shadow"]),
		);
		expect(parsed.captions[0]?.style).toMatchObject(caption.style!);
	});

	test("is deterministic", () => {
		const first = serializeAss({
			captions: [STYLED, PLAIN],
			playRes: PLAY_RES,
		});
		const second = serializeAss({
			captions: [STYLED, PLAIN],
			playRes: PLAY_RES,
		});
		expect(second).toEqual(first);
	});
});

describe("ASS export speaker and highlight", () => {
	test("carries the speaker as the cue Name and reports word highlight as a loss", () => {
		const { content, lossReport } = serializeAss({
			captions: [
				{
					...PLAIN,
					speaker: "guest,\nhost",
					style: { highlight: { enabled: true, color: "#ffd400" } },
				},
			],
			playRes: PLAY_RES,
		});
		// Commas and newlines would split Dialogue fields or rows, so both
		// become spaces while the speaker stays in the Name field.
		expect(content).toContain(
			"Dialogue: 0,0:00:03.00,0:00:05.00,Default,guest  host,",
		);
		expect(lossReport.supported).toContain("speaker");
		expect(lossReport.dropped).toEqual([
			{
				feature: "highlight",
				cueCount: 1,
				reason:
					"ASS karaoke tags fill words as they are sung rather than emphasizing the spoken word",
			},
		]);
		const parsed = parseAss({ input: content });
		expect(parsed.captions).toHaveLength(1);
	});
});
