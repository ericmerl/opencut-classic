import { upsertPathKeyframe } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type { TimelineElement } from "@/timeline";
import { mediaTime, type MediaTime } from "@/wasm";

export interface AudioDuckingRegion {
	startTime: MediaTime;
	duration: MediaTime;
}

export interface AudioDuckingControl {
	regions: AudioDuckingRegion[];
	reductionDb: number;
	attackDuration: MediaTime;
	releaseDuration: MediaTime;
}

interface LocalRegion {
	start: number;
	end: number;
}

export function buildAudioDuckingPatch({
	element,
	control,
}: {
	element: TimelineElement;
	control: AudioDuckingControl;
}): Partial<TimelineElement> {
	if (element.type !== "audio" && element.type !== "video") {
		throw new Error("audio ducking requires a video or audio element");
	}
	assertDuckingControl(control);
	if (control.regions.length === 0) {
		return { animations: withoutDucking({ animations: element.animations }) };
	}

	const regions = mergeLocalRegions({
		regions: control.regions.flatMap((region) => {
			const start = Math.max(0, region.startTime - element.startTime);
			const end = Math.min(
				element.duration,
				region.startTime + region.duration - element.startTime,
			);
			return end > start ? [{ start, end }] : [];
		}),
		joinDistance: control.attackDuration + control.releaseDuration,
	});
	if (regions.length === 0) {
		throw new Error("audio ducking regions do not overlap the target element");
	}

	const target = resolveAnimationTarget({ element, path: "volume" });
	if (!target) throw new Error("volume automation is unavailable");
	let animations = withoutDucking({ animations: element.animations });
	for (const point of buildDuckingPoints({
		regions,
		duration: element.duration,
		reductionDb: control.reductionDb,
		attackDuration: control.attackDuration,
		releaseDuration: control.releaseDuration,
	})) {
		animations = upsertPathKeyframe({
			animations,
			propertyPath: "ducking",
			time: mediaTime({ ticks: point.time }),
			value: point.value,
			interpolation: "linear",
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
	}
	return { animations };
}

function assertDuckingControl(control: AudioDuckingControl): void {
	if (
		!Number.isFinite(control.reductionDb) ||
		control.reductionDb <= 0 ||
		control.reductionDb > 60
	) {
		throw new Error(
			"ducking reductionDb must be greater than 0 and at most 60",
		);
	}
	assertDuration(control.attackDuration, "attackDuration", true);
	assertDuration(control.releaseDuration, "releaseDuration", true);
	for (const region of control.regions) {
		assertDuration(region.startTime, "region startTime", true);
		assertDuration(region.duration, "region duration", false);
	}
}

function assertDuration(value: number, name: string, allowZero: boolean): void {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(
			`${name} must be ${allowZero ? "non-negative" : "positive"} ticks`,
		);
	}
}

function withoutDucking({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const next = { ...animations };
	delete next.ducking;
	return Object.keys(next).length > 0 ? next : undefined;
}

function mergeLocalRegions({
	regions,
	joinDistance,
}: {
	regions: LocalRegion[];
	joinDistance: number;
}): LocalRegion[] {
	const ordered = [...regions].sort((left, right) => left.start - right.start);
	const merged: LocalRegion[] = [];
	for (const region of ordered) {
		const prior = merged[merged.length - 1];
		if (!prior || region.start > prior.end + joinDistance) {
			merged.push({ ...region });
			continue;
		}
		prior.end = Math.max(prior.end, region.end);
	}
	return merged;
}

function buildDuckingPoints({
	regions,
	duration,
	reductionDb,
	attackDuration,
	releaseDuration,
}: {
	regions: LocalRegion[];
	duration: number;
	reductionDb: number;
	attackDuration: number;
	releaseDuration: number;
}): Array<{ time: number; value: number }> {
	const points = new Map<number, number>([
		[0, 0],
		[duration, 0],
	]);
	for (const region of regions) {
		const effectiveAttack = attackDuration === 0 ? 1 : attackDuration;
		const effectiveRelease = releaseDuration === 0 ? 1 : releaseDuration;
		const attackStart = Math.max(0, region.start - effectiveAttack);
		const releaseEnd = Math.min(duration, region.end + effectiveRelease);
		setLowest(
			points,
			attackStart,
			attackStart === region.start ? -reductionDb : 0,
		);
		setLowest(points, region.start, -reductionDb);
		setLowest(points, region.end, -reductionDb);
		setLowest(points, releaseEnd, releaseEnd === region.end ? -reductionDb : 0);
	}
	return [...points.entries()]
		.sort(([left], [right]) => left - right)
		.map(([time, value]) => ({ time, value }));
}

function setLowest(
	points: Map<number, number>,
	time: number,
	value: number,
): void {
	points.set(time, Math.min(points.get(time) ?? 0, value));
}
