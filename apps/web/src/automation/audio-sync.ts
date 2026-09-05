import { getSourceTimeAtClipTimeSeconds } from "@/retime";
import type { RetimeConfig } from "@/timeline";

export interface AudioBufferView {
	sampleRate: number;
	numberOfChannels: number;
	length: number;
	getChannelData(channel: number): Float32Array;
}

export interface AudioLagResult {
	lagSamples: number;
	score: number;
	overlapSamples: number;
}

export function buildAudioEnvelope({
	buffer,
	trimStart,
	clipDuration,
	retime,
	analysisSampleRate,
	maxDuration,
}: {
	buffer: AudioBufferView;
	trimStart: number;
	clipDuration: number;
	retime?: RetimeConfig;
	analysisSampleRate: number;
	maxDuration: number;
}): Float32Array {
	if (!Number.isFinite(analysisSampleRate) || analysisSampleRate <= 0) {
		throw new Error("analysisSampleRate must be positive");
	}
	const duration = Math.max(0, Math.min(clipDuration, maxDuration));
	const count = Math.max(1, Math.floor(duration * analysisSampleRate));
	const envelope = new Float32Array(count);
	for (let index = 0; index < count; index++) {
		const localStart = index / analysisSampleRate;
		const localEnd = Math.min(duration, (index + 1) / analysisSampleRate);
		// Rust maps both constant rates and time maps; a reverse segment yields a
		// descending source span, so order the bounds before sampling.
		const mappedStart =
			trimStart +
			getSourceTimeAtClipTimeSeconds({ clipTimeSeconds: localStart, retime });
		const mappedEnd =
			trimStart +
			getSourceTimeAtClipTimeSeconds({ clipTimeSeconds: localEnd, retime });
		const sourceStart = Math.max(
			0,
			Math.floor(Math.min(mappedStart, mappedEnd) * buffer.sampleRate),
		);
		const sourceEnd = Math.min(
			buffer.length,
			Math.max(
				sourceStart + 1,
				Math.ceil(Math.max(mappedStart, mappedEnd) * buffer.sampleRate),
			),
		);
		let sumSquares = 0;
		let sampleCount = 0;
		for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
			const data = buffer.getChannelData(channel);
			for (
				let sourceIndex = sourceStart;
				sourceIndex < sourceEnd;
				sourceIndex++
			) {
				const sample = data[sourceIndex] ?? 0;
				sumSquares += sample * sample;
				sampleCount += 1;
			}
		}
		envelope[index] = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
	}
	return envelope;
}

export function findBestAudioLag({
	reference,
	target,
	maxLagSamples,
	minOverlapSamples,
	coarseStep = 4,
}: {
	reference: Float32Array;
	target: Float32Array;
	maxLagSamples: number;
	minOverlapSamples: number;
	coarseStep?: number;
}): AudioLagResult {
	if (reference.length === 0 || target.length === 0) {
		throw new Error("audio synchronization requires non-empty envelopes");
	}
	const maximum = Math.max(0, Math.floor(maxLagSamples));
	const minimumOverlap = Math.max(2, Math.floor(minOverlapSamples));
	if (Math.min(reference.length, target.length) < minimumOverlap) {
		throw new Error("audio synchronization window is too short");
	}
	const step = Math.max(1, Math.floor(coarseStep));
	let best: AudioLagResult | null = null;
	for (let lag = -maximum; lag <= maximum; lag += step) {
		best = chooseBetter(
			best,
			correlate({
				reference,
				target,
				lag,
				minOverlapSamples: minimumOverlap,
			}),
		);
	}
	if (!best) throw new Error("audio synchronization found no valid overlap");
	const fineStart = Math.max(-maximum, best.lagSamples - step + 1);
	const fineEnd = Math.min(maximum, best.lagSamples + step - 1);
	for (let lag = fineStart; lag <= fineEnd; lag++) {
		best = chooseBetter(
			best,
			correlate({
				reference,
				target,
				lag,
				minOverlapSamples: minimumOverlap,
			}),
		);
	}
	if (!best) throw new Error("audio synchronization found no valid overlap");
	return best;
}

export function synchronizedTargetStart({
	referenceStart,
	lagSamples,
	analysisSampleRate,
	ticksPerSecond,
}: {
	referenceStart: number;
	lagSamples: number;
	analysisSampleRate: number;
	ticksPerSecond: number;
}): number {
	return Math.round(
		referenceStart - (lagSamples / analysisSampleRate) * ticksPerSecond,
	);
}

function correlate({
	reference,
	target,
	lag,
	minOverlapSamples,
}: {
	reference: Float32Array;
	target: Float32Array;
	lag: number;
	minOverlapSamples: number;
}): AudioLagResult | null {
	const referenceStart = Math.max(0, -lag);
	const targetStart = Math.max(0, lag);
	const overlap = Math.min(
		reference.length - referenceStart,
		target.length - targetStart,
	);
	if (overlap < minOverlapSamples) return null;

	let referenceMean = 0;
	let targetMean = 0;
	for (let index = 0; index < overlap; index++) {
		referenceMean += reference[referenceStart + index];
		targetMean += target[targetStart + index];
	}
	referenceMean /= overlap;
	targetMean /= overlap;

	let covariance = 0;
	let referencePower = 0;
	let targetPower = 0;
	for (let index = 0; index < overlap; index++) {
		const referenceValue = reference[referenceStart + index] - referenceMean;
		const targetValue = target[targetStart + index] - targetMean;
		covariance += referenceValue * targetValue;
		referencePower += referenceValue * referenceValue;
		targetPower += targetValue * targetValue;
	}
	const denominator = Math.sqrt(referencePower * targetPower);
	if (denominator <= Number.EPSILON) return null;
	return {
		lagSamples: lag,
		score: covariance / denominator,
		overlapSamples: overlap,
	};
}

function chooseBetter(
	current: AudioLagResult | null,
	candidate: AudioLagResult | null,
): AudioLagResult | null {
	if (!candidate) return current;
	if (!current) return candidate;
	if (candidate.score > current.score + 1e-12) return candidate;
	if (
		Math.abs(candidate.score - current.score) <= 1e-12 &&
		Math.abs(candidate.lagSamples) < Math.abs(current.lagSamples)
	) {
		return candidate;
	}
	return current;
}
