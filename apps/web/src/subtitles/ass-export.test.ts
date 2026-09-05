import { describe, expect, test } from "bun:test";
import { parseAss } from "./ass";
import { serializeAss, toAssColor } from "./ass-export";
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
		expect(toAssColor("#ff8000")).toBe("&H000080FF");
		expect(toAssColor("#ff800080")).toBe("&H7F0080FF");
		expect(toAssColor("rgba(0, 128, 255, 0.5)")).toBe("&H80FF8000");
		expect(() => toAssColor("red")).toThrow("unsupported colour");
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

describe("ASS outline and shadow", () => {
	const OUTLINED: SubtitleCue = {
		text: "Outlined",
		startTime: 0,
		duration: 1,
		style: {
			fontFamily: "TikTok Sans",
			fontSize: 6,
			color: "#ffffff",
			outline: { enabled: true, color: "#102030", width: 0.125 },
			shadow: {
				enabled: true,
				color: "#000000",
				offsetX: 0.0625,
				offsetY: 0.0625,
				blur: 0,
			},
		},
	};

	test("round-trips outline width and an even shadow through ASS pixels", () => {
		// fontSize 6 is 6/90 of the 1920 play height: a 128 px face, so the
		// 0.125 em outline is 16 px and the 0.0625 em shadow is 8 px.
		const { content, lossReport } = serializeAss({
			captions: [OUTLINED],
			playRes: { width: 1080, height: 1920 },
		});
		const styleRow = content
			.split("\n")
			.find((line) => line.startsWith("Style: Default,"));
		expect(styleRow).toBeDefined();
		const fields = styleRow!.slice("Style: ".length).split(",");
		// Name, Fontname, Fontsize, Primary, Secondary, Outline colour, Back colour ...
		expect(fields[2]).toBe("128");
		expect(fields[5]).toBe("&H00302010");
		expect(fields[15]).toBe("1");
		expect(fields[16]).toBe("16");
		expect(fields[17]).toBe("8");
		expect(lossReport.supported).toEqual(
			expect.arrayContaining(["outline", "shadow"]),
		);
		expect(lossReport.dropped).toEqual([]);

		const parsed = parseAss({ input: content });
		expect(parsed.warnings).toEqual([]);
		expect(parsed.captions[0]?.style).toMatchObject({
			outline: { enabled: true, color: "#102030", width: 0.125 },
			shadow: {
				enabled: true,
				color: "#000000",
				offsetX: 0.0625,
				offsetY: 0.0625,
				blur: 0,
			},
		});
	});

	test("reports blur and uneven shadow offsets as structured losses", () => {
		const { lossReport } = serializeAss({
			captions: [
				{
					...OUTLINED,
					style: {
						...OUTLINED.style,
						shadow: {
							enabled: true,
							color: "#000000",
							offsetX: 0.1,
							offsetY: 0.02,
							blur: 0.2,
						},
					},
				},
			],
			playRes: { width: 1080, height: 1920 },
		});
		expect(lossReport.dropped.map((loss) => loss.feature)).toEqual([
			"shadow.blur",
			"shadow.offset",
		]);
	});
});
