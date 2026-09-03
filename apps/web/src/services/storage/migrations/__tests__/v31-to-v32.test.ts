import { describe, expect, test } from "bun:test";
import { transformProjectV31ToV32 } from "../transformers/v31-to-v32";
import { asRecord, asRecordArray } from "./helpers";

describe("V31 to V32 Migration", () => {
	test("back-fills a stable id on every bookmark and keeps existing ids", () => {
		let counter = 0;
		const result = transformProjectV31ToV32({
			project: {
				id: "project-v31-bookmarks",
				version: 31,
				scenes: [
					{
						id: "scene-1",
						bookmarks: [
							{ time: 120_000, note: "hook", color: "#ff0000" },
							{ id: "keep-me", time: 240_000 },
							{ id: "keep-me", time: 360_000, duration: 12_000 },
							{ id: "", time: 480_000 },
						],
					},
					{ id: "scene-2" },
				],
			},
			generateId: () => `generated-${++counter}`,
		});

		expect(result.skipped).toBe(false);
		expect(result.project.version).toBe(32);
		const scenes = asRecordArray(result.project.scenes);
		expect(asRecordArray(asRecord(scenes[0]).bookmarks)).toEqual([
			{ id: "generated-1", time: 120_000, note: "hook", color: "#ff0000" },
			{ id: "keep-me", time: 240_000 },
			{ id: "generated-2", time: 360_000, duration: 12_000 },
			{ id: "generated-3", time: 480_000 },
		]);
		expect(asRecord(scenes[1]).bookmarks).toBeUndefined();
	});

	test("skips projects that are not exactly v31", () => {
		expect(
			transformProjectV31ToV32({ project: { id: "p", version: 32 } }),
		).toMatchObject({ skipped: true, reason: "already v32" });
		expect(
			transformProjectV31ToV32({ project: { id: "p", version: 30 } }),
		).toMatchObject({ skipped: true, reason: "not v31" });
		expect(
			transformProjectV31ToV32({ project: { version: 31 } }),
		).toMatchObject({
			skipped: true,
			reason: "no project id",
		});
	});
});
