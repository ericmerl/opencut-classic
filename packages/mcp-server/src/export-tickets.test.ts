import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportTickets } from "./export-tickets";

describe("ExportTickets", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-tickets-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("writes a one-time upload to a new output file", async () => {
		const tickets = new ExportTickets(32191);
		const outputPath = join(directory, "result.webm");
		const ticket = await tickets.create(outputPath, "webm");
		const id = new URL(ticket.url).pathname.split("/").at(-1)!;

		const receipt = await tickets.receive(
			id,
			new Request(ticket.url, {
				method: "PUT",
				body: new Uint8Array([1, 2, 3, 4]),
			}),
		);

		expect(receipt).toEqual({ outputPath, bytesWritten: 4 });
		expect(new Uint8Array(await readFile(outputPath))).toEqual(
			new Uint8Array([1, 2, 3, 4]),
		);
		await expect(
			tickets.receive(
				id,
				new Request(ticket.url, {
					method: "PUT",
					body: new Uint8Array([5]),
				}),
			),
		).rejects.toThrow("Expired or invalid export ticket");
	});

	test("rejects an existing destination before issuing a ticket", async () => {
		const tickets = new ExportTickets(32191);
		const outputPath = join(directory, "existing.mp4");
		await writeFile(outputPath, "original");

		await expect(tickets.create(outputPath, "mp4")).rejects.toThrow(
			"Export destination already exists",
		);
		expect(await readFile(outputPath, "utf8")).toBe("original");
	});

	test("requires an absolute path with the selected format extension", async () => {
		const tickets = new ExportTickets(32191);
		await expect(tickets.create("relative.webm", "webm")).rejects.toThrow(
			"Export path must be absolute",
		);
		await expect(
			tickets.create(join(directory, "wrong.mp4"), "webm"),
		).rejects.toThrow("Export path must end in .webm");
	});
});
