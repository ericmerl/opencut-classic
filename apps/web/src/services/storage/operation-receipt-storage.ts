import { IndexedDBAdapter } from "./indexeddb-adapter";
import {
	OPERATION_RECEIPT_ENVELOPE_VERSION,
	OPERATION_RECEIPT_STORAGE_SCHEMA_VERSION,
	type PersistedOperationReceipt,
	type OperationReceiptBinding,
} from "./types";

type OperationReceiptInput = Omit<
	PersistedOperationReceipt,
	"id" | "envelopeVersion" | "storageSchemaVersion"
>;

export class OperationReceiptStore {
	private readonly adapter = new IndexedDBAdapter<unknown>({
		dbName: "opencut-operation-receipts",
		storeName: "receipts",
		version: 1,
	});
	private readonly writeTails = new Map<string, Promise<void>>();

	async save(receipt: OperationReceiptInput): Promise<void> {
		const key = receiptStorageKey(receipt.binding);
		const prior = this.writeTails.get(key) ?? Promise.resolve();
		const next = prior.then(() => this.saveNow(receipt));
		this.writeTails.set(key, next);
		try {
			await next;
		} finally {
			if (this.writeTails.get(key) === next) {
				this.writeTails.delete(key);
			}
		}
	}

	async load(
		binding: OperationReceiptBinding,
	): Promise<PersistedOperationReceipt | null> {
		const key = receiptStorageKey(binding);
		const value = await this.adapter.get(key);
		return value === null
			? null
			: parseOperationReceiptEnvelope({ value, key, binding });
	}

	private async saveNow(receipt: OperationReceiptInput): Promise<void> {
		validateReceiptInput(receipt);
		const key = receiptStorageKey(receipt.binding);
		const priorValue = await this.adapter.get(key);
		if (priorValue !== null) {
			const prior = parseOperationReceiptEnvelope({
				value: priorValue,
				key,
				binding: receipt.binding,
			});
			if (
				stableSerialize(prior.binding) === stableSerialize(receipt.binding) &&
				stableSerialize(prior.afterState) ===
					stableSerialize(receipt.afterState) &&
				stableSerialize(prior.result) === stableSerialize(receipt.result)
			) {
				return;
			}
			throw new Error(
				`operation receipt ${receipt.operationId} already records a different operation result`,
			);
		}
		await this.adapter.set({
			key,
			value: {
				id: key,
				envelopeVersion: OPERATION_RECEIPT_ENVELOPE_VERSION,
				storageSchemaVersion: OPERATION_RECEIPT_STORAGE_SCHEMA_VERSION,
				...receipt,
			},
		});
	}
}

export function parseOperationReceiptEnvelope({
	value,
	key,
	binding,
}: {
	value: unknown;
	key: string;
	binding: OperationReceiptBinding;
}): PersistedOperationReceipt {
	const operationId = binding.outerOperationId;
	if (!isRecord(value)) throw malformed(operationId, "not an object");
	if (value.id !== key || value.operationId !== operationId) {
		throw malformed(operationId, "identity mismatch");
	}
	if (value.envelopeVersion !== OPERATION_RECEIPT_ENVELOPE_VERSION) {
		throw malformed(operationId, "unsupported envelope version");
	}
	if (value.storageSchemaVersion !== OPERATION_RECEIPT_STORAGE_SCHEMA_VERSION) {
		throw malformed(operationId, "unsupported storage schema version");
	}
	if (!isReceiptBinding(value.binding)) {
		throw malformed(operationId, "invalid binding");
	}
	if (stableSerialize(value.binding) !== stableSerialize(binding)) {
		throw malformed(operationId, "contract mismatch");
	}
	if (!isAfterState(value.afterState, true)) {
		throw malformed(operationId, "invalid immutable after-state");
	}
	if (typeof value.recordedAt !== "string" || value.recordedAt.length === 0) {
		throw malformed(operationId, "invalid recordedAt");
	}
	if (!Number.isFinite(Date.parse(value.recordedAt as string))) {
		throw malformed(operationId, "invalid recordedAt");
	}
	assertJsonValue(value.result, "result");
	const afterState = value.afterState as Record<string, unknown>;
	return {
		...value,
		afterState: {
			...afterState,
			contentHashProjectionVersion:
				afterState.contentHashProjectionVersion ?? 1,
		},
	} as unknown as PersistedOperationReceipt;
}

function validateReceiptInput(receipt: OperationReceiptInput): void {
	if (
		!receipt.operationId ||
		!isReceiptBinding(receipt.binding) ||
		receipt.binding.outerOperationId !== receipt.operationId ||
		!isAfterState(receipt.afterState, false)
	) {
		throw new Error("operation receipt identity fields are required");
	}
	if (!Number.isFinite(Date.parse(receipt.recordedAt))) {
		throw new Error("operation receipt recordedAt must be an ISO date");
	}
	assertJsonValue(receipt.result, "result");
}

export function receiptStorageKey(binding: OperationReceiptBinding): string {
	validateBinding(binding);
	return `${binding.outerOperationId}\u001f${binding.outerToolName}\u001f${binding.role}\u001f${binding.stepId}\u001f${binding.outerRequestFingerprint}\u001f${binding.browserMethod}\u001f${binding.browserRequestFingerprint}`;
}

function validateBinding(binding: OperationReceiptBinding): void {
	if (!isReceiptBinding(binding)) {
		throw new Error("operation receipt binding is invalid");
	}
}

function isReceiptBinding(value: unknown): value is OperationReceiptBinding {
	if (!isRecord(value) || value.version !== 1) return false;
	return (
		[
			"outerOperationId",
			"outerToolName",
			"outerRequestFingerprint",
			"stepId",
			"browserMethod",
			"browserRequestFingerprint",
		].every(
			(field) => typeof value[field] === "string" && value[field].length > 0,
		) &&
		(value.role === "direct-terminal" || value.role === "composite-step")
	);
}

function isAfterState(value: unknown, allowLegacyMissing: boolean): boolean {
	return (
		isRecord(value) &&
		typeof value.projectId === "string" &&
		value.projectId.length > 0 &&
		typeof value.sceneId === "string" &&
		value.sceneId.length > 0 &&
		typeof value.revisionAfter === "number" &&
		Number.isSafeInteger(value.revisionAfter) &&
		value.revisionAfter >= 0 &&
		typeof value.sessionRevisionAfter === "number" &&
		value.sessionRevisionAfter === value.revisionAfter &&
		typeof value.durableWriteVersion === "number" &&
		Number.isSafeInteger(value.durableWriteVersion) &&
		value.durableWriteVersion > 0 &&
		typeof value.contentHashAfter === "string" &&
		/^[a-f0-9]{64}$/.test(value.contentHashAfter) &&
		(allowLegacyMissing
			? value.contentHashProjectionVersion === undefined ||
				value.contentHashProjectionVersion === 1 ||
				value.contentHashProjectionVersion === 2
			: value.contentHashProjectionVersion === 2)
	);
}

function assertJsonValue(value: unknown, path: string): void {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		value.forEach((child, index) =>
			assertJsonValue(child, `${path}[${index}]`),
		);
		return;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			assertJsonValue(child, `${path}.${key}`);
		}
		return;
	}
	throw new Error(`operation receipt ${path} is outside the JSON domain`);
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function malformed(operationId: string, reason: string): Error {
	return new Error(`operation receipt ${operationId} is malformed: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
