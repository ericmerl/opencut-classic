import type { AllocationRole, ObjectIdAllocation } from "opencut-wasm";

export class ResolvedObjectIds {
	private readonly remaining: Map<string, string>;
	readonly strict: boolean;

	constructor(allocations: readonly ObjectIdAllocation[] | undefined) {
		this.strict = allocations !== undefined;
		this.remaining = new Map();
		for (const allocation of allocations ?? []) {
			const key = allocationKey({
				role: allocation.role,
				sourceId: allocation.sourceId,
			});
			if (this.remaining.has(key)) {
				throw new Error(`duplicate resolved ID allocation: ${key}`);
			}
			this.remaining.set(key, allocation.resolvedId);
		}
	}

	take({
		role,
		sourceId,
		fallback,
	}: {
		role: AllocationRole;
		sourceId: string;
		fallback: () => string;
	}): string {
		const key = allocationKey({ role, sourceId });
		const resolved = this.remaining.get(key);
		if (resolved !== undefined) {
			this.remaining.delete(key);
			return resolved;
		}
		if (this.strict) throw new Error(`missing resolved ID allocation: ${key}`);
		return fallback();
	}

	assertExhausted(): void {
		if (this.remaining.size === 0) return;
		throw new Error(
			`unused resolved ID allocations: ${[...this.remaining.keys()].sort().join(", ")}`,
		);
	}
}

function allocationKey({
	role,
	sourceId,
}: {
	role: AllocationRole;
	sourceId: string;
}): string {
	return `${role}\0${sourceId}`;
}

export function resolveElementAutoTrackId({
	elementId,
	autoTrackId,
	resolvedAllocations,
}: {
	elementId: string | undefined;
	autoTrackId: string | undefined;
	resolvedAllocations: readonly ObjectIdAllocation[] | undefined;
}): string | undefined {
	const resolvedIds = new ResolvedObjectIds(resolvedAllocations);
	if (!resolvedIds.strict) return autoTrackId;
	if (!elementId) {
		throw new Error("resolved element insertion is missing elementId");
	}
	const resolvedTrackId = autoTrackId
		? resolvedIds.take({
				role: "element-auto-track",
				sourceId: elementId,
				fallback: () => autoTrackId,
			})
		: undefined;
	resolvedIds.assertExhausted();
	if (resolvedTrackId !== autoTrackId) {
		throw new Error("autoTrackId does not match its resolved allocation");
	}
	return resolvedTrackId;
}
