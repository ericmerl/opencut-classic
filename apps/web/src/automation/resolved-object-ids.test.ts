/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { resolveElementAutoTrackId } from "./resolved-object-ids";

describe("resolved native object IDs", () => {
	test("binds an inserted element to its exact auto-created track", () => {
		expect(
			resolveElementAutoTrackId({
				elementId: "element-1",
				autoTrackId: "track-1",
				resolvedAllocations: [
					{
						role: "element-auto-track",
						sourceId: "element-1",
						resolvedId: "track-1",
					},
				],
			}),
		).toBe("track-1");
	});

	test("rejects missing, mismatched, and unused auto-track allocations", () => {
		expect(() =>
			resolveElementAutoTrackId({
				elementId: "element-1",
				autoTrackId: "track-1",
				resolvedAllocations: [],
			}),
		).toThrow("missing resolved ID allocation");
		expect(() =>
			resolveElementAutoTrackId({
				elementId: "element-1",
				autoTrackId: "track-1",
				resolvedAllocations: [
					{
						role: "element-auto-track",
						sourceId: "element-1",
						resolvedId: "different-track",
					},
				],
			}),
		).toThrow("does not match");
		expect(() =>
			resolveElementAutoTrackId({
				elementId: "element-1",
				autoTrackId: undefined,
				resolvedAllocations: [
					{
						role: "element-auto-track",
						sourceId: "element-1",
						resolvedId: "track-1",
					},
				],
			}),
		).toThrow("unused resolved ID allocations");
	});
});
