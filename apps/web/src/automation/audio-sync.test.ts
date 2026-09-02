/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
	buildAudioEnvelope,
	findBestAudioLag,
	synchronizedTargetStart,
} from "./audio-sync";

describe("audio synchronization", () => {
	test("finds a delayed copy with normalized cross-correlation", () => {
		const reference = Float32Array.from([
			0, 0, 0.2, 0.8, 0.1, 0.4, 0.9, 0.3, 0, 0,
		]);
		const target = Float32Array.from([
			0, 0, 0, 0, 0, 0.2, 0.8, 0.1, 0.4, 0.9, 0.3, 0, 0,
		]);

		const result = findBestAudioLag({
			reference,
			target,
			maxLagSamples: 6,
			minOverlapSamples: 6,
			coarseStep: 3,
		});

		expect(result.lagSamples).toBe(3);
		expect(result.score).toBeCloseTo(1);
		expect(
			synchronizedTargetStart({
				referenceStart: 120_000,
				lagSamples: result.lagSamples,
				analysisSampleRate: 3,
				ticksPerSecond: 120_000,
			}),
		).toBe(0);
	});

	test("builds an RMS envelope from trimmed and retimed source audio", () => {
		const samples = Float32Array.from([0, 0, 1, 1, 0.5, 0.5, 0, 0]);
		const envelope = buildAudioEnvelope({
			buffer: {
				sampleRate: 4,
				numberOfChannels: 1,
				length: samples.length,
				getChannelData: () => samples,
			},
			trimStart: 0.5,
			clipDuration: 1.5,
			retime: { rate: 2 },
			analysisSampleRate: 2,
			maxDuration: 10,
		});

		expect(envelope[0]).toBeCloseTo(Math.sqrt(0.625));
		expect(Array.from(envelope.slice(1))).toEqual([0, 0]);
	});

	test("rejects silent envelopes without a valid correlation", () => {
		expect(() =>
			findBestAudioLag({
				reference: new Float32Array(20),
				target: new Float32Array(20),
				maxLagSamples: 5,
				minOverlapSamples: 10,
			}),
		).toThrow("no valid overlap");
	});
});
