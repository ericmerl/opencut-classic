import { describe, expect, test } from "bun:test";
import { withExclusiveRender } from "./render-coordinator";

describe("render coordinator", () => {
	test("serializes compositor consumers through their final copy", async () => {
		const events: string[] = [];
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = withExclusiveRender(async () => {
			events.push("first-start");
			await gate;
			events.push("first-copy");
		});
		const second = withExclusiveRender(async () => {
			events.push("second-start");
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(["first-start"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(events).toEqual(["first-start", "first-copy", "second-start"]);
	});
});
