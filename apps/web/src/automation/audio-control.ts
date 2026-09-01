import { upsertPathKeyframe } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import {
	getElementVolume,
	type AudioCapableElement,
} from "@/timeline/audio-state";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type { TimelineElement } from "@/timeline";
import { mediaTime, type MediaTime } from "@/wasm";

export interface AudioControl {
	volumeDb?: number;
	muted?: boolean;
	fade?: {
		inDuration: MediaTime;
		outDuration: MediaTime;
		floorDb: number;
	};
}

function requireAudioElement({
	element,
}: {
	element: TimelineElement;
}): AudioCapableElement {
	if (element.type !== "audio" && element.type !== "video") {
		throw new Error("audio controls require a video or audio element");
	}
	return element;
}

function assertVolumeDb({
	value,
	name,
}: {
	value: number;
	name: string;
}): void {
	if (
		!Number.isFinite(value) ||
		value < VOLUME_DB_MIN ||
		value > VOLUME_DB_MAX
	) {
		throw new Error(
			`${name} must be between ${VOLUME_DB_MIN} and ${VOLUME_DB_MAX} dB`,
		);
	}
}

function assertFadeDuration({
	value,
	name,
}: {
	value: MediaTime;
	name: string;
}): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be non-negative ticks`);
	}
}

function withoutVolumeAnimation({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const nextAnimations = { ...animations };
	delete nextAnimations.volume;
	return Object.keys(nextAnimations).length > 0 ? nextAnimations : undefined;
}

export function buildAudioControlPatch({
	element,
	control,
}: {
	element: TimelineElement;
	control: AudioControl;
}): Partial<TimelineElement> {
	const audioElement = requireAudioElement({ element });
	const targetVolumeDb =
		control.volumeDb ?? getElementVolume({ element: audioElement });
	assertVolumeDb({ value: targetVolumeDb, name: "volumeDb" });

	const params = { ...audioElement.params };
	if (control.volumeDb !== undefined) params.volume = targetVolumeDb;
	if (control.muted !== undefined) params.muted = control.muted;
	if (!control.fade) return { params };

	const { inDuration, outDuration, floorDb } = control.fade;
	assertFadeDuration({ value: inDuration, name: "fade.inDuration" });
	assertFadeDuration({ value: outDuration, name: "fade.outDuration" });
	assertVolumeDb({ value: floorDb, name: "fade.floorDb" });
	if (floorDb > targetVolumeDb) {
		throw new Error("fade.floorDb cannot exceed volumeDb");
	}
	if (inDuration + outDuration > audioElement.duration) {
		throw new Error("audio fades cannot overlap");
	}

	let animations = withoutVolumeAnimation({
		animations: audioElement.animations,
	});
	const target = resolveAnimationTarget({
		element: { ...audioElement, params },
		path: "volume",
	});
	if (!target) throw new Error("volume automation is unavailable");

	const keyframes: Array<{ time: MediaTime; value: number }> = [];
	if (inDuration > 0) {
		keyframes.push(
			{ time: mediaTime({ ticks: 0 }), value: floorDb },
			{ time: inDuration, value: targetVolumeDb },
		);
	}
	if (outDuration > 0) {
		keyframes.push(
			{
				time: mediaTime({ ticks: audioElement.duration - outDuration }),
				value: targetVolumeDb,
			},
			{ time: audioElement.duration, value: floorDb },
		);
	}

	for (const keyframe of keyframes) {
		animations = upsertPathKeyframe({
			animations,
			propertyPath: "volume",
			time: keyframe.time,
			value: keyframe.value,
			interpolation: "linear",
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
	}

	return { params, animations };
}
