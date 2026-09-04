import { Database } from "bun:sqlite";
import { canonicalSerialize } from "@opencut/canonical-json";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod/v4";

export const HISTORY_CHECKPOINT_SCHEMA =
	"opencut.history-checkpoint.v1" as const;
const DATABASE_NAME = "history-checkpoints.sqlite";
const identifierSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativeEntrySchema = z
	.object({
		entryId: z.number().int().positive(),
		commandName: z.string().min(1).max(512),
	})
	.strict();
const nativeHistorySchema = z
	.object({
		activitySequence: z.number().int().nonnegative(),
		history: z.array(nativeEntrySchema).max(10_000),
		redo: z.array(nativeEntrySchema).max(10_000),
		pending: z.null(),
		rippleEnabled: z.boolean(),
	})
	.strict();
const checkpointSchema = z
	.object({
		schemaVersion: z.literal(HISTORY_CHECKPOINT_SCHEMA),
		checkpointId: identifierSchema,
		operationId: identifierSchema,
		name: z.string().trim().min(1).max(256),
		projectId: identifierSchema,
		sceneId: identifierSchema,
		revision: z.number().int().nonnegative(),
		contentHash: digestSchema,
		contentHashProjectionVersion: z.union([
			z.literal(1),
			z.literal(2),
			z.literal(3),
		]),
		createdAt: z.iso.datetime({ offset: true }),
		connectionIdentity: z
			.object({
				serverInstanceId: identifierSchema,
				editorInstanceId: identifierSchema,
				editorSessionId: identifierSchema,
				connectionGeneration: z.number().int().positive(),
				bridgeProtocolVersion: z.literal(2),
			})
			.strict(),
		nativeHistory: nativeHistorySchema,
	})
	.strict();

export type HistoryCheckpointRecord = z.infer<typeof checkpointSchema>;

type CheckpointRow = {
	event_sequence: number;
	record_json: string;
	record_checksum: string;
};

export class HistoryCheckpointIntegrityError extends Error {
	readonly code = "HISTORY_CHECKPOINT_INTEGRITY_FAILED";

	constructor(message: string) {
		super(message);
		this.name = "HistoryCheckpointIntegrityError";
	}
}

export class HistoryCheckpointStore {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;
	private readinessPromise: Promise<void> | null = null;

	constructor(directory: string) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, DATABASE_NAME);
	}

	async readiness(): Promise<void> {
		if (this.database) return;
		this.readinessPromise ??= this.initialize().catch((error) => {
			this.readinessPromise = null;
			throw error;
		});
		await this.readinessPromise;
	}

	async create(record: HistoryCheckpointRecord): Promise<HistoryCheckpointRecord> {
		await this.readiness();
		const parsed = checkpointSchema.parse(record);
		const json = canonicalSerialize(parsed);
		const checksum = sha256(json);
		try {
			this.requireDatabase()
				.query(`INSERT INTO history_checkpoints(
					checkpoint_id, operation_id, project_id, scene_id, name,
					created_at, record_json, record_checksum
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					parsed.checkpointId,
					parsed.operationId,
					parsed.projectId,
					parsed.sceneId,
					parsed.name,
					parsed.createdAt,
					json,
					checksum,
				);
		} catch (error) {
			if (String(error).includes("UNIQUE constraint failed")) {
				throw new Error(`checkpoint ${parsed.checkpointId} already exists`);
			}
			throw error;
		}
		return parsed;
	}

	async get(checkpointId: string): Promise<HistoryCheckpointRecord | null> {
		await this.readiness();
		const row = this.requireDatabase()
			.query("SELECT event_sequence, record_json, record_checksum FROM history_checkpoints WHERE checkpoint_id=?")
			.get(checkpointId) as CheckpointRow | null;
		return row ? this.parseRow(row) : null;
	}

	async list(input: {
		limit: number;
		cursor?: string;
		projectId?: string;
		sceneId?: string;
	}): Promise<{ entries: HistoryCheckpointRecord[]; nextCursor: string | null }> {
		await this.readiness();
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
			throw new Error("checkpoint list limit must be between 1 and 100");
		}
		const cursor = input.cursor === undefined ? null : Number(input.cursor);
		if (
			cursor !== null &&
			(!Number.isSafeInteger(cursor) || cursor < 1 || String(cursor) !== input.cursor)
		) {
			throw new Error("invalid checkpoint cursor");
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
			.query(`SELECT event_sequence, record_json, record_checksum
				FROM history_checkpoints
				${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
				ORDER BY event_sequence DESC LIMIT ?`)
			.all(...values, input.limit + 1) as CheckpointRow[];
		const hasMore = rows.length > input.limit;
		const page = rows.slice(0, input.limit);
		return {
			entries: page.map((row) => this.parseRow(row)),
			nextCursor:
				hasMore && page.length > 0
					? String(page[page.length - 1]!.event_sequence)
					: null,
		};
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
		database.exec(`CREATE TABLE IF NOT EXISTS history_checkpoints(
			event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			checkpoint_id TEXT NOT NULL UNIQUE,
			operation_id TEXT NOT NULL UNIQUE,
			project_id TEXT NOT NULL,
			scene_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL,
			record_json TEXT NOT NULL,
			record_checksum TEXT NOT NULL
		)`);
		database.exec("CREATE INDEX IF NOT EXISTS history_checkpoints_project_sequence ON history_checkpoints(project_id, event_sequence DESC)");
		database.exec("CREATE INDEX IF NOT EXISTS history_checkpoints_scene_sequence ON history_checkpoints(scene_id, event_sequence DESC)");
		this.database = database;
	}

	private parseRow(row: CheckpointRow): HistoryCheckpointRecord {
		if (sha256(row.record_json) !== row.record_checksum) {
			throw new HistoryCheckpointIntegrityError(
				`checkpoint row ${row.event_sequence} checksum mismatch`,
			);
		}
		try {
			return checkpointSchema.parse(JSON.parse(row.record_json));
		} catch (error) {
			throw new HistoryCheckpointIntegrityError(
				`checkpoint row ${row.event_sequence} is invalid: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("history checkpoint store is not ready");
		return this.database;
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
