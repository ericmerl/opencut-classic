import type { AutomationProjectSnapshot } from "./types";

export interface AutomationAffectedObject {
	objectType:
		| "project"
		| "scene"
		| "track"
		| "element"
		| "media"
		| "transition"
		| "relationship";
	objectId: string;
	action: "created" | "updated" | "deleted" | "imported";
}

export function diffAutomationSnapshots(
	before: AutomationProjectSnapshot,
	after: AutomationProjectSnapshot,
): AutomationAffectedObject[] {
	const changes: AutomationAffectedObject[] = [];
	diffById(changes, "track", before.tracks, after.tracks, "trackId");
	diffById(changes, "element", before.elements, after.elements, "elementId");
	diffById(
		changes,
		"media",
		before.mediaAssets,
		after.mediaAssets,
		"assetId",
		"imported",
	);
	diffById(
		changes,
		"transition",
		before.transitions,
		after.transitions,
		"transitionId",
	);
	diffRelationships(changes, before, after);
	if (changes.length > 0 || stableSerialize(before.settings) !== stableSerialize(after.settings)) {
		changes.push(
			{ objectType: "project", objectId: after.projectId, action: "updated" },
			{ objectType: "scene", objectId: after.sceneId, action: "updated" },
		);
	}
	return changes.sort(
		(left, right) =>
			left.objectType.localeCompare(right.objectType) ||
			left.objectId.localeCompare(right.objectId) ||
			left.action.localeCompare(right.action),
	);
}

function diffById<T extends object, K extends keyof T>(
	changes: AutomationAffectedObject[],
	objectType: AutomationAffectedObject["objectType"],
	beforeValues: T[],
	afterValues: T[],
	idKey: K,
	createAction: AutomationAffectedObject["action"] = "created",
): void {
	const before = new Map(beforeValues.map((value) => [String(value[idKey]), value]));
	const after = new Map(afterValues.map((value) => [String(value[idKey]), value]));
	for (const [id, value] of after) {
		const prior = before.get(id);
		if (!prior) changes.push({ objectType, objectId: id, action: createAction });
		else if (stableSerialize(prior) !== stableSerialize(value)) {
			changes.push({ objectType, objectId: id, action: "updated" });
		}
	}
	for (const id of before.keys()) {
		if (!after.has(id)) changes.push({ objectType, objectId: id, action: "deleted" });
	}
}

function diffRelationships(
	changes: AutomationAffectedObject[],
	before: AutomationProjectSnapshot,
	after: AutomationProjectSnapshot,
): void {
	const beforeRelationships = relationships(before);
	const afterRelationships = relationships(after);
	for (const [id, members] of afterRelationships) {
		const prior = beforeRelationships.get(id);
		if (prior === undefined) {
			changes.push({ objectType: "relationship", objectId: id, action: "created" });
		} else if (stableSerialize(prior) !== stableSerialize(members)) {
			changes.push({ objectType: "relationship", objectId: id, action: "updated" });
		}
	}
	for (const id of beforeRelationships.keys()) {
		if (!afterRelationships.has(id)) {
			changes.push({ objectType: "relationship", objectId: id, action: "deleted" });
		}
	}
}

function relationships(snapshot: AutomationProjectSnapshot): Map<string, string[]> {
	const values = new Map<string, string[]>();
	for (const element of snapshot.elements) {
		for (const [kind, id] of [
			["group", element.groupId],
			["link", element.linkId],
		] as const) {
			if (!id) continue;
			const relationshipId = `${kind}:${id}`;
			const members = values.get(relationshipId) ?? [];
			members.push(`${element.trackId}:${element.elementId}`);
			values.set(relationshipId, members);
		}
	}
	for (const members of values.values()) members.sort();
	return values;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
