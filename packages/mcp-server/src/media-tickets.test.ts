import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaTickets } from "./media-tickets";

describe("MediaTickets", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-media-tickets-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("returns separate path and byte-content fingerprints", async () => {
		const path = join(directory, "matte.png");
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		await writeFile(path, bytes);
		const ticket = await new MediaTickets(32191).create(path);

		expect(ticket.contentHash).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);
		expect(ticket.sourceFingerprint).not.toBe(ticket.contentHash);
		expect(ticket.size).toBe(bytes.length);
	});
});
