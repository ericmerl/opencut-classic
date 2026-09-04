import { Database } from "bun:sqlite";
import { canonicalSerialize } from "@opencut/canonical-json";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod/v4";

export const REVIEW_ANNOTATION_SCHEMA = "opencut.review-annotation.v1" as const;
export const WATERMARK_INSPECTION_SCHEMA =
	"opencut.watermark-inspection.v1" as const;
export const WATERMARK_SAMPLING_POLICY_SCHEMA =
	"opencut.watermark-sampling-policy.v1" as const;
export const EXPORT_REVIEW_SIGNOFF_SCHEMA =
	"opencut.export-review-signoff.v1" as const;

const identifierSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceTargetSchema = z
	.object({
		kind: z.enum(["preview-frame", "preview-range", "export"]),
		evidenceOperationId: identifierSchema,
		evidenceReceiptId: identifierSchema,
		artifactSha256: digestSchema,
		projectContentHash: digestSchema,
	})
	.strict();
const locationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("time"), ticks: z.number().int().nonnegative() }),
	z.object({
		kind: z.literal("range"),
		startTicks: z.number().int().nonnegative(),
		endTicksExclusive: z.number().int().positive(),
	}),
]);
const normalizedRegionSchema = z
	.object({
		x: z.number().finite().min(0).max(1),
		y: z.number().finite().min(0).max(1),
		width: z.number().finite().positive().max(1),
		height: z.number().finite().positive().max(1),
	})
	.strict();
const findingSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("human") }).strict(),
	z
		.object({
			kind: z.literal("automated"),
			detector: z
				.object({
					provider: identifierSchema,
					modelId: identifierSchema,
					modelVersion: identifierSchema,
					optionsFingerprint: digestSchema.optional(),
				})
				.strict(),
		})
		.strict(),
]);
const replacementEvidenceSchema = evidenceTargetSchema.nullable();
const annotationSchema = z
	.object({
		schemaVersion: z.literal(REVIEW_ANNOTATION_SCHEMA),
		annotationId: identifierSchema,
		versionId: identifierSchema,
		version: z.number().int().positive(),
		previousVersionId: identifierSchema.nullable(),
		operationId: identifierSchema,
		projectId: identifierSchema,
		sceneId: identifierSchema,
		createdAt: z.iso.datetime({ offset: true }),
		target: evidenceTargetSchema,
		location: locationSchema,
		region: normalizedRegionSchema,
		category: identifierSchema,
		severity: z.enum(["info", "warning", "blocking"]),
		status: z.enum(["open", "resolved", "dismissed"]),
		finding: findingSchema,
		reviewer: z.string().trim().min(1).max(256),
		notes: z.string().trim().min(1).max(16_384),
		resolutionOperationId: identifierSchema.nullable(),
		replacementEvidence: replacementEvidenceSchema,
		bookmarkId: identifierSchema.nullable(),
	})
	.strict();

const watermarkOutcomeSchema = z.enum([
	"clean",
	"watermark-found",
	"unable-to-determine",
]);
const cornerResultsSchema = z
	.object({
		"top-left": watermarkOutcomeSchema,
		"top-right": watermarkOutcomeSchema,
		"bottom-left": watermarkOutcomeSchema,
		"bottom-right": watermarkOutcomeSchema,
	})
	.strict();
const watermarkReviewSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("human"),
			reviewer: z.string().trim().min(1).max(256),
		})
		.strict(),
	z
		.object({
			kind: z.literal("automated"),
			reviewer: z.string().trim().min(1).max(256),
			detector: z
				.object({
					provider: identifierSchema,
					modelId: identifierSchema,
					modelVersion: identifierSchema,
					optionsFingerprint: digestSchema.optional(),
				})
				.strict(),
		})
		.strict(),
]);
const watermarkInspectionSchema = z
	.object({
		schemaVersion: z.literal(WATERMARK_INSPECTION_SCHEMA),
		inspectionId: identifierSchema,
		operationId: identifierSchema,
		projectId: identifierSchema,
		sceneId: identifierSchema,
		projectContentHash: digestSchema,
		createdAt: z.iso.datetime({ offset: true }),
		exportEvidence: evidenceTargetSchema.extend({ kind: z.literal("export") }),
		renderEvidence: z.array(evidenceTargetSchema).max(100),
		policy: z
			.object({
				schemaVersion: z.literal(WATERMARK_SAMPLING_POLICY_SCHEMA),
				fullFrameSamples: z.tuple([
					z.literal("opening"),
					z.literal("middle"),
					z.literal("ending"),
				]),
				corners: z.tuple([
					z.literal("top-left"),
					z.literal("top-right"),
					z.literal("bottom-left"),
					z.literal("bottom-right"),
				]),
				requireFinalExportBytesInspection: z.literal(true),
				requireHumanReview: z.literal(true),
			})
			.strict(),
		review: watermarkReviewSchema,
		samples: z
			.array(
				z
					.object({
						position: z.enum(["opening", "middle", "ending"]),
						artifactSha256: digestSchema,
						fullFrame: watermarkOutcomeSchema,
						corners: cornerResultsSchema,
					})
					.strict(),
			)
			.length(3),
		finalExportBytes: z
			.object({
				artifactSha256: digestSchema,
				status: watermarkOutcomeSchema,
			})
			.strict(),
		status: z.enum(["verified-clean", "rejected", "inconclusive"]),
		notes: z.string().trim().min(1).max(16_384),
	})
	.strict();
const exportReviewSignoffSchema = z
	.object({
		schemaVersion: z.literal(EXPORT_REVIEW_SIGNOFF_SCHEMA),
		signoffId: identifierSchema,
		operationId: identifierSchema,
		inspectionId: identifierSchema,
		exportOperationId: identifierSchema,
		outputSha256: digestSchema,
		projectId: identifierSchema,
		sceneId: identifierSchema,
		projectContentHash: digestSchema,
		reviewer: z.string().trim().min(1).max(256),
		notes: z.string().trim().min(1).max(16_384),
		createdAt: z.iso.datetime({ offset: true }),
		status: z.literal("signed-off"),
		humanReview: z.literal(true),
		unresolvedBlockingFindings: z.literal(0),
	})
	.strict();

export type ReviewAnnotationRecord = z.infer<typeof annotationSchema>;
export type WatermarkInspectionRecord = z.infer<
	typeof watermarkInspectionSchema
>;
export type ExportReviewSignoffRecord = z.infer<
	typeof exportReviewSignoffSchema
>;

type AnnotationRow = {
	event_sequence: number;
	record_json: string;
	record_checksum: string;
};

export class ReviewEvidenceIntegrityError extends Error {
	readonly code = "REVIEW_EVIDENCE_INTEGRITY_FAILED";

	constructor(message: string) {
		super(message);
		this.name = "ReviewEvidenceIntegrityError";
	}
}

export class ReviewEvidenceStore {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;
	private readinessPromise: Promise<void> | null = null;

	constructor(directory: string) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, "review-evidence.sqlite");
	}

	async readiness(): Promise<void> {
		if (this.database) return;
		this.readinessPromise ??= this.initialize().catch((error) => {
			this.readinessPromise = null;
			throw error;
		});
		await this.readinessPromise;
	}

	async appendAnnotation(
		record: ReviewAnnotationRecord,
	): Promise<ReviewAnnotationRecord> {
		await this.readiness();
		const parsed = annotationSchema.parse(record);
		const json = canonicalSerialize(parsed);
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const latest = database
				.query(
					`SELECT version_id, version FROM review_annotations
					WHERE annotation_id=? ORDER BY version DESC LIMIT 1`,
				)
				.get(parsed.annotationId) as {
				version_id: string;
				version: number;
			} | null;
			if (
				(latest === null &&
					(parsed.version !== 1 || parsed.previousVersionId !== null)) ||
				(latest !== null &&
					(parsed.version !== latest.version + 1 ||
						parsed.previousVersionId !== latest.version_id))
			) {
				throw new Error(
					"review annotation append must reference the exact previous version",
				);
			}
			database
				.query(
					`INSERT INTO review_annotations(
					annotation_id, version_id, version, operation_id, project_id, scene_id,
					created_at, record_json, record_checksum
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					parsed.annotationId,
					parsed.versionId,
					parsed.version,
					parsed.operationId,
					parsed.projectId,
					parsed.sceneId,
					parsed.createdAt,
					json,
					sha256(json),
				);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		return parsed;
	}

	async getAnnotation(
		annotationId: string,
		version?: number,
	): Promise<ReviewAnnotationRecord | null> {
		await this.readiness();
		const row = (
			version === undefined
				? this.requireDatabase()
						.query(
							`SELECT event_sequence, record_json, record_checksum
						FROM review_annotations WHERE annotation_id=?
						ORDER BY version DESC LIMIT 1`,
						)
						.get(annotationId)
				: this.requireDatabase()
						.query(
							`SELECT event_sequence, record_json, record_checksum
						FROM review_annotations WHERE annotation_id=? AND version=?`,
						)
						.get(annotationId, version)
		) as AnnotationRow | null;
		return row ? this.parseRow(row) : null;
	}

	async listAnnotations(input: {
		limit: number;
		cursor?: string;
		projectId?: string;
		sceneId?: string;
	}): Promise<{
		annotations: ReviewAnnotationRecord[];
		nextCursor: string | null;
	}> {
		await this.readiness();
		if (
			!Number.isInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 100
		) {
			throw new Error("review annotation list limit must be between 1 and 100");
		}
		const cursor = input.cursor === undefined ? null : Number(input.cursor);
		if (
			cursor !== null &&
			(!Number.isSafeInteger(cursor) ||
				cursor < 1 ||
				String(cursor) !== input.cursor)
		) {
			throw new Error("invalid review annotation cursor");
		}
		const conditions: string[] = [];
		const values: Array<string | number> = [];
		if (cursor !== null) {
			conditions.push("event_sequence < ?");
			values.push(cursor);
		}
		if (input.projectId) {
			conditions.push("project_id = ?");
			values.push(input.projectId);
		}
		if (input.sceneId) {
			conditions.push("scene_id = ?");
			values.push(input.sceneId);
		}
		const rows = this.requireDatabase()
			.query(
				`SELECT event_sequence, record_json, record_checksum
				FROM review_annotations
				${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
				ORDER BY event_sequence DESC LIMIT ?`,
			)
			.all(...values, input.limit + 1) as AnnotationRow[];
		const page = rows.slice(0, input.limit);
		return {
			annotations: page.map((row) => this.parseRow(row)),
			nextCursor:
				rows.length > input.limit && page.length > 0
					? String(page[page.length - 1]!.event_sequence)
					: null,
		};
	}

	async appendWatermarkInspection(
		record: WatermarkInspectionRecord,
	): Promise<WatermarkInspectionRecord> {
		await this.readiness();
		const parsed = watermarkInspectionSchema.parse(record);
		const json = canonicalSerialize(parsed);
		this.requireDatabase()
			.query(
				`INSERT INTO watermark_inspections(
				inspection_id, operation_id, project_id, scene_id, created_at,
				record_json, record_checksum
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				parsed.inspectionId,
				parsed.operationId,
				parsed.projectId,
				parsed.sceneId,
				parsed.createdAt,
				json,
				sha256(json),
			);
		return parsed;
	}

	async getWatermarkInspection(
		inspectionId: string,
	): Promise<WatermarkInspectionRecord | null> {
		await this.readiness();
		const row = this.requireDatabase()
			.query(
				`SELECT event_sequence, record_json, record_checksum
				FROM watermark_inspections WHERE inspection_id=?`,
			)
			.get(inspectionId) as AnnotationRow | null;
		return row ? this.parseWatermarkRow(row) : null;
	}

	async listLatestAnnotations(input: {
		projectId: string;
		sceneId: string;
		limit: number;
	}): Promise<ReviewAnnotationRecord[]> {
		await this.readiness();
		if (
			!Number.isInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 10_001
		) {
			throw new Error("latest annotation limit must be between 1 and 10001");
		}
		const rows = this.requireDatabase()
			.query(
				`SELECT a.event_sequence, a.record_json, a.record_checksum
				FROM review_annotations a
				JOIN (
					SELECT annotation_id, MAX(version) AS version
					FROM review_annotations
					WHERE project_id=? AND scene_id=?
					GROUP BY annotation_id
				) latest ON latest.annotation_id=a.annotation_id AND latest.version=a.version
				ORDER BY a.event_sequence DESC LIMIT ?`,
			)
			.all(input.projectId, input.sceneId, input.limit) as AnnotationRow[];
		return rows.map((row) => this.parseRow(row));
	}

	async appendExportReviewSignoff(
		record: ExportReviewSignoffRecord,
	): Promise<ExportReviewSignoffRecord> {
		await this.readiness();
		const parsed = exportReviewSignoffSchema.parse(record);
		const json = canonicalSerialize(parsed);
		this.requireDatabase()
			.query(
				`INSERT INTO export_review_signoffs(
				signoff_id, operation_id, project_id, scene_id, created_at,
				record_json, record_checksum
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				parsed.signoffId,
				parsed.operationId,
				parsed.projectId,
				parsed.sceneId,
				parsed.createdAt,
				json,
				sha256(json),
			);
		return parsed;
	}

	async getExportReviewSignoff(
		signoffId: string,
	): Promise<ExportReviewSignoffRecord | null> {
		await this.readiness();
		const row = this.requireDatabase()
			.query(
				`SELECT event_sequence, record_json, record_checksum
				FROM export_review_signoffs WHERE signoff_id=?`,
			)
			.get(signoffId) as AnnotationRow | null;
		return row ? this.parseSignoffRow(row) : null;
	}

	close(): void {
		this.database?.close(false);
		this.database = null;
		this.readinessPromise = null;
	}

	private async initialize(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const database = new Database(this.databasePath, { create: true });
		database.exec("PRAGMA busy_timeout = 5000");
		database.exec("PRAGMA journal_mode = WAL");
		database.exec("PRAGMA synchronous = FULL");
		database.exec(`CREATE TABLE IF NOT EXISTS review_annotations(
			event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			annotation_id TEXT NOT NULL,
			version_id TEXT NOT NULL UNIQUE,
			version INTEGER NOT NULL,
			operation_id TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			scene_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			record_json TEXT NOT NULL,
			record_checksum TEXT NOT NULL,
			UNIQUE(annotation_id, version)
		)`);
		database.exec(`CREATE TRIGGER IF NOT EXISTS review_annotations_no_update
			BEFORE UPDATE ON review_annotations BEGIN
				SELECT RAISE(ABORT, 'review annotation versions are immutable');
			END`);
		database.exec(`CREATE TRIGGER IF NOT EXISTS review_annotations_no_delete
			BEFORE DELETE ON review_annotations BEGIN
				SELECT RAISE(ABORT, 'review annotation versions are immutable');
			END`);
		database.exec(`CREATE TABLE IF NOT EXISTS watermark_inspections(
			event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			inspection_id TEXT NOT NULL UNIQUE,
			operation_id TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			scene_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			record_json TEXT NOT NULL,
			record_checksum TEXT NOT NULL
		)`);
		database.exec(`CREATE TRIGGER IF NOT EXISTS watermark_inspections_no_update
			BEFORE UPDATE ON watermark_inspections BEGIN
				SELECT RAISE(ABORT, 'watermark inspection records are immutable');
			END`);
		database.exec(`CREATE TRIGGER IF NOT EXISTS watermark_inspections_no_delete
			BEFORE DELETE ON watermark_inspections BEGIN
				SELECT RAISE(ABORT, 'watermark inspection records are immutable');
			END`);
		database.exec(`CREATE TABLE IF NOT EXISTS export_review_signoffs(
			event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			signoff_id TEXT NOT NULL UNIQUE,
			operation_id TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			scene_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			record_json TEXT NOT NULL,
			record_checksum TEXT NOT NULL
		)`);
		database.exec(`CREATE TRIGGER IF NOT EXISTS export_review_signoffs_no_update
			BEFORE UPDATE ON export_review_signoffs BEGIN
				SELECT RAISE(ABORT, 'export review sign-off records are immutable');
			END`);
		database.exec(`CREATE TRIGGER IF NOT EXISTS export_review_signoffs_no_delete
			BEFORE DELETE ON export_review_signoffs BEGIN
				SELECT RAISE(ABORT, 'export review sign-off records are immutable');
			END`);
		this.database = database;
	}

	private parseRow(row: AnnotationRow): ReviewAnnotationRecord {
		if (sha256(row.record_json) !== row.record_checksum) {
			throw new ReviewEvidenceIntegrityError(
				`review annotation row ${row.event_sequence} checksum mismatch`,
			);
		}
		try {
			return annotationSchema.parse(JSON.parse(row.record_json));
		} catch (error) {
			throw new ReviewEvidenceIntegrityError(
				`review annotation row ${row.event_sequence} is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private parseWatermarkRow(row: AnnotationRow): WatermarkInspectionRecord {
		if (sha256(row.record_json) !== row.record_checksum) {
			throw new ReviewEvidenceIntegrityError(
				`watermark inspection row ${row.event_sequence} checksum mismatch`,
			);
		}
		try {
			return watermarkInspectionSchema.parse(JSON.parse(row.record_json));
		} catch (error) {
			throw new ReviewEvidenceIntegrityError(
				`watermark inspection row ${row.event_sequence} is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private parseSignoffRow(row: AnnotationRow): ExportReviewSignoffRecord {
		if (sha256(row.record_json) !== row.record_checksum) {
			throw new ReviewEvidenceIntegrityError(
				`export review sign-off row ${row.event_sequence} checksum mismatch`,
			);
		}
		try {
			return exportReviewSignoffSchema.parse(JSON.parse(row.record_json));
		} catch (error) {
			throw new ReviewEvidenceIntegrityError(
				`export review sign-off row ${row.event_sequence} is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("review evidence store is not ready");
		return this.database;
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
