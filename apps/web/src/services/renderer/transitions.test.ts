import { describe, expect, test } from "bun:test";
import type { Transform } from "@/rendering";
import { applyClipTransition } from "./transitions";

const baseTransform: Transform = {
	position: { x: 10, y: 20 },
	scaleX: 1,
	scaleY: 1,
	rotate: 0,
};

describe("applyClipTransition", () => {
	test("crossfades both sides of the cut", () => {
		const incoming = applyClipTransition({
			type: "crossfade",
			phase: "in",
			progress: 0.25,
			canvasWidth: 1080,
			transform: baseTransform,
			opacity: 0.8,
		});
		const outgoing = applyClipTransition({
			type: "crossfade",
			phase: "out",
			progress: 0.25,
			canvasWidth: 1080,
			transform: baseTransform,
			opacity: 0.8,
		});

		expect(incoming.opacity).toBeCloseTo(0.2);
		expect(outgoing.opacity).toBeCloseTo(0.6);
	});

	test("builds a black midpoint for fade-through-black", () => {
		for (const phase of ["in", "out"] as const) {
			expect(
				applyClipTransition({
					type: "fade-through-black",
					phase,
					progress: 0.5,
					canvasWidth: 1080,
					transform: baseTransform,
					opacity: 1,
				}).opacity,
			).toBe(0);
		}
	});

	test("slides, wipes, and zooms without mutating the base transform", () => {
		const slide = applyClipTransition({
			type: "slide",
			phase: "in",
			progress: 0.5,
			canvasWidth: 1000,
			transform: baseTransform,
			opacity: 1,
		});
		const wipe = applyClipTransition({
			type: "wipe",
			phase: "in",
			progress: 0.4,
			canvasWidth: 1000,
			transform: baseTransform,
			opacity: 1,
		});
		const zoom = applyClipTransition({
			type: "zoom",
			phase: "in",
			progress: 0.5,
			canvasWidth: 1000,
			transform: baseTransform,
			opacity: 1,
		});

		expect(slide.transform.position.x).toBe(510);
		expect(wipe.wipeProgress).toBe(0.4);
		expect(zoom.transform.scaleX).toBeCloseTo(0.9);
		expect(baseTransform).toEqual({
			position: { x: 10, y: 20 },
			scaleX: 1,
			scaleY: 1,
			rotate: 0,
		});
	});
});
