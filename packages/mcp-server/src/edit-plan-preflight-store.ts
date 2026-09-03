import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import {
	browserEditPlanPreflightResponseSchema,
	canonicalEditPlanJson,
} from "./edit-plan-preflight-contract";

const DATABASE_NAME = "edit-plan-preflights.sqlite";
const SCHEMA_VERSION = 1;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		receiptId: z.string().min(1).max(512),
		preflightId: z.string().min(1).max(256),
		requestFingerprint: digestSchema,
		planFingerprint: digestSchema,
		preflightFingerprint: digestSchema.nullable(),
		planDiffHash: digestSchema.nullable(),
		projectId: z.string().min(1).max(256),
		sceneId: z.string().min(1).max(256),
		revision: z.number().int().nonnegative(),
		contentHash: digestSchema,
		writeVersion: z.number().int().positive(),
		saveReceiptOperationId: z.string().min(1).max(256),
		saveReceiptId: z.string().min(1).max(512),
		createdAt: z.iso.datetime({ offset: true }),
		terminalResult: browserEditPlanPreflightResponseSchema,
	})
	.strict()
	.superRefine((value, context) => {
		try {
			canonicalEditPlanJson(value.terminalResult);
		} catch (error) {
			context.addIssue({
				code: "custom",
				path: ["terminalResult"],
				message: error instanceof Error ? error.message : "invalid result JSON",
				input: value.terminalResult,
			});
		}
	});

export type EditPlanPreflightReceipt = z.infer<typeof receiptSchema>;

export class EditPlanPreflightReuseError extends Error {
	readonly code = "PREFLIGHT_ID_REUSED";
	constructor(preflightId: string) {
		super(`preflightId ${preflightId} was already used with different input`);
		this.name = "EditPlanPreflightReuseError";
	}
}

export class EditPlanPreflightIntegrityError extends Error {
	readonly code = "PREFLIGHT_INTEGRITY_FAILED";
	constructor(message: string) {
		super(message);
		this.name = "EditPlanPreflightIntegrityError";
	}
}

export type EditPlanPreflightClaim =
	| { status: "claimed" }
	| { status: "in-progress" }
	| { status: "replayed"; receipt: EditPlanPreflightReceipt };

type ReceiptRow = {
	receipt_id: string;
	preflight_id: string;
	event_sequence: number;
	receipt_json: string;
	receipt_checksum: string;
};

export class EditPlanPreflightStore {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;
	private readinessPromise: Promise<void> | null = null;
	private readonly ownerNonce = randomUUID();

	constructor(directory: string) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, DATABASE_NAME);
	}

	async readiness(): Promise<void> {
		if (this.database) return;
		if (!this.readinessPromise) {
			this.readinessPromise = this.initialize().catch((error) => {
				this.readinessPromise = null;
				throw error;
			});
		}
		await this.readinessPromise;
	}

	async claim(
		preflightId: string,
		requestFingerprint: string,
	): Promise<EditPlanPreflightClaim> {
		validateIdentity(preflightId, requestFingerprint);
		await this.readiness();
		return withImmediate(this.requireDatabase(), () => {
			const row = this.requireDatabase()
				.query("SELECT request_fingerprint, status, receipt_id, owner_pid, owner_nonce FROM preflight_claims WHERE preflight_id=?")
				.get(preflightId) as {
				request_fingerprint: string;
				status: "started" | "completed";
				receipt_id: string | null;
				owner_pid: number;
				owner_nonce: string;
			} | null;
			if (row) {
				if (row.request_fingerprint !== requestFingerprint) {
					throw new EditPlanPreflightReuseError(preflightId);
				}
				if (row.status === "completed" && row.receipt_id) {
					return { status: "replayed", receipt: this.requireReceipt(row.receipt_id) };
				}
				if (!pidIsAlive(row.owner_pid)) {
					this.requireDatabase()
						.query("UPDATE preflight_claims SET owner_pid=?, owner_nonce=? WHERE preflight_id=? AND status='started' AND owner_pid=? AND owner_nonce=?")
						.run(process.pid, this.ownerNonce, preflightId, row.owner_pid, row.owner_nonce);
					this.appendEvent(preflightId, "adopted", {
						ownerPid: process.pid,
						ownerNonce: this.ownerNonce,
					});
					return { status: "claimed" };
				}
				return { status: "in-progress" };
			}
			const createdAt = new Date().toISOString();
			this.requireDatabase()
				.query("INSERT INTO preflight_claims(preflight_id, request_fingerprint, status, owner_pid, owner_nonce, created_at) VALUES (?, ?, 'started', ?, ?, ?)")
				.run(preflightId, requestFingerprint, process.pid, this.ownerNonce, createdAt);
			this.appendEvent(preflightId, "claimed", {
				requestFingerprint,
				createdAt,
				ownerPid: process.pid,
				ownerNonce: this.ownerNonce,
			});
			return { status: "claimed" };
		});
	}

	async complete(
		receipt: EditPlanPreflightReceipt,
	): Promise<EditPlanPreflightReceipt> {
		return this.publish(receipt, false);
	}

	async reconcile(
		receipt: EditPlanPreflightReceipt,
	): Promise<EditPlanPreflightReceipt> {
		return this.publish(receipt, true);
	}

	private async publish(
		receipt: EditPlanPreflightReceipt,
		allowExternalReceipt: boolean,
	): Promise<EditPlanPreflightReceipt> {
		await this.readiness();
		const parsed = receiptSchema.parse(receipt);
		const result = await withImmediate(this.requireDatabase(), () => {
			const claim = this.requireDatabase()
				.query("SELECT request_fingerprint, status, receipt_id, owner_pid, owner_nonce FROM preflight_claims WHERE preflight_id=?")
				.get(parsed.preflightId) as {
				request_fingerprint: string;
				status: "started" | "completed";
				receipt_id: string | null;
				owner_pid: number;
				owner_nonce: string;
			} | null;
			if (!claim) throw new Error("preflight must be claimed before completion");
			if (claim.request_fingerprint !== parsed.requestFingerprint) {
				throw new EditPlanPreflightReuseError(parsed.preflightId);
			}
			if (claim.status === "completed" && claim.receipt_id) {
				const prior = this.requireReceipt(claim.receipt_id);
				if (canonicalEditPlanJson(prior) !== canonicalEditPlanJson(parsed)) {
					throw new EditPlanPreflightReuseError(parsed.preflightId);
				}
				return prior;
			}
			if (
				!allowExternalReceipt &&
				(claim.owner_pid !== process.pid || claim.owner_nonce !== this.ownerNonce)
			) {
				throw new Error("preflight completion was fenced by another owner");
			}
			const eventSequence = this.nextEventSequence();
			const receiptJson = canonicalEditPlanJson(parsed);
			const receiptChecksum = sha256(receiptJson);
			this.requireDatabase()
				.query(`INSERT INTO preflight_receipts(
					receipt_id, preflight_id, project_id, scene_id, event_sequence,
					created_at, receipt_json, receipt_checksum
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`) 
				.run(
					parsed.receiptId,
					parsed.preflightId,
					parsed.projectId,
					parsed.sceneId,
					eventSequence,
					parsed.createdAt,
					receiptJson,
					receiptChecksum,
				);
			this.requireDatabase()
				.query("UPDATE preflight_claims SET status='completed', receipt_id=?, completed_at=? WHERE preflight_id=? AND status='started'")
				.run(parsed.receiptId, parsed.createdAt, parsed.preflightId);
			this.appendEvent(parsed.preflightId, "completed", {
				receiptId: parsed.receiptId,
				receiptChecksum,
			}, eventSequence);
			return parsed;
		});
		await syncDirectory(this.directory);
		return result;
	}

	async get(receiptId: string): Promise<EditPlanPreflightReceipt | null> {
		await this.readiness();
		await withImmediate(this.requireDatabase(), () =>
			verifyDatabase(this.requireDatabase()),
		);
		const row = this.requireDatabase()
			.query("SELECT receipt_id, preflight_id, event_sequence, receipt_json, receipt_checksum FROM preflight_receipts WHERE receipt_id=?")
			.get(receiptId) as ReceiptRow | null;
		return row ? parseReceiptRow(row) : null;
	}

	async getByPreflightId(
		preflightId: string,
	): Promise<EditPlanPreflightReceipt | null> {
		await this.readiness();
		return withReadTransaction(this.requireDatabase(), () => {
			verifyDatabase(this.requireDatabase());
			const row = this.requireDatabase()
				.query("SELECT receipt_id, preflight_id, event_sequence, receipt_json, receipt_checksum FROM preflight_receipts WHERE preflight_id=?")
				.get(preflightId) as ReceiptRow | null;
			return row ? parseReceiptRow(row) : null;
		});
	}

	async list(input: {
		projectId?: string;
		sceneId?: string;
		limit: number;
		cursor?: string;
	}): Promise<{ receipts: EditPlanPreflightReceipt[]; nextCursor?: string }> {
		await this.readiness();
		await withImmediate(this.requireDatabase(), () =>
			verifyDatabase(this.requireDatabase()),
		);
		if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
			throw new Error("preflight list limit must be between 1 and 100");
		}
		const cursor = input.cursor
			? decodeCursor(input.cursor, input.projectId, input.sceneId)
			: null;
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (input.projectId) {
			clauses.push("project_id=?");
			params.push(input.projectId);
		}
		if (input.sceneId) {
			clauses.push("scene_id=?");
			params.push(input.sceneId);
		}
		if (cursor) {
			clauses.push("(event_sequence < ? OR (event_sequence = ? AND receipt_id < ?))");
			params.push(cursor.sequence, cursor.sequence, cursor.receiptId);
		}
		const rows = this.requireDatabase()
			.query(`SELECT receipt_id, preflight_id, event_sequence, receipt_json, receipt_checksum
				FROM preflight_receipts ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
				ORDER BY event_sequence DESC, receipt_id DESC LIMIT ?`)
			.all(...params, input.limit + 1) as ReceiptRow[];
		const page = rows.slice(0, input.limit);
		const receipts = page.map(parseReceiptRow);
		const last = page.at(-1);
		return {
			receipts,
			...(rows.length > input.limit && last
				? {
						nextCursor: encodeCursor(
							last.event_sequence,
							last.receipt_id,
							input.projectId,
							input.sceneId,
						),
					}
				: {}),
		};
	}

	close(): void {
		if (this.database) {
			try {
				this.database.exec("PRAGMA wal_checkpoint(FULL)");
			} finally {
				this.database.close();
			}
		}
		this.database = null;
		this.readinessPromise = null;
	}

	private async initialize(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const database = new Database(this.databasePath, { create: true, strict: true });
		try {
			database.exec("PRAGMA busy_timeout=10000");
			await setWal(database);
			database.exec("PRAGMA synchronous=FULL");
			database.exec("PRAGMA foreign_keys=ON");
			await withImmediate(database, () => initializeSchema(database));
			verifyDatabase(database);
		} catch (error) {
			database.close();
			throw error;
		}
		this.database = database;
		await syncDirectory(this.directory);
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("preflight store is not ready");
		return this.database;
	}

	private requireReceipt(receiptId: string): EditPlanPreflightReceipt {
		const row = this.requireDatabase()
			.query("SELECT receipt_id, preflight_id, event_sequence, receipt_json, receipt_checksum FROM preflight_receipts WHERE receipt_id=?")
			.get(receiptId) as ReceiptRow | null;
		if (!row) throw new EditPlanPreflightIntegrityError("completed claim has no receipt");
		return parseReceiptRow(row);
	}

	private nextEventSequence(): number {
		const row = this.requireDatabase()
			.query("SELECT last_sequence FROM preflight_metadata WHERE singleton=1")
			.get() as { last_sequence: number };
		return row.last_sequence + 1;
	}

	private appendEvent(
		preflightId: string,
		eventType: "claimed" | "adopted" | "completed",
		payload: unknown,
		sequence = this.nextEventSequence(),
	): void {
		const metadata = this.requireDatabase()
			.query("SELECT event_count, last_sequence, last_hash FROM preflight_metadata WHERE singleton=1")
			.get() as { event_count: number; last_sequence: number; last_hash: string };
		if (sequence !== metadata.last_sequence + 1) {
			throw new EditPlanPreflightIntegrityError("event sequence is not monotonic");
		}
		const eventJson = canonicalEditPlanJson(payload);
		const eventHash = sha256(
			canonicalEditPlanJson({
				sequence,
				preflightId,
				eventType,
				eventJson,
				previousHash: metadata.last_hash,
			}),
		);
		this.requireDatabase()
			.query("INSERT INTO preflight_events(sequence, preflight_id, event_type, event_json, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?)")
			.run(sequence, preflightId, eventType, eventJson, metadata.last_hash, eventHash);
		this.requireDatabase()
			.query("UPDATE preflight_metadata SET event_count=?, last_sequence=?, last_hash=? WHERE singleton=1")
			.run(metadata.event_count + 1, sequence, eventHash);
	}
}

function initializeSchema(database: Database): void {
	const version = Number(
		(database.query("PRAGMA user_version").get() as { user_version: number })
			.user_version,
	);
	if (version !== 0 && version !== SCHEMA_VERSION) {
		throw new Error(`unsupported edit-plan preflight schema version: ${version}`);
	}
	database.exec(`CREATE TABLE IF NOT EXISTS preflight_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton=1),
		schema_version INTEGER NOT NULL,
		event_count INTEGER NOT NULL,
		last_sequence INTEGER NOT NULL,
		last_hash TEXT NOT NULL
	) STRICT;
	INSERT OR IGNORE INTO preflight_metadata VALUES (1, ${SCHEMA_VERSION}, 0, 0, '${"0".repeat(64)}');
	CREATE TABLE IF NOT EXISTS preflight_claims (
		preflight_id TEXT PRIMARY KEY,
		request_fingerprint TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('started','completed')),
		owner_pid INTEGER NOT NULL,
		owner_nonce TEXT NOT NULL,
		receipt_id TEXT UNIQUE,
		created_at TEXT NOT NULL,
		completed_at TEXT
	) STRICT;
	CREATE TABLE IF NOT EXISTS preflight_receipts (
		receipt_id TEXT PRIMARY KEY,
		preflight_id TEXT NOT NULL UNIQUE,
		project_id TEXT NOT NULL,
		scene_id TEXT NOT NULL,
		event_sequence INTEGER NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		receipt_json TEXT NOT NULL,
		receipt_checksum TEXT NOT NULL,
		FOREIGN KEY(preflight_id) REFERENCES preflight_claims(preflight_id)
	) STRICT;
	CREATE TABLE IF NOT EXISTS preflight_events (
		sequence INTEGER PRIMARY KEY,
		preflight_id TEXT NOT NULL,
		event_type TEXT NOT NULL CHECK(event_type IN ('claimed','adopted','completed')),
		event_json TEXT NOT NULL,
		previous_hash TEXT NOT NULL,
		event_hash TEXT NOT NULL
	) STRICT;
	CREATE INDEX IF NOT EXISTS preflight_receipts_source
		ON preflight_receipts(project_id, scene_id, event_sequence DESC, receipt_id DESC);
	CREATE TRIGGER IF NOT EXISTS preflight_receipts_immutable
		BEFORE UPDATE ON preflight_receipts BEGIN SELECT RAISE(ABORT, 'preflight receipt is immutable'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_receipts_no_delete
		BEFORE DELETE ON preflight_receipts BEGIN SELECT RAISE(ABORT, 'preflight receipt is append-only'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_events_immutable
		BEFORE UPDATE ON preflight_events BEGIN SELECT RAISE(ABORT, 'preflight event is immutable'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_events_no_delete
		BEFORE DELETE ON preflight_events BEGIN SELECT RAISE(ABORT, 'preflight event is append-only'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_claims_no_delete
		BEFORE DELETE ON preflight_claims BEGIN SELECT RAISE(ABORT, 'preflight claim is append-only'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_metadata_no_delete
		BEFORE DELETE ON preflight_metadata BEGIN SELECT RAISE(ABORT, 'preflight metadata is required'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_claim_identity_immutable
		BEFORE UPDATE ON preflight_claims
		WHEN OLD.preflight_id != NEW.preflight_id OR OLD.request_fingerprint != NEW.request_fingerprint
		BEGIN SELECT RAISE(ABORT, 'preflight identity is immutable'); END;
	CREATE TRIGGER IF NOT EXISTS preflight_claim_terminal_immutable
		BEFORE UPDATE ON preflight_claims WHEN OLD.status='completed'
		BEGIN SELECT RAISE(ABORT, 'preflight terminal result is immutable'); END;
	PRAGMA user_version=${SCHEMA_VERSION};`);
}

function verifyDatabase(database: Database): void {
	const quick = database.query("PRAGMA quick_check").get() as { quick_check: string };
	const journal = database.query("PRAGMA journal_mode").get() as { journal_mode: string };
	const sync = database.query("PRAGMA synchronous").get() as { synchronous: number };
	if (
		quick.quick_check !== "ok" ||
		journal.journal_mode.toLowerCase() !== "wal" ||
		sync.synchronous !== 2
	) {
		throw new EditPlanPreflightIntegrityError("SQLite durability or integrity preflight failed");
	}
	const requiredTriggers = new Set([
		"preflight_receipts_immutable",
		"preflight_receipts_no_delete",
		"preflight_events_immutable",
		"preflight_events_no_delete",
		"preflight_claims_no_delete",
		"preflight_metadata_no_delete",
		"preflight_claim_identity_immutable",
		"preflight_claim_terminal_immutable",
	]);
	const installedTriggers = database
		.query("SELECT name FROM sqlite_master WHERE type='trigger'")
		.all() as Array<{ name: string }>;
	for (const name of installedTriggers.map(({ name }) => name)) {
		requiredTriggers.delete(name);
	}
	if (requiredTriggers.size > 0) {
		throw new EditPlanPreflightIntegrityError("preflight integrity triggers are missing");
	}
	const metadata = database
		.query("SELECT schema_version, event_count, last_sequence, last_hash FROM preflight_metadata WHERE singleton=1")
		.get() as {
		schema_version: number;
		event_count: number;
		last_sequence: number;
		last_hash: string;
	} | null;
	if (!metadata || metadata.schema_version !== SCHEMA_VERSION) {
		throw new EditPlanPreflightIntegrityError("preflight metadata schema mismatch");
	}
	const rows = database
		.query("SELECT sequence, preflight_id, event_type, event_json, previous_hash, event_hash FROM preflight_events ORDER BY sequence")
		.all() as Array<{
		sequence: number;
		preflight_id: string;
		event_type: string;
		event_json: string;
		previous_hash: string;
		event_hash: string;
	}>;
	let previousHash = "0".repeat(64);
	for (const [index, row] of rows.entries()) {
		if (row.sequence !== index + 1 || row.previous_hash !== previousHash) {
			throw new EditPlanPreflightIntegrityError("preflight event sequence or chain is corrupt");
		}
		const expected = sha256(
			canonicalEditPlanJson({
				sequence: row.sequence,
				preflightId: row.preflight_id,
				eventType: row.event_type,
				eventJson: row.event_json,
				previousHash,
			}),
		);
		if (row.event_hash !== expected) {
			throw new EditPlanPreflightIntegrityError("preflight event hash is corrupt");
		}
		previousHash = row.event_hash;
	}
	if (
		metadata.event_count !== rows.length ||
		metadata.last_sequence !== rows.length ||
		metadata.last_hash !== previousHash
	) {
		throw new EditPlanPreflightIntegrityError("preflight event tail is missing or inconsistent");
	}
	const receipts = database
		.query("SELECT receipt_id, preflight_id, event_sequence, receipt_json, receipt_checksum FROM preflight_receipts")
		.all() as ReceiptRow[];
	for (const row of receipts) parseReceiptRow(row);
	verifyClaimProjection(database, rows, receipts);
}

function verifyClaimProjection(
	database: Database,
	events: Array<{
		sequence: number;
		preflight_id: string;
		event_type: string;
		event_json: string;
	}>,
	receipts: ReceiptRow[],
): void {
	const claims = database
		.query("SELECT preflight_id, request_fingerprint, status, owner_pid, owner_nonce, receipt_id, created_at FROM preflight_claims")
		.all() as Array<{
			preflight_id: string;
			request_fingerprint: string;
			status: "started" | "completed";
			owner_pid: number;
			owner_nonce: string;
			receipt_id: string | null;
			created_at: string;
		}>;
	if (claims.length === 0 && events.length > 0) {
		throw new EditPlanPreflightIntegrityError("preflight events have no claims");
	}
	const claimIds = new Set(claims.map((claim) => claim.preflight_id));
	if (events.some((event) => !claimIds.has(event.preflight_id))) {
		throw new EditPlanPreflightIntegrityError("preflight event references a missing claim");
	}
	const receiptsByClaim = new Map(receipts.map((row) => [row.preflight_id, row]));
	for (const claim of claims) {
		const history = events.filter((event) => event.preflight_id === claim.preflight_id);
		if (history.length === 0 || history[0]?.event_type !== "claimed") {
			throw new EditPlanPreflightIntegrityError("preflight claim history is missing");
		}
		let ownerPid = 0;
		let ownerNonce = "";
		let completedReceiptId: string | null = null;
		for (const [index, event] of history.entries()) {
			let payload: unknown;
			try {
				payload = JSON.parse(event.event_json);
			} catch {
				throw new EditPlanPreflightIntegrityError("preflight event payload is corrupt");
			}
			if (event.event_type === "claimed") {
				if (index !== 0) throw new EditPlanPreflightIntegrityError("preflight claim was duplicated");
				const parsed = z.object({ requestFingerprint: digestSchema, createdAt: z.iso.datetime({ offset: true }), ownerPid: z.number().int().positive(), ownerNonce: z.string().uuid() }).strict().safeParse(payload);
				if (!parsed.success || parsed.data.requestFingerprint !== claim.request_fingerprint || parsed.data.createdAt !== claim.created_at) {
					throw new EditPlanPreflightIntegrityError("preflight claim identity projection is corrupt");
				}
				ownerPid = parsed.data.ownerPid;
				ownerNonce = parsed.data.ownerNonce;
			} else if (event.event_type === "adopted") {
				if (completedReceiptId) throw new EditPlanPreflightIntegrityError("preflight terminal history was extended");
				const parsed = z.object({ ownerPid: z.number().int().positive(), ownerNonce: z.string().uuid() }).strict().safeParse(payload);
				if (!parsed.success) throw new EditPlanPreflightIntegrityError("preflight adoption projection is corrupt");
				ownerPid = parsed.data.ownerPid;
				ownerNonce = parsed.data.ownerNonce;
			} else if (event.event_type === "completed") {
				if (completedReceiptId) throw new EditPlanPreflightIntegrityError("preflight completed twice");
				const parsed = z.object({ receiptId: z.string().min(1).max(512), receiptChecksum: digestSchema }).strict().safeParse(payload);
				if (!parsed.success) throw new EditPlanPreflightIntegrityError("preflight completion projection is corrupt");
				const receipt = receiptsByClaim.get(claim.preflight_id);
				if (!receipt || receipt.receipt_id !== parsed.data.receiptId || receipt.receipt_checksum !== parsed.data.receiptChecksum) {
					throw new EditPlanPreflightIntegrityError("preflight completion receipt projection is corrupt");
				}
				completedReceiptId = parsed.data.receiptId;
			}
		}
		if (ownerPid !== claim.owner_pid || ownerNonce !== claim.owner_nonce) {
			throw new EditPlanPreflightIntegrityError("preflight claim owner projection is corrupt");
		}
		if (
			(claim.status === "completed" && completedReceiptId !== claim.receipt_id) ||
			(claim.status === "started" && (completedReceiptId || claim.receipt_id))
		) {
			throw new EditPlanPreflightIntegrityError("preflight claim terminal projection is corrupt");
		}
	}
}

function parseReceiptRow(row: ReceiptRow): EditPlanPreflightReceipt {
	if (sha256(row.receipt_json) !== row.receipt_checksum) {
		throw new EditPlanPreflightIntegrityError("preflight receipt checksum mismatch");
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(row.receipt_json);
	} catch {
		throw new EditPlanPreflightIntegrityError("preflight receipt JSON is corrupt");
	}
	const parsed = receiptSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new EditPlanPreflightIntegrityError("preflight receipt schema is corrupt");
	}
	if (parsed.data.receiptId !== row.receipt_id || parsed.data.preflightId !== row.preflight_id) {
		throw new EditPlanPreflightIntegrityError("preflight receipt index binding mismatch");
	}
	return parsed.data;
}

async function setWal(database: Database): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			database.exec("PRAGMA journal_mode=WAL");
			return;
		} catch (error) {
			if (!isBusy(error) || attempt === 19) throw error;
			await Bun.sleep(Math.min(10 * 2 ** attempt, 250));
		}
	}
}

async function withImmediate<T>(database: Database, action: () => T): Promise<T> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = action();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					database.exec("ROLLBACK");
				} catch {}
				throw error;
			}
		} catch (error) {
			if (!isBusy(error) || attempt === 19) throw error;
			await Bun.sleep(Math.min(10 * 2 ** attempt, 250));
		}
	}
	throw new Error("unreachable SQLite retry state");
}

async function withReadTransaction<T>(
	database: Database,
	action: () => T,
): Promise<T> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			database.exec("BEGIN");
			try {
				const result = action();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					database.exec("ROLLBACK");
				} catch {}
				throw error;
			}
		} catch (error) {
			if (!isBusy(error) || attempt === 19) throw error;
			await Bun.sleep(Math.min(10 * 2 ** attempt, 250));
		}
	}
	throw new Error("unreachable SQLite retry state");
}

function validateIdentity(preflightId: string, fingerprint: string): void {
	if (!preflightId || preflightId.length > 256) throw new Error("invalid preflightId");
	if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
		throw new Error("request fingerprint must be lowercase SHA-256");
	}
}

function encodeCursor(
	sequence: number,
	receiptId: string,
	projectId?: string,
	sceneId?: string,
): string {
	return Buffer.from(
		JSON.stringify({
			v: 1,
			sequence,
			receiptId,
			projectId: projectId ?? null,
			sceneId: sceneId ?? null,
		}),
	).toString("base64url");
}

function decodeCursor(
	value: string,
	projectId?: string,
	sceneId?: string,
): { sequence: number; receiptId: string } {
	if (value.length > 512) throw new Error("cursor exceeds 512-character limit");
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new Error("invalid preflight cursor");
	}
	const schema = z
		.object({
			v: z.literal(1),
			sequence: z.number().int().positive(),
			receiptId: z.string().min(1).max(512),
			projectId: z.string().min(1).max(256).nullable(),
			sceneId: z.string().min(1).max(256).nullable(),
		})
		.strict();
	const parsed = schema.safeParse(decoded);
	if (!parsed.success) throw new Error("invalid preflight cursor");
	if (
		parsed.data.projectId !== (projectId ?? null) ||
		parsed.data.sceneId !== (sceneId ?? null)
	) {
		throw new Error("preflight cursor does not match the requested filters");
	}
	return parsed.data;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isBusy(error: unknown): boolean {
	return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

function pidIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r").catch(() => null);
	if (!handle) return;
	try {
		await handle.sync().catch(() => undefined);
	} finally {
		await handle.close();
	}
}
