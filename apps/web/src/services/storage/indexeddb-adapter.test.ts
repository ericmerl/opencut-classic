import { afterEach, describe, expect, test } from "bun:test";
import { deleteDatabase, IndexedDBAdapter } from "./indexeddb-adapter";

const nativeIndexedDB = globalThis.indexedDB;
const originalIndexedDB = Object.getOwnPropertyDescriptor(
	globalThis,
	"indexedDB",
);

afterEach(() => {
	if (originalIndexedDB) {
		Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
	} else {
		Reflect.deleteProperty(globalThis, "indexedDB");
	}
});

describe("IndexedDBAdapter transaction durability", () => {
	test("waits for commit, closes the handle, and reopens persisted data", async () => {
		const fake = new FakeIndexedDB();
		installIndexedDB(fake);
		const first = new IndexedDBAdapter<{ id: string; value: string }>({
			dbName: "projects",
			storeName: "projects",
		});

		await first.set({
			key: "project-1",
			value: { id: "project-1", value: "persisted" },
		});
		expect(fake.openCount).toBe(1);
		expect(fake.closeCount).toBe(1);

		const reopened = new IndexedDBAdapter<{ id: string; value: string }>({
			dbName: "projects",
			storeName: "projects",
		});
		expect(await reopened.get("project-1")).toEqual({
			id: "project-1",
			value: "persisted",
		});
		expect(fake.openCount).toBe(2);
		expect(fake.closeCount).toBe(2);
	});

	test("rejects an aborted transaction after request success and closes", async () => {
		const fake = new FakeIndexedDB();
		fake.abortNextWrite = true;
		installIndexedDB(fake);
		const adapter = new IndexedDBAdapter<{ value: string }>({
			dbName: "projects",
			storeName: "projects",
		});

		await expect(
			adapter.set({ key: "project-1", value: { value: "not committed" } }),
		).rejects.toThrow("transaction aborted");
		expect(fake.closeCount).toBe(1);

		expect(await adapter.get("project-1")).toBeNull();
		expect(fake.closeCount).toBe(2);
	});

	test("preserves a request error and closes only after the later abort", async () => {
		const fake = new FakeIndexedDB();
		fake.failNextWriteRequest = true;
		fake.emitTransactionErrorBeforeAbort = true;
		installIndexedDB(fake);
		const adapter = new IndexedDBAdapter<{ id: string; value: string }>({
			dbName: "projects",
			storeName: "projects",
		});

		await expect(
			adapter.set({
				key: "project-1",
				value: { id: "project-1", value: "not persisted" },
			}),
		).rejects.toBe(fake.requestFailure);

		expect(fake.abortCalls).toBe(1);
		expect(fake.transactionErrorCount).toBe(1);
		expect(fake.closeCount).toBe(1);
		expect(fake.terminalEvents).toEqual(["error", "abort", "close"]);
	});

	test("closes a handle that succeeds after a blocked open was rejected", async () => {
		const fake = new FakeIndexedDB();
		fake.blockNextOpen = true;
		installIndexedDB(fake);
		const adapter = new IndexedDBAdapter<{ id: string }>({
			dbName: "projects",
			storeName: "projects",
		});

		await expect(adapter.get("project-1")).rejects.toThrow(
			"IndexedDB open was blocked",
		);
		await yieldMicrotasks();
		expect(fake.closeCount).toBe(1);
	});

	test("keeps a blocked deletion pending until it later succeeds", async () => {
		const fake = new FakeIndexedDB();
		fake.blockNextDelete = true;
		installIndexedDB(fake);
		let settled = false;
		const deletion = deleteDatabase({ dbName: "projects" });
		void deletion.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await yieldMicrotasks();
		expect(fake.deleteBlockedCount).toBe(1);
		expect(settled).toBe(false);
		fake.completeBlockedDelete();
		await deletion;
		expect(settled).toBe(true);
	});

	test("keeps a blocked deletion pending until it later errors", async () => {
		const fake = new FakeIndexedDB();
		fake.blockNextDelete = true;
		installIndexedDB(fake);
		let settled = false;
		const deletion = deleteDatabase({ dbName: "projects" });
		void deletion.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await yieldMicrotasks();
		expect(fake.deleteBlockedCount).toBe(1);
		expect(settled).toBe(false);
		fake.failBlockedDelete();
		await expect(deletion).rejects.toThrow("database deletion failed");
		expect(settled).toBe(true);
	});
});

const realBrowserTest = nativeIndexedDB ? test : test.skip;
realBrowserTest(
	"real browser integration hook persists data across reopened handles",
	async () => {
		installIndexedDB(nativeIndexedDB);
		const dbName = `opencut-save-test-${crypto.randomUUID()}`;
		const first = new IndexedDBAdapter<{ id: string; value: string }>({
			dbName,
			storeName: "records",
		});
		await first.set({
			key: "record-1",
			value: { id: "record-1", value: "committed" },
		});
		const reopened = new IndexedDBAdapter<{ id: string; value: string }>({
			dbName,
			storeName: "records",
		});
		expect(await reopened.get("record-1")).toEqual({
			id: "record-1",
			value: "committed",
		});
		await deleteDatabase({ dbName });
	},
);

function installIndexedDB(factory: IDBFactory | FakeIndexedDB): void {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: factory as IDBFactory,
	});
}

class FakeIndexedDB {
	readonly values = new Map<string, unknown>();
	readonly requestFailure = new DOMException(
		"write request failed",
		"ConstraintError",
	);
	readonly terminalEvents: string[] = [];
	openCount = 0;
	closeCount = 0;
	abortCalls = 0;
	transactionErrorCount = 0;
	deleteBlockedCount = 0;
	abortNextWrite = false;
	blockNextOpen = false;
	blockNextDelete = false;
	failNextWriteRequest = false;
	emitTransactionErrorBeforeAbort = false;
	private pendingDelete: MutableOpenRequest<undefined> | null = null;

	open(): IDBOpenDBRequest {
		this.openCount += 1;
		const request = fakeOpenRequest<IDBDatabase>();
		const database = this.database();
		const shouldBlock = this.blockNextOpen;
		this.blockNextOpen = false;
		queueMicrotask(() => {
			request.result = database;
			if (shouldBlock) {
				request.onblocked?.(eventFor(request));
				queueMicrotask(() => request.onsuccess?.(eventFor(request)));
				return;
			}
			request.onsuccess?.(eventFor(request));
		});
		return request as unknown as IDBOpenDBRequest;
	}

	deleteDatabase(): IDBOpenDBRequest {
		const request = fakeOpenRequest<undefined>();
		const shouldBlock = this.blockNextDelete;
		this.blockNextDelete = false;
		queueMicrotask(() => {
			if (shouldBlock) {
				this.deleteBlockedCount += 1;
				this.pendingDelete = request;
				request.onblocked?.(eventFor(request));
				return;
			}
			request.onsuccess?.(eventFor(request));
		});
		return request as unknown as IDBOpenDBRequest;
	}

	completeBlockedDelete(): void {
		const request = this.takePendingDelete();
		request.onsuccess?.(eventFor(request));
	}

	failBlockedDelete(): void {
		const request = this.takePendingDelete();
		request.error = new DOMException(
			"database deletion failed",
			"UnknownError",
		);
		request.onerror?.(eventFor(request));
	}

	private database(): IDBDatabase {
		return {
			objectStoreNames: { contains: () => true },
			transaction: () => this.transaction(),
			close: () => {
				this.closeCount += 1;
				this.terminalEvents.push("close");
			},
		} as unknown as IDBDatabase;
	}

	private transaction(): IDBTransaction {
		const transaction = {
			abort: () => {
				this.abortCalls += 1;
				this.dispatchAbort(transaction);
			},
			error: null,
			onabort: null,
			oncomplete: null,
			onerror: null,
			objectStore: () => this.objectStore(transaction),
		} as unknown as IDBTransaction;
		return transaction;
	}

	private objectStore(transaction: IDBTransaction): IDBObjectStore {
		return {
			put: (value: { id: string }) => {
				const request = fakeRequest<IDBValidKey>();
				const shouldAbort = this.abortNextWrite;
				const shouldFailRequest = this.failNextWriteRequest;
				this.abortNextWrite = false;
				this.failNextWriteRequest = false;
				queueMicrotask(() => {
					if (shouldFailRequest) {
						request.error = this.requestFailure;
						request.onerror?.(eventFor(request));
						return;
					}
					request.result = value.id;
					request.onsuccess?.(eventFor(request));
					queueMicrotask(() => {
						if (shouldAbort) {
							this.dispatchAbort(transaction);
							return;
						}
						this.values.set(value.id, structuredClone(value));
						transaction.oncomplete?.(eventFor(transaction));
					});
				});
				return request as unknown as IDBRequest<IDBValidKey>;
			},
			get: (key: string) => {
				const request = fakeRequest<unknown>();
				queueMicrotask(() => {
					request.result = this.values.get(key);
					request.onsuccess?.(eventFor(request));
					queueMicrotask(() => transaction.oncomplete?.(eventFor(transaction)));
				});
				return request as unknown as IDBRequest;
			},
		} as unknown as IDBObjectStore;
	}

	private dispatchAbort(transaction: IDBTransaction): void {
		const finish = () => {
			Object.defineProperty(transaction, "error", {
				configurable: true,
				value: new DOMException("transaction aborted", "AbortError"),
			});
			this.terminalEvents.push("abort");
			transaction.onabort?.(eventFor(transaction));
		};
		if (this.emitTransactionErrorBeforeAbort) {
			Object.defineProperty(transaction, "error", {
				configurable: true,
				value: new DOMException("transaction error", "UnknownError"),
			});
			this.transactionErrorCount += 1;
			this.terminalEvents.push("error");
			transaction.onerror?.(eventFor(transaction));
		}
		queueMicrotask(finish);
	}

	private takePendingDelete(): MutableOpenRequest<undefined> {
		const request = this.pendingDelete;
		if (!request) throw new Error("No blocked deletion is pending");
		this.pendingDelete = null;
		return request;
	}
}

interface MutableRequest<TResult> {
	result: TResult;
	error: DOMException | null;
	onsuccess: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
}

interface MutableOpenRequest<TResult> extends MutableRequest<TResult> {
	onblocked: ((event: Event) => void) | null;
}

function fakeRequest<TResult>(): MutableRequest<TResult> {
	return {
		result: undefined as TResult,
		error: null,
		onsuccess: null,
		onerror: null,
	};
}

function fakeOpenRequest<TResult>(): MutableOpenRequest<TResult> {
	return { ...fakeRequest<TResult>(), onblocked: null };
}

function eventFor(target: unknown): Event {
	return { target } as unknown as Event;
}

async function yieldMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
