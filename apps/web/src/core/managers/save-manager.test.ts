import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { PersistedProjectWrite } from "./project-manager";
import { SaveManager } from "./save-manager";

describe("SaveManager flush barrier", () => {
	test("joins one in-flight save across concurrent flush callers", async () => {
		const pending = deferred<PersistedProjectWrite | null>();
		let saveCalls = 0;
		const manager = createManager(async () => {
			saveCalls += 1;
			return pending.promise;
		});

		manager.markDirty();
		const first = manager.flush();
		const second = manager.flush();
		await yieldMicrotasks();

		expect(saveCalls).toBe(1);
		expect(manager.getIsDirty()).toBe(true);
		pending.resolve(receipt(1));
		expect(await first).toEqual(receipt(1));
		expect(await second).toEqual(receipt(1));
		expect(saveCalls).toBe(1);
		expect(manager.getIsDirty()).toBe(false);
		manager.stop();
	});

	test("performs and waits for a second pass when state changes during save", async () => {
		const firstWrite = deferred<PersistedProjectWrite | null>();
		const secondWrite = deferred<PersistedProjectWrite | null>();
		let saveCalls = 0;
		const manager = createManager(() => {
			saveCalls += 1;
			return saveCalls === 1 ? firstWrite.promise : secondWrite.promise;
		});

		manager.markDirty();
		const flushed = manager.flush();
		await yieldMicrotasks();
		expect(saveCalls).toBe(1);

		manager.markDirty();
		firstWrite.resolve(receipt(1));
		await yieldMicrotasks();
		expect(saveCalls).toBe(2);
		expect(manager.getIsDirty()).toBe(true);

		secondWrite.resolve(receipt(2));
		expect(await flushed).toEqual(receipt(2));
		expect(manager.getIsDirty()).toBe(false);
		manager.stop();
	});

	test("retains a failed generation and retries it on the next flush", async () => {
		const storageError = new Error("storage transaction aborted");
		let saveCalls = 0;
		const manager = createManager(async () => {
			saveCalls += 1;
			if (saveCalls === 1) throw storageError;
			return receipt(2);
		});

		manager.markDirty();
		await expect(manager.flush()).rejects.toBe(storageError);
		expect(manager.getLastSaveError()).toBe(storageError);
		expect(manager.getIsDirty()).toBe(true);

		expect(await manager.flush()).toEqual(receipt(2));
		expect(saveCalls).toBe(2);
		expect(manager.getLastSaveError()).toBeNull();
		expect(manager.getIsDirty()).toBe(false);
		manager.stop();
	});

	test("handles an autosave rejection without an unhandled promise", async () => {
		const storageError = new Error("autosave transaction aborted");
		const errors: unknown[][] = [];
		let saveCalls = 0;
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		const manager = createManager(async () => {
			saveCalls += 1;
			throw storageError;
		}, 0);

		try {
			manager.markDirty();
			await waitForTimer();

			expect(manager.getLastSaveError()).toBe(storageError);
			expect(manager.getIsDirty()).toBe(true);
			expect(errors).toHaveLength(1);
			expect(saveCalls).toBe(1);
		} finally {
			manager.stop();
			console.error = originalConsoleError;
		}
	});

	test("retries a newer generation after an autosave failure", async () => {
		const firstWrite = deferred<PersistedProjectWrite | null>();
		const storageError = new Error("first autosave failed");
		const originalConsoleError = console.error;
		console.error = () => undefined;
		let saveCalls = 0;
		const manager = createManager(() => {
			saveCalls += 1;
			return saveCalls === 1 ? firstWrite.promise : Promise.resolve(receipt(2));
		}, 0);

		try {
			manager.markDirty();
			await waitUntil(() => saveCalls === 1);
			manager.markDirty();
			firstWrite.reject(storageError);

			await waitUntil(() => saveCalls === 2);
			await waitUntil(() => !manager.getIsDirty());
			expect(manager.getLastSaveError()).toBeNull();
			expect(saveCalls).toBe(2);
		} finally {
			manager.stop();
			console.error = originalConsoleError;
		}
	});
});

function createManager(
	saveCurrentProject: () => Promise<PersistedProjectWrite | null>,
	debounceMs = 60_000,
): SaveManager {
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "project-1" } }),
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject,
		},
		scenes: { subscribe: () => () => undefined },
		timeline: { subscribe: () => () => undefined },
	} as unknown as EditorCore;
	return new SaveManager({ editor, debounceMs });
}

function receipt(sequence: number): PersistedProjectWrite {
	return {
		projectId: "project-1",
		persistedAt: `2026-09-02T12:00:0${sequence}.000Z`,
		snapshotAt: `2026-09-02T12:00:0${sequence}.100Z`,
		completedAt: `2026-09-02T12:00:0${sequence}.200Z`,
		storageSchemaVersion: 1,
		writeVersion: sequence,
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function yieldMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitForTimer(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
