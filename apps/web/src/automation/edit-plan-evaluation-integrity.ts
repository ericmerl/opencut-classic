import type {
	CanonicalValue,
	ChangedObject,
	EditPlanEvaluation,
	ProjectSnapshot,
	ResolvedEditOperation,
	SourceBinding,
} from "opencut-wasm";
import { canonicalSerialize } from "./project-content-hash";

const EDIT_PLAN_CONTRACT = "opencut.edit-plan-preflight.v2";

export async function verifyEditPlanEvaluationIntegrity({
	evaluation,
	expectedSource,
	expectedOperations,
}: {
	evaluation: EditPlanEvaluation;
	expectedSource: SourceBinding;
	expectedOperations: readonly ResolvedEditOperation[];
}): Promise<string | null> {
	if (evaluation.schemaVersion !== EDIT_PLAN_CONTRACT) {
		return "native evaluation contract version does not match V2";
	}
	if (!equalGenerated({ left: evaluation.source, right: expectedSource })) {
		return "native evaluation source binding does not match apply request";
	}
	if (
		!equalGenerated({
			left: evaluation.resolvedOperations,
			right: expectedOperations,
		})
	) {
		return "apply operations differ from native resolved operations";
	}
	if (
		!equalGenerated({
			left: evaluation.cost,
			right: evaluation.requirements.cost,
		})
	) {
		return "native evaluation cost differs from capability evidence";
	}
	const beforeHash = await hashSnapshot(evaluation.before);
	if (
		beforeHash !== evaluation.source.canonicalProjectHash ||
		beforeHash !== evaluation.beforeSummary.canonicalHash
	) {
		return "native evaluation before-state hash is invalid";
	}
	const predictedHash = await hashSnapshot(evaluation.predictedAfter);
	if (
		predictedHash !== evaluation.predictedProjectHash ||
		predictedHash !== evaluation.predictedAfterSummary.canonicalHash
	) {
		return "native predicted project hash is invalid";
	}
	const planDiffHash = await sha256(
		canonicalSerialize({
			predictedProjectHash: evaluation.predictedProjectHash,
			changedObjects: evaluation.changedObjects,
			timingConsequences: evaluation.timingConsequences,
			rippleExpansion: evaluation.rippleExpansion,
			relationshipExpansion: evaluation.relationshipExpansion,
		}),
	);
	return planDiffHash === evaluation.planDiffHash
		? null
		: "native plan diff hash is invalid";
}

export function diffProjectSnapshots({
	before,
	after,
}: {
	before: ProjectSnapshot;
	after: ProjectSnapshot;
}): ChangedObject[] {
	const changed: ChangedObject[] = [];
	diffValue({ path: "", before, after, changed });
	return changed.sort((left, right) =>
		compareOrdinal({
			left: `${left.objectType}\0${left.objectId}\0${left.fieldPath}`,
			right: `${right.objectType}\0${right.objectId}\0${right.fieldPath}`,
		}),
	);
}

function diffValue({
	path,
	before,
	after,
	changed,
}: {
	path: string;
	before: unknown;
	after: unknown;
	changed: ChangedObject[];
}): void {
	if (equal({ left: before, right: after })) return;
	if (isPlainObject(before) && isPlainObject(after)) {
		const keys = [
			...new Set([...Object.keys(before), ...Object.keys(after)]),
		].sort((left, right) => compareOrdinal({ left, right }));
		for (const key of keys) {
			diffValue({
				path: path ? `${path}.${key}` : key,
				before: before[key] ?? null,
				after: after[key] ?? null,
				changed,
			});
		}
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		const length = Math.max(before.length, after.length);
		for (let index = 0; index < length; index += 1) {
			diffValue({
				path: `${path}[${index}]`,
				before: before[index] ?? null,
				after: after[index] ?? null,
				changed,
			});
		}
		return;
	}
	changed.push({
		objectType: "project",
		objectId: "canonical-project",
		fieldPath: path,
		before: toCanonicalValue(before),
		after: toCanonicalValue(after),
	});
}

function toCanonicalValue(value: unknown): CanonicalValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (Array.isArray(value)) return value.map(toCanonicalValue);
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				toCanonicalValue(child),
			]),
		);
	}
	throw new Error("project diff left the strict canonical JSON domain");
}

function equal({ left, right }: { left: unknown; right: unknown }): boolean {
	return canonicalSerialize(left) === canonicalSerialize(right);
}

function equalGenerated({
	left,
	right,
}: {
	left: unknown;
	right: unknown;
}): boolean {
	return (
		canonicalSerialize(normalizeGeneratedValue(left)) ===
		canonicalSerialize(normalizeGeneratedValue(right))
	);
}

function normalizeGeneratedValue(value: unknown): unknown {
	if (value === undefined) return null;
	if (Array.isArray(value)) return value.map(normalizeGeneratedValue);
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				normalizeGeneratedValue(child),
			]),
		);
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareOrdinal({
	left,
	right,
}: {
	left: string;
	right: string;
}): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function hashSnapshot(snapshot: ProjectSnapshot): Promise<string> {
	return sha256(canonicalSerialize(snapshot));
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
