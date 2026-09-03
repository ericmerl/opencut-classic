import { expect, test } from "bun:test";
import { extractAudioUntilCancelled } from "./range-audio-cancellation";

test("audio cancellation waits for in-flight extraction cleanup", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () => Response.json({ cancellationRequested: true }),
		{ preconnect: originalFetch.preconnect },
	);
	let finishExtraction!: (value: Blob) => void;
	let terminal = false;
	try {
		const extraction = new Promise<Blob>((resolve) => {
			finishExtraction = resolve;
		});
		const result = extractAudioUntilCancelled({
			baseUrl: "http://127.0.0.1/preview-range/token",
			extract: () => extraction,
		}).then((value) => {
			terminal = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(terminal).toBe(false);
		finishExtraction(new Blob(["cleaned-up"]));
		expect(await result).toEqual({ status: "cancelled" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});
