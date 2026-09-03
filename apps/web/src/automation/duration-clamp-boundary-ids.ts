import type { DurationClampBoundaryIds } from "@/commands/timeline/element/update-elements";
import { generateUUID } from "@/utils/id";
import type { ObjectIdAllocation } from "opencut-wasm";
import { ResolvedObjectIds } from "./resolved-object-ids";

export function buildDurationClampBoundaryIds({
	resolvedAllocations,
}: {
	resolvedAllocations: readonly ObjectIdAllocation[] | undefined;
}): DurationClampBoundaryIds {
	const resolvedIds = new ResolvedObjectIds(resolvedAllocations);
	return {
		resolveLeft: (propertyPath) =>
			resolvedIds.take({
				role: "duration-clamp-left-boundary-keyframe",
				sourceId: propertyPath,
				fallback: generateUUID,
			}),
		resolveRight: (propertyPath) =>
			resolvedIds.take({
				role: "duration-clamp-right-boundary-keyframe",
				sourceId: propertyPath,
				fallback: generateUUID,
			}),
		assertExhausted: () => resolvedIds.assertExhausted(),
	};
}
