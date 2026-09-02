let renderTail: Promise<void> = Promise.resolve();

/**
 * The compositor and video cache are process-global. Every consumer must keep
 * this lease until the compositor output has been copied or submitted to an
 * encoder so another render cannot replace the frame in between.
 */
export async function withExclusiveRender<T>(
	work: () => Promise<T>,
): Promise<T> {
	const prior = renderTail;
	let release!: () => void;
	renderTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await prior.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
	}
}
