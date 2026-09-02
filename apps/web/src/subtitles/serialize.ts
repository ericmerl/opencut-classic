import type { SubtitleCue } from "./types";

export type SubtitleExportFormat = "srt" | "vtt";

export function serializeSubtitles({
	captions,
	format,
}: {
	captions: SubtitleCue[];
	format: SubtitleExportFormat;
}): string {
	const body = captions
		.map((caption, index) => {
			const start = formatTimestamp({ seconds: caption.startTime, format });
			const end = formatTimestamp({
				seconds: caption.startTime + caption.duration,
				format,
			});
			const cue = `${start} --> ${end}\n${caption.text.trim()}`;
			return format === "srt" ? `${index + 1}\n${cue}` : cue;
		})
		.join("\n\n");
	return format === "vtt" ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}

function formatTimestamp({
	seconds,
	format,
}: {
	seconds: number;
	format: SubtitleExportFormat;
}): string {
	const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
	const hours = Math.floor(totalMilliseconds / 3_600_000);
	const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
	const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
	const milliseconds = totalMilliseconds % 1000;
	const separator = format === "srt" ? "," : ".";
	return `${pad({ value: hours, length: 2 })}:${pad({ value: minutes, length: 2 })}:${pad({ value: wholeSeconds, length: 2 })}${separator}${pad({ value: milliseconds, length: 3 })}`;
}

function pad({ value, length }: { value: number; length: number }): string {
	return String(value).padStart(length, "0");
}
