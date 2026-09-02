import {
	hashBlobIncrementally,
	IncrementalSha256,
	type IncrementalHashOptions,
} from "./incremental-sha256";

export const MEDIA_CONTENT_HASH_ALGORITHM = "SHA-256" as const;

export interface MediaContentHash {
	algorithm: typeof MEDIA_CONTENT_HASH_ALGORITHM;
	digest: string;
}

export interface MediaProviderIdentity {
	kind: "provider";
	provider: string;
	providerVersion: string;
	sourceUrl: string;
	contentHash: MediaContentHash;
}

export interface LocalMediaIdentity {
	kind: "local";
	contentHash?: MediaContentHash;
}

export type MediaSourceIdentity = LocalMediaIdentity | MediaProviderIdentity;

export class MediaContentIntegrityError extends Error {
	readonly code = "MEDIA_CONTENT_INTEGRITY_MISMATCH";

	constructor(
		readonly expected: MediaContentHash,
		readonly actual: MediaContentHash,
	) {
		super(
			"Persisted media bytes do not match their immutable SHA-256 identity",
		);
		this.name = "MediaContentIntegrityError";
	}
}

export async function hashMediaBytes(
	input: Blob | ArrayBuffer | ArrayBufferView,
	options: IncrementalHashOptions = {},
): Promise<MediaContentHash> {
	if (options.signal?.aborted) {
		throw new DOMException(
			options.signal.reason?.toString() ?? "Hashing aborted",
			"AbortError",
		);
	}
	const isBlob = input instanceof Blob;
	const source = ArrayBuffer.isView(input)
		? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
		: input instanceof ArrayBuffer
			? new Uint8Array(input)
			: null;
	const digest = isBlob
		? await hashBlobIncrementally(input, options)
		: new IncrementalSha256().update(source!).digestHex();
	if (source) {
		options.onProgress?.(0, source.byteLength);
		options.onProgress?.(source.byteLength, source.byteLength);
	}
	return {
		algorithm: MEDIA_CONTENT_HASH_ALGORITHM,
		digest,
	};
}

export async function resolvePersistedMediaIdentity({
	file,
	storedIdentity,
}: {
	file: Blob;
	storedIdentity: MediaSourceIdentity | undefined;
}): Promise<{
	identity: MediaSourceIdentity;
	backfilled: boolean;
}> {
	if (storedIdentity?.kind === "provider") {
		assertProviderIdentity(storedIdentity);
		await assertBytesMatch({ file, expected: storedIdentity.contentHash });
		return { identity: storedIdentity, backfilled: false };
	}
	if (storedIdentity?.kind === "local" && storedIdentity.contentHash) {
		if (!isValidMediaContentHash(storedIdentity.contentHash)) {
			throw new Error("Persisted local media content identity is malformed");
		}
		await assertBytesMatch({ file, expected: storedIdentity.contentHash });
		return { identity: storedIdentity, backfilled: false };
	}
	return {
		identity: { kind: "local", contentHash: await hashMediaBytes(file) },
		backfilled: true,
	};
}

export function assertProviderIdentity(identity: MediaProviderIdentity): void {
	if (
		!identity.provider.trim() ||
		!identity.providerVersion.trim() ||
		!identity.sourceUrl.trim() ||
		!isValidMediaContentHash(identity.contentHash)
	) {
		throw new Error(
			"Persisted provider media identity is incomplete or malformed",
		);
	}
}

async function assertBytesMatch({
	file,
	expected,
}: {
	file: Blob;
	expected: MediaContentHash;
}): Promise<void> {
	const actual = await hashMediaBytes(file);
	if (actual.digest !== expected.digest) {
		throw new MediaContentIntegrityError(expected, actual);
	}
}

export function isValidMediaContentHash(
	value: unknown,
): value is MediaContentHash {
	if (!isRecord(value)) return false;
	return (
		value.algorithm === MEDIA_CONTENT_HASH_ALGORITHM &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
