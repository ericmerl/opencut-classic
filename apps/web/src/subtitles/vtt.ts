import type { ParseSubtitleResult, SubtitleCue } from "./types";

const TIMESTAMP_SEPARATOR = /\s*-->\s*/;
const TIMESTAMP_PATTERN =
	/^(?:(\d{2,}):)?(\d{2}):(\d{2})[.](\d{1,3})(?:\s+.*)?$/;

export function parseVtt({ input }: { input: string }): ParseSubtitleResult {
	const normalized = input
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (!normalized) {
		return { captions: [], skippedCueCount: 0, warnings: [] };
	}

	const blocks = normalized.split(/\n{2,}/);
	const captions: SubtitleCue[] = [];
	let skippedCueCount = 0;
	let strippedMarkupCount = 0;

	for (const [blockIndex, block] of blocks.entries()) {
		const lines = block.split("\n").map((line) => line.trim());
		if (blockIndex === 0 && lines[0]?.startsWith("WEBVTT")) {
			continue;
		}
		if (
			lines.length === 0 ||
			lines[0]?.startsWith("NOTE") ||
			lines[0] === "STYLE" ||
			lines[0] === "REGION"
		) {
			continue;
		}

		const timestampIndex = lines[0]?.includes("-->") ? 0 : 1;
		const timestampLine = lines[timestampIndex];
		if (!timestampLine) {
			skippedCueCount += 1;
			continue;
		}
		const [rawStart, rawEnd] = timestampLine.split(TIMESTAMP_SEPARATOR);
		const startTime = parseVttTimestamp({ input: rawStart });
		const endTime = parseVttTimestamp({ input: rawEnd });
		const duration = endTime - startTime;
		if (
			!Number.isFinite(startTime) ||
			!Number.isFinite(endTime) ||
			duration <= 0
		) {
			skippedCueCount += 1;
			continue;
		}

		const rawText = lines
			.slice(timestampIndex + 1)
			.join("\n")
			.trim();
		const text = stripVttMarkup({ input: rawText });
		if (!text) {
			skippedCueCount += 1;
			continue;
		}
		strippedMarkupCount += text !== rawText ? 1 : 0;
		captions.push({ text, startTime, duration });
	}

	return {
		captions,
		skippedCueCount,
		warnings:
			strippedMarkupCount > 0
				? [
						`Stripped unsupported WebVTT markup from ${strippedMarkupCount} subtitle cue(s).`,
					]
				: [],
	};
}

function parseVttTimestamp({ input }: { input: string | undefined }): number {
	const match = input?.trim().match(TIMESTAMP_PATTERN);
	if (!match) return Number.NaN;
	const [, hours = "0", minutes, seconds, milliseconds] = match;
	return (
		Number.parseInt(hours, 10) * 3600 +
		Number.parseInt(minutes, 10) * 60 +
		Number.parseInt(seconds, 10) +
		Number.parseInt(milliseconds.padEnd(3, "0"), 10) / 1000
	);
}

function stripVttMarkup({ input }: { input: string }): string {
	return input
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}
