import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportReceiptStore } from "./export-receipts";

describe("ExportReceiptStore", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-receipts-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("persists an immutable receipt and a separate inspection", async () => {
		const store = new ExportReceiptStore(directory);
		const outputPath = join(directory, "video.mp4");
		const outputBytes = new Uint8Array([1, 2, 3]);
		await writeFile(outputPath, outputBytes);
		const outputSha256 = hash(outputBytes);
		const frameSamples = [];
		for (const position of ["opening", "middle", "ending"] as const) {
			const path = join(directory, `${position}.png`);
			const bytes = new TextEncoder().encode(position);
			await writeFile(path, bytes);
			frameSamples.push({
				position,
				timeSeconds: 0,
				path,
				bytes: bytes.byteLength,
				sha256: hash(bytes),
			});
		}
		await store.write({
			schemaVersion: 1,
			operationId: "export-1",
			fingerprint: "fingerprint-1",
			createdAt: "2026-09-01T00:00:00.000Z",
			result: {
				status: "exported",
				outputPath,
				bytesWritten: outputBytes.byteLength,
				sha256: outputSha256,
				validation: { status: "validated", frameSamples },
			},
			inspection: {
				status: "pending",
				outputSha256,
				reviewer: null,
				notes: null,
				inspectedAt: null,
			},
		});

		await store.recordInspection({
			operationId: "export-1",
			outputSha256,
			status: "verified-clean",
			reviewer: "vision-review",
			notes: "Opening, middle, ending, and corners are clean.",
		});

		const reloaded = await new ExportReceiptStore(directory).get("export-1");
		expect(reloaded).toMatchObject({
			operationId: "export-1",
			fingerprint: "fingerprint-1",
			inspection: {
				status: "verified-clean",
				outputSha256,
				reviewer: "vision-review",
			},
		});

		await writeFile(frameSamples[1]!.path, "tampered");
		await expect(
			store.recordInspection({
				operationId: "export-1",
				outputSha256,
				status: "rejected",
			}),
		).rejects.toThrow("middle frame sample");
	});

	test("rejects mismatched inspection hashes", async () => {
		const store = new ExportReceiptStore(directory);
		await store.write({
			schemaVersion: 1,
			operationId: "export-1",
			fingerprint: "fingerprint-1",
			createdAt: "2026-09-01T00:00:00.000Z",
			result: {},
			inspection: {
				status: "pending",
				outputSha256: "a".repeat(64),
				reviewer: null,
				notes: null,
				inspectedAt: null,
			},
		});

		await expect(
			store.recordInspection({
				operationId: "export-1",
				outputSha256: "b".repeat(64),
				status: "verified-clean",
			}),
		).rejects.toThrow("does not match");
	});
});

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
