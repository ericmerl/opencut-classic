import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportReceiptStore } from "./export-receipts";
import { ExportValidator } from "./export-validator";

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";

describe("ExportValidator", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-validator-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("fully decodes, probes, and samples a valid export", async () => {
		const outputPath = join(directory, "fixture.mp4");
		await createFixture(outputPath);
		const receipts = new ExportReceiptStore(join(directory, "receipts"));
		const validator = new ExportValidator(receipts, { ffmpeg, ffprobe });

		const validation = await validator.validate({
			operationId: "export-1",
			outputPath,
			format: "mp4",
			expectedWidth: 160,
			expectedHeight: 90,
			expectedFps: 10,
			includeAudio: true,
		});

		expect(validation).toMatchObject({
			status: "validated",
			fullDecode: true,
			video: {
				codec: "h264",
				width: 160,
				height: 90,
				fps: 10,
				pixelFormat: "yuv420p",
				colorPrimaries: "bt709",
				colorTransfer: "bt709",
				colorMatrix: "bt709",
				colorRange: "tv",
			},
			audio: {
				present: true,
				codec: "aac",
				fallback: {
					preferredCodec: "aac",
					actualCodec: "aac",
					outcome: "preferred",
				},
			},
			mastering: {
				preview: { chain: "opencut-fixed-mastering-v1" },
				export: { chain: "opencut-fixed-mastering-v1" },
				difference: expect.stringContaining("per rendered buffer"),
			},
		});
		expect(validation.video.profile).not.toBeNull();
		expect(validation.video.level).not.toBeNull();
		expect(validation.audio.sampleRate).toBe(44_100);
		expect(validation.audio.measurements?.integratedLufs).not.toBeNull();
		expect(validation.audio.measurements?.truePeakDbtp).not.toBeNull();
		expect(validation.frameSamples.map((sample) => sample.position)).toEqual([
			"opening",
			"middle",
			"ending",
		]);
		for (const sample of validation.frameSamples) {
			expect((await stat(sample.path)).size).toBeGreaterThan(0);
			expect(sample.sha256).toHaveLength(64);
		}
		await expect(
			validator.validate({
				operationId: "export-no-audio",
				outputPath,
				format: "mp4",
				expectedWidth: 160,
				expectedHeight: 90,
				expectedFps: 10,
				includeAudio: false,
			}),
		).rejects.toThrow("includeAudio is false");
	});

	test("fails when requested audio is absent", async () => {
		const outputPath = join(directory, "silent-video.mp4");
		await createFixture(outputPath, { includeAudio: false });
		const validator = new ExportValidator(
			new ExportReceiptStore(join(directory, "silent-receipts")),
			{ ffmpeg, ffprobe },
		);

		await expect(
			validator.validate({
				operationId: "missing-requested-audio",
				outputPath,
				format: "mp4",
				expectedWidth: 160,
				expectedHeight: 90,
				expectedFps: 10,
				includeAudio: true,
			}),
		).rejects.toThrow("includeAudio is true");
	});

	test("samples the ending from video duration when audio outlasts video", async () => {
		const outputPath = join(directory, "audio-tail.mp4");
		await createFixture(outputPath, { audioDuration: 1.25, shortest: false });
		const validator = new ExportValidator(
			new ExportReceiptStore(join(directory, "audio-tail-receipts")),
			{ ffmpeg, ffprobe },
		);

		const validation = await validator.validate({
			operationId: "audio-tail",
			outputPath,
			format: "mp4",
			expectedWidth: 160,
			expectedHeight: 90,
			expectedFps: 10,
			includeAudio: true,
		});

		expect(validation.durationSeconds).toBeGreaterThan(1);
		expect(validation.frameSamples.at(-1)?.position).toBe("ending");
		expect(validation.frameSamples.at(-1)?.timeSeconds).toBeCloseTo(0.8);
	});
});

async function createFixture(
	outputPath: string,
	{
		audioDuration = 1,
		shortest = true,
		includeAudio = true,
	}: {
		audioDuration?: number;
		shortest?: boolean;
		includeAudio?: boolean;
	} = {},
): Promise<void> {
	const process = Bun.spawn(
		[
			ffmpeg,
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x90:r=10:d=1",
			...(includeAudio
				? [
						"-f",
						"lavfi",
						"-i",
						`sine=frequency=440:duration=${audioDuration}`,
					]
				: []),
			...(includeAudio && shortest ? ["-shortest"] : []),
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-color_primaries",
			"bt709",
			"-color_trc",
			"bt709",
			"-colorspace",
			"bt709",
			"-color_range",
			"tv",
			...(includeAudio ? ["-c:a", "aac"] : []),
			outputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = await new Response(process.stderr).text();
	const exitCode = await process.exited;
	if (exitCode !== 0) throw new Error(stderr);
}
