import { describe, expect, test } from "bun:test";
import { activeWordIndex } from "./highlight";

describe("caption word highlighting", () => {
	test("uses Rust's integer-floor word boundaries", () => {
		const input = { content: "aa b", durationTicks: 10 };
		expect(activeWordIndex({ ...input, elapsedTicks: 5 })).toBe(0);
		// Rust starts the second word at floor(10 * 2 / 3) = tick 6.
		expect(activeWordIndex({ ...input, elapsedTicks: 6 })).toBe(1);
	});

	test("counts Unicode scalar values and clamps time to the caption", () => {
		const input = { content: "😀 hi", durationTicks: 9 };
		expect(activeWordIndex({ ...input, elapsedTicks: -1 })).toBe(0);
		expect(activeWordIndex({ ...input, elapsedTicks: 3 })).toBe(1);
		expect(activeWordIndex({ ...input, elapsedTicks: 99 })).toBe(1);
	});

	test("returns null without renderable words or positive duration", () => {
		expect(
			activeWordIndex({ content: " \n ", elapsedTicks: 0, durationTicks: 10 }),
		).toBeNull();
		expect(
			activeWordIndex({ content: "hello", elapsedTicks: 0, durationTicks: 0 }),
		).toBeNull();
	});
});
