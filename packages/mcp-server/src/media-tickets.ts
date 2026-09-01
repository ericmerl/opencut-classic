import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

interface MediaTicket {
	path: string;
	expiresAt: number;
}

export class MediaTickets {
	private tickets = new Map<string, MediaTicket>();

	constructor(private port: number) {}

	async create(path: string): Promise<{
		url: string;
		name: string;
		mimeType: string;
		size: number;
		sourceFingerprint: string;
		contentHash: string;
	}> {
		if (!isAbsolute(path)) throw new Error("Media path must be absolute");
		const info = await stat(path);
		if (!info.isFile()) throw new Error("Media path must identify a file");
		const file = Bun.file(path);
		if (!isSupportedMediaType(file.type)) {
			throw new Error(`Unsupported media type: ${file.type || "unknown"}`);
		}
		this.removeExpired();
		const id = randomBytes(32).toString("hex");
		this.tickets.set(id, { path, expiresAt: Date.now() + 60_000 });
		return {
			url: `http://127.0.0.1:${this.port}/media/${id}`,
			name: basename(path),
			mimeType: file.type,
			size: info.size,
			sourceFingerprint: createHash("sha256")
				.update(`${resolve(path)}\0${info.size}\0${info.mtimeMs}`)
				.digest("hex"),
			contentHash: await hashFile(path),
		};
	}

	take(id: string): { file: Bun.BunFile; mimeType: string } | null {
		this.removeExpired();
		const ticket = this.tickets.get(id);
		if (!ticket) return null;
		this.tickets.delete(id);
		const file = Bun.file(ticket.path);
		return { file, mimeType: file.type };
	}

	private removeExpired(): void {
		const now = Date.now();
		for (const [id, ticket] of this.tickets) {
			if (ticket.expiresAt <= now) this.tickets.delete(id);
		}
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function isSupportedMediaType(type: string): boolean {
	return (
		type.startsWith("video/") ||
		type.startsWith("audio/") ||
		type.startsWith("image/")
	);
}
