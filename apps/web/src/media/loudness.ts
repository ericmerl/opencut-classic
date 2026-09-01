const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;
const BLOCK_SECONDS = 0.4;
const BLOCK_STEP_SECONDS = 0.1;
const LOUDNESS_OFFSET = -0.691;
const TRUE_PEAK_OVERSAMPLE = 4;

interface AudioSampleBuffer {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	getChannelData(channel: number): Float32Array;
}

export interface LoudnessMeasurement {
	integratedLufs: number | null;
	samplePeakDbfs: number | null;
	estimatedTruePeakDbtp: number | null;
	durationSeconds: number;
	channels: number;
	sampleRate: number;
	analyzedBlocks: number;
}

interface BiquadCoefficients {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

function buildHighShelf({
	sampleRate,
}: {
	sampleRate: number;
}): BiquadCoefficients {
	const frequency = 1681.974450955533;
	const gainDb = 3.99984385397;
	const quality = 0.7071752369554196;
	const k = Math.tan((Math.PI * frequency) / sampleRate);
	const highGain = 10 ** (gainDb / 20);
	const bandGain = highGain ** 0.4996667741545416;
	const denominator = 1 + k / quality + k * k;
	return {
		b0: (highGain + (bandGain * k) / quality + k * k) / denominator,
		b1: (2 * (k * k - highGain)) / denominator,
		b2: (highGain - (bandGain * k) / quality + k * k) / denominator,
		a1: (2 * (k * k - 1)) / denominator,
		a2: (1 - k / quality + k * k) / denominator,
	};
}

function buildHighPass({
	sampleRate,
}: {
	sampleRate: number;
}): BiquadCoefficients {
	const frequency = 38.13547087602444;
	const quality = 0.5003270373238773;
	const k = Math.tan((Math.PI * frequency) / sampleRate);
	const denominator = 1 + k / quality + k * k;
	return {
		b0: 1 / denominator,
		b1: -2 / denominator,
		b2: 1 / denominator,
		a1: (2 * (k * k - 1)) / denominator,
		a2: (1 - k / quality + k * k) / denominator,
	};
}

function filterBiquad({
	samples,
	coefficients,
}: {
	samples: Float32Array;
	coefficients: BiquadCoefficients;
}): Float64Array {
	const output = new Float64Array(samples.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let index = 0; index < samples.length; index++) {
		const x0 = samples[index];
		const y0 =
			coefficients.b0 * x0 +
			coefficients.b1 * x1 +
			coefficients.b2 * x2 -
			coefficients.a1 * y1 -
			coefficients.a2 * y2;
		output[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}
	return output;
}

function filterKWeighting({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): Float64Array {
	const shelf = filterBiquad({
		samples,
		coefficients: buildHighShelf({ sampleRate }),
	});
	return filterBiquad({
		samples: Float32Array.from(shelf),
		coefficients: buildHighPass({ sampleRate }),
	});
}

function energyToLufs(energy: number): number {
	return LOUDNESS_OFFSET + 10 * Math.log10(energy);
}

function collectBlockEnergies({
	channels,
	sampleRate,
	length,
}: {
	channels: Float64Array[];
	sampleRate: number;
	length: number;
}): number[] {
	const blockLength = Math.max(1, Math.round(BLOCK_SECONDS * sampleRate));
	const blockStep = Math.max(1, Math.round(BLOCK_STEP_SECONDS * sampleRate));
	const blockCount =
		length <= blockLength
			? 1
			: Math.floor((length - blockLength) / blockStep) + 1;
	const energies: number[] = [];

	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const start = blockIndex * blockStep;
		const end = Math.min(length, start + blockLength);
		let energy = 0;
		for (const channel of channels) {
			let squareSum = 0;
			for (let sample = start; sample < end; sample++) {
				squareSum += channel[sample] * channel[sample];
			}
			energy += squareSum / blockLength;
		}
		energies.push(energy);
	}
	return energies;
}

function calculateIntegratedLufs({
	energies,
}: {
	energies: number[];
}): number | null {
	const absoluteGated = energies.filter(
		(energy) => energy > 0 && energyToLufs(energy) >= ABSOLUTE_GATE_LUFS,
	);
	if (absoluteGated.length === 0) return null;
	const ungatedEnergy =
		absoluteGated.reduce((sum, energy) => sum + energy, 0) /
		absoluteGated.length;
	const relativeGate = energyToLufs(ungatedEnergy) + RELATIVE_GATE_OFFSET_LU;
	const finalGate = Math.max(ABSOLUTE_GATE_LUFS, relativeGate);
	const gated = absoluteGated.filter(
		(energy) => energyToLufs(energy) >= finalGate,
	);
	if (gated.length === 0) return null;
	return energyToLufs(
		gated.reduce((sum, energy) => sum + energy, 0) / gated.length,
	);
}

function catmullRom({
	p0,
	p1,
	p2,
	p3,
	position,
}: {
	p0: number;
	p1: number;
	p2: number;
	p3: number;
	position: number;
}): number {
	const squared = position * position;
	const cubed = squared * position;
	return (
		0.5 *
		(2 * p1 +
			(-p0 + p2) * position +
			(2 * p0 - 5 * p1 + 4 * p2 - p3) * squared +
			(-p0 + 3 * p1 - 3 * p2 + p3) * cubed)
	);
}

function getPeaks({ buffer }: { buffer: AudioSampleBuffer }): {
	samplePeak: number;
	estimatedTruePeak: number;
} {
	let samplePeak = 0;
	let estimatedTruePeak = 0;
	for (
		let channelIndex = 0;
		channelIndex < buffer.numberOfChannels;
		channelIndex++
	) {
		const samples = buffer.getChannelData(channelIndex);
		for (let index = 0; index < samples.length; index++) {
			const magnitude = Math.abs(samples[index]);
			samplePeak = Math.max(samplePeak, magnitude);
			estimatedTruePeak = Math.max(estimatedTruePeak, magnitude);
			if (index >= samples.length - 1) continue;
			const p0 = samples[Math.max(0, index - 1)];
			const p1 = samples[index];
			const p2 = samples[index + 1];
			const p3 = samples[Math.min(samples.length - 1, index + 2)];
			for (let phase = 1; phase < TRUE_PEAK_OVERSAMPLE; phase++) {
				estimatedTruePeak = Math.max(
					estimatedTruePeak,
					Math.abs(
						catmullRom({
							p0,
							p1,
							p2,
							p3,
							position: phase / TRUE_PEAK_OVERSAMPLE,
						}),
					),
				);
			}
		}
	}
	return { samplePeak, estimatedTruePeak };
}

function linearToDb(value: number): number | null {
	return value > 0 ? 20 * Math.log10(value) : null;
}

export function measureLoudness({
	buffer,
}: {
	buffer: AudioSampleBuffer;
}): LoudnessMeasurement {
	if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0) {
		throw new Error("audio sample rate must be positive");
	}
	const filteredChannels = Array.from(
		{ length: buffer.numberOfChannels },
		(_, channel) =>
			filterKWeighting({
				samples: buffer.getChannelData(channel),
				sampleRate: buffer.sampleRate,
			}),
	);
	const energies = collectBlockEnergies({
		channels: filteredChannels,
		sampleRate: buffer.sampleRate,
		length: buffer.length,
	});
	const { samplePeak, estimatedTruePeak } = getPeaks({ buffer });
	return {
		integratedLufs: calculateIntegratedLufs({ energies }),
		samplePeakDbfs: linearToDb(samplePeak),
		estimatedTruePeakDbtp: linearToDb(estimatedTruePeak),
		durationSeconds: buffer.length / buffer.sampleRate,
		channels: buffer.numberOfChannels,
		sampleRate: buffer.sampleRate,
		analyzedBlocks: energies.length,
	};
}
