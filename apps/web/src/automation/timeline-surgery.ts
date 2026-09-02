import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import { isRetimableElement, type TimelineElement } from "@/timeline";
import { mediaTime, roundMediaTime, type MediaTime } from "@/wasm";
import type { AutomationEditOperation } from "./types";

export function validateTrackCreationPlan(
	operations: AutomationEditOperation[],
): void {
	for (const [index, operation] of operations.entries()) {
		if (operation.kind !== "add_track") continue;
		if (!operation.trackId) {
			throw new Error(
				"add_track requires trackId so the track can be populated in the same plan",
			);
		}
		const isPopulatedByLaterOperation = operations
			.slice(index + 1)
			.some(
				(candidate) =>
					(candidate.kind === "move" &&
						candidate.targetTrackId === operation.trackId) ||
					((candidate.kind === "insert_graphic" ||
						candidate.kind === "insert_sticker" ||
						candidate.kind === "insert_adjustment_layer") &&
						candidate.trackId === operation.trackId),
			);
		if (!isPopulatedByLaterOperation) {
			throw new Error(
				`new track ${operation.trackId} must receive an element from a later operation in the same plan`,
			);
		}
	}
}

function assertMediaTime({
	value,
	name,
	allowZero,
}: {
	value: MediaTime;
	name: string;
	allowZero: boolean;
}): void {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(
			`${name} must be ${allowZero ? "non-negative" : "positive"} ticks`,
		);
	}
}

export function getElementSourceDuration({
	element,
}: {
	element: TimelineElement;
}): MediaTime {
	if (isRetimableElement(element) && element.sourceDuration !== undefined) {
		return element.sourceDuration;
	}

	const visibleSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: element.duration,
			retime: isRetimableElement(element) ? element.retime : undefined,
		}),
	});
	return mediaTime({
		ticks: element.trimStart + visibleSourceSpan + element.trimEnd,
	});
}

export function buildTrimPatch({
	element,
	startTime,
	duration,
	trimStart,
	trimEnd,
}: {
	element: TimelineElement;
	startTime?: MediaTime;
	duration?: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
}): Partial<TimelineElement> {
	if (startTime !== undefined) {
		assertMediaTime({ value: startTime, name: "startTime", allowZero: true });
	}
	if (duration !== undefined) {
		assertMediaTime({ value: duration, name: "duration", allowZero: false });
	}
	assertMediaTime({ value: trimStart, name: "trimStart", allowZero: true });
	assertMediaTime({ value: trimEnd, name: "trimEnd", allowZero: true });

	const sourceDuration = getElementSourceDuration({ element });
	const remainingSourceTicks = sourceDuration - trimStart - trimEnd;
	if (remainingSourceTicks <= 0) {
		throw new Error("trimStart and trimEnd must leave a visible source span");
	}
	const remainingSourceSpan = mediaTime({ ticks: remainingSourceTicks });
	const derivedDuration = roundMediaTime({
		time: getTimelineDurationForSourceSpan({
			sourceSpan: remainingSourceSpan,
			retime: isRetimableElement(element) ? element.retime : undefined,
		}),
	});
	if (duration !== undefined && duration !== derivedDuration) {
		throw new Error(
			`duration must be ${derivedDuration} ticks for the requested source trims`,
		);
	}

	return {
		startTime: startTime ?? element.startTime,
		duration: derivedDuration,
		trimStart,
		trimEnd,
		...(isRetimableElement(element) && element.sourceDuration === undefined
			? { sourceDuration }
			: {}),
	};
}
