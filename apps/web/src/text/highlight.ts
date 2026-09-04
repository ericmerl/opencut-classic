/** Word-by-word emphasis for captions: the spoken word takes `color`. */
export interface TextHighlight {
	enabled: boolean;
	color: string;
}

/** The highlight with the word the renderer paints at the resolved time. */
export interface ResolvedTextHighlight extends TextHighlight {
	wordIndex: number | null;
}

export function splitCaptionWords(content: string): string[] {
	return content.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Index of the word spoken at `elapsedTicks` of the caption, by character
 * share of its duration. Boundaries use the same integer-floor interpolation
 * as Rust's `rechunk_captions`, so the renderer and evaluator agree exactly.
 * Null when the caption has no words or has no positive duration.
 */
export function activeWordIndex({
	content,
	elapsedTicks,
	durationTicks,
}: {
	content: string;
	elapsedTicks: number;
	durationTicks: number;
}): number | null {
	const words = splitCaptionWords(content);
	if (words.length === 0 || durationTicks <= 0) return null;
	const lengths = words.map((word) => Array.from(word).length);
	const total = lengths.reduce((sum, length) => sum + length, 0);
	if (total === 0) return null;
	const duration = BigInt(Math.trunc(durationTicks));
	const elapsed = BigInt(
		Math.trunc(Math.min(Math.max(elapsedTicks, 0), durationTicks)),
	);
	let before = 0;
	for (let index = 0; index < words.length; index++) {
		before += lengths[index]!;
		const end = (duration * BigInt(before)) / BigInt(total);
		if (elapsed < end) return index;
	}
	return words.length - 1;
}
