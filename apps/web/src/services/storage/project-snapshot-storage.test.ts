/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProjectSnapshot } from "opencut-wasm";
import { canonicalSerialize } from "@/automation/project-content-hash";

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

		async update({
			key,
			update,
		}: {
			key: string;
			update: (current: T | null) => T | null;
		}): Promise<T | null> {
			const value = update(
				(structuredClone(this.values.get(key)) as T) ?? null,
			);
			if (value === null) this.values.delete(key);
			else this.values.set(key, structuredClone(value));
			return structuredClone(value);
		}

		async getAll(): Promise<T[]> {
			return [...this.values.values()].map(
				(value) => structuredClone(value) as T,
			);
		}

		async remove(key: string): Promise<void> {
			this.values.delete(key);
		}
	},
}));

const { ComparisonSourceUnavailableError, ProjectSnapshotStore } =
	await import("./project-snapshot-storage");

afterEach(() => databases.clear());

describe("content-addressed project snapshots", () => {
	test("retains exact canonical media bytes across store reconstruction", async () => {
		const mediaBytes = new TextEncoder().encode("immutable source media");
		const mediaDigest = await sha256Bytes(mediaBytes);
		const snapshot = projectSnapshotWithMedia(mediaDigest);
		const digest = await sha256(canonicalSerialize(snapshot));
		const file = new File([mediaBytes], "source.mp4", {
			type: "video/mp4",
			lastModified: 1_725_000_000_000,
		});

		await new ProjectSnapshotStore().saveVerified({
			...snapshotLookup(digest),
			snapshot,
			mediaAssets: [persistedMedia({ file, digest: mediaDigest })],
			verification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});

		const retained = await new ProjectSnapshotStore().load(
			snapshotLookup(digest),
		);
		expect(retained.mediaAssets).toHaveLength(1);
		expect(retained.mediaAssets[0]).toMatchObject({
			id: "media-1",
			name: "source.mp4",
			type: "video",
			size: mediaBytes.byteLength,
			sourceIdentity: {
				kind: "local",
				contentHash: { algorithm: "SHA-256", digest: mediaDigest },
			},
		});
		expect(
			new Uint8Array(await retained.mediaAssets[0]!.file.arrayBuffer()),
		).toEqual(mediaBytes);
	});

	test("fails closed before publishing missing or mismatched canonical media", async () => {
		const expectedMediaDigest = await sha256Bytes(
			new TextEncoder().encode("expected source media"),
		);
		const snapshot = projectSnapshotWithMedia(expectedMediaDigest);
		const digest = await sha256(canonicalSerialize(snapshot));
		const store = new ProjectSnapshotStore();
		const verification = {
			writeVersion: 7,
			receiptId: `save:project-1:7:${digest}`,
			operationId: "save-7",
			verifiedAt: "2026-09-03T12:00:00.000Z",
		};

		await expect(
			store.saveVerified({
				...snapshotLookup(digest),
				snapshot,
				mediaAssets: [],
				verification,
			}),
		).rejects.toThrow("required media");
		await expect(store.load(snapshotLookup(digest))).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
		});

		const wrongFile = new File(["different bytes"], "source.mp4", {
			type: "video/mp4",
		});
		await expect(
			store.saveVerified({
				...snapshotLookup(digest),
				snapshot,
				mediaAssets: [
					persistedMedia({ file: wrongFile, digest: expectedMediaDigest }),
				],
				verification,
			}),
		).rejects.toThrow("immutable SHA-256 identity");
		await expect(store.load(snapshotLookup(digest))).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
		});
	});

	test("loads an exact verified canonical snapshot after store reconstruction", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		await new ProjectSnapshotStore().saveVerified({
			contentHash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 2,
				digest,
			},
			projectId: "project-1",
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});

		expect(
			await new ProjectSnapshotStore().load(snapshotLookup(digest)),
		).toEqual({
			contentHash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 2,
				digest,
			},
			projectId: "project-1",
			snapshot,
			mediaAssets: [],
			firstVerifiedAt: "2026-09-03T12:00:00.000Z",
			lastVerifiedAt: "2026-09-03T12:00:00.000Z",
			expiresAt: "2026-12-02T12:00:00.000Z",
			latestVerification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});
	});

	test("keeps render-complete media-free v1 envelopes loadable after the schema upgrade", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		await new ProjectSnapshotStore().saveVerified({
			...snapshotLookup(digest),
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});
		const raw = databases
			.get("opencut-project-snapshots/snapshots")
			?.get(digest);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("expected a retained snapshot envelope");
		}
		Reflect.set(raw, "envelopeVersion", 1);
		Reflect.set(raw, "storageSchemaVersion", 1);
		Reflect.deleteProperty(raw, "mediaAssets");

		expect(
			await new ProjectSnapshotStore().load(snapshotLookup(digest)),
		).toMatchObject({ snapshot, mediaAssets: [] });
	});

	test("fails with COMPARISON_SOURCE_UNAVAILABLE for missing and expired hashes", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		await new ProjectSnapshotStore().saveVerified({
			contentHash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 2,
				digest,
			},
			projectId: "project-1",
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});
		const atExpiry = new ProjectSnapshotStore({
			now: () => new Date("2026-12-02T12:00:00.000Z"),
		});

		for (const digestToLoad of [digest, "f".repeat(64)]) {
			try {
				await atExpiry.load(snapshotLookup(digestToLoad));
				throw new Error("expected snapshot lookup to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(ComparisonSourceUnavailableError);
				expect(error).toMatchObject({
					code: "COMPARISON_SOURCE_UNAVAILABLE",
					contentHash: digestToLoad,
				});
			}
		}
	});

	test("does not return a retained hash for a different project identity", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		const store = new ProjectSnapshotStore();
		await store.saveVerified({
			...snapshotLookup(digest),
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});

		await expect(
			store.load(snapshotLookup(digest, "project-2")),
		).rejects.toMatchObject({ code: "COMPARISON_SOURCE_UNAVAILABLE" });
	});

	test("retains a verified legacy projection under its own canonical hash", async () => {
		const { id: _omittedProjectId, ...legacyProject } =
			projectSnapshot("Legacy").project;
		const snapshot = {
			...projectSnapshot("Legacy"),
			projectionVersion: 1 as const,
			project: legacyProject,
		};
		const digest = await sha256(canonicalSerialize(snapshot));
		const lookup = {
			...snapshotLookup(digest),
			contentHash: {
				...snapshotLookup(digest).contentHash,
				projectionVersion: 1 as const,
			},
		};
		const store = new ProjectSnapshotStore();
		await store.saveVerified({
			...lookup,
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 3,
				receiptId: `save:project-1:3:${digest}`,
				operationId: "legacy-save",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});
		await store.saveVerified({
			...lookup,
			projectId: "project-2",
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 4,
				receiptId: `save:project-2:4:${digest}`,
				operationId: "legacy-save-2",
				verifiedAt: "2026-09-04T12:00:00.000Z",
			},
		});

		expect(await new ProjectSnapshotStore().load(lookup)).toMatchObject({
			contentHash: { digest, projectionVersion: 1 },
			projectId: "project-1",
			snapshot,
		});
		expect(
			await new ProjectSnapshotStore().load({
				...lookup,
				projectId: "project-2",
			}),
		).toMatchObject({
			contentHash: { digest, projectionVersion: 1 },
			projectId: "project-2",
			snapshot,
		});
	});

	test("same-hash verification extends retention without allowing stale writers to shorten it", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		const store = new ProjectSnapshotStore();
		const save = (verifiedAt: string, writeVersion: number) =>
			store.saveVerified({
				contentHash: {
					algorithm: "SHA-256",
					projection: "opencut-project-content",
					projectionVersion: 2,
					digest,
				},
				projectId: "project-1",
				snapshot,
				mediaAssets: [],
				verification: {
					writeVersion,
					receiptId: `save:project-1:${writeVersion}:${digest}`,
					operationId: `save-${writeVersion}`,
					verifiedAt,
				},
			});

		await save("2026-09-03T12:00:00.000Z", 7);
		await save("2026-09-02T12:00:00.000Z", 6);
		expect(await store.load(snapshotLookup(digest))).toMatchObject({
			firstVerifiedAt: "2026-09-03T12:00:00.000Z",
			lastVerifiedAt: "2026-09-03T12:00:00.000Z",
			expiresAt: "2026-12-02T12:00:00.000Z",
			latestVerification: { writeVersion: 7 },
		});

		await save("2026-09-04T12:00:00.000Z", 8);
		expect(await store.load(snapshotLookup(digest))).toMatchObject({
			firstVerifiedAt: "2026-09-03T12:00:00.000Z",
			lastVerifiedAt: "2026-09-04T12:00:00.000Z",
			expiresAt: "2026-12-03T12:00:00.000Z",
			latestVerification: { writeVersion: 8 },
		});
	});

	test("concurrent store instances cannot let a stale verifier shorten retention", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		const save = (
			store: InstanceType<typeof ProjectSnapshotStore>,
			verifiedAt: string,
			writeVersion: number,
		) =>
			store.saveVerified({
				...snapshotLookup(digest),
				snapshot,
				mediaAssets: [],
				verification: {
					writeVersion,
					receiptId: `save:project-1:${writeVersion}:${digest}`,
					operationId: `save-${writeVersion}`,
					verifiedAt,
				},
			});

		await Promise.all([
			save(new ProjectSnapshotStore(), "2026-09-04T12:00:00.000Z", 8),
			save(new ProjectSnapshotStore(), "2026-09-03T12:00:00.000Z", 7),
		]);

		expect(
			await new ProjectSnapshotStore().load(snapshotLookup(digest)),
		).toMatchObject({
			lastVerifiedAt: "2026-09-04T12:00:00.000Z",
			expiresAt: "2026-12-03T12:00:00.000Z",
			latestVerification: { writeVersion: 8 },
		});
	});

	test("fails closed when retained canonical state is tampered under its hash key", async () => {
		const snapshot = projectSnapshot();
		const digest = await sha256(canonicalSerialize(snapshot));
		await new ProjectSnapshotStore().saveVerified({
			contentHash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 2,
				digest,
			},
			projectId: "project-1",
			snapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 7,
				receiptId: `save:project-1:7:${digest}`,
				operationId: "save-7",
				verifiedAt: "2026-09-03T12:00:00.000Z",
			},
		});
		const raw = databases
			.get("opencut-project-snapshots/snapshots")
			?.get(digest) as { snapshot: ProjectSnapshot };
		raw.snapshot.project.name = "Tampered";

		try {
			await new ProjectSnapshotStore().load(snapshotLookup(digest));
			throw new Error("expected tampered snapshot to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ComparisonSourceUnavailableError);
			expect(error).toMatchObject({
				code: "COMPARISON_SOURCE_UNAVAILABLE",
				reason: "corrupt",
			});
		}
	});

	test("cleanup removes only snapshots whose 90-day retention has elapsed", async () => {
		const oldSnapshot = projectSnapshot("Old");
		const freshSnapshot = projectSnapshot("Fresh");
		const oldHash = await sha256(canonicalSerialize(oldSnapshot));
		const freshHash = await sha256(canonicalSerialize(freshSnapshot));
		const store = new ProjectSnapshotStore({
			now: () => new Date("2026-09-01T00:00:00.000Z"),
		});
		for (const [snapshot, digest, verifiedAt, writeVersion] of [
			[oldSnapshot, oldHash, "2026-06-01T00:00:00.000Z", 1],
			[freshSnapshot, freshHash, "2026-07-01T00:00:00.000Z", 2],
		] as const) {
			await store.saveVerified({
				contentHash: {
					algorithm: "SHA-256",
					projection: "opencut-project-content",
					projectionVersion: 2,
					digest,
				},
				projectId: "project-1",
				snapshot,
				mediaAssets: [],
				verification: {
					writeVersion,
					receiptId: `save:project-1:${writeVersion}:${digest}`,
					operationId: `save-${writeVersion}`,
					verifiedAt,
				},
			});
		}

		expect(await store.cleanupExpired()).toEqual({ removed: 1, retained: 1 });
		await expect(store.load(snapshotLookup(oldHash))).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
		});
		expect(await store.load(snapshotLookup(freshHash))).toMatchObject({
			projectId: "project-1",
			snapshot: freshSnapshot,
		});
	});

	test("a new save opportunistically cleans expired snapshots", async () => {
		const oldSnapshot = projectSnapshot("Old");
		const oldHash = await sha256(canonicalSerialize(oldSnapshot));
		await new ProjectSnapshotStore({
			now: () => new Date("2026-06-01T00:00:00.000Z"),
		}).saveVerified({
			...snapshotLookup(oldHash),
			snapshot: oldSnapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 1,
				receiptId: `save:project-1:1:${oldHash}`,
				operationId: "save-old",
				verifiedAt: "2026-06-01T00:00:00.000Z",
			},
		});

		const freshSnapshot = projectSnapshot("Fresh");
		const freshHash = await sha256(canonicalSerialize(freshSnapshot));
		await new ProjectSnapshotStore({
			now: () => new Date("2026-09-01T00:00:00.001Z"),
		}).saveVerified({
			...snapshotLookup(freshHash),
			snapshot: freshSnapshot,
			mediaAssets: [],
			verification: {
				writeVersion: 2,
				receiptId: `save:project-1:2:${freshHash}`,
				operationId: "save-fresh",
				verifiedAt: "2026-09-01T00:00:00.001Z",
			},
		});

		expect(
			databases.get("opencut-project-snapshots/snapshots")?.has(oldHash),
		).toBe(false);
		expect(
			databases.get("opencut-project-snapshots/snapshots")?.has(freshHash),
		).toBe(true);
	});
});

function projectSnapshot(name = "Retained"): ProjectSnapshot {
	return {
		projection: "opencut-project-content",
		projectionVersion: 2,
		project: {
			id: "project-1",
			name,
			activeSceneId: "scene-1",
			mainSceneId: null,
			settings: {},
			scenes: [],
		},
		mediaAssets: [],
	};
}

function projectSnapshotWithMedia(mediaDigest: string): ProjectSnapshot {
	return {
		...projectSnapshot(),
		mediaAssets: [
			{
				id: "media-1",
				name: "source.mp4",
				type: "video",
				size: 22,
				width: 1920,
				height: 1080,
				duration: 9_000,
				fps: 30,
				hasAudio: true,
				sourceFingerprint: "source-fingerprint",
				source: {
					kind: "local",
					contentHash: { algorithm: "SHA-256", digest: mediaDigest },
				},
				role: "timeline",
			},
		],
	};
}

function persistedMedia({ file, digest }: { file: File; digest: string }) {
	return {
		id: "media-1",
		name: "source.mp4",
		type: "video" as const,
		size: file.size,
		lastModified: file.lastModified,
		width: 1920,
		height: 1080,
		duration: 9_000,
		fps: 30,
		hasAudio: true,
		sourceFingerprint: "source-fingerprint",
		role: "timeline" as const,
		sourceIdentity: {
			kind: "local" as const,
			contentHash: { algorithm: "SHA-256" as const, digest },
		},
		file,
	};
}

function snapshotLookup(digest: string, projectId = "project-1") {
	return {
		contentHash: {
			algorithm: "SHA-256" as const,
			projection: "opencut-project-content" as const,
			projectionVersion: 2 as const,
			digest,
		},
		projectId,
	};
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

async function sha256Bytes(value: Uint8Array): Promise<string> {
	const bytes = Uint8Array.from(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
