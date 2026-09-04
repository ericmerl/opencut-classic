import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExportReceiptStore } from "./export-receipts";

interface ProbeStream extends Record<string, unknown> {
	codec_type?: string;
	codec_name?: string;
	profile?: string;
	level?: number;
	pix_fmt?: string;
	color_primaries?: string;
	color_transfer?: string;
	color_space?: string;
	color_range?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	start_time?: string;
	duration?: string;
	sample_rate?: string;
	channels?: number;
	channel_layout?: string;
}

interface ProbeDocument extends Record<string, unknown> {
	format?: Record<string, unknown>;
	streams?: ProbeStream[];
}

export interface ExportFrameSample {
	position: "opening" | "middle" | "ending" | "cover";
	frameIndex: number;
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
		profile: string | null;
		level: number | null;
		pixelFormat: string | null;
		colorPrimaries: string | null;
		colorTransfer: string | null;
		colorMatrix: string | null;
		colorRange: string | null;
		width: number;
		height: number;
		fps: number | null;
		durationSeconds: number;
		blackSegments: ExportTemporalSegment[];
		frozenSegments: ExportTemporalSegment[];
	};
	audio: {
		present: boolean;
		codec: string | null;
		declaredCodecDelaySeconds: number | null;
		declaredSeekPreRollSeconds: number | null;
		sampleRate: number | null;
		channels: number | null;
		channelLayout: string | null;
		fallback: {
			preferredCodec: "aac" | "opus";
			actualCodec: "aac" | "opus";
			outcome: "preferred" | "aac-to-opus";
		} | null;
		measurements: {
			integratedLufs: number | null;
			truePeakDbtp: number | null;
			silenceSegments: ExportTemporalSegment[];
			startOffsetSeconds: number | null;
			durationDeltaSeconds: number | null;
		} | null;
	};
	mastering: {
		preview: typeof FIXED_MASTERING_POLICY;
		export: typeof FIXED_MASTERING_POLICY;
		difference: string;
	};
	frameSamples: ExportFrameSample[];
	coverFrame: ExportFrameSample | null;
}

export interface ExportTemporalSegment {
	startSeconds: number;
	endSeconds: number;
	durationSeconds: number;
}

const FIXED_MASTERING_POLICY = {
	chain: "opencut-fixed-mastering-v1",
	application: "conditional-above-output-headroom",
	conditionScope: "rendered-buffer-peak",
	limiter: {
		thresholdDb: -1,
		kneeDb: 0,
		ratio: 20,
		attackSeconds: 0.001,
		releaseSeconds: 0.12,
	},
	outputHeadroomLinear: 0.98,
} as const;

// The same chain runs for previews and exports, but the limiter only engages
// when the rendered buffer peaks above the output headroom. The export decides
// that over the full timeline mix while a preview range decides over its own
// window, so a quiet window can stay unlimited where the full export is limited.
const MASTERING_SCOPE_DIFFERENCE =
	"limiter engagement is decided per rendered buffer: the export evaluates the full timeline mix while a preview range evaluates only its requested window";

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
		coverFrame,
	}: {
		operationId: string;
		outputPath: string;
		format: "mp4" | "webm";
		expectedWidth: number;
		expectedHeight: number;
		expectedFps: number;
		includeAudio: boolean;
		coverFrame?: { frameIndex: number; resolvedTicks: number } | null;
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
		if (includeAudio && !audio) {
			throw new Error(
				"export does not contain audio even though includeAudio is true",
			);
		}
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
		const videoDurationSeconds = numericValueOrNull(video.duration);
		const validatedVideoDurationSeconds =
			videoDurationSeconds !== null && videoDurationSeconds > 0
				? Math.min(durationSeconds, videoDurationSeconds)
				: durationSeconds;
		const audioCodec = stringValue(audio?.codec_name);
		const audioFallback = resolveAudioFallback({
			format,
			includeAudio,
			audioCodec,
		});
		const declaredOpusTiming =
			format === "webm" && audioCodec === "opus"
				? await readDeclaredWebmOpusTiming(outputPath)
				: null;
		if (
			format === "webm" &&
			audioCodec === "opus" &&
			(declaredOpusTiming?.codecDelaySeconds === null ||
				declaredOpusTiming?.seekPreRollSeconds === null)
		) {
			throw new Error(
				"WebM Opus export does not declare CodecDelay and SeekPreRoll",
			);
		}
		const videoSignals = await this.measureVideoSignals(outputPath);
		const audioMeasurements = audio
			? await this.measureAudio({
					outputPath,
					video,
					audio,
					videoDurationSeconds: validatedVideoDurationSeconds,
				})
			: null;
		const frameSamples = await this.extractFrameSamples({
			operationId,
			outputPath,
			durationSeconds: validatedVideoDurationSeconds,
			fps: fps ?? expectedFps,
		});
		const coverFrameSample = coverFrame
			? await this.extractFrame({
					operationId,
					outputPath,
					position: "cover",
					frameIndex: coverFrame.frameIndex,
					fps: fps ?? expectedFps,
				})
			: null;
		return {
			status: "validated",
			validatedAt: new Date().toISOString(),
			fullDecode: true,
			formatName,
			durationSeconds,
			video: {
				codec: stringValue(video.codec_name) ?? "unknown",
				profile: stringValue(video.profile),
				level: numericValueOrNull(video.level),
				pixelFormat: stringValue(video.pix_fmt),
				colorPrimaries: stringValue(video.color_primaries),
				colorTransfer: stringValue(video.color_transfer),
				colorMatrix: stringValue(video.color_space),
				colorRange: stringValue(video.color_range),
				width,
				height,
				fps,
				durationSeconds: validatedVideoDurationSeconds,
				blackSegments: videoSignals.blackSegments,
				frozenSegments: videoSignals.frozenSegments,
			},
			audio: {
				present: !!audio,
				codec: audioCodec,
				declaredCodecDelaySeconds:
					declaredOpusTiming?.codecDelaySeconds ?? null,
				declaredSeekPreRollSeconds:
					declaredOpusTiming?.seekPreRollSeconds ?? null,
				sampleRate: numericValueOrNull(audio?.sample_rate),
				channels: numericValueOrNull(audio?.channels),
				channelLayout: stringValue(audio?.channel_layout),
				fallback: audioFallback,
				measurements: audioMeasurements,
			},
			mastering: {
				preview: FIXED_MASTERING_POLICY,
				export: FIXED_MASTERING_POLICY,
				difference: MASTERING_SCOPE_DIFFERENCE,
			},
			frameSamples,
			coverFrame: coverFrameSample,
		};
	}

	private async measureVideoSignals(outputPath: string): Promise<{
		blackSegments: ExportTemporalSegment[];
		frozenSegments: ExportTemporalSegment[];
	}> {
		const { stderr } = await runCommandResult(
			this.ffmpeg,
			[
				"-hide_banner",
				"-nostats",
				"-i",
				outputPath,
				"-vf",
				"blackdetect=d=0.1:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=0.5",
				"-an",
				"-f",
				"null",
				"-",
			],
			"export video signal analysis",
			2 * 60 * 60_000,
		);
		return {
			blackSegments: parseTemporalSegments(stderr, "black"),
			frozenSegments: parseTemporalSegments(stderr, "freeze"),
		};
	}

	private async measureAudio({
		outputPath,
		video,
		audio,
		videoDurationSeconds,
	}: {
		outputPath: string;
		video: ProbeStream;
		audio: ProbeStream;
		videoDurationSeconds: number;
	}): Promise<{
		integratedLufs: number | null;
		truePeakDbtp: number | null;
		silenceSegments: ExportTemporalSegment[];
		startOffsetSeconds: number | null;
		durationDeltaSeconds: number | null;
	}> {
		const [{ stderr: loudness }, { stderr: silence }] = await Promise.all([
			runCommandResult(
				this.ffmpeg,
				[
					"-hide_banner",
					"-nostats",
					"-i",
					outputPath,
					"-map",
					"0:a:0",
					"-filter_complex",
					"ebur128=peak=true",
					"-f",
					"null",
					"-",
				],
				"export audio loudness analysis",
				2 * 60 * 60_000,
			),
			runCommandResult(
				this.ffmpeg,
				[
					"-hide_banner",
					"-nostats",
					"-i",
					outputPath,
					"-map",
					"0:a:0",
					"-af",
					"silencedetect=noise=-50dB:d=0.5",
					"-f",
					"null",
					"-",
				],
				"export audio silence analysis",
				2 * 60 * 60_000,
			),
		]);
		const metrics = parseEbur128Summary(loudness);
		const videoStart = numericValueOrNull(video.start_time);
		const audioStart = numericValueOrNull(audio.start_time);
		const audioDuration = numericValueOrNull(audio.duration);
		return {
			...metrics,
			silenceSegments: parseTemporalSegments(silence, "silence"),
			startOffsetSeconds:
				videoStart !== null && audioStart !== null
					? audioStart - videoStart
					: null,
			durationDeltaSeconds:
				audioDuration !== null ? audioDuration - videoDurationSeconds : null,
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
		// Samples are pinned to integer frame indices so an exact-time preview can
		// request the identical media time. The ending sample stays at least two
		// frames (and 100 ms) before the end so container duration rounding cannot
		// push it past the last encoded frame.
		const safeFps = Math.max(fps, 1);
		const frameCount = Math.max(1, Math.round(durationSeconds * safeFps));
		const endingOffsetFrames = Math.max(2, Math.ceil(0.1 * safeFps));
		const positions = (
			[
				{ position: "opening", frameIndex: 0 },
				{ position: "middle", frameIndex: Math.floor(frameCount / 2) },
				{
					position: "ending",
					frameIndex: Math.max(0, frameCount - endingOffsetFrames),
				},
			] satisfies Array<{
				position: ExportFrameSample["position"];
				frameIndex: number;
			}>
		).map((sample) => ({
			...sample,
			timeSeconds: sample.frameIndex / safeFps,
		}));
		const samples: ExportFrameSample[] = [];
		for (const position of positions) {
			samples.push(
				await this.extractFrame({
					operationId,
					outputPath,
					position: position.position,
					frameIndex: position.frameIndex,
					fps: safeFps,
				}),
			);
		}
		return samples;
	}

	private async extractFrame({
		operationId,
		outputPath,
		position,
		frameIndex,
		fps,
	}: {
		operationId: string;
		outputPath: string;
		position: ExportFrameSample["position"];
		frameIndex: number;
		fps: number;
	}): Promise<ExportFrameSample> {
		const directory = await this.receipts.artifactsDirectory(operationId);
		const path = join(directory, `${position}.png`);
		await runCommand(
			this.ffmpeg,
			[
				"-v",
				"error",
				"-i",
				outputPath,
				"-ss",
				Math.max(0, (frameIndex - 0.5) / Math.max(fps, 1)).toFixed(6),
				"-frames:v",
				"1",
				"-an",
				"-y",
				path,
			],
			`${position} frame extraction`,
			10 * 60_000,
		);
		const info = await stat(path).catch(() => null);
		if (!info?.isFile() || info.size === 0) {
			throw new Error(`${position} frame sample is empty`);
		}
		return {
			position,
			frameIndex,
			timeSeconds: frameIndex / Math.max(fps, 1),
			path,
			bytes: info.size,
			sha256: await hashFile(path),
		};
	}
}

async function readDeclaredWebmOpusTiming(outputPath: string): Promise<{
	codecDelaySeconds: number | null;
	seekPreRollSeconds: number | null;
}> {
	const handle = await open(outputPath, "r");
	try {
		const info = await handle.stat();
		const bytes = Buffer.alloc(Math.min(info.size, 4 * 1024 * 1024));
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const filePrefix = bytes.subarray(0, bytesRead);
		const clusterOffset = filePrefix.indexOf(
			Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
		);
		const header =
			clusterOffset >= 0 ? filePrefix.subarray(0, clusterOffset) : filePrefix;
		const codecDelayNanoseconds = ebmlUnsignedInteger(
			header,
			Buffer.from([0x56, 0xaa]),
		);
		const seekPreRollNanoseconds = ebmlUnsignedInteger(
			header,
			Buffer.from([0x56, 0xbb]),
		);
		return {
			codecDelaySeconds:
				codecDelayNanoseconds === null ? null : codecDelayNanoseconds / 1e9,
			seekPreRollSeconds:
				seekPreRollNanoseconds === null ? null : seekPreRollNanoseconds / 1e9,
		};
	} finally {
		await handle.close();
	}
}

function ebmlUnsignedInteger(bytes: Buffer, id: Buffer): number | null {
	const values: number[] = [];
	let searchOffset = 0;
	for (;;) {
		const elementOffset = bytes.indexOf(id, searchOffset);
		if (elementOffset < 0) break;
		const value = ebmlUnsignedIntegerAt(bytes, elementOffset + id.length);
		if (value !== null) values.push(value);
		searchOffset = elementOffset + id.length;
	}
	return values.length > 0 ? Math.max(...values) : null;
}

function ebmlUnsignedIntegerAt(
	bytes: Buffer,
	sizeOffset: number,
): number | null {
	const firstSizeByte = bytes[sizeOffset];
	if (firstSizeByte === undefined || firstSizeByte === 0) return null;
	let sizeLength = 1;
	let marker = 0x80;
	while ((firstSizeByte & marker) === 0 && sizeLength <= 8) {
		sizeLength += 1;
		marker >>= 1;
	}
	if (sizeLength > 8 || sizeOffset + sizeLength > bytes.length) return null;
	let size = firstSizeByte & (marker - 1);
	for (let index = 1; index < sizeLength; index += 1) {
		size = size * 256 + bytes[sizeOffset + index]!;
	}
	if (size < 1 || size > 8) return null;
	const dataOffset = sizeOffset + sizeLength;
	if (dataOffset + size > bytes.length) return null;
	let value = 0;
	for (let index = 0; index < size; index += 1) {
		value = value * 256 + bytes[dataOffset + index]!;
	}
	return Number.isSafeInteger(value) ? value : null;
}

async function runCommand(
	command: string,
	args: string[],
	label: string,
	timeoutMs = 60_000,
): Promise<string> {
	return (await runCommandResult(command, args, label, timeoutMs)).stdout;
}

async function runCommandResult(
	command: string,
	args: string[],
	label: string,
	timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string }> {
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
	return { stdout, stderr };
}

function resolveAudioFallback({
	format,
	includeAudio,
	audioCodec,
}: {
	format: "mp4" | "webm";
	includeAudio: boolean;
	audioCodec: string | null;
}): ExportMediaValidation["audio"]["fallback"] {
	if (!includeAudio) return null;
	const preferredCodec = format === "mp4" ? "aac" : "opus";
	if (audioCodec !== "aac" && audioCodec !== "opus") {
		throw new Error(
			`export audio codec ${audioCodec ?? "unknown"} is not AAC or Opus`,
		);
	}
	if (audioCodec === preferredCodec) {
		return { preferredCodec, actualCodec: audioCodec, outcome: "preferred" };
	}
	if (preferredCodec === "aac" && audioCodec === "opus") {
		return { preferredCodec, actualCodec: audioCodec, outcome: "aac-to-opus" };
	}
	throw new Error(
		`export audio codec ${audioCodec} does not match the required ${preferredCodec} codec`,
	);
}

function parseEbur128Summary(stderr: string): {
	integratedLufs: number | null;
	truePeakDbtp: number | null;
} {
	const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
	if (!summary.startsWith("Summary:")) {
		throw new Error("FFmpeg ebur128 output did not contain a summary");
	}
	const integrated =
		/Integrated loudness:\s*[\s\S]*?I:\s*(-?inf|-?\d+(?:\.\d+)?)\s+LUFS/i.exec(
			summary,
		)?.[1];
	const truePeak =
		/True peak:\s*[\s\S]*?Peak:\s*(-?inf|-?\d+(?:\.\d+)?)\s+dBFS/i.exec(
			summary,
		)?.[1];
	if (!integrated || !truePeak) {
		throw new Error("FFmpeg ebur128 summary is incomplete");
	}
	return {
		integratedLufs: finiteMetric(integrated),
		truePeakDbtp: finiteMetric(truePeak),
	};
}

function parseTemporalSegments(
	stderr: string,
	kind: "black" | "freeze" | "silence",
): ExportTemporalSegment[] {
	const starts = new Map<number, number>();
	const segments: ExportTemporalSegment[] = [];
	const pattern =
		kind === "black"
			? /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g
			: kind === "freeze"
				? /freeze_(start|end|duration):\s*([\d.]+)/g
				: /silence_(start|end|duration):\s*([\d.]+)/g;
	if (kind === "black") {
		for (const match of stderr.matchAll(pattern)) {
			segments.push({
				startSeconds: Number(match[1]),
				endSeconds: Number(match[2]),
				durationSeconds: Number(match[3]),
			});
		}
		return segments.filter(validSegment);
	}
	let currentStart: number | null = null;
	for (const match of stderr.matchAll(pattern)) {
		const event = match[1];
		const value = Number(match[2]);
		if (!Number.isFinite(value)) continue;
		if (event === "start") {
			currentStart = value;
			continue;
		}
		if (event === "duration" && currentStart !== null) {
			starts.set(currentStart, value);
			continue;
		}
		if (event === "end" && currentStart !== null) {
			segments.push({
				startSeconds: currentStart,
				endSeconds: value,
				durationSeconds: starts.get(currentStart) ?? value - currentStart,
			});
			starts.delete(currentStart);
			currentStart = null;
		}
	}
	return segments.filter(validSegment);
}

function validSegment(segment: ExportTemporalSegment): boolean {
	return (
		Number.isFinite(segment.startSeconds) &&
		Number.isFinite(segment.endSeconds) &&
		Number.isFinite(segment.durationSeconds) &&
		segment.endSeconds >= segment.startSeconds &&
		segment.durationSeconds >= 0
	);
}

function finiteMetric(value: string): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
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
