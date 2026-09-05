import type { TimelineElement } from "@/timeline";
import type { TransitionBoundaryElement } from "opencut-wasm";

export function toTransitionBoundary(
	element: TimelineElement,
): TransitionBoundaryElement {
	return {
		id: element.id,
		type: element.type,
		startTime: element.startTime,
		duration: element.duration,
		hasMasks: "masks" in element && Boolean(element.masks?.length),
	};
}
