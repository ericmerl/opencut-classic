import { describe, expect, test } from "bun:test";
import { parsePersistedSaveProjectResult } from "./save-project-receipt";

describe("persisted save receipt projection migration", () => {
	test("reads an exact legacy receipt as projection version 1", () => {
		const legacy = receipt();
		expect(parsePersistedSaveProjectResult(legacy)).toEqual({
			...legacy,
			contentHashProjectionVersion: 1,
		});
	});

	test("reads and preserves an exact version 2 receipt", () => {
		const current = {
			...receipt(),
			contentHashProjectionVersion: 2 as const,
		};
		expect(parsePersistedSaveProjectResult(current)).toEqual(current);
	});

	test("rejects unsupported versions and unknown fields", () => {
		expect(() =>
			parsePersistedSaveProjectResult({
				...receipt(),
				contentHashProjectionVersion: 3,
			}),
		).toThrow("projection version");
		expect(() =>
			parsePersistedSaveProjectResult({ ...receipt(), unexpected: true }),
		).toThrow("missing or unknown fields");
	});

	test("rejects malformed, truncated, replay, and unverifiable receipts", () => {
		const cases: unknown[] = [
			{ ...receipt(), status: "replayed" },
			{ ...receipt(), contentHash: "not-a-hash" },
			{ ...receipt(), readbackContentHash: "b".repeat(64) },
			{ ...receipt(), completedAt: "not-a-date" },
			{ ...receipt(), reloadVerified: false },
			Object.fromEntries(
				Object.entries(receipt()).filter(([key]) => key !== "receiptId"),
			),
		];
		for (const value of cases) {
			expect(() => parsePersistedSaveProjectResult(value)).toThrow();
		}
	});
});

function receipt() {
	const contentHash = "a".repeat(64);
	return {
		status: "saved" as const,
		receiptId: `save:project-1:7:${contentHash}`,
		operationId: "save-1",
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 9,
		contentHash,
		persistedAt: "2026-09-03T12:00:00.000Z",
		completedAt: "2026-09-03T12:00:01.000Z",
		storageSchemaVersion: 1,
		writeVersion: 7,
		reloadVerified: true as const,
		readbackContentHash: contentHash,
	};
}
