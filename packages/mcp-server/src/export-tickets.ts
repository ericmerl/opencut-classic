import { createHash, randomBytes } from "node:crypto";
import { link, stat, unlink, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	resolve,
} from "node:path";

interface ExportTicket {
	outputPath: string;
	format: "mp4" | "webm";
	expiresAt: number;
}

export class ExportTickets {
	private tickets = new Map<string, ExportTicket>();

	constructor(private port: number) {}

	async create(
		path: string,
		format: "mp4" | "webm",
	): Promise<{ url: string; outputPath: string }> {
		if (!isAbsolute(path)) throw new Error("Export path must be absolute");
		const outputPath = resolve(path);
		if (extname(outputPath).toLowerCase() !== `.${format}`) {
			throw new Error(`Export path must end in .${format}`);
		}
		const parent = dirname(outputPath);
		const parentInfo = await stat(parent).catch(() => null);
		if (!parentInfo?.isDirectory()) {
			throw new Error("Export destination directory does not exist");
		}
		const existing = await stat(outputPath).catch(() => null);
		if (existing) throw new Error("Export destination already exists");

		this.removeExpired();
		const id = randomBytes(32).toString("hex");
		this.tickets.set(id, {
			outputPath,
			format,
			expiresAt: Date.now() + 30 * 60_000,
		});
		return {
			url: `http://127.0.0.1:${this.port}/export/${id}`,
			outputPath,
		};
	}

	has(id: string): boolean {
		this.removeExpired();
		return this.tickets.has(id);
	}

	async receive(
		id: string,
		request: Request,
	): Promise<{
		outputPath: string;
		bytesWritten: number;
		sha256: string;
	}> {
		this.removeExpired();
		const ticket = this.tickets.get(id);
		if (!ticket) throw new Error("Expired or invalid export ticket");
		this.tickets.delete(id);

		const bytes = await request.arrayBuffer();
		if (bytes.byteLength === 0) throw new Error("Export upload was empty");
		const buffer = Buffer.from(bytes);
		validateContainerSignature({ bytes: buffer, format: ticket.format });
		const parent = dirname(ticket.outputPath);
		const tempPath = join(
			parent,
			`.${basename(ticket.outputPath)}.opencut-${randomBytes(12).toString("hex")}.tmp`,
		);

		try {
			await writeFile(tempPath, buffer, { flag: "wx" });
			await link(tempPath, ticket.outputPath);
			return {
				outputPath: ticket.outputPath,
				bytesWritten: bytes.byteLength,
				sha256: createHash("sha256").update(buffer).digest("hex"),
			};
		} finally {
			await unlink(tempPath).catch(() => undefined);
		}
	}

	private removeExpired(): void {
		const now = Date.now();
		for (const [id, ticket] of this.tickets) {
			if (ticket.expiresAt <= now) this.tickets.delete(id);
		}
	}
}

function validateContainerSignature({
	bytes,
	format,
}: {
	bytes: Buffer;
	format: "mp4" | "webm";
}): void {
	const isMp4 =
		bytes.byteLength >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
	const isWebm =
		bytes.byteLength >= 4 &&
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3;
	if ((format === "mp4" && !isMp4) || (format === "webm" && !isWebm)) {
		throw new Error(
			`Export bytes do not have a valid ${format} container signature`,
		);
	}
}
