import type { StorageAdapter } from "./types";

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;

	constructor({
		dbName,
		storeName,
		version = 1,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
	}) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
	}

	private async getDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.version);
			let settled = false;
			const rejectOnce = (error: unknown) => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			request.onerror = () =>
				rejectOnce(request.error ?? new Error("IndexedDB open failed"));
			request.onblocked = () =>
				rejectOnce(new Error(`IndexedDB open was blocked: ${this.dbName}`));
			request.onsuccess = () => {
				if (settled) {
					request.result.close();
					return;
				}
				settled = true;
				resolve(request.result);
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: "id" });
				}
			};
		});
	}

	async get(key: string): Promise<T | null> {
		return this.runTransaction({
			mode: "readonly",
			operation: async (store) => {
				const value = await this.readRequest(
					store.get(key) as IDBRequest<T | undefined>,
				);
				return value ?? null;
			},
		});
	}

	async set({ key, value }: { key: string; value: T }): Promise<void> {
		await this.runTransaction({
			mode: "readwrite",
			operation: async (store) => {
				await this.readRequest(store.put({ id: key, ...value }));
			},
		});
	}

	async update({
		key,
		update,
	}: {
		key: string;
		update: (current: T | null) => T | null;
	}): Promise<T | null> {
		return this.runTransaction({
			mode: "readwrite",
			operation: async (store) => {
				const stored = await this.readRequest(
					store.get(key) as IDBRequest<T | undefined>,
				);
				const value = update(stored ?? null);
				if (value === null) {
					await this.readRequest(store.delete(key));
				} else {
					await this.readRequest(store.put({ id: key, ...value }));
				}
				return value;
			},
		});
	}

	async remove(key: string): Promise<void> {
		await this.runTransaction({
			mode: "readwrite",
			operation: async (store) => {
				await this.readRequest(store.delete(key));
			},
		});
	}

	async list(): Promise<string[]> {
		return this.runTransaction({
			mode: "readonly",
			operation: async (store) =>
				(await this.readRequest(store.getAllKeys())) as string[],
		});
	}

	async getAll(): Promise<T[]> {
		return this.runTransaction({
			mode: "readonly",
			operation: (store) => this.readRequest(store.getAll() as IDBRequest<T[]>),
		});
	}

	async clear(): Promise<void> {
		await this.runTransaction({
			mode: "readwrite",
			operation: async (store) => {
				await this.readRequest(store.clear());
			},
		});
	}

	private async runTransaction<TResult>({
		mode,
		operation,
	}: {
		mode: IDBTransactionMode;
		operation: (store: IDBObjectStore) => Promise<TResult>;
	}): Promise<TResult> {
		const db = await this.getDB();
		try {
			const transaction = db.transaction([this.storeName], mode);
			const terminal = this.waitForTransaction(transaction);
			let result!: TResult;
			let operationError: unknown = null;
			try {
				result = await operation(transaction.objectStore(this.storeName));
			} catch (error) {
				operationError = error;
				this.abortTransaction(transaction);
			}

			const terminalError = await terminal;
			if (operationError !== null) throw operationError;
			if (terminalError !== null) throw terminalError;
			return result;
		} finally {
			db.close();
		}
	}

	private readRequest<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
		return new Promise((resolve, reject) => {
			request.onerror = () =>
				reject(request.error ?? new Error("IndexedDB request failed"));
			request.onsuccess = () => resolve(request.result);
		});
	}

	private abortTransaction(transaction: IDBTransaction): void {
		try {
			transaction.abort();
		} catch {
			// The transaction may already have reached a terminal state.
		}
	}

	private waitForTransaction(
		transaction: IDBTransaction,
	): Promise<unknown | null> {
		return new Promise((resolve) => {
			let observedError: unknown = null;
			transaction.oncomplete = () => resolve(null);
			transaction.onabort = () =>
				resolve(
					transaction.error ??
						observedError ??
						new Error("IndexedDB transaction aborted"),
				);
			transaction.onerror = () => {
				observedError =
					transaction.error ?? new Error("IndexedDB transaction failed");
			};
		});
	}
}

export async function deleteDatabase({
	dbName,
}: {
	dbName: string;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(dbName);
		let settled = false;
		const rejectOnce = (error: unknown) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		request.onsuccess = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		request.onerror = () =>
			rejectOnce(request.error ?? new Error("IndexedDB deletion failed"));
		request.onblocked = () => {
			// A blocked deletion can still succeed after other connections close.
		};
	});
}
