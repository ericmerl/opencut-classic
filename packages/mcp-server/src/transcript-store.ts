import { createHash, randomBytes } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	readdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as z from "zod/v4";
import { stableSerialize } from "./matte-generation-data";

const identifier = z.string().trim().min(1).max(512);
const hashIdentity = z
	.object({
		algorithm: z.literal("SHA-256"),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const sourceRange = z
	.object({
		startTicks: z.number().int().nonnegative(),
		endTicks: z.number().int().nonnegative(),
	})
	.strict()
	.refine((value) => value.endTicks >= value.startTicks, {
		message: "range end must not precede its start",
	});

export const transcriptProviderSchema = z
	.object({
		providerId: identifier,
		providerVersion: identifier,
		workflowVersion: identifier,
		modelId: identifier,
		modelRevision: identifier,
		modelArtifact: z
			.object({
				path: z.string().min(1),
				bytes: z.number().int().positive(),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
		device: z.enum(["cuda", "cpu", "webgpu", "wasm"]),
		deviceName: z.string().trim().min(1).nullable(),
		runtime: z.record(
			z.string(),
			z.union([z.string(), z.number(), z.boolean(), z.null()]),
		),
		decision: identifier,
		usedFallback: z.boolean(),
		reviewReasons: z.array(z.string().trim().min(1)).max(1_000),
		warnings: z.array(z.string().trim().min(1)).max(1_000),
	})
	.strict();

export const transcriptWordSchema = z
	.object({
		wordId: identifier,
		segmentId: identifier,
		index: z.number().int().nonnegative(),
		originalText: z.string().min(1),
		text: z.string().min(1),
		sourceTime: sourceRange,
		timelineTime: sourceRange.nullable(),
		speaker: z.string().trim().min(1).nullable(),
		confidence: z.number().min(0).max(1).nullable(),
	})
	.strict();

export const transcriptSegmentSchema = z
	.object({
		segmentId: identifier,
		index: z.number().int().nonnegative(),
		originalText: z.string().min(1),
		text: z.string().min(1),
		sourceTime: sourceRange,
		timelineTime: sourceRange.nullable(),
		speaker: z.string().trim().min(1).nullable(),
		confidence: z.number().min(0).max(1).nullable(),
		wordIds: z.array(identifier).min(1).max(10_000),
	})
	.strict();

const transcriptCorrectionSchema = z
	.object({
		correctionId: identifier,
		appliedAt: z.string().datetime(),
		policy: z.enum(["transcript-only", "propagate-linked-captions"]),
		changes: z
			.array(
				z
					.object({
						wordId: identifier,
						before: z.string().min(1),
						after: z.string().min(1),
					})
					.strict(),
			)
			.min(1)
			.max(10_000),
		generatedCaptionOperations: z
			.array(z.record(z.string(), z.unknown()))
			.max(10_000),
	})
	.strict();

const transcriptMappingSchema = z
	.object({
		captions: z
			.array(
				z
					.object({
						trackId: identifier,
						elementId: identifier,
						startWordId: identifier,
						endWordId: identifier,
					})
					.strict(),
			)
			.max(10_000),
		cuts: z
			.array(
				z
					.object({
						decisionId: identifier,
						startWordId: identifier.nullable(),
						endWordId: identifier.nullable(),
						sourceTime: sourceRange,
					})
					.strict(),
			)
			.max(10_000),
	})
	.strict();

export const transcriptRecordSchema = z
	.object({
		schemaVersion: z.literal(1),
		transcriptId: identifier,
		operationId: identifier,
		requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
		version: z.number().int().positive(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		projectId: identifier,
		sceneId: identifier,
		projectRevision: z.number().int().nonnegative(),
		projectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
		source: z
			.object({
				assetId: identifier,
				trackId: identifier,
				clipId: identifier,
				name: z.string().min(1),
				mimeType: z.string().min(1),
				contentHash: hashIdentity,
				sourceFingerprint: z.string().nullable(),
				durationTicks: z.number().int().positive(),
				clip: z
					.object({
						timelineStartTicks: z.number().int().nonnegative(),
						durationTicks: z.number().int().positive(),
						trimStartTicks: z.number().int().nonnegative(),
						trimEndTicks: z.number().int().nonnegative(),
						retimeRate: z.number().finite().positive(),
					})
					.strict(),
			})
			.strict(),
		language: z.string().trim().min(1),
		originalText: z.string(),
		text: z.string(),
		segments: z.array(transcriptSegmentSchema).max(100_000),
		words: z.array(transcriptWordSchema).max(1_000_000),
		correctionHistory: z.array(transcriptCorrectionSchema).max(100_000),
		mappings: transcriptMappingSchema,
		provider: transcriptProviderSchema,
		providerArtifact: z
			.object({
				path: z.string().min(1),
				bytes: z.number().int().positive(),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
		contentHash: hashIdentity,
	})
	.strict();

export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptProvider = z.infer<typeof transcriptProviderSchema>;

export class TranscriptStore {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = resolve(directory);
	}

	async readiness(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
	}

	async create(
		record: Omit<
			TranscriptRecord,
			"schemaVersion" | "version" | "createdAt" | "updatedAt" | "contentHash"
		>,
		now = new Date().toISOString(),
	): Promise<{ status: "created" | "replayed"; transcript: TranscriptRecord }> {
		await this.readiness();
		const existing = await this.get(record.transcriptId);
		if (existing) {
			if (
				existing.operationId !== record.operationId ||
				existing.requestFingerprint !== record.requestFingerprint
			) {
				throw new Error("transcriptId was already used by another operation");
			}
			return { status: "replayed", transcript: existing };
		}
		const transcript = withTranscriptHash({
			...record,
			schemaVersion: 1,
			version: 1,
			createdAt: now,
			updatedAt: now,
		});
		await this.writeVersion(transcript);
		return { status: "created", transcript };
	}

	async update({
		transcriptId,
		expectedVersion,
		update,
		now = new Date().toISOString(),
	}: {
		transcriptId: string;
		expectedVersion: number;
		update: (current: TranscriptRecord) => TranscriptRecord;
		now?: string;
	}): Promise<TranscriptRecord> {
		const current = await this.require(transcriptId);
		if (current.version !== expectedVersion) {
			throw new Error(
				`transcript version conflict: expected ${expectedVersion}, actual ${current.version}`,
			);
		}
		const proposed = update(structuredClone(current));
		if (
			proposed.transcriptId !== current.transcriptId ||
			proposed.operationId !== current.operationId ||
			proposed.requestFingerprint !== current.requestFingerprint ||
			proposed.projectId !== current.projectId ||
			proposed.sceneId !== current.sceneId ||
			proposed.createdAt !== current.createdAt
		) {
			throw new Error("transcript update changed immutable identity");
		}
		const next = withTranscriptHash({
			...proposed,
			schemaVersion: 1,
			version: current.version + 1,
			updatedAt: now,
		});
		await this.writeVersion(next);
		return next;
	}

	async require(
		transcriptId: string,
		version?: number,
	): Promise<TranscriptRecord> {
		const transcript = await this.get(transcriptId, version);
		if (!transcript) throw new Error(`transcript not found: ${transcriptId}`);
		return transcript;
	}

	async get(
		transcriptId: string,
		version?: number,
	): Promise<TranscriptRecord | null> {
		const directory = this.transcriptDirectory(transcriptId);
		const names = await readdir(directory).catch(() => []);
		const versions = names
			.map(parseVersionName)
			.filter((value): value is number => value !== null)
			.sort((left, right) => left - right);
		const selected = version ?? versions.at(-1);
		if (selected === undefined || !versions.includes(selected)) return null;
		const path = join(directory, versionName(selected));
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new Error(`durable transcript is invalid: ${path}`);
		}
		const parsed = transcriptRecordSchema.parse(value);
		if (parsed.transcriptId !== transcriptId || parsed.version !== selected) {
			throw new Error("durable transcript identity does not match its path");
		}
		verifyTranscriptHash(parsed);
		return parsed;
	}

	async list(projectId?: string): Promise<TranscriptRecord[]> {
		await this.readiness();
		const entries = await readdir(this.directory, { withFileTypes: true });
		const records: TranscriptRecord[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const names = await readdir(join(this.directory, entry.name));
			const latest = names
				.map(parseVersionName)
				.filter((value): value is number => value !== null)
				.sort((left, right) => right - left)[0];
			if (latest === undefined) continue;
			const value = transcriptRecordSchema.parse(
				JSON.parse(
					await readFile(
						join(this.directory, entry.name, versionName(latest)),
						"utf8",
					),
				),
			);
			verifyTranscriptHash(value);
			if (!projectId || value.projectId === projectId) records.push(value);
		}
		return records.sort(
			(left, right) =>
				right.updatedAt.localeCompare(left.updatedAt) ||
				left.transcriptId.localeCompare(right.transcriptId),
		);
	}

	private transcriptDirectory(transcriptId: string): string {
		return join(this.directory, sha256(transcriptId));
	}

	private async writeVersion(record: TranscriptRecord): Promise<void> {
		const parsed = transcriptRecordSchema.parse(record);
		verifyTranscriptHash(parsed);
		const directory = this.transcriptDirectory(parsed.transcriptId);
		await mkdir(directory, { recursive: true });
		const path = join(directory, versionName(parsed.version));
		const temporary = join(
			directory,
			`.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
		);
		try {
			await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
				flag: "wx",
			});
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`transcript version already exists: ${parsed.version}`);
			}
			throw error;
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}

export function withTranscriptHash(
	record: Omit<TranscriptRecord, "contentHash"> & {
		contentHash?: TranscriptRecord["contentHash"];
	},
): TranscriptRecord {
	const { contentHash: _contentHash, ...projection } = record;
	return transcriptRecordSchema.parse({
		...projection,
		contentHash: {
			algorithm: "SHA-256",
			digest: sha256(stableSerialize(projection)),
		},
	});
}

export function verifyTranscriptHash(record: TranscriptRecord): void {
	const { contentHash, ...projection } = record;
	if (contentHash.digest !== sha256(stableSerialize(projection))) {
		throw new Error(`transcript content hash mismatch: ${record.transcriptId}`);
	}
}

function versionName(version: number): string {
	return `${String(version).padStart(8, "0")}.json`;
}

function parseVersionName(value: string): number | null {
	const match = /^(\d{8})\.json$/.exec(value);
	return match ? Number(match[1]) : null;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
