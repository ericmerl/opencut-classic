import { PitchShifter } from "soundtouchjs";
import { clampRetimeRate, shouldMaintainPitch } from "@/retime/rate";
import type { RetimeConfig } from "@/timeline";
import * as opencutWasm from "opencut-wasm";
import type { TimeMap, TimeMapAudioChunk } from "opencut-wasm";
import { getSourceTimeAtClipTime } from "./resolve";

const MEDIA_TICKS_PER_SECOND = 120_000;

const RATE_EPSILON = 1e-6;
export function planTimeMapAudioChunks({
	timeMap,
}: {
	timeMap: TimeMap;
}): TimeMapAudioChunk[] {
	const plan = opencutWasm.planTimeMapAudio({ timeMap });
	if (!plan) throw new Error("Rust rejected the time-map audio plan");
	return plan.chunks;
}

function sampleLinear({
	channelData,
	position,
}: {
	channelData: Float32Array;
	position: number;
}): number {
	if (position <= 0) {
		return channelData[0] ?? 0;
	}
	const lower = Math.floor(position);
	const upper = Math.min(channelData.length - 1, lower + 1);
	if (lower >= channelData.length) {
		return 0;
	}
	const fraction = position - lower;
	return channelData[lower] * (1 - fraction) + channelData[upper] * fraction;
}

export function sampleRetimedAudioChannel({
	channelData,
	sourceSampleRate,
	trimStart,
	clipTime,
	retime,
}: {
	channelData: Float32Array;
	sourceSampleRate: number;
	trimStart: number;
	clipTime: number;
	retime?: RetimeConfig;
}): number {
	const clipTicks = Math.round(clipTime * MEDIA_TICKS_PER_SECOND);
	const audioMapping = retime?.timeMap
		? opencutWasm.resolveTimeMapAudioSample({
				timeMap: retime.timeMap,
				clipTime: clipTicks,
			})
		: undefined;
	if (retime?.timeMap && !audioMapping) {
		throw new Error("Rust rejected the time-map audio sample");
	}
	if (audioMapping?.muted) return 0;
	const mappedSourceTime = audioMapping
		? audioMapping.sourceTime / MEDIA_TICKS_PER_SECOND
		: getSourceTimeAtClipTime({ clipTime, retime });
	return sampleLinear({
		channelData,
		position: (trimStart + mappedSourceTime) * sourceSampleRate,
	});
}

function buildResampledBuffer({
	audioContext,
	sourceBuffer,
	trimStart,
	clipDuration,
	targetSampleRate,
	retime,
}: {
	audioContext: BaseAudioContext;
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	targetSampleRate: number;
	retime?: RetimeConfig;
}): AudioBuffer {
	const outputLength = Math.max(1, Math.ceil(clipDuration * targetSampleRate));
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));
	const outputBuffer = audioContext.createBuffer(
		numChannels,
		outputLength,
		targetSampleRate,
	);

	for (let channel = 0; channel < numChannels; channel++) {
		const sourceData = sourceBuffer.getChannelData(
			Math.min(channel, sourceBuffer.numberOfChannels - 1),
		);
		const outputData = outputBuffer.getChannelData(channel);

		for (let i = 0; i < outputLength; i++) {
			const clipTime = i / targetSampleRate;
			outputData[i] = sampleRetimedAudioChannel({
				channelData: sourceData,
				sourceSampleRate: sourceBuffer.sampleRate,
				trimStart,
				clipTime,
				retime,
			});
		}
	}

	return outputBuffer;
}

async function buildPitchPreservedBuffer({
	sourceBuffer,
	trimStart,
	clipDuration,
	rate,
	endRate = rate,
	reverse = false,
	targetSampleRate,
}: {
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	rate: number;
	endRate?: number;
	reverse?: boolean;
	targetSampleRate: number;
}): Promise<AudioBuffer> {
	const nativeSampleRate = sourceBuffer.sampleRate;
	const sourceDuration = clipDuration * ((rate + endRate) / 2);
	const startSample = Math.max(0, Math.floor(trimStart * nativeSampleRate));
	const numSourceSamples = Math.max(
		1,
		Math.ceil(sourceDuration * nativeSampleRate),
	);
	const available = Math.max(0, sourceBuffer.length - startSample);
	const actualSamples = Math.max(1, Math.min(numSourceSamples, available));
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));

	// Resample to targetSampleRate first — soundtouchjs reads raw channel data
	// and does not respect the source buffer's native sample rate.
	const resampledLength = Math.max(
		1,
		Math.ceil(sourceDuration * targetSampleRate),
	);
	const resampleCtx = new OfflineAudioContext(
		numChannels,
		resampledLength,
		targetSampleRate,
	);
	const nativeBuffer = resampleCtx.createBuffer(
		numChannels,
		actualSamples,
		nativeSampleRate,
	);

	for (let ch = 0; ch < numChannels; ch++) {
		const src = sourceBuffer.getChannelData(
			Math.min(ch, sourceBuffer.numberOfChannels - 1),
		);
		if (reverse) {
			const reversed = new Float32Array(actualSamples);
			for (let index = 0; index < actualSamples; index++) {
				reversed[index] = src[startSample + actualSamples - index - 1] ?? 0;
			}
			nativeBuffer.copyToChannel(reversed, ch);
		} else {
			nativeBuffer.copyToChannel(
				src.subarray(startSample, startSample + actualSamples),
				ch,
			);
		}
	}

	const resampleSourceNode = resampleCtx.createBufferSource();
	resampleSourceNode.buffer = nativeBuffer;
	resampleSourceNode.connect(resampleCtx.destination);
	resampleSourceNode.start(0);
	const resampledBuffer = await resampleCtx.startRendering();

	const outputSamples = Math.max(1, Math.ceil(clipDuration * targetSampleRate));
	const stretchCtx = new OfflineAudioContext(
		numChannels,
		outputSamples,
		targetSampleRate,
	);
	const analysisBlockSize = 1024;
	const shifter = new PitchShifter(
		stretchCtx,
		resampledBuffer,
		analysisBlockSize,
	);
	shifter.tempo = rate;
	shifter.pitch = 1;
	let renderedFrames = 0;
	shifter.on("play", () => {
		renderedFrames += analysisBlockSize;
		const position = Math.min(1, renderedFrames / outputSamples);
		shifter.tempo = rate + (endRate - rate) * position;
	});
	shifter.connect(stretchCtx.destination);
	return stretchCtx.startRendering();
}

async function buildPitchPreservedTimeMapBuffer({
	audioContext,
	sourceBuffer,
	trimStart,
	clipDuration,
	timeMap,
}: {
	audioContext: BaseAudioContext;
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	timeMap: TimeMap;
}): Promise<AudioBuffer> {
	const targetSampleRate = audioContext.sampleRate;
	const outputLength = Math.max(1, Math.ceil(clipDuration * targetSampleRate));
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));
	const output = audioContext.createBuffer(
		numChannels,
		outputLength,
		targetSampleRate,
	);
	for (const chunk of planTimeMapAudioChunks({ timeMap })) {
		const outputStart = Math.round(
			(chunk.timelineStart / MEDIA_TICKS_PER_SECOND) * targetSampleRate,
		);
		const outputEnd = Math.min(
			outputLength,
			Math.round(
				(chunk.timelineEnd / MEDIA_TICKS_PER_SECOND) * targetSampleRate,
			),
		);
		if (outputEnd <= outputStart) continue;

		if (chunk.kind === "hold") {
			if (!chunk.muted) {
				const sourceIndex =
					(trimStart + chunk.sourceTime / MEDIA_TICKS_PER_SECOND) *
					sourceBuffer.sampleRate;
				for (let channel = 0; channel < numChannels; channel++) {
					const source = sourceBuffer.getChannelData(
						Math.min(channel, sourceBuffer.numberOfChannels - 1),
					);
					const sample = sampleLinear({
						channelData: source,
						position: sourceIndex,
					});
					output.getChannelData(channel).fill(sample, outputStart, outputEnd);
				}
			}
			continue;
		}

		const clipSeconds =
			(chunk.timelineEnd - chunk.timelineStart) / MEDIA_TICKS_PER_SECOND;
		if (chunk.startRate < RATE_EPSILON || chunk.endRate < RATE_EPSILON)
			continue;
		const reverse = chunk.direction === "reverse";
		const sourceStartTicks = Math.min(chunk.sourceStart, chunk.sourceEnd);
		const rendered = await buildPitchPreservedBuffer({
			sourceBuffer,
			trimStart: trimStart + sourceStartTicks / MEDIA_TICKS_PER_SECOND,
			clipDuration: clipSeconds,
			rate: chunk.startRate,
			endRate: chunk.endRate,
			reverse,
			targetSampleRate,
		});
		for (let channel = 0; channel < numChannels; channel++) {
			output
				.getChannelData(channel)
				.set(
					rendered
						.getChannelData(Math.min(channel, rendered.numberOfChannels - 1))
						.subarray(0, outputEnd - outputStart),
					outputStart,
				);
		}
	}
	return output;
}

export async function renderRetimedBuffer({
	audioContext,
	sourceBuffer,
	trimStart,
	clipDuration,
	retime,
	maintainPitch = false,
}: {
	audioContext: BaseAudioContext;
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	retime?: RetimeConfig;
	maintainPitch?: boolean;
}): Promise<AudioBuffer> {
	const targetSampleRate = audioContext.sampleRate;
	const rate = clampRetimeRate({ rate: retime?.rate ?? 1 });
	const requestedPitchPreservation =
		retime?.timeMap?.audioPolicy.maintainPitch ?? maintainPitch;
	if (retime?.timeMap && requestedPitchPreservation) {
		return buildPitchPreservedTimeMapBuffer({
			audioContext,
			sourceBuffer,
			trimStart,
			clipDuration,
			timeMap: retime.timeMap,
		});
	}
	const usePitchPreservation =
		!retime?.timeMap &&
		shouldMaintainPitch({ rate, maintainPitch: requestedPitchPreservation }) &&
		Math.abs(rate - 1) > RATE_EPSILON;

	if (usePitchPreservation) {
		return buildPitchPreservedBuffer({
			sourceBuffer,
			trimStart,
			clipDuration,
			rate,
			targetSampleRate,
		});
	}

	return buildResampledBuffer({
		audioContext,
		sourceBuffer,
		trimStart,
		clipDuration,
		targetSampleRate,
		retime,
	});
}
