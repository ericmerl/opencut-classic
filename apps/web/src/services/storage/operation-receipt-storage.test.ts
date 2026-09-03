import { afterEach, describe, expect, mock, test } from "bun:test";

const databases = new Map<string, Map<string, unknown>>();

mock.module("./indexeddb-adapter", () => ({
	IndexedDBAdapter: class<T> {
		private readonly values: Map<string, unknown>;

		constructor(options: { dbName: string; storeName: string }) {
			const key = `${options.dbName}/${options.storeName}`;
			this.values = databases.get(key) ?? new Map();
			databases.set(key, this.values);
		}

		async get(key: string): Promise<T | null> {
			return (structuredClone(this.values.get(key)) as T) ?? null;
		}

		async set({ key, value }: { key: string; value: T }): Promise<void> {
			this.values.set(key, structuredClone(value));
		}
	},
}));

const {
	OperationReceiptStore,
	parseOperationReceiptEnvelope,
	receiptStorageKey,
} = await import("./operation-receipt-storage");

afterEach(() => databases.clear());

describe("durable browser operation receipts", () => {
	test("reads legacy projection metadata and persists explicit version 2", async () => {
		const store = new OperationReceiptStore();
		const current = buildReceipt();
		current.afterState.contentHashProjectionVersion = 2;
		await store.save(current);
		expect((await store.load(current.binding))?.afterState).toMatchObject({
			contentHashProjectionVersion: 2,
		});

		const legacy = buildReceipt("legacy-projection");
		await store.save(legacy);
		const key = receiptStorageKey(legacy.binding);
		const values = databases.get("opencut-operation-receipts/receipts")!;
		const stored = structuredClone(values.get(key)) as Record<string, unknown>;
		const afterState = stored.afterState as Record<string, unknown>;
		delete afterState.contentHashProjectionVersion;
		values.set(key, stored);
		expect((await store.load(legacy.binding))?.afterState).toMatchObject({
			contentHashProjectionVersion: 1,
		});
	});

	test("survives reconstruction and exactly replays an immutable receipt", async () => {
		const first = new OperationReceiptStore();
		const receipt = buildReceipt();
		await first.save(receipt);
		await first.save({
			...receipt,
			recordedAt: "2026-09-02T00:00:01.000Z",
			result: { revision: 2, status: "applied" },
		});

		const restarted = new OperationReceiptStore();
		expect(await restarted.load(receipt.binding)).toMatchObject({
			id: receiptStorageKey(receipt.binding),
			operationId: receipt.operationId,
			binding: receipt.binding,
			afterState: receipt.afterState,
			result: { status: "applied", revision: 2 },
			recordedAt: receipt.recordedAt,
		});
	});

	test("serializes concurrent writes and rejects changed operation reuse", async () => {
		const store = new OperationReceiptStore();
		const receipt = buildReceipt();
		const results = await Promise.allSettled([
			store.save(receipt),
			store.save({
				...receipt,
				afterState: {
					...receipt.afterState,
					revisionAfter: 3,
					sessionRevisionAfter: 3,
				},
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(await store.load(receipt.binding)).toMatchObject({
			binding: receipt.binding,
			afterState: receipt.afterState,
		});
	});

	test("fails closed on malformed, unsupported, and non-JSON records", () => {
		const operationId = "operation-browser-1";
		const binding = buildReceipt().binding;
		const key = receiptStorageKey(binding);
		expect(() =>
			parseOperationReceiptEnvelope({
				key,
				binding,
				value: {
					...buildPersistedReceipt(),
					envelopeVersion: 99,
				},
			}),
		).toThrow("unsupported envelope version");
		expect(() =>
			parseOperationReceiptEnvelope({
				key,
				binding,
				value: {
					...buildPersistedReceipt(),
					result: { invalid: undefined },
				},
			}),
		).toThrow("outside the JSON domain");
	});
});

function buildReceipt(operationId = "operation-browser-1") {
	const hash = "b".repeat(64);
	return {
		operationId,
		binding: {
			version: 1 as const,
			outerOperationId: operationId,
			outerToolName: "opencut_apply_edit_plan",
			outerRequestFingerprint: "a".repeat(64),
			role: "direct-terminal" as const,
			stepId: "opencut_apply_edit_plan:direct",
			browserMethod: "apply_edit_plan",
			browserRequestFingerprint: "c".repeat(64),
		},
		afterState: {
			projectId: "project-1",
			sceneId: "scene-1",
			revisionAfter: 2,
			sessionRevisionAfter: 2,
			durableWriteVersion: 7,
			contentHashAfter: hash,
			contentHashProjectionVersion: 2 as const,
		},
		result: { status: "applied", revision: 2 },
		recordedAt: "2026-09-02T00:00:00.000Z",
	};
}

function buildPersistedReceipt() {
	const receipt = buildReceipt();
	return {
		id: receiptStorageKey(receipt.binding),
		envelopeVersion: 3,
		storageSchemaVersion: 3,
		...receipt,
	};
}
