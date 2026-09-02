import { randomBytes } from "node:crypto";
import { link, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

interface SourceTicket {
	outputPath: string;
	expiresAt: number;
}

export class SourceTickets {
	private tickets = new Map<string, SourceTicket>();

	constructor(private port: number) {}

	async create(path: string): Promise<{ url: string; outputPath: string }> {
		if (!isAbsolute(path))
			throw new Error("Source transfer path must be absolute");
		const outputPath = resolve(path);
		const parentInfo = await stat(dirname(outputPath)).catch(() => null);
		if (!parentInfo?.isDirectory()) {
			throw new Error("Source transfer directory does not exist");
		}
		if (await stat(outputPath).catch(() => null)) {
			throw new Error("Source transfer destination already exists");
		}

		this.removeExpired();
		const id = randomBytes(32).toString("hex");
		this.tickets.set(id, {
			outputPath,
			expiresAt: Date.now() + 30 * 60_000,
		});
		return {
			url: `http://127.0.0.1:${this.port}/source/${id}`,
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
	): Promise<{ outputPath: string; bytesWritten: number }> {
		this.removeExpired();
		const ticket = this.tickets.get(id);
		if (!ticket) throw new Error("Expired or invalid source ticket");
		this.tickets.delete(id);

		const bytes = await request.arrayBuffer();
		if (bytes.byteLength === 0) throw new Error("Source upload was empty");
		const tempPath = join(
			dirname(ticket.outputPath),
			`.${basename(ticket.outputPath)}.opencut-${randomBytes(12).toString("hex")}.tmp`,
		);

		try {
			await writeFile(tempPath, Buffer.from(bytes), { flag: "wx" });
			await link(tempPath, ticket.outputPath);
			return { outputPath: ticket.outputPath, bytesWritten: bytes.byteLength };
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
