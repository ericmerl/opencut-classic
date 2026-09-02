/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { parsePersistedSaveProjectResult } from "./save-project-receipt";

const HASH = "a".repeat(64);

describe("persisted save result schema", () => {
	test("accepts the exact current saved result", () => {
		expect(parsePersistedSaveProjectResult(buildResult())).toEqual(
			buildResult(),
		);
	});

	test("rejects malformed, truncated, replay, and unknown-field results", () => {
		const cases: unknown[] = [
			{ ...buildResult(), status: "replayed" },
			{ ...buildResult(), contentHash: "not-a-hash" },
			{ ...buildResult(), readbackContentHash: "b".repeat(64) },
			{ ...buildResult(), completedAt: "not-a-date" },
			{ ...buildResult(), reloadVerified: false },
			{ ...buildResult(), extra: true },
			Object.fromEntries(
				Object.entries(buildResult()).filter(([key]) => key !== "receiptId"),
			),
		];
		for (const value of cases) {
			expect(() => parsePersistedSaveProjectResult(value)).toThrow();
		}
	});
});

function buildResult() {
	return {
		status: "saved" as const,
		receiptId: `save:project-1:1:${HASH}`,
		operationId: "save-1",
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 2,
		contentHash: HASH,
		persistedAt: "2026-09-02T12:00:00.000Z",
		completedAt: "2026-09-02T12:00:00.100Z",
		storageSchemaVersion: 1,
		writeVersion: 1,
		reloadVerified: true as const,
		readbackContentHash: HASH,
	};
}
