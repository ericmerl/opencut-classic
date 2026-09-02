import type { Command } from "@/commands/base-command";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import type { TimelineElement } from "@/timeline";
import type { AutomationEditOperation } from "./types";

type CaptionCorrection = Extract<
	AutomationEditOperation,
	{ kind: "update_caption" }
>;

export function buildCaptionCorrectionCommand({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: CaptionCorrection;
}): Command {
	const patch = buildCaptionCorrectionPatch({ element, operation });
	return new UpdateElementsCommand({
		updates: [
			{
				trackId: operation.trackId,
				elementId: operation.elementId,
				patch,
			},
		],
	});
}

export function buildCaptionCorrectionPatch({
	element,
	operation,
}: {
	element: TimelineElement;
	operation: CaptionCorrection;
}): Partial<TimelineElement> {
	if (element.type !== "text") {
		throw new Error("caption corrections require a text element");
	}
	if (
		operation.text === undefined &&
		operation.startTime === undefined &&
		operation.duration === undefined
	) {
		throw new Error("at least one caption correction is required");
	}
	if (operation.text !== undefined && !operation.text.trim()) {
		throw new Error("caption text is required");
	}
	if (operation.startTime !== undefined) {
		assertMediaTime({
			value: operation.startTime,
			name: "caption startTime",
			allowZero: true,
		});
	}
	if (operation.duration !== undefined) {
		assertMediaTime({
			value: operation.duration,
			name: "caption duration",
			allowZero: false,
		});
	}

	return {
		...(operation.text === undefined
			? {}
			: {
					params: {
						...element.params,
						content: operation.text,
					},
				}),
		...(operation.startTime === undefined
			? {}
			: { startTime: operation.startTime }),
		...(operation.duration === undefined
			? {}
			: { duration: operation.duration }),
	};
}

function assertMediaTime({
	value,
	name,
	allowZero,
}: {
	value: number;
	name: string;
	allowZero: boolean;
}): void {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(
			`${name} must be ${allowZero ? "non-negative" : "positive"} ticks`,
		);
	}
}
