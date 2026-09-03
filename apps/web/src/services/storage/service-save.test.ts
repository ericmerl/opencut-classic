/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline";

const databases = new Map<string, Map<string, unknown>>();
const fileDirectories = new Map<string, Map<string, File>>();
let nextProjectSetFailure: Error | null = null;
let mediaMetadataSetCalls = 0;

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	TICKS_PER_SECOND: 120000,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundMediaTime: ({ time }: { time: number }) => time,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
}));
mock.module("@/services/storage/migrations", () => ({
	migrations: [],
	runStorageMigrations: async () => ({ migratedCount: 0 }),
}));
mock.module("./indexeddb-adapter", () => ({
	IndexedDBAdapter: class<T> {
		private values: Map<string, unknown>;
		private dbName: string;
		constructor(options: { dbName: string; storeName: string }) {
			this.dbName = options.dbName;
			const key = `${options.dbName}/${options.storeName}`;
			this.values = databases.get(key) ?? new Map();
			databases.set(key, this.values);
		}
		async get(key: string): Promise<T | null> {
			return (structuredClone(this.values.get(key)) as T) ?? null;
		}
		async set({ key, value }: { key: string; value: T }): Promise<void> {
			if (this.dbName === "video-editor-projects" && nextProjectSetFailure) {
				const failure = nextProjectSetFailure;
				nextProjectSetFailure = null;
				throw failure;
			}
			if (this.dbName.startsWith("video-editor-media-")) {
				mediaMetadataSetCalls += 1;
			}
			this.values.set(key, structuredClone(value));
		}
		async list(): Promise<string[]> {
			return [...this.values.keys()];
		}
		async getAll(): Promise<T[]> {
			return [...this.values.values()].map(
				(value) => structuredClone(value) as T,
			);
		}
		async remove(key: string): Promise<void> {
			this.values.delete(key);
		}
		async clear(): Promise<void> {
			this.values.clear();
		}
	},
	deleteDatabase: async () => undefined,
}));
mock.module("./opfs-adapter", () => ({
	OPFSAdapter: class {
		private files: Map<string, File>;
		constructor(directoryName: string) {
			this.files = fileDirectories.get(directoryName) ?? new Map();
			fileDirectories.set(directoryName, this.files);
		}
		static isSupported(): boolean {
			return true;
		}
		async get(key: string): Promise<File | null> {
			return this.files.get(key) ?? null;
		}
		async set({ key, value }: { key: string; value: File }): Promise<void> {
			this.files.set(key, value);
		}
		async remove(key: string): Promise<void> {
			this.files.delete(key);
		}
		async list(): Promise<string[]> {
			return [...this.files.keys()];
		}
		async clear(): Promise<void> {
			this.files.clear();
		}
	},
}));

const { StorageService } = await import("./service");
const { SaveReceiptStorageError } = await import("./save-receipt-storage");

afterEach(() => {
	databases.clear();
	fileDirectories.clear();
	nextProjectSetFailure = null;
	mediaMetadataSetCalls = 0;
});

describe("StorageService save envelope", () => {
	test("embeds the save receipt identity in the project commit", async () => {
		const service = new StorageService();
		const contentHash = "a".repeat(64);
		const write = await service.saveProject({
			project: buildProject("Receipt-bound"),
			saveReceiptBinding: {
				operationId: "save-bound",
				fingerprint: "b".repeat(64),
				contentHash,
				contentHashProjectionVersion: 2,
				sceneId: "scene-1",
				revision: 4,
			},
		});

		expect(write.saveReceiptIdentity).toEqual({
			version: 2,
			operationId: "save-bound",
			fingerprint: "b".repeat(64),
			contentHash,
			contentHashProjectionVersion: 2,
			sceneId: "scene-1",
			revision: 4,
			receiptId: `save:project-1:1:${contentHash}`,
		});
		const readback = await new StorageService().loadProjectFresh({
			id: "project-1",
		});
		expect(readback?.persistence).toEqual(write);

		const rebound = await new StorageService().bindProjectSaveReceiptIdentity({
			projectId: "project-1",
			expectedWriteVersion: 1,
			binding: {
				operationId: "save-clean",
				fingerprint: "c".repeat(64),
				contentHash,
				contentHashProjectionVersion: 2,
				sceneId: "scene-1",
				revision: 4,
			},
		});
		expect(rebound).toMatchObject({
			operationId: "save-clean",
			receiptId: `save:project-1:1:${contentHash}`,
		});
		expect(
			(await new StorageService().loadProjectFresh({ id: "project-1" }))
				?.persistence,
		).toMatchObject({ writeVersion: 1, saveReceiptIdentity: rebound });
		expect(
			await new StorageService().bindProjectSaveReceiptIdentity({
				projectId: "project-1",
				expectedWriteVersion: 1,
				binding: {
					operationId: "save-clean",
					fingerprint: "d".repeat(64),
					contentHash,
					contentHashProjectionVersion: 2,
					sceneId: "scene-1",
					revision: 4,
				},
			}),
		).toBeNull();
	});

	test("persists monotonic writes and verifies them through a fresh service", async () => {
		const service = new StorageService();
		const first = await service.saveProject({ project: buildProject("First") });
		const second = await service.saveProject({
			project: buildProject("Second"),
		});

		expect(first.writeVersion).toBe(1);
		expect(second.writeVersion).toBe(2);
		expect(Date.parse(second.completedAt)).toBeGreaterThanOrEqual(
			Date.parse(second.snapshotAt),
		);
		const restarted = new StorageService();
		const readback = await restarted.loadProjectFresh({ id: "project-1" });
		expect(readback?.project.metadata.name).toBe("Second");
		expect(readback?.persistence).toEqual(second);
		expect(readback?.mediaAssets).toEqual([]);
	});

	test("rehydrates and verifies persisted media bytes without a blob URL", async () => {
		const service = new StorageService();
		const project = buildProject("Media");
		await service.saveProject({ project });
		const file = new File(["media bytes"], "clip.mp4", {
			type: "video/mp4",
			lastModified: 42,
		});
		await service.saveMediaAsset({
			projectId: "project-1",
			mediaAsset: {
				id: "media-1",
				name: "clip.mp4",
				type: "video",
				file,
				url: "blob:live-editor-only",
			},
		});

		const readback = await new StorageService().loadProjectFresh({
			id: "project-1",
		});
		expect(readback?.mediaAssets[0]?.file).toBe(file);
		expect(readback?.mediaAssets[0]?.sourceIdentity).toMatchObject({
			kind: "local",
			contentHash: { algorithm: "SHA-256" },
		});
		expect("url" in (readback?.mediaAssets[0] ?? {})).toBe(false);
	});

	test("fresh read-only project loading never persists media identity backfill", async () => {
		const service = new StorageService();
		await service.saveProject({ project: buildProject("Read only") });
		await service.saveMediaAsset({
			projectId: "project-1",
			mediaAsset: {
				id: "media-1",
				name: "clip.mp4",
				type: "video",
				file: new File(["media bytes"], "clip.mp4", {
					type: "video/mp4",
				}),
				url: "blob:ephemeral",
			},
		});
		const metadata = databases
			.get("video-editor-media-project-1/media-metadata")
			?.get("media-1");
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
			throw new Error("media metadata fixture is missing");
		}
		Reflect.deleteProperty(metadata, "sourceIdentity");
		mediaMetadataSetCalls = 0;

		const readback = await new StorageService().loadProjectFreshReadOnly({
			id: "project-1",
		});

		expect(readback?.mediaAssets[0]?.sourceIdentity).toMatchObject({
			kind: "local",
			contentHash: { algorithm: "SHA-256" },
		});
		expect(mediaMetadataSetCalls).toBe(0);
		expect(Reflect.get(metadata, "sourceIdentity")).toBeUndefined();

		await new StorageService().loadProjectFresh({ id: "project-1" });
		expect(mediaMetadataSetCalls).toBe(1);
		expect(Reflect.get(metadata, "sourceIdentity")).toBeUndefined();
		expect(
			databases
				.get("video-editor-media-project-1/media-metadata")
				?.get("media-1"),
		).toHaveProperty("sourceIdentity");
	});

	test("retains the prior complete snapshot when a replacement commit fails", async () => {
		const service = new StorageService();
		const first = await service.saveProject({ project: buildProject("First") });
		nextProjectSetFailure = new Error("injected transaction abort");

		await expect(
			service.saveProject({ project: buildProject("Uncommitted") }),
		).rejects.toThrow("injected transaction abort");

		const raw = databases
			.get("video-editor-projects/projects")
			?.get("project-1") as Record<string, unknown>;
		expect(raw).toMatchObject({
			writeVersion: first.writeVersion,
			completedAt: first.completedAt,
		});
		const restarted = await new StorageService().loadProjectFresh({
			id: "project-1",
		});
		expect(restarted?.project.metadata.name).toBe("First");
		expect(restarted?.persistence).toEqual(first);
	});

	test("versions and validates save receipts across service restart", async () => {
		const receipt = buildReceipt();
		await new StorageService().saveSaveReceipt(receipt);

		const loaded = await new StorageService().loadSaveReceipt({
			operationId: receipt.operationId,
			parseResult: parseReceiptResult,
		});
		expect(loaded).toEqual({
			...receipt,
			id: receipt.operationId,
			envelopeVersion: 1,
			storageSchemaVersion: 1,
		});
	});

	test("rejects old, unsupported, and truncated save receipt records", async () => {
		const values = getSaveReceiptValues();
		values.set("old", {
			operationId: "old",
			fingerprint: "fingerprint",
			result: { operationId: "old" },
			recordedAt: "2026-09-02T12:00:00.000Z",
		});
		values.set("future", {
			...buildReceipt("future"),
			envelopeVersion: 2,
			storageSchemaVersion: 1,
		});
		values.set("truncated", {
			envelopeVersion: 1,
			storageSchemaVersion: 1,
			operationId: "truncated",
			recordedAt: "2026-09-02T12:00:00.000Z",
		});

		for (const operationId of ["old", "future"]) {
			await expect(
				new StorageService().loadSaveReceipt({
					operationId,
					parseResult: parseReceiptResult,
				}),
			).rejects.toMatchObject({
				name: SaveReceiptStorageError.name,
				code: "unsupported-save-receipt-version",
			});
		}
		await expect(
			new StorageService().loadSaveReceipt({
				operationId: "truncated",
				parseResult: parseReceiptResult,
			}),
		).rejects.toMatchObject({
			name: SaveReceiptStorageError.name,
			code: "corrupt-save-receipt",
		});
	});
});

function getSaveReceiptValues(): Map<string, unknown> {
	const key = "opencut-save-receipts/receipts";
	const values = databases.get(key) ?? new Map<string, unknown>();
	databases.set(key, values);
	return values;
}

function buildReceipt(operationId = "save-1") {
	return {
		operationId,
		fingerprint: "fingerprint",
		result: { operationId },
		recordedAt: "2026-09-02T12:00:00.000Z",
	};
}

function parseReceiptResult(value: unknown): { operationId: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid result");
	}
	const operationId = (value as Record<string, unknown>).operationId;
	if (typeof operationId !== "string") throw new Error("invalid result");
	return { operationId };
}

function buildProject(name: string): TProject {
	const scene = {
		id: "scene-1",
		name: "Main",
		isMain: true,
		tracks: {
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [],
			audio: [],
		},
		bookmarks: [],
		createdAt: new Date("2026-09-02T00:00:00.000Z"),
		updatedAt: new Date("2026-09-02T00:00:00.000Z"),
	} as TScene;
	return {
		metadata: {
			id: "project-1",
			name,
			duration: 0 as TProject["metadata"]["duration"],
			createdAt: scene.createdAt,
			updatedAt: scene.updatedAt,
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}
