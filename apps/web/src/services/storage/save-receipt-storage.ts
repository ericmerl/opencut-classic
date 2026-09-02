import {
	SAVE_RECEIPT_ENVELOPE_VERSION,
	SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
	type PersistedSaveReceiptEnvelope,
} from "./types";

export type SaveReceiptStorageErrorCode =
	| "unsupported-save-receipt-version"
	| "corrupt-save-receipt";

export class SaveReceiptStorageError extends Error {
	constructor(
		readonly code: SaveReceiptStorageErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SaveReceiptStorageError";
	}
}

export function parseSaveReceiptEnvelope<T extends { operationId: string }>({
	value,
	operationId,
	parseResult,
}: {
	value: unknown;
	operationId: string;
	parseResult: (value: unknown) => T;
}): PersistedSaveReceiptEnvelope<T> {
	if (!isRecord(value)) {
		throw corrupt("save receipt is not an object");
	}
	if (!("envelopeVersion" in value)) {
		throw unsupported("save receipt has no envelope version");
	}
	if (value.envelopeVersion !== SAVE_RECEIPT_ENVELOPE_VERSION) {
		throw unsupported(
			`save receipt envelope version ${String(value.envelopeVersion)} is unsupported`,
		);
	}
	if (value.storageSchemaVersion !== SAVE_RECEIPT_STORAGE_SCHEMA_VERSION) {
		throw unsupported(
			`save receipt storage schema version ${String(value.storageSchemaVersion)} is unsupported`,
		);
	}
	assertExactKeys(value, [
		"envelopeVersion",
		"fingerprint",
		"id",
		"operationId",
		"recordedAt",
		"result",
		"storageSchemaVersion",
	]);
	if (
		value.id !== operationId ||
		value.operationId !== operationId ||
		!operationId.trim()
	) {
		throw corrupt("save receipt operation ID does not match its storage key");
	}
	if (typeof value.fingerprint !== "string" || !value.fingerprint) {
		throw corrupt("save receipt fingerprint is missing");
	}
	if (!isCanonicalTimestamp(value.recordedAt)) {
		throw corrupt("save receipt recordedAt is not a canonical timestamp");
	}
	let result: T;
	try {
		result = parseResult(value.result);
	} catch (error) {
		throw corrupt("save receipt result does not match its schema", error);
	}
	if (result.operationId !== operationId) {
		throw corrupt(
			"save receipt result operation ID does not match its envelope",
		);
	}
	return {
		id: operationId,
		envelopeVersion: SAVE_RECEIPT_ENVELOPE_VERSION,
		storageSchemaVersion: SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
		operationId,
		fingerprint: value.fingerprint,
		result,
		recordedAt: value.recordedAt,
	};
}

function assertExactKeys(
	value: Record<string, unknown>,
	expectedKeys: string[],
): void {
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		const missing = expected.filter((key) => !actual.includes(key));
		const unknown = actual.filter((key) => !expected.includes(key));
		throw corrupt(
			`save receipt envelope fields are invalid (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
		);
	}
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function corrupt(message: string, cause?: unknown): SaveReceiptStorageError {
	return new SaveReceiptStorageError("corrupt-save-receipt", message, {
		cause,
	});
}

function unsupported(message: string): SaveReceiptStorageError {
	return new SaveReceiptStorageError(
		"unsupported-save-receipt-version",
		message,
	);
}
