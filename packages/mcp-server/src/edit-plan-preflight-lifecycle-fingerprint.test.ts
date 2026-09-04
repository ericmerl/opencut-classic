import { describe, expect, test } from "bun:test";
import { editPlanSemanticFingerprint } from "./edit-plan-preflight-contract";
import type { PreflightEditOperation } from "./edit-plan-preflight-contract";

/**
 * The browser fingerprints operations after the WASM adapter materializes
 * every optional field, so the server must null the same keys. These cases
 * mirror the optional-key table for the issue #20 operation families; a
 * mismatch here means the preflight receipt would be rejected as reuse.
 */
const cases: Array<{
	omitted: PreflightEditOperation;
	explicit: PreflightEditOperation;
}> = [
	{
		omitted: { kind: "reorder_tracks", overlayTrackIds: ["a"] },
		explicit: {
			kind: "reorder_tracks",
			overlayTrackIds: ["a"],
			audioTrackIds: null,
		} as unknown as PreflightEditOperation,
	},
	{
		omitted: { kind: "remove_track", trackId: "t", occupied: "delete" },
		explicit: {
			kind: "remove_track",
			trackId: "t",
			occupied: "delete",
			targetTrackId: null,
			resolvedCascadeElementIds: ["rust-resolved-element"],
		} as unknown as PreflightEditOperation,
	},
	{
		omitted: { kind: "duplicate_track", trackId: "t" },
		explicit: {
			kind: "duplicate_track",
			trackId: "t",
			newTrackId: null,
			name: null,
		} as unknown as PreflightEditOperation,
	},
	{
		omitted: { kind: "add_bookmark", time: 0 },
		explicit: {
			kind: "add_bookmark",
			time: 0,
			bookmarkId: null,
			duration: null,
			note: null,
			color: null,
		} as unknown as PreflightEditOperation,
	},
	{
		omitted: { kind: "update_bookmark", bookmarkId: "b", clear: ["note"] },
		explicit: {
			kind: "update_bookmark",
			bookmarkId: "b",
			clear: ["note"],
			note: null,
			color: null,
			duration: null,
		} as unknown as PreflightEditOperation,
	},
	{
		omitted: { kind: "instantiate_asset", assetId: "a", startTime: 0 },
		explicit: {
			kind: "instantiate_asset",
			assetId: "a",
			startTime: 0,
			elementId: null,
			name: null,
			duration: null,
			trackId: null,
		} as unknown as PreflightEditOperation,
	},
];

describe("lifecycle operation preflight fingerprints", () => {
	test("null every optional field the browser adapter materializes", () => {
		for (const { omitted, explicit } of cases) {
			expect(editPlanSemanticFingerprint("plan", [omitted])).toBe(
				editPlanSemanticFingerprint("plan", [explicit]),
			);
		}
	});

	test("keep operations without optional fields byte-stable", () => {
		const stable: PreflightEditOperation[] = [
			{ kind: "rename_track", trackId: "t", name: "Titles" },
			{ kind: "set_main_track", trackId: "t" },
			{ kind: "move_bookmark", bookmarkId: "b", time: 4_000 },
			{ kind: "remove_bookmark", bookmarkId: "b" },
		];
		expect(editPlanSemanticFingerprint("plan", stable)).toBe(
			editPlanSemanticFingerprint("plan", structuredClone(stable)),
		);
	});
});
