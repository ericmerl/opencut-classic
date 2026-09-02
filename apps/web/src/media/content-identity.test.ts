import { describe, expect, test } from "bun:test";
import {
	hashMediaBytes,
	isValidMediaContentHash,
	MediaContentIntegrityError,
	MEDIA_CONTENT_HASH_ALGORITHM,
	resolvePersistedMediaIdentity,
} from "./content-identity";
import { DEFAULT_SHA256_CHUNK_BYTES } from "./incremental-sha256";

describe("media content identity", () => {
	test("hashes exact bytes with browser-compatible SHA-256", async () => {
		const result = await hashMediaBytes(new TextEncoder().encode("abc"));
		expect(result).toEqual({
			algorithm: MEDIA_CONTENT_HASH_ALGORITHM,
			digest:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		});
	});

	test("matches the empty SHA-256 vector", async () => {
		expect((await hashMediaBytes(new Blob())).digest).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	test("matches Web Crypto across SHA-256 block and read boundaries", async () => {
		for (const size of [55, 56, 63, 64, 65, 127, 128, 129]) {
			const bytes = Uint8Array.from(
				{ length: size },
				(_, index) => index % 251,
			);
			const expected = await webCryptoDigest(bytes);
			for (const chunkBytes of [1, 63, 64, 65]) {
				expect(
					(await hashMediaBytes(new Blob([bytes]), { chunkBytes })).digest,
				).toBe(expected);
			}
		}
	});

	test("matches Web Crypto for deterministic randomized bytes", async () => {
		let state = 0x12345678;
		const bytes = Uint8Array.from({ length: 257_123 }, () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state & 0xff;
		});
		expect(
			(await hashMediaBytes(new Blob([bytes]), { chunkBytes: 8191 })).digest,
		).toBe(await webCryptoDigest(bytes));
	});

	test("distinguishes byte changes and is deterministic", async () => {
		const first = await hashMediaBytes(new Uint8Array([0, 1, 2, 3]));
		const repeated = await hashMediaBytes(new Uint8Array([0, 1, 2, 3]));
		const changed = await hashMediaBytes(new Uint8Array([0, 1, 2, 4]));
		expect(repeated).toEqual(first);
		expect(changed.digest).not.toBe(first.digest);
	});

	test("validates only normalized SHA-256 identities", () => {
		expect(
			isValidMediaContentHash({ algorithm: "SHA-256", digest: "a".repeat(64) }),
		).toBe(true);
		expect(
			isValidMediaContentHash({ algorithm: "sha256", digest: "a".repeat(64) }),
		).toBe(false);
		expect(
			isValidMediaContentHash({ algorithm: "SHA-256", digest: "A".repeat(64) }),
		).toBe(false);
		expect(
			isValidMediaContentHash({ algorithm: "SHA-256", digest: "a".repeat(63) }),
		).toBe(false);
	});

	test("truthfully backfills legacy identity from persisted bytes", async () => {
		const bytes = new Blob([new Uint8Array([9, 8, 7, 6])]);
		const backfilled = await resolvePersistedMediaIdentity({
			file: bytes,
			storedIdentity: undefined,
		});
		expect(backfilled.backfilled).toBe(true);
		expect(backfilled.identity.contentHash).toEqual(
			await hashMediaBytes(new Uint8Array([9, 8, 7, 6])),
		);

		const restored = await resolvePersistedMediaIdentity({
			file: bytes,
			storedIdentity: backfilled.identity,
		});
		expect(restored).toEqual({
			identity: backfilled.identity,
			backfilled: false,
		});
	});

	test("preserves complete provider provenance across verified reload", async () => {
		const file = new Blob(["provider bytes"]);
		const contentHash = await hashMediaBytes(file);
		const identity = {
			kind: "provider" as const,
			provider: "sound-library",
			providerVersion: "catalog-2026-09-01",
			sourceUrl: "https://media.example/immutable/clip",
			contentHash,
		};
		expect(
			await resolvePersistedMediaIdentity({ file, storedIdentity: identity }),
		).toEqual({ identity, backfilled: false });
	});

	test("fails explicitly when persisted bytes no longer match", async () => {
		const expected = await hashMediaBytes(new Blob(["original"]));
		await expect(
			resolvePersistedMediaIdentity({
				file: new Blob(["corrupt"]),
				storedIdentity: { kind: "local", contentHash: expected },
			}),
		).rejects.toBeInstanceOf(MediaContentIntegrityError);
	});

	test("rejects malformed provider identity instead of relabeling it local", async () => {
		await expect(
			resolvePersistedMediaIdentity({
				file: new Blob(["bytes"]),
				storedIdentity: {
					kind: "provider",
					provider: "",
					providerVersion: "v1",
					sourceUrl: "https://media.example/clip",
					contentHash: {
						algorithm: "SHA-256",
						digest: "a".repeat(64),
					},
				},
			}),
		).rejects.toThrow("provider media identity");
	});

	test("reads a multi-gigabyte virtual Blob with bounded allocations", async () => {
		const controller = new AbortController();
		const requestedSizes: number[] = [];
		const virtualBlob = new VirtualBlob(3 * 1024 * 1024 * 1024, requestedSizes);
		let progressCalls = 0;
		await expect(
			hashMediaBytes(virtualBlob, {
				chunkBytes: DEFAULT_SHA256_CHUNK_BYTES,
				signal: controller.signal,
				onProgress: (processed) => {
					progressCalls++;
					if (processed >= DEFAULT_SHA256_CHUNK_BYTES * 3) controller.abort();
				},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(virtualBlob.size).toBeGreaterThan(2 ** 31);
		expect(Math.max(...requestedSizes)).toBe(DEFAULT_SHA256_CHUNK_BYTES);
		expect(requestedSizes).toHaveLength(3);
		expect(progressCalls).toBe(4);
	});
});

async function webCryptoDigest(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

class VirtualBlob extends Blob {
	constructor(
		private readonly virtualSize: number,
		private readonly requestedSizes: number[],
	) {
		super();
	}

	override get size(): number {
		return this.virtualSize;
	}

	override slice(start = 0, end = this.size): Blob {
		const length = Math.max(0, Math.min(end, this.size) - start);
		this.requestedSizes.push(length);
		return new Blob([new Uint8Array(length)]);
	}
}
