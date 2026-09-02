import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubtitleFiles } from "./subtitle-files";

describe("SubtitleFiles", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-subtitle-files-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("reads a supported UTF-8 subtitle with a content hash", async () => {
		const path = join(directory, "captions.vtt");
		const content = "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n";
		await writeFile(path, content);

		const result = await new SubtitleFiles().read(path);

		expect(result.fileName).toBe("captions.vtt");
		expect(result.input).toBe(content);
		expect(result.contentHash).toBe(
			createHash("sha256").update(content).digest("hex"),
		);
	});

	test("writes a new subtitle atomically with a receipt", async () => {
		const outputPath = join(directory, "captions.srt");
		const content = "1\n00:00:00,000 --> 00:00:01,000\nHello\n";

		const receipt = await new SubtitleFiles().write({
			path: outputPath,
			format: "srt",
			content,
		});

		expect(await readFile(outputPath, "utf8")).toBe(content);
		expect(receipt).toEqual({
			outputPath,
			bytesWritten: Buffer.byteLength(content),
			sha256: createHash("sha256").update(content).digest("hex"),
		});
		await expect(
			new SubtitleFiles().write({ path: outputPath, format: "srt", content }),
		).rejects.toThrow("Subtitle destination already exists");
	});

	test("rejects unsupported extensions and relative paths", async () => {
		const files = new SubtitleFiles();
		await expect(files.read("captions.srt")).rejects.toThrow(
			"Subtitle path must be absolute",
		);
		const path = join(directory, "captions.txt");
		await writeFile(path, "captions");
		await expect(files.read(path)).rejects.toThrow(
			"Subtitle path must end in .srt, .ass, or .vtt",
		);
	});
});
