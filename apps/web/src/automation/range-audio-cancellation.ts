export async function extractAudioUntilCancelled({
	baseUrl,
	extract,
}: {
	baseUrl: string;
	extract: () => Promise<Blob>;
}): Promise<{ status: "ready"; audio: Blob } | { status: "cancelled" }> {
	let settled:
		| { status: "ready"; audio: Blob }
		| { status: "failed"; error: unknown }
		| undefined;
	void extract().then(
		(audio) => {
			settled = { status: "ready", audio };
		},
		(error: unknown) => {
			settled = { status: "failed", error };
		},
	);
	let cancellationObserved = false;
	while (!settled) {
		if ((await readProgress(`${baseUrl}/status`)).cancellationRequested) {
			cancellationObserved = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	// Web Audio decoding itself is not abortable. Once cancellation is observed,
	// wait for that bounded local work to settle so no extraction remains alive
	// after the durable terminal cancellation receipt is published.
	while (cancellationObserved && !settled)
		await new Promise((resolve) => setTimeout(resolve, 25));
	if (cancellationObserved) return { status: "cancelled" };
	const result = settled as
		| { status: "ready"; audio: Blob }
		| { status: "failed"; error: unknown }
		| undefined;
	if (!result) throw new Error("audio extraction settled without a result");
	if (result.status === "failed") throw result.error;
	return result;
}

async function readProgress(url: string) {
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`preview range status failed with HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("preview range status returned an invalid receipt");
	return value as { cancellationRequested: boolean };
}
