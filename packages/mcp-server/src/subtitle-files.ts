import { createHash, randomBytes } from "node:crypto";
import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	resolve,
} from "node:path";

const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const IMPORT_EXTENSIONS = new Set([".srt", ".ass", ".vtt"]);

export class SubtitleFiles {
	async read(path: string): Promise<{
		fileName: string;
		input: string;
		bytesRead: number;
		contentHash: string;
	}> {
		if (!isAbsolute(path)) throw new Error("Subtitle path must be absolute");
		const inputPath = resolve(path);
		if (!IMPORT_EXTENSIONS.has(extname(inputPath).toLowerCase())) {
			throw new Error("Subtitle path must end in .srt, .ass, or .vtt");
		}
		const info = await stat(inputPath);
		if (!info.isFile()) throw new Error("Subtitle path must identify a file");
		if (info.size === 0) throw new Error("Subtitle file is empty");
		if (info.size > MAX_SUBTITLE_BYTES) {
			throw new Error("Subtitle file exceeds the 10 MiB limit");
		}

		const bytes = await readFile(inputPath);
		let input: string;
		try {
			input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("Subtitle file must contain valid UTF-8 text");
		}
		return {
			fileName: basename(inputPath),
			input,
			bytesRead: bytes.byteLength,
			contentHash: createHash("sha256").update(bytes).digest("hex"),
		};
	}

	async write({
		path,
		format,
		content,
	}: {
		path: string;
		format: "srt" | "vtt" | "ass";
		content: string;
	}): Promise<{ outputPath: string; bytesWritten: number; sha256: string }> {
		if (!isAbsolute(path))
			throw new Error("Subtitle output path must be absolute");
		const outputPath = resolve(path);
		if (extname(outputPath).toLowerCase() !== `.${format}`) {
			throw new Error(`Subtitle output path must end in .${format}`);
		}
		const parent = dirname(outputPath);
		const parentInfo = await stat(parent).catch(() => null);
		if (!parentInfo?.isDirectory()) {
			throw new Error("Subtitle destination directory does not exist");
		}
		if (await stat(outputPath).catch(() => null)) {
			throw new Error("Subtitle destination already exists");
		}

		const bytes = Buffer.from(content, "utf8");
		if (bytes.byteLength === 0) throw new Error("Subtitle export was empty");
		const tempPath = join(
			parent,
			`.${basename(outputPath)}.opencut-${randomBytes(12).toString("hex")}.tmp`,
		);
		try {
			await writeFile(tempPath, bytes, { flag: "wx" });
			await link(tempPath, outputPath);
			return {
				outputPath,
				bytesWritten: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
		} finally {
			await unlink(tempPath).catch(() => undefined);
		}
	}
}
