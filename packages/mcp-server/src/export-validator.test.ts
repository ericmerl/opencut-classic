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
			video: { width: 160, height: 90, fps: 10 },
			audio: { present: true },
		});
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
});

async function createFixture(outputPath: string): Promise<void> {
	const process = Bun.spawn(
		[
			ffmpeg,
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x90:r=10:d=1",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-shortest",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			outputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = await new Response(process.stderr).text();
	const exitCode = await process.exited;
	if (exitCode !== 0) throw new Error(stderr);
}
