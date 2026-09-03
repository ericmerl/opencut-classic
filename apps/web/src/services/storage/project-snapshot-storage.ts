import type { ProjectSnapshot, SnapshotRetentionState } from "opencut-wasm";
import { resolvePersistedMediaIdentity } from "@/media/content-identity";
import {
	canonicalSerialize,
	type ProjectContentHash,
} from "@/automation/project-content-hash";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import type { PersistedMediaReadback } from "./types";

export const PROJECT_SNAPSHOT_ENVELOPE_VERSION = 2 as const;
export const PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION = 2 as const;

const PROJECT_SNAPSHOT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_PROJECT_SNAPSHOT_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_RETAINED_PROJECT_MEDIA_BYTES = 512 * 1024 * 1024;
const LEGACY_PROJECT_SNAPSHOT_ENVELOPE_VERSION = 1 as const;
const LEGACY_PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION = 1 as const;

export interface ProjectSnapshotVerification {
	writeVersion: number;
	receiptId: string;
	operationId: string;
	verifiedAt: string;
}

export interface RetainVerifiedProjectSnapshotInput {
	contentHash: ProjectContentHash;
	projectId: string;
	snapshot: ProjectSnapshot;
	mediaAssets: readonly PersistedMediaReadback[];
	verification: ProjectSnapshotVerification;
}

export interface LoadProjectSnapshotInput {
	contentHash: ProjectContentHash;
	projectId: string;
}

export interface RetainedProjectSnapshot {
	contentHash: ProjectContentHash;
	projectId: string;
	snapshot: ProjectSnapshot;
	mediaAssets: PersistedMediaReadback[];
	firstVerifiedAt: string;
	lastVerifiedAt: string;
	expiresAt: string;
	latestVerification: ProjectSnapshotVerification;
}

export class ComparisonSourceUnavailableError extends Error {
	readonly code = "COMPARISON_SOURCE_UNAVAILABLE" as const;

	constructor({
		contentHash,
		reason,
	}: {
		contentHash: string;
		reason: "missing" | "expired" | "identity-mismatch" | "corrupt";
	}) {
		super(`retained project snapshot ${contentHash} is unavailable`);
		this.contentHash = contentHash;
		this.reason = reason;
		this.name = "ComparisonSourceUnavailableError";
	}

	readonly contentHash: string;
	readonly reason: "missing" | "expired" | "identity-mismatch" | "corrupt";
}

export type ProjectSnapshotStorageErrorCode =
	| "unsupported-project-snapshot-version"
	| "corrupt-project-snapshot";

export class ProjectSnapshotStorageError extends Error {
	constructor({
		code,
		message,
	}: {
		code: ProjectSnapshotStorageErrorCode;
		message: string;
	}) {
		super(message);
		this.code = code;
		this.name = "ProjectSnapshotStorageError";
	}

	readonly code: ProjectSnapshotStorageErrorCode;
}

interface PersistedProjectSnapshotEnvelope extends Omit<
	RetainedProjectSnapshot,
	"mediaAssets" | "projectId"
> {
	id: string;
	canonicalJson: string;
	mediaAssets: PersistedSnapshotMediaAsset[];
	projectIds: string[];
	envelopeVersion: typeof PROJECT_SNAPSHOT_ENVELOPE_VERSION;
	storageSchemaVersion: typeof PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION;
}

interface PersistedSnapshotMediaAsset extends Omit<
	PersistedMediaReadback,
	"file"
> {
	bytes: ArrayBuffer;
	fileName: string;
	fileType: string;
}

type SnapshotRetentionEvaluator =
	(typeof import("opencut-wasm"))["evaluateProjectSnapshotRetention"];

export class ProjectSnapshotStore {
	private readonly now: () => Date;
	private lastCleanupAt: number | null = null;
	private readonly adapter = new IndexedDBAdapter<unknown>({
		dbName: "opencut-project-snapshots",
		storeName: "snapshots",
		version: 1,
	});

	constructor({ now = () => new Date() }: { now?: () => Date } = {}) {
		this.now = now;
	}

	async saveVerified({
		contentHash,
		projectId,
		snapshot,
		mediaAssets,
		verification,
	}: RetainVerifiedProjectSnapshotInput): Promise<RetainedProjectSnapshot> {
		validateContentHash(contentHash);
		validateVerification(verification);
		if (!projectId || !snapshotMatchesProject({ snapshot, projectId })) {
			throw new Error("project snapshot project identity is invalid");
		}
		const canonicalJson = canonicalSerialize(snapshot);
		const actualDigest = await sha256(canonicalJson);
		if (actualDigest !== contentHash.digest) {
			throw new Error(
				"project snapshot canonical bytes do not match the content hash",
			);
		}
		await this.maybeCleanupExpired();
		const verifiedMediaAssets = await prepareRetainedMedia({
			snapshot,
			mediaAssets,
		});
		await this.assertRetainedMediaCapacity({
			contentHash: contentHash.digest,
			mediaBytes: persistedMediaBytes(verifiedMediaAssets),
		});
		const evaluateRetention = await loadSnapshotRetentionEvaluator();

		const stored = await this.adapter.update({
			key: contentHash.digest,
			update: (priorValue) => {
				const prior =
					priorValue === null
						? null
						: parseEnvelopeStructure({
								value: priorValue,
								contentHash: contentHash.digest,
								evaluateRetention,
							});
				if (prior && prior.canonicalJson !== canonicalJson) {
					throw new Error(
						"project snapshot hash is already bound to different canonical bytes",
					);
				}
				const evaluation = evaluateRetention({
					prior: prior ? toNativeRetentionState(prior) : undefined,
					verification: toNativeVerification(verification),
				});
				if (evaluation.status === "rejected") {
					throw new Error(evaluation.reason);
				}
				const state = evaluation.state;
				return {
					id: contentHash.digest,
					canonicalJson,
					envelopeVersion: PROJECT_SNAPSHOT_ENVELOPE_VERSION,
					storageSchemaVersion: PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION,
					contentHash,
					mediaAssets: verifiedMediaAssets,
					projectIds:
						contentHash.projectionVersion === 1
							? [...new Set([...(prior?.projectIds ?? []), projectId])].sort()
							: [projectId],
					snapshot,
					firstVerifiedAt: toIso(state.firstVerifiedAtMs),
					lastVerifiedAt: toIso(state.lastVerifiedAtMs),
					expiresAt: toIso(state.expiresAtMs),
					latestVerification: fromNativeVerification(state.latestVerification),
				} satisfies PersistedProjectSnapshotEnvelope;
			},
		});
		if (stored === null) throw new Error("project snapshot update was deleted");
		return withoutEnvelope({
			value: parseEnvelopeStructure({
				value: stored,
				contentHash: contentHash.digest,
				evaluateRetention,
			}),
			projectId,
		});
	}

	async load({
		contentHash,
		projectId,
	}: LoadProjectSnapshotInput): Promise<RetainedProjectSnapshot> {
		validateContentHash(contentHash);
		if (!projectId) throw new Error("project snapshot projectId is required");
		const now = this.now().getTime();
		let unavailableReason: "missing" | "expired" = "missing";
		const value = await this.adapter.update({
			key: contentHash.digest,
			update: (current) => {
				if (current !== null && isExpiredValue({ value: current, now })) {
					unavailableReason = "expired";
					return null;
				}
				return current;
			},
		});
		if (value === null) {
			throw new ComparisonSourceUnavailableError({
				contentHash: contentHash.digest,
				reason: unavailableReason,
			});
		}
		let envelope: PersistedProjectSnapshotEnvelope;
		try {
			envelope = await parseEnvelope({
				value,
				contentHash: contentHash.digest,
			});
		} catch {
			throw new ComparisonSourceUnavailableError({
				contentHash: contentHash.digest,
				reason: "corrupt",
			});
		}
		if (
			!envelope.projectIds.includes(projectId) ||
			envelope.contentHash.algorithm !== contentHash.algorithm ||
			envelope.contentHash.projection !== contentHash.projection ||
			envelope.contentHash.projectionVersion !== contentHash.projectionVersion
		) {
			throw new ComparisonSourceUnavailableError({
				contentHash: contentHash.digest,
				reason: "identity-mismatch",
			});
		}
		return withoutEnvelope({ value: envelope, projectId });
	}

	async cleanupExpired(): Promise<{ removed: number; retained: number }> {
		const values = await this.adapter.getAll();
		const now = this.now().getTime();
		let removed = 0;
		let retained = 0;
		for (const value of values) {
			if (!isRecord(value) || typeof value.id !== "string") continue;
			let removedCurrent = false;
			await this.adapter.update({
				key: value.id,
				update: (current) => {
					if (current !== null && isExpiredValue({ value: current, now })) {
						removedCurrent = true;
						return null;
					}
					return current;
				},
			});
			if (removedCurrent) removed += 1;
			else retained += 1;
		}
		return { removed, retained };
	}

	private async maybeCleanupExpired(): Promise<void> {
		const now = this.now().getTime();
		if (
			this.lastCleanupAt !== null &&
			now - this.lastCleanupAt < PROJECT_SNAPSHOT_CLEANUP_INTERVAL_MS
		) {
			return;
		}
		await this.cleanupExpired();
		this.lastCleanupAt = now;
	}

	private async assertRetainedMediaCapacity({
		contentHash,
		mediaBytes,
	}: {
		contentHash: string;
		mediaBytes: number;
	}): Promise<void> {
		let retainedBytes = 0;
		for (const value of await this.adapter.getAll()) {
			if (!isRecord(value) || value.id === contentHash) continue;
			const bytes = persistedEnvelopeMediaBytes(value);
			if (bytes === null) {
				throw new Error("retained project snapshot quota metadata is corrupt");
			}
			retainedBytes += bytes;
		}
		if (retainedBytes + mediaBytes > MAX_RETAINED_PROJECT_MEDIA_BYTES) {
			throw new Error("retained project snapshot media quota exceeded");
		}
	}

	async clear(): Promise<void> {
		await this.adapter.clear();
	}
}

async function parseEnvelope({
	value,
	contentHash,
}: {
	value: unknown;
	contentHash: string;
}): Promise<PersistedProjectSnapshotEnvelope> {
	const envelope = parseEnvelopeStructure({
		value,
		contentHash,
		evaluateRetention: await loadSnapshotRetentionEvaluator(),
	});
	let actualDigest: string;
	try {
		actualDigest = await sha256(envelope.canonicalJson);
	} catch {
		throw corrupt(`project snapshot ${contentHash} is not canonical`);
	}
	if (actualDigest !== contentHash) {
		throw corrupt(
			`project snapshot ${contentHash} canonical bytes do not match its hash`,
		);
	}
	await verifyRetainedProjectMedia({
		snapshot: envelope.snapshot,
		mediaAssets: restoreRetainedMedia(envelope.mediaAssets),
	});
	return envelope;
}

function parseEnvelopeStructure({
	value,
	contentHash,
	evaluateRetention,
}: {
	value: unknown;
	contentHash: string;
	evaluateRetention: SnapshotRetentionEvaluator;
}): PersistedProjectSnapshotEnvelope {
	if (!isRecord(value)) throw corrupt("project snapshot is not an object");
	if (
		value.envelopeVersion === LEGACY_PROJECT_SNAPSHOT_ENVELOPE_VERSION &&
		value.storageSchemaVersion ===
			LEGACY_PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION
	) {
		assertExactKeys({
			value,
			expected: [
				"canonicalJson",
				"contentHash",
				"envelopeVersion",
				"expiresAt",
				"firstVerifiedAt",
				"id",
				"lastVerifiedAt",
				"latestVerification",
				"projectIds",
				"snapshot",
				"storageSchemaVersion",
			],
		});
		return parseEnvelopeStructure({
			value: {
				...value,
				envelopeVersion: PROJECT_SNAPSHOT_ENVELOPE_VERSION,
				storageSchemaVersion: PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION,
				mediaAssets: [],
			},
			contentHash,
			evaluateRetention,
		});
	}
	if (
		value.envelopeVersion !== PROJECT_SNAPSHOT_ENVELOPE_VERSION ||
		value.storageSchemaVersion !== PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION
	) {
		throw new ProjectSnapshotStorageError({
			code: "unsupported-project-snapshot-version",
			message: `project snapshot ${contentHash} has an unsupported version`,
		});
	}
	assertExactKeys({
		value,
		expected: [
			"canonicalJson",
			"contentHash",
			"envelopeVersion",
			"expiresAt",
			"firstVerifiedAt",
			"id",
			"lastVerifiedAt",
			"latestVerification",
			"mediaAssets",
			"projectIds",
			"snapshot",
			"storageSchemaVersion",
		],
	});
	if (
		value.id !== contentHash ||
		!isProjectContentHash(value.contentHash) ||
		value.contentHash.digest !== contentHash ||
		!isSortedUniqueProjectIds(value.projectIds) ||
		!isRecord(value.snapshot) ||
		!isPersistedSnapshotMedia(value.mediaAssets) ||
		typeof value.canonicalJson !== "string" ||
		!isCanonicalTimestamp(value.firstVerifiedAt) ||
		!isCanonicalTimestamp(value.lastVerifiedAt) ||
		!isCanonicalTimestamp(value.expiresAt) ||
		!isVerification(value.latestVerification)
	) {
		throw corrupt(`project snapshot ${contentHash} is malformed`);
	}
	// Every field and exact key was checked immediately above.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const envelope = value as unknown as PersistedProjectSnapshotEnvelope;
	if (
		envelope.snapshot.projection !== envelope.contentHash.projection ||
		envelope.snapshot.projectionVersion !==
			envelope.contentHash.projectionVersion ||
		!snapshotMatchesProjects({
			snapshot: envelope.snapshot,
			projectIds: envelope.projectIds,
		}) ||
		envelope.latestVerification.verifiedAt !== envelope.lastVerifiedAt ||
		Date.parse(envelope.firstVerifiedAt) >
			Date.parse(envelope.lastVerifiedAt) ||
		canonicalSerialize(envelope.snapshot) !== envelope.canonicalJson
	) {
		throw corrupt(`project snapshot ${contentHash} bindings are invalid`);
	}
	const evaluation = evaluateRetention({
		prior: toNativeRetentionState(envelope),
		verification: toNativeVerification(envelope.latestVerification),
	});
	if (
		evaluation.status !== "retained" ||
		evaluation.state.firstVerifiedAtMs !==
			Date.parse(envelope.firstVerifiedAt) ||
		evaluation.state.lastVerifiedAtMs !== Date.parse(envelope.lastVerifiedAt) ||
		evaluation.state.expiresAtMs !== Date.parse(envelope.expiresAt)
	) {
		throw corrupt(`project snapshot ${contentHash} retention is invalid`);
	}
	return envelope;
}

async function prepareRetainedMedia({
	snapshot,
	mediaAssets,
}: {
	snapshot: ProjectSnapshot;
	mediaAssets: readonly PersistedMediaReadback[];
}): Promise<PersistedSnapshotMediaAsset[]> {
	const requestedBytes = mediaAssets.reduce((total, media) => {
		const next = total + media.file.size;
		if (!Number.isSafeInteger(next)) {
			throw new Error("project snapshot media byte count overflowed");
		}
		return next;
	}, 0);
	if (requestedBytes > MAX_PROJECT_SNAPSHOT_MEDIA_BYTES) {
		throw new Error(
			"project snapshot media exceeds the 256 MiB retention limit",
		);
	}
	const verified = await verifyRetainedProjectMedia({ snapshot, mediaAssets });
	const retained: PersistedSnapshotMediaAsset[] = [];
	for (const { file, ...media } of verified) {
		retained.push({
			...media,
			bytes: await file.arrayBuffer(),
			fileName: file.name,
			fileType: file.type,
		});
	}
	return retained;
}

function persistedMediaBytes(
	mediaAssets: PersistedSnapshotMediaAsset[],
): number {
	return mediaAssets.reduce(
		(total, media) => total + media.bytes.byteLength,
		0,
	);
}

function persistedEnvelopeMediaBytes(
	value: Record<string, unknown>,
): number | null {
	if (
		value.envelopeVersion === LEGACY_PROJECT_SNAPSHOT_ENVELOPE_VERSION &&
		value.storageSchemaVersion ===
			LEGACY_PROJECT_SNAPSHOT_STORAGE_SCHEMA_VERSION
	) {
		return 0;
	}
	if (!Array.isArray(value.mediaAssets)) return null;
	let total = 0;
	for (const media of value.mediaAssets) {
		if (!isRecord(media) || !(media.bytes instanceof ArrayBuffer)) return null;
		total += media.bytes.byteLength;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

export async function verifyRetainedProjectMedia({
	snapshot,
	mediaAssets,
}: {
	snapshot: ProjectSnapshot;
	mediaAssets: readonly PersistedMediaReadback[];
}): Promise<PersistedMediaReadback[]> {
	const byId = new Map<string, PersistedMediaReadback>();
	for (const media of mediaAssets) {
		if (!media || typeof media.id !== "string" || byId.has(media.id)) {
			throw new Error("retained project snapshot media identity is invalid");
		}
		byId.set(media.id, media);
	}
	if (byId.size !== snapshot.mediaAssets.length) {
		throw new Error("required media bytes are missing from project snapshot");
	}

	const verified: PersistedMediaReadback[] = [];
	for (const canonical of snapshot.mediaAssets) {
		const media = byId.get(canonical.id);
		if (!media) {
			throw new Error(
				`required media bytes are missing from project snapshot: ${canonical.id}`,
			);
		}
		if (!(media.file instanceof Blob)) {
			throw new Error(`required media bytes are invalid: ${canonical.id}`);
		}
		const resolved = await resolvePersistedMediaIdentity({
			file: media.file,
			storedIdentity: media.sourceIdentity,
		});
		if (
			resolved.backfilled ||
			!mediaMatchesCanonical({ media, canonical, identity: resolved.identity })
		) {
			throw new Error(
				`retained media identity does not match canonical snapshot: ${canonical.id}`,
			);
		}
		verified.push({ ...media, sourceIdentity: resolved.identity });
	}
	return verified;
}

function mediaMatchesCanonical({
	media,
	canonical,
	identity,
}: {
	media: PersistedMediaReadback;
	canonical: ProjectSnapshot["mediaAssets"][number];
	identity: PersistedMediaReadback["sourceIdentity"];
}): boolean {
	if (
		media.id !== canonical.id ||
		media.name !== canonical.name ||
		media.type !== canonical.type ||
		media.file.size !== canonical.size ||
		!optionalEqual({ actual: media.width, expected: canonical.width }) ||
		!optionalEqual({ actual: media.height, expected: canonical.height }) ||
		!optionalEqual({ actual: media.duration, expected: canonical.duration }) ||
		!optionalEqual({ actual: media.fps, expected: canonical.fps }) ||
		!optionalEqual({ actual: media.hasAudio, expected: canonical.hasAudio }) ||
		!optionalEqual({
			actual: media.sourceFingerprint,
			expected: canonical.sourceFingerprint,
		}) ||
		!optionalEqual({ actual: media.role, expected: canonical.role }) ||
		identity.kind !== canonical.source.kind ||
		!canonical.source.contentHash ||
		!identity.contentHash ||
		identity.contentHash.algorithm !== canonical.source.contentHash.algorithm ||
		identity.contentHash.digest !== canonical.source.contentHash.digest
	) {
		return false;
	}
	return (
		identity.kind === "local" ||
		(canonical.source.kind === "provider" &&
			identity.provider === canonical.source.provider &&
			identity.providerVersion === canonical.source.providerVersion &&
			identity.sourceUrl === canonical.source.sourceUrl)
	);
}

function isPersistedSnapshotMedia(
	value: unknown,
): value is PersistedSnapshotMediaAsset[] {
	return (
		Array.isArray(value) &&
		value.every(
			(media) =>
				isRecord(media) &&
				typeof media.id === "string" &&
				typeof media.name === "string" &&
				typeof media.type === "string" &&
				typeof media.size === "number" &&
				typeof media.lastModified === "number" &&
				typeof media.fileName === "string" &&
				typeof media.fileType === "string" &&
				media.bytes instanceof ArrayBuffer &&
				isRecord(media.sourceIdentity),
		)
	);
}

function restoreRetainedMedia(
	mediaAssets: readonly PersistedSnapshotMediaAsset[],
): PersistedMediaReadback[] {
	return mediaAssets.map(({ bytes, fileName, fileType, ...media }) => ({
		...media,
		file: new File([bytes], fileName, {
			type: fileType,
			lastModified: media.lastModified,
		}),
	}));
}

function optionalEqual({
	actual,
	expected,
}: {
	actual: string | number | boolean | undefined;
	expected: string | number | boolean | null;
}): boolean {
	return (actual ?? null) === expected;
}

function toNativeRetentionState(
	value: Pick<
		RetainedProjectSnapshot,
		"firstVerifiedAt" | "lastVerifiedAt" | "expiresAt" | "latestVerification"
	>,
): SnapshotRetentionState {
	return {
		firstVerifiedAtMs: Date.parse(value.firstVerifiedAt),
		lastVerifiedAtMs: Date.parse(value.lastVerifiedAt),
		expiresAtMs: Date.parse(value.expiresAt),
		latestVerification: toNativeVerification(value.latestVerification),
	};
}

function toNativeVerification(value: ProjectSnapshotVerification) {
	return {
		writeVersion: value.writeVersion,
		receiptId: value.receiptId,
		operationId: value.operationId,
		verifiedAtMs: Date.parse(value.verifiedAt),
	};
}

function fromNativeVerification(
	value: SnapshotRetentionState["latestVerification"],
): ProjectSnapshotVerification {
	return {
		writeVersion: value.writeVersion,
		receiptId: value.receiptId,
		operationId: value.operationId,
		verifiedAt: toIso(value.verifiedAtMs),
	};
}

function toIso(value: number): string {
	return new Date(value).toISOString();
}

function isExpiredValue({
	value,
	now,
}: {
	value: unknown;
	now: number;
}): boolean {
	return (
		isRecord(value) &&
		isCanonicalTimestamp(value.expiresAt) &&
		Date.parse(value.expiresAt) <= now
	);
}

async function loadSnapshotRetentionEvaluator(): Promise<SnapshotRetentionEvaluator> {
	return (await import("opencut-wasm")).evaluateProjectSnapshotRetention;
}

function snapshotMatchesProject({
	snapshot,
	projectId,
}: {
	snapshot: ProjectSnapshot;
	projectId: string;
}): boolean {
	return snapshot.projectionVersion === 1
		? snapshot.project.id == null
		: snapshot.project.id === projectId;
}

function snapshotMatchesProjects({
	snapshot,
	projectIds,
}: {
	snapshot: ProjectSnapshot;
	projectIds: string[];
}): boolean {
	return snapshot.projectionVersion === 1
		? snapshot.project.id == null
		: projectIds.length === 1 && snapshot.project.id === projectIds[0];
}

function isSortedUniqueProjectIds(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(projectId, index) =>
				typeof projectId === "string" &&
				projectId.length > 0 &&
				(index === 0 || value[index - 1]! < projectId),
		)
	);
}

function assertExactKeys({
	value,
	expected,
}: {
	value: Record<string, unknown>;
	expected: string[];
}): void {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (
		actual.length !== sortedExpected.length ||
		actual.some((key, index) => key !== sortedExpected[index])
	) {
		throw corrupt("project snapshot envelope fields are invalid");
	}
}

function withoutEnvelope({
	value,
	projectId,
}: {
	value: PersistedProjectSnapshotEnvelope;
	projectId: string;
}): RetainedProjectSnapshot {
	const {
		id: _id,
		canonicalJson: _canonicalJson,
		projectIds: _projectIds,
		envelopeVersion: _envelopeVersion,
		storageSchemaVersion: _storageSchemaVersion,
		mediaAssets,
		...record
	} = value;
	return {
		...record,
		mediaAssets: restoreRetainedMedia(mediaAssets),
		projectId,
	};
}

function validateContentHash(value: ProjectContentHash): void {
	if (!isProjectContentHash(value)) {
		throw new Error("project snapshot content hash is invalid");
	}
}

function isProjectContentHash(value: unknown): value is ProjectContentHash {
	return (
		isRecord(value) &&
		value.algorithm === "SHA-256" &&
		value.projection === "opencut-project-content" &&
		(value.projectionVersion === 1 || value.projectionVersion === 2) &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest)
	);
}

function validateVerification(value: ProjectSnapshotVerification): void {
	if (!isVerification(value)) {
		throw new Error("project snapshot verification is invalid");
	}
}

function isVerification(value: unknown): value is ProjectSnapshotVerification {
	return (
		isRecord(value) &&
		typeof value.writeVersion === "number" &&
		Number.isSafeInteger(value.writeVersion) &&
		value.writeVersion > 0 &&
		typeof value.receiptId === "string" &&
		value.receiptId.length > 0 &&
		typeof value.operationId === "string" &&
		value.operationId.length > 0 &&
		isCanonicalTimestamp(value.verifiedAt)
	);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corrupt(message: string): ProjectSnapshotStorageError {
	return new ProjectSnapshotStorageError({
		code: "corrupt-project-snapshot",
		message,
	});
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
