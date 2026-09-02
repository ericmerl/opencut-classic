import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExportReceiptStore } from "./export-receipts";

interface ProbeStream extends Record<string, unknown> {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	sample_rate?: string;
	channels?: number;
	channel_layout?: string;
}

interface ProbeDocument extends Record<string, unknown> {
	format?: Record<string, unknown>;
	streams?: ProbeStream[];
}

export interface ExportFrameSample {
	position: "opening" | "middle" | "ending";
	timeSeconds: number;
	path: string;
	bytes: number;
	sha256: string;
}

export interface ExportMediaValidation {
	status: "validated";
	validatedAt: string;
	fullDecode: true;
	formatName: string;
	durationSeconds: number;
	video: {
		codec: string;
		width: number;
		height: number;
		fps: number | null;
	};
	audio: {
		present: boolean;
		codec: string | null;
		sampleRate: number | null;
		channels: number | null;
		channelLayout: string | null;
	};
	frameSamples: ExportFrameSample[];
}

export class ExportValidator {
	private preflightPromise: Promise<void> | null = null;
	private readonly ffmpeg: string;
	private readonly ffprobe: string;

	constructor(
		private receipts: ExportReceiptStore,
		config: { ffmpeg?: string; ffprobe?: string } = {},
	) {
		this.ffmpeg =
			config.ffmpeg ??
			globalThis.process.env.OPENCUT_FFMPEG_PATH ??
			globalThis.process.env.FFMPEG_PATH ??
			"ffmpeg";
		this.ffprobe =
			config.ffprobe ??
			globalThis.process.env.OPENCUT_FFPROBE_PATH ??
			globalThis.process.env.FFPROBE_PATH ??
			deriveFfprobePath(this.ffmpeg);
	}

	preflight(): Promise<void> {
		this.preflightPromise ??= Promise.all([
			runCommand(this.ffmpeg, ["-version"], "FFmpeg preflight"),
			runCommand(this.ffprobe, ["-version"], "FFprobe preflight"),
		]).then(() => undefined);
		return this.preflightPromise;
	}

	async validate({
		operationId,
		outputPath,
		format,
		expectedWidth,
		expectedHeight,
		expectedFps,
		includeAudio,
	}: {
		operationId: string;
		outputPath: string;
		format: "mp4" | "webm";
		expectedWidth: number;
		expectedHeight: number;
		expectedFps: number;
		includeAudio: boolean;
	}): Promise<ExportMediaValidation> {
		await this.preflight();
		const probe = await this.probe(outputPath);
		const formatName = stringField(probe.format, "format_name");
		if (!containerMatches({ requested: format, formatName })) {
			throw new Error(
				`export container ${formatName || "unknown"} does not match ${format}`,
			);
		}
		const durationSeconds = numberField(probe.format, "duration");
		if (!(durationSeconds > 0)) {
			throw new Error("export duration is missing or non-positive");
		}
		const streams = Array.isArray(probe.streams) ? probe.streams : [];
		const video = streams.find((stream) => stream.codec_type === "video");
		if (!video) throw new Error("export does not contain a video stream");
		const width = numericValue(video.width);
		const height = numericValue(video.height);
		if (width !== expectedWidth || height !== expectedHeight) {
			throw new Error(
				`export resolution ${width}x${height} does not match expected ${expectedWidth}x${expectedHeight}`,
			);
		}
		const fps = parseRatio(video.avg_frame_rate ?? video.r_frame_rate);
		if (fps === null) {
			throw new Error("export frame rate is missing or invalid");
		}
		if (Math.abs(fps - expectedFps) > 0.02) {
			throw new Error(
				`export frame rate ${fps.toFixed(6)} does not match expected ${expectedFps.toFixed(6)}`,
			);
		}
		const audio = streams.find((stream) => stream.codec_type === "audio");
		if (!includeAudio && audio) {
			throw new Error(
				"export contains audio even though includeAudio is false",
			);
		}

		await runCommand(
			this.ffmpeg,
			["-v", "error", "-i", outputPath, "-f", "null", "-"],
			"full export decode",
			2 * 60 * 60_000,
		);
		const frameSamples = await this.extractFrameSamples({
			operationId,
			outputPath,
			durationSeconds,
			fps: fps ?? expectedFps,
		});
		return {
			status: "validated",
			validatedAt: new Date().toISOString(),
			fullDecode: true,
			formatName,
			durationSeconds,
			video: {
				codec: stringValue(video.codec_name) ?? "unknown",
				width,
				height,
				fps,
			},
			audio: {
				present: !!audio,
				codec: stringValue(audio?.codec_name),
				sampleRate: numericValueOrNull(audio?.sample_rate),
				channels: numericValueOrNull(audio?.channels),
				channelLayout: stringValue(audio?.channel_layout),
			},
			frameSamples,
		};
	}

	async verifyOutput({
		outputPath,
		bytesWritten,
		sha256,
	}: {
		outputPath: string;
		bytesWritten: number;
		sha256: string;
	}): Promise<void> {
		const info = await stat(outputPath).catch(() => null);
		if (!info?.isFile()) throw new Error("durable export output is missing");
		if (info.size !== bytesWritten) {
			throw new Error(
				"durable export output size no longer matches its receipt",
			);
		}
		if ((await hashFile(outputPath)) !== sha256) {
			throw new Error(
				"durable export output SHA-256 no longer matches its receipt",
			);
		}
	}

	private async probe(outputPath: string): Promise<ProbeDocument> {
		const stdout = await runCommand(
			this.ffprobe,
			[
				"-v",
				"error",
				"-show_format",
				"-show_streams",
				"-of",
				"json",
				outputPath,
			],
			"export probe",
		);
		let value: unknown;
		try {
			value = JSON.parse(stdout);
		} catch {
			throw new Error("FFprobe returned invalid JSON");
		}
		if (!isRecord(value)) throw new Error("FFprobe response is incomplete");
		return value as ProbeDocument;
	}

	private async extractFrameSamples({
		operationId,
		outputPath,
		durationSeconds,
		fps,
	}: {
		operationId: string;
		outputPath: string;
		durationSeconds: number;
		fps: number;
	}): Promise<ExportFrameSample[]> {
		const directory = await this.receipts.artifactsDirectory(operationId);
		const finalFrameOffset = Math.max(1 / Math.max(fps, 1), 0.04);
		const positions: Array<{
			position: ExportFrameSample["position"];
			timeSeconds: number;
		}> = [
			{ position: "opening", timeSeconds: 0 },
			{ position: "middle", timeSeconds: durationSeconds / 2 },
			{
				position: "ending",
				timeSeconds: Math.max(0, durationSeconds - finalFrameOffset),
			},
		];
		const samples: ExportFrameSample[] = [];
		for (const position of positions) {
			const path = join(directory, `${position.position}.png`);
			await runCommand(
				this.ffmpeg,
				[
					"-v",
					"error",
					"-ss",
					position.timeSeconds.toFixed(6),
					"-i",
					outputPath,
					"-frames:v",
					"1",
					"-an",
					"-y",
					path,
				],
				`${position.position} frame extraction`,
				10 * 60_000,
			);
			const info = await stat(path).catch(() => null);
			if (!info?.isFile() || info.size === 0) {
				throw new Error(`${position.position} frame sample is empty`);
			}
			samples.push({
				...position,
				path,
				bytes: info.size,
				sha256: await hashFile(path),
			});
		}
		return samples;
	}
}

async function runCommand(
	command: string,
	args: string[],
	label: string,
	timeoutMs = 60_000,
): Promise<string> {
	let process: ReturnType<typeof Bun.spawn>;
	try {
		process = Bun.spawn([command, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...globalThis.process.env },
		});
	} catch (error) {
		throw new Error(
			`${label} could not start: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		process.kill();
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout as ReadableStream<Uint8Array>).text(),
		new Response(process.stderr as ReadableStream<Uint8Array>).text(),
		process.exited,
	]);
	clearTimeout(timer);
	if (timedOut) throw new Error(`${label} timed out`);
	if (exitCode !== 0) {
		throw new Error(
			`${label} failed with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`,
		);
	}
	return stdout;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function deriveFfprobePath(ffmpeg: string): string {
	if (ffmpeg === "ffmpeg") return "ffprobe";
	const suffix = globalThis.process.platform === "win32" ? ".exe" : "";
	return join(dirname(ffmpeg), `ffprobe${suffix}`);
}

function containerMatches({
	requested,
	formatName,
}: {
	requested: "mp4" | "webm";
	formatName: string;
}): boolean {
	const values = new Set(formatName.split(","));
	return requested === "mp4"
		? values.has("mp4") || values.has("mov")
		: values.has("webm");
}

function parseRatio(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const [numerator, denominator] = value.split("/").map(Number);
	if (
		!Number.isFinite(numerator) ||
		!Number.isFinite(denominator) ||
		!denominator
	) {
		return null;
	}
	return numerator / denominator;
}

function stringField(
	value: Record<string, unknown> | undefined,
	key: string,
): string {
	return stringValue(value?.[key]) ?? "";
}

function numberField(
	value: Record<string, unknown> | undefined,
	key: string,
): number {
	return numericValueOrNull(value?.[key]) ?? Number.NaN;
}

function numericValue(value: unknown): number {
	const parsed = numericValueOrNull(value);
	return parsed ?? Number.NaN;
}

function numericValueOrNull(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
