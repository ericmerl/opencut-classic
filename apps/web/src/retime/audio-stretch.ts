import { PitchShifter } from "soundtouchjs";
import { clampRetimeRate, shouldMaintainPitch } from "@/retime/rate";
import type { RetimeConfig } from "@/timeline";
import type { TimeMap } from "opencut-wasm";
import { getSourceTimeAtClipTime } from "./resolve";

const MEDIA_TICKS_PER_SECOND = 120_000;

const RATE_EPSILON = 1e-6;
// SoundTouch's 4,096-sample analysis window and startup latency need a
// substantial slice. One-second chunks retain variable tempo on longer ramps
// while keeping each independent analysis window renderable.
const PITCH_PRESERVATION_CHUNK_TICKS = MEDIA_TICKS_PER_SECOND;

export interface TimeMapAudioChunk {
	kind: "speed" | "hold";
	timelineStart: number;
	timelineEnd: number;
	sourceStart: number;
	sourceEnd: number;
}

export function planTimeMapAudioChunks({
	timeMap,
	maxChunkTicks = PITCH_PRESERVATION_CHUNK_TICKS,
}: {
	timeMap: TimeMap;
	maxChunkTicks?: number;
}): TimeMapAudioChunk[] {
	if (!Number.isInteger(maxChunkTicks) || maxChunkTicks <= 0) {
		throw new Error("maxChunkTicks must be a positive integer");
	}
	const retime: RetimeConfig = { rate: 1, mode: "time-map", timeMap };
	const chunks: TimeMapAudioChunk[] = [];
	for (const segment of timeMap.segments) {
		if (segment.kind === "hold") {
			chunks.push({
				kind: "hold",
				timelineStart: segment.timelineStart,
				timelineEnd: segment.timelineEnd,
				sourceStart: segment.sourceTime,
				sourceEnd: segment.sourceTime,
			});
			continue;
		}
		const chunkCount = Math.max(
			1,
			Math.ceil((segment.timelineEnd - segment.timelineStart) / maxChunkTicks),
		);
		for (let index = 0; index < chunkCount; index++) {
			const timelineStart = Math.round(
				segment.timelineStart +
					((segment.timelineEnd - segment.timelineStart) * index) / chunkCount,
			);
			const timelineEnd = Math.round(
				segment.timelineStart +
					((segment.timelineEnd - segment.timelineStart) * (index + 1)) /
						chunkCount,
			);
			chunks.push({
				kind: "speed",
				timelineStart,
				timelineEnd,
				sourceStart: getSourceTimeAtClipTime({
					clipTime: timelineStart,
					retime,
				}),
				sourceEnd: getSourceTimeAtClipTime({ clipTime: timelineEnd, retime }),
			});
		}
	}
	return chunks;
}

function isMutedTimeMapHold({
	clipTicks,
	retime,
}: {
	clipTicks: number;
	retime?: RetimeConfig;
}): boolean {
	if (!retime?.timeMap || retime.timeMap.audioPolicy.hold !== "mute") {
		return false;
	}
	const lastIndex = retime.timeMap.segments.length - 1;
	return retime.timeMap.segments.some(
		(segment, index) =>
			segment.kind === "hold" &&
			clipTicks >= segment.timelineStart &&
			(clipTicks < segment.timelineEnd ||
				(index === lastIndex && clipTicks === segment.timelineEnd)),
	);
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
	if (isMutedTimeMapHold({ clipTicks, retime })) return 0;
	const mappedSourceTime = retime?.timeMap
		? getSourceTimeAtClipTime({ clipTime: clipTicks, retime }) /
			MEDIA_TICKS_PER_SECOND
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
	reverse = false,
	targetSampleRate,
}: {
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	rate: number;
	reverse?: boolean;
	targetSampleRate: number;
}): Promise<AudioBuffer> {
	const nativeSampleRate = sourceBuffer.sampleRate;
	const sourceDuration = clipDuration * rate;
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
	const shifter = new PitchShifter(stretchCtx, resampledBuffer, 4096);
	shifter.tempo = rate;
	shifter.pitch = 1;
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
			if (timeMap.audioPolicy.hold === "hold-sample") {
				const sourceIndex =
					(trimStart + chunk.sourceStart / MEDIA_TICKS_PER_SECOND) *
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
		const sourceDeltaSeconds =
			Math.abs(chunk.sourceEnd - chunk.sourceStart) / MEDIA_TICKS_PER_SECOND;
		const rate = sourceDeltaSeconds / clipSeconds;
		if (!Number.isFinite(rate) || rate < RATE_EPSILON) continue;
		const reverse = chunk.sourceEnd < chunk.sourceStart;
		const sourceStartTicks = Math.min(chunk.sourceStart, chunk.sourceEnd);
		const rendered = await buildPitchPreservedBuffer({
			sourceBuffer,
			trimStart: trimStart + sourceStartTicks / MEDIA_TICKS_PER_SECOND,
			clipDuration: clipSeconds,
			rate,
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
