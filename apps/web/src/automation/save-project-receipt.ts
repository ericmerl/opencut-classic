import type { AutomationSaveProjectResult } from "./types";

export type PersistedAutomationSaveResult = Extract<
	AutomationSaveProjectResult,
	{ status: "saved" }
>;

const RESULT_KEYS = [
	"completedAt",
	"contentHash",
	"operationId",
	"persistedAt",
	"projectId",
	"readbackContentHash",
	"receiptId",
	"reloadVerified",
	"revision",
	"sceneId",
	"status",
	"storageSchemaVersion",
	"writeVersion",
] as const;
const VERSIONED_RESULT_KEYS = [
	...RESULT_KEYS,
	"contentHashProjectionVersion",
] as const;

export function parsePersistedSaveProjectResult(
	value: unknown,
): PersistedAutomationSaveResult {
	if (!isRecord(value)) throw new Error("save result is not an object");
	const legacy = assertExactKeys(value);
	if (value.status !== "saved")
		throw new Error("save result status is invalid");
	for (const field of [
		"receiptId",
		"operationId",
		"projectId",
		"sceneId",
	] as const) {
		if (typeof value[field] !== "string" || !value[field]) {
			throw new Error(`save result ${field} is missing`);
		}
	}
	if (!isNonnegativeInteger(value.revision)) {
		throw new Error("save result revision is invalid");
	}
	if (
		!isPositiveInteger(value.storageSchemaVersion) ||
		!isPositiveInteger(value.writeVersion)
	) {
		throw new Error("save result storage version is invalid");
	}
	if (!isCanonicalTimestamp(value.persistedAt)) {
		throw new Error("save result persistedAt is invalid");
	}
	if (
		!isCanonicalTimestamp(value.completedAt) ||
		Date.parse(value.completedAt) < Date.parse(value.persistedAt)
	) {
		throw new Error("save result completedAt is invalid");
	}
	if (
		!isCanonicalHash(value.contentHash) ||
		!isCanonicalHash(value.readbackContentHash) ||
		value.contentHash !== value.readbackContentHash
	) {
		throw new Error("save result content hash is invalid");
	}
	if (value.reloadVerified !== true) {
		throw new Error("save result reload verification is invalid");
	}
	const contentHashProjectionVersion = legacy
		? 1
		: value.contentHashProjectionVersion;
	if (
		contentHashProjectionVersion !== 1 &&
		contentHashProjectionVersion !== 2 &&
		contentHashProjectionVersion !== 3
	) {
		throw new Error("save result content hash projection version is invalid");
	}
	return {
		...value,
		contentHashProjectionVersion,
	} as unknown as PersistedAutomationSaveResult;
}

function assertExactKeys(value: Record<string, unknown>): boolean {
	const actual = Object.keys(value).sort();
	const legacy = [...RESULT_KEYS].sort();
	const versioned = [...VERSIONED_RESULT_KEYS].sort();
	if (sameKeys(actual, legacy)) return true;
	if (sameKeys(actual, versioned)) return false;
	throw new Error("save result contains missing or unknown fields");
}

function sameKeys(actual: string[], expected: string[]): boolean {
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
	);
}

function isCanonicalHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return isNonnegativeInteger(value) && value > 0;
}
