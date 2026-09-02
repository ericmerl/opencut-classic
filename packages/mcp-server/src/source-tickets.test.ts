import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceTickets } from "./source-tickets";

describe("SourceTickets", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-source-tickets-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("receives one browser upload into the requested path", async () => {
		const outputPath = join(directory, "source.webm");
		const tickets = new SourceTickets(32191);
		const ticket = await tickets.create(outputPath);
		const id = new URL(ticket.url).pathname.split("/").at(-1)!;
		const result = await tickets.receive(
			id,
			new Request(ticket.url, {
				method: "PUT",
				body: new Uint8Array([1, 2, 3, 4]),
			}),
		);

		expect(result).toEqual({ outputPath, bytesWritten: 4 });
		expect(await readFile(outputPath)).toEqual(Buffer.from([1, 2, 3, 4]));
		await expect(
			tickets.receive(
				id,
				new Request(ticket.url, { method: "PUT", body: "again" }),
			),
		).rejects.toThrow("Expired or invalid source ticket");
	});
});
