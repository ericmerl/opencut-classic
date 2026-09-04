import { expect, test } from "bun:test";
import { validateReviewAnnotation } from "./native-review-evidence";

test("uses Rust to reject a review region outside the normalized frame", () => {
	expect(
		validateReviewAnnotation({
			location: { kind: "time", ticks: 120_000 },
			region: { x: 0.8, y: 0.2, width: 0.3, height: 0.4 },
			finding: { kind: "human" },
		}),
	).toEqual({
		status: "rejected",
		code: "REGION_OUTSIDE_FRAME",
		reason: "normalized region must fit entirely inside the frame",
	});
});
