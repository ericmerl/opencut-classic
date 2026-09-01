/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { measureLoudness } from "./loudness";

function buildSineBuffer({
	amplitude,
	seconds = 2,
	sampleRate = 48000,
}: {
	amplitude: number;
	seconds?: number;
	sampleRate?: number;
}) {
	const samples = Float32Array.from(
		{ length: seconds * sampleRate },
		(_, index) =>
			amplitude * Math.sin((2 * Math.PI * 1000 * index) / sampleRate),
	);
	return {
		numberOfChannels: 2,
		length: samples.length,
		sampleRate,
		getChannelData: () => samples,
	};
}

describe("measureLoudness", () => {
	test("returns null loudness and peaks for silence", () => {
		const samples = new Float32Array(48000);
		const result = measureLoudness({
			buffer: {
				numberOfChannels: 1,
				length: samples.length,
				sampleRate: 48000,
				getChannelData: () => samples,
			},
		});

		expect(result.integratedLufs).toBeNull();
		expect(result.samplePeakDbfs).toBeNull();
		expect(result.estimatedTruePeakDbtp).toBeNull();
	});

	test("tracks a 6 dB amplitude change", () => {
		const quiet = measureLoudness({
			buffer: buildSineBuffer({ amplitude: 0.1 }),
		});
		const loud = measureLoudness({
			buffer: buildSineBuffer({ amplitude: 0.2 }),
		});

		expect(quiet.integratedLufs).not.toBeNull();
		expect(loud.integratedLufs).not.toBeNull();
		expect(loud.integratedLufs! - quiet.integratedLufs!).toBeCloseTo(6.02, 1);
		expect(loud.samplePeakDbfs! - quiet.samplePeakDbfs!).toBeCloseTo(6.02, 1);
	});

	test("estimates inter-sample peak at or above sample peak", () => {
		const result = measureLoudness({
			buffer: buildSineBuffer({ amplitude: 0.9, sampleRate: 44100 }),
		});

		expect(result.estimatedTruePeakDbtp!).toBeGreaterThanOrEqual(
			result.samplePeakDbfs!,
		);
	});
});
