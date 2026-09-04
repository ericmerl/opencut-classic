/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mediaTime } from "@/wasm";
import { normalizeEditPlanFingerprintOperations } from "./edit-plan-preflight-receipt";
import type { AutomationEditOperation } from "./types";

/**
 * Mirrors the MCP server's optional-key table for the issue #20 operation
 * families. The server nulls exactly these keys before fingerprinting, so the
 * browser must materialize the same set (and nothing else) as null.
 */
const cases: Array<{ operation: AutomationEditOperation; nulls: string[] }> = [
	{
		operation: { kind: "rename_track", trackId: "t", name: "Titles" },
		nulls: [],
	},
	{
		operation: { kind: "reorder_tracks", overlayTrackIds: ["a"] },
		nulls: ["audioTrackIds"],
	},
	{
		operation: { kind: "remove_track", trackId: "t", occupied: "delete" },
		nulls: ["targetTrackId"],
	},
	{
		operation: { kind: "duplicate_track", trackId: "t" },
		nulls: ["name", "newTrackId"],
	},
	{ operation: { kind: "set_main_track", trackId: "t" }, nulls: [] },
	{
		operation: { kind: "add_bookmark", time: mediaTime({ ticks: 0 }) },
		nulls: ["bookmarkId", "color", "duration", "note"],
	},
	{
		operation: { kind: "update_bookmark", bookmarkId: "b", clear: ["note"] },
		nulls: ["color", "duration", "note"],
	},
	{
		operation: {
			kind: "move_bookmark",
			bookmarkId: "b",
			time: mediaTime({ ticks: 4_000 }),
		},
		nulls: [],
	},
	{ operation: { kind: "remove_bookmark", bookmarkId: "b" }, nulls: [] },
	{
		operation: {
			kind: "instantiate_asset",
			assetId: "a",
			startTime: mediaTime({ ticks: 0 }),
		},
		nulls: ["duration", "elementId", "name", "trackId"],
	},
];

describe("lifecycle operation preflight fingerprint normalization", () => {
	test("materializes exactly the server's optional keys as null", () => {
		for (const { operation, nulls } of cases) {
			const [normalized] = normalizeEditPlanFingerprintOperations([
				operation,
			]) as Array<Record<string, unknown>>;
			const nullKeys = Object.entries(normalized ?? {})
				.filter(([, value]) => value === null)
				.map(([key]) => key)
				.sort();
			expect({ kind: operation.kind, nullKeys }).toEqual({
				kind: operation.kind,
				nullKeys: nulls,
			});
			expect(normalized).not.toHaveProperty("resolvedAllocations");
		}
	});
});
