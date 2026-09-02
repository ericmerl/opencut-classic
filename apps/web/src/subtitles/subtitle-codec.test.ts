import { describe, expect, test } from "bun:test";
import { parseSubtitleFile } from "./parse";
import { serializeSubtitles } from "./serialize";

describe("subtitle codecs", () => {
	test("parses WebVTT cue identifiers, settings, and markup", () => {
		const result = parseSubtitleFile({
			fileName: "captions.vtt",
			input: [
				"WEBVTT",
				"Kind: captions",
				"Language: en",
				"",
				"intro",
				"00:00.500 --> 00:02.250 align:start",
				"<v Speaker>Clean &amp; simple</v>",
			].join("\n"),
		});

		expect(result.captions).toEqual([
			{ text: "Clean & simple", startTime: 0.5, duration: 1.75 },
		]);
		expect(result.skippedCueCount).toBe(0);
		expect(result.warnings).toHaveLength(1);
	});

	test("serializes deterministic SRT and VTT documents", () => {
		const captions = [
			{ text: "First", startTime: 0.5, duration: 1.75 },
			{ text: "Second\nline", startTime: 3, duration: 2 },
		];

		expect(serializeSubtitles({ captions, format: "srt" })).toBe(
			"1\n00:00:00,500 --> 00:00:02,250\nFirst\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond\nline\n",
		);
		expect(serializeSubtitles({ captions, format: "vtt" })).toBe(
			"WEBVTT\n\n00:00:00.500 --> 00:00:02.250\nFirst\n\n00:00:03.000 --> 00:00:05.000\nSecond\nline\n",
		);
	});
});
