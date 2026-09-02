import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	OPERATION_LEDGER_SCHEMA_VERSION,
	OperationLedgerUnsupportedVersionError,
	parseOperationLedgerRecord,
	type OperationLedgerRecord,
} from "./operation-ledger-schema";

const DATABASE_NAME = "operation-ledger.sqlite";
const SQLITE_SCHEMA_VERSION = 1;

type RecordDraft = Omit<
	OperationLedgerRecord,
	"eventSequence" | "previousChecksum"
>;

export interface ReadJournal {
	versions: OperationLedgerRecord[];
	recoveryWarnings: string[];
}

export interface OperationLedgerReadiness {
	databasePath: string;
	journalMode: "wal";
	synchronous: "full";
	foreignKeys: true;
	integrity: "ok";
}

export class OperationLedgerCorruptionError extends Error {
	readonly code = "OPERATION_LEDGER_CORRUPT";
	constructor(
		message: string,
		readonly path: string,
	) {
		super(message);
		this.name = "OperationLedgerCorruptionError";
	}
}

export class OperationLedgerReadinessError extends Error {
	readonly code = "OPERATION_LEDGER_NOT_DURABLE";
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "OperationLedgerReadinessError";
	}
}

export class OperationLedgerGuardError extends Error {
	readonly code = "OPERATION_LEDGER_GUARD_REJECTED";
	constructor(
		readonly reason:
			| "missing"
			| "fingerprint"
			| "lease"
			| "not-expired"
			| "terminal"
			| "terminal-mismatch",
		readonly operationId: string,
	) {
		super(`operation append guard rejected: ${reason}`);
		this.name = "OperationLedgerGuardError";
	}
}

export interface GuardedAppend {
	operationId: string;
	inputFingerprint: string;
	mode: "adopt" | "nonterminal" | "terminal";
	ownerId?: string;
	fencingToken: string;
	nowMs?: number;
	allowUnexpiredOwnerId?: string;
	build: (current: OperationLedgerRecord) => RecordDraft;
	replayMatches?: (terminal: OperationLedgerRecord) => boolean;
}

export class OperationLedgerStorage {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;
	private readinessResult: OperationLedgerReadiness | null = null;

	constructor(directory: string) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, DATABASE_NAME);
	}

	operationDirectory(_operationId: string): string {
		return this.databasePath;
	}

	async initialize(_createdAt: string): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		let database: Database | null = null;
		try {
			database = new Database(this.databasePath, {
				create: true,
				strict: true,
			});
			database.exec("PRAGMA busy_timeout=10000");
			database.exec("PRAGMA foreign_keys=ON");
			const journalMode = await enableWal(database);
			database.exec("PRAGMA synchronous=FULL");
			if (journalMode !== "wal") {
				throw new OperationLedgerReadinessError(
					`SQLite WAL is unavailable: ${journalMode}`,
				);
			}
			database.exec("BEGIN IMMEDIATE");
			try {
				this.initializeSchema(database);
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			verifyDatabase(database, this.databasePath);
			const operationIds = database
				.query("SELECT DISTINCT operation_id FROM operation_versions")
				.all() as Array<{ operation_id: string }>;
			for (const { operation_id } of operationIds) {
				this.readVersions(database, operation_id);
			}
			if (
				pragmaNumber(database, "PRAGMA synchronous", "synchronous") !== 2 ||
				pragmaNumber(database, "PRAGMA foreign_keys", "foreign_keys") !== 1
			) {
				throw new OperationLedgerReadinessError(
					"SQLite durability pragmas were not retained",
				);
			}
		} catch (error) {
			database?.close();
			if (
				error instanceof OperationLedgerUnsupportedVersionError ||
				error instanceof OperationLedgerReadinessError ||
				error instanceof OperationLedgerCorruptionError
			)
				throw error;
			throw new OperationLedgerReadinessError(
				"SQLite ledger failed readiness",
				error,
			);
		}
		if (!database) {
			throw new OperationLedgerReadinessError("SQLite ledger did not open");
		}
		this.database = database;
		this.readinessResult = {
			databasePath: this.databasePath,
			journalMode: "wal",
			synchronous: "full",
			foreignKeys: true,
			integrity: "ok",
		};
	}

	readiness(): OperationLedgerReadiness {
		if (!this.readinessResult)
			throw new OperationLedgerReadinessError("ledger is not initialized");
		return this.readinessResult;
	}

	close(): void {
		this.database?.close();
		this.database = null;
		this.readinessResult = null;
	}

	async publish(draft: RecordDraft): Promise<OperationLedgerRecord> {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			const previous = this.readVersions(database, draft.operationId).at(-1);
			if (previous && draft.ledgerVersion <= previous.ledgerVersion)
				throw publishConflict();
			const sequence = database
				.query(
					"INSERT INTO event_sequences DEFAULT VALUES RETURNING event_sequence",
				)
				.get() as { event_sequence: number | bigint };
			const record = parseOperationLedgerRecord({
				...draft,
				eventSequence: Number(sequence.event_sequence),
				previousChecksum: previous ? checksumRecord(previous) : null,
			});
			validateTransition(previous, record);
			database
				.query(
					`INSERT INTO operation_versions
				(operation_id, ledger_version, event_sequence, previous_checksum, record_checksum, record_json)
				VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					record.operationId,
					record.ledgerVersion,
					record.eventSequence,
					record.previousChecksum,
					checksumRecord(record),
					JSON.stringify(record),
				);
			injectFault("before-commit");
			database.exec("COMMIT");
			committed = true;
			injectFault("after-commit");
			return record;
		} finally {
			if (!committed) {
				try {
					database.exec("ROLLBACK");
				} catch {
					/* process exit or SQLite already rolled back */
				}
			}
		}
	}

	async appendGuarded(
		guard: GuardedAppend,
	): Promise<{ published: boolean; record: OperationLedgerRecord }> {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			const versions = this.readVersions(database, guard.operationId);
			const current = versions.at(-1);
			if (!current)
				throw new OperationLedgerGuardError("missing", guard.operationId);
			if (current.inputFingerprint !== guard.inputFingerprint)
				throw new OperationLedgerGuardError("fingerprint", guard.operationId);
			if (current.status !== "started") {
				const priorLease = versions.at(-2)?.lease;
				if (
					guard.mode !== "terminal" ||
					!priorLease ||
					priorLease.ownerId !== guard.ownerId ||
					priorLease.fencingToken !== guard.fencingToken
				) {
					throw new OperationLedgerGuardError("terminal", guard.operationId);
				}
				if (!guard.replayMatches?.(current))
					throw new OperationLedgerGuardError(
						"terminal-mismatch",
						guard.operationId,
					);
				database.exec("COMMIT");
				committed = true;
				return { published: false, record: current };
			}
			const currentLease = current.lease;
			if (
				!currentLease ||
				currentLease.fencingToken !== guard.fencingToken ||
				(guard.mode !== "adopt" && currentLease.ownerId !== guard.ownerId)
			) {
				throw new OperationLedgerGuardError("lease", guard.operationId);
			}
			if (
				guard.mode === "adopt" &&
				currentLease.ownerId !== guard.allowUnexpiredOwnerId &&
				Date.parse(currentLease.expiresAt) >
					(guard.nowMs ?? Number.NEGATIVE_INFINITY)
			) {
				throw new OperationLedgerGuardError("not-expired", guard.operationId);
			}
			const record = insertDraft(database, guard.build(current), current);
			database.exec("COMMIT");
			committed = true;
			return { published: true, record };
		} finally {
			if (!committed) {
				try {
					database.exec("ROLLBACK");
				} catch {
					/* SQLite may already have rolled back */
				}
			}
		}
	}

	async readJournal(operationId: string): Promise<ReadJournal> {
		return {
			versions: this.readVersions(this.requireDatabase(), operationId),
			recoveryWarnings: [],
		};
	}

	async listJournals(): Promise<ReadJournal[]> {
		const database = this.requireDatabase();
		const ids = database
			.query(
				"SELECT DISTINCT operation_id FROM operation_versions ORDER BY operation_id",
			)
			.all() as Array<{ operation_id: string }>;
		return ids.map(({ operation_id }) => ({
			versions: this.readVersions(database, operation_id),
			recoveryWarnings: [],
		}));
	}

	private initializeSchema(database: Database): void {
		const version = pragmaNumber(
			database,
			"PRAGMA user_version",
			"user_version",
		);
		if (version !== 0 && version !== SQLITE_SCHEMA_VERSION) {
			throw new OperationLedgerUnsupportedVersionError(version);
		}
		if (version === 0) {
			database.exec(`
					CREATE TABLE event_sequences (
						event_sequence INTEGER PRIMARY KEY AUTOINCREMENT
					);
					CREATE TABLE operation_versions (
						operation_id TEXT NOT NULL,
						ledger_version INTEGER NOT NULL CHECK (ledger_version > 0),
						event_sequence INTEGER NOT NULL UNIQUE,
						previous_checksum TEXT,
						record_checksum TEXT NOT NULL,
						record_json TEXT NOT NULL,
						PRIMARY KEY (operation_id, ledger_version),
						FOREIGN KEY (event_sequence) REFERENCES event_sequences(event_sequence)
					);
					CREATE INDEX operation_history_order ON operation_versions(event_sequence DESC);
					CREATE TRIGGER operation_versions_no_update BEFORE UPDATE ON operation_versions
					BEGIN SELECT RAISE(ABORT, 'operation history is append-only'); END;
					CREATE TRIGGER operation_versions_no_delete BEFORE DELETE ON operation_versions
					BEGIN SELECT RAISE(ABORT, 'operation history is append-only'); END;
					CREATE TRIGGER event_sequences_no_update BEFORE UPDATE ON event_sequences
					BEGIN SELECT RAISE(ABORT, 'event history is append-only'); END;
					CREATE TRIGGER event_sequences_no_delete BEFORE DELETE ON event_sequences
					BEGIN SELECT RAISE(ABORT, 'event history is append-only'); END;
					PRAGMA user_version=${SQLITE_SCHEMA_VERSION};
			`);
		}
		for (const table of ["event_sequences", "operation_versions"]) {
			const found = database
				.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
				.get(table);
			if (!found)
				throw new OperationLedgerCorruptionError(
					`required table is missing: ${table}`,
					this.databasePath,
				);
		}
	}

	private readVersions(
		database: Database,
		operationId: string,
	): OperationLedgerRecord[] {
		const rows = database
			.query(
				`SELECT ledger_version, event_sequence, previous_checksum,
			record_checksum, record_json FROM operation_versions
			WHERE operation_id = ? ORDER BY ledger_version`,
			)
			.all(operationId) as StoredRow[];
		const versions: OperationLedgerRecord[] = [];
		let previous: OperationLedgerRecord | undefined;
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index]!;
			let value: unknown;
			try {
				value = JSON.parse(row.record_json);
			} catch {
				throw new OperationLedgerCorruptionError(
					"stored operation JSON is corrupt",
					this.databasePath,
				);
			}
			let record: OperationLedgerRecord;
			try {
				record = parseOperationLedgerRecord(value);
			} catch (error) {
				if (error instanceof OperationLedgerUnsupportedVersionError)
					throw error;
				throw new OperationLedgerCorruptionError(
					"stored operation schema is invalid",
					this.databasePath,
				);
			}
			if (
				row.ledger_version !== index + 1 ||
				row.ledger_version !== record.ledgerVersion ||
				row.event_sequence !== record.eventSequence ||
				row.previous_checksum !== record.previousChecksum ||
				row.record_checksum !== checksumRecord(record) ||
				record.operationId !== operationId
			) {
				throw new OperationLedgerCorruptionError(
					"stored operation checksum or head metadata is invalid",
					this.databasePath,
				);
			}
			validateTransition(previous, record);
			versions.push(record);
			previous = record;
		}
		return versions;
	}

	private requireDatabase(): Database {
		if (!this.database)
			throw new OperationLedgerReadinessError("ledger is not initialized");
		return this.database;
	}
}

interface StoredRow {
	ledger_version: number;
	event_sequence: number;
	previous_checksum: string | null;
	record_checksum: string;
	record_json: string;
}

export function checksumRecord(record: OperationLedgerRecord): string {
	return createHash("sha256").update(stableSerialize(record)).digest("hex");
}

function insertDraft(
	database: Database,
	draft: RecordDraft,
	previous: OperationLedgerRecord | undefined,
): OperationLedgerRecord {
	const sequence = database
		.query(
			"INSERT INTO event_sequences DEFAULT VALUES RETURNING event_sequence",
		)
		.get() as { event_sequence: number | bigint };
	const record = parseOperationLedgerRecord({
		...draft,
		eventSequence: Number(sequence.event_sequence),
		previousChecksum: previous ? checksumRecord(previous) : null,
	});
	validateTransition(previous, record);
	database
		.query(
			`INSERT INTO operation_versions
			(operation_id, ledger_version, event_sequence, previous_checksum, record_checksum, record_json)
			VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			record.operationId,
			record.ledgerVersion,
			record.eventSequence,
			record.previousChecksum,
			checksumRecord(record),
			JSON.stringify(record),
		);
	return record;
}

function validateTransition(
	previous: OperationLedgerRecord | undefined,
	next: OperationLedgerRecord,
): void {
	if (!previous) {
		if (
			next.ledgerVersion !== 1 ||
			next.status !== "started" ||
			next.attempt !== 1
		)
			throw new OperationLedgerCorruptionError(
				"invalid initial operation transition",
				next.operationId,
			);
		return;
	}
	const immutable = [
		"operationId",
		"operationKind",
		"description",
		"operationType",
		"requiresSaveVerification",
		"actor",
		"requestIdentity",
		"connectionAffinity",
		"inputFingerprint",
		"revisionBefore",
		"contentHashBefore",
		"createdAt",
	] as const;
	if (
		previous.status !== "started" ||
		next.ledgerVersion !== previous.ledgerVersion + 1 ||
		next.eventSequence <= previous.eventSequence ||
		next.previousChecksum !== checksumRecord(previous) ||
		immutable.some(
			(key) => stableSerialize(previous[key]) !== stableSerialize(next[key]),
		) ||
		!preservesResolvedIdentity(previous.projectId, next.projectId) ||
		!preservesResolvedIdentity(previous.sceneId, next.sceneId) ||
		!validCheckpointTransition(previous, next) ||
		!validArtifactTransition(previous, next) ||
		!containsPriorAffectedObjects(previous, next) ||
		next.attempt < previous.attempt ||
		next.attempt > previous.attempt + 1
	) {
		throw new OperationLedgerCorruptionError(
			"invalid operation state transition",
			next.operationId,
		);
	}
}

function preservesResolvedIdentity(
	previous: string | null,
	next: string | null,
): boolean {
	return previous === null ? true : previous === next;
}

function validCheckpointTransition(
	previous: OperationLedgerRecord,
	next: OperationLedgerRecord,
): boolean {
	const ranks = { prepared: 0, committed: 1, verified: 2 } as const;
	const nextById = new Map(
		next.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]),
	);
	return previous.checkpoints.every((checkpoint) => {
		const successor = nextById.get(checkpoint.checkpointId);
		return (
			Boolean(successor) &&
			successor!.kind === checkpoint.kind &&
			ranks[successor!.state] >= ranks[checkpoint.state]
		);
	});
}

function validArtifactTransition(
	previous: OperationLedgerRecord,
	next: OperationLedgerRecord,
): boolean {
	const ranks = {
		prepared: 0,
		created: 1,
		transferred: 2,
		attached: 3,
		verified: 4,
	} as const;
	const nextById = new Map(
		next.artifacts.map((artifact) => [artifact.artifactId, artifact]),
	);
	return previous.artifacts.every((artifact) => {
		const successor = nextById.get(artifact.artifactId);
		return (
			Boolean(successor) &&
			successor!.kind === artifact.kind &&
			successor!.sha256 === artifact.sha256 &&
			successor!.path === artifact.path &&
			ranks[successor!.state] >= ranks[artifact.state]
		);
	});
}

function containsPriorAffectedObjects(
	previous: OperationLedgerRecord,
	next: OperationLedgerRecord,
): boolean {
	const nextObjects = new Set(
		next.affectedObjects.map((value) => stableSerialize(value)),
	);
	return previous.affectedObjects.every((value) =>
		nextObjects.has(stableSerialize(value)),
	);
}

function verifyDatabase(database: Database, path: string): void {
	const rows = database.query("PRAGMA quick_check").all() as Array<
		Record<string, string>
	>;
	if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
		throw new OperationLedgerCorruptionError("SQLite quick_check failed", path);
	}
	const orphaned = database
		.query(
			`SELECT COUNT(*) AS count FROM event_sequences AS events
			LEFT JOIN operation_versions AS versions
			ON versions.event_sequence = events.event_sequence
			WHERE versions.event_sequence IS NULL`,
		)
		.get() as { count: number };
	if (Number(orphaned.count) !== 0) {
		throw new OperationLedgerCorruptionError(
			"global event sequence contains a missing operation version",
			path,
		);
	}
	const requiredObjects = [
		"operation_versions_no_update",
		"operation_versions_no_delete",
		"event_sequences_no_update",
		"event_sequences_no_delete",
	];
	for (const name of requiredObjects) {
		const trigger = database
			.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?")
			.get(name);
		if (!trigger) {
			throw new OperationLedgerCorruptionError(
				`required append-only trigger is missing: ${name}`,
				path,
			);
		}
	}
}

function pragmaString(database: Database, sql: string, field: string): string {
	return String(
		(database.query(sql).get() as Record<string, unknown>)[field],
	).toLowerCase();
}

async function enableWal(database: Database): Promise<string> {
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			return pragmaString(database, "PRAGMA journal_mode=WAL", "journal_mode");
		} catch (error) {
			if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
			await Bun.sleep(10);
		}
	}
}

function isSqliteBusy(error: unknown): boolean {
	return (
		(error as { code?: unknown } | null)?.code === "SQLITE_BUSY" ||
		(error as { errno?: unknown } | null)?.errno === 5
	);
}
function pragmaNumber(database: Database, sql: string, field: string): number {
	return Number((database.query(sql).get() as Record<string, unknown>)[field]);
}
function publishConflict(): NodeJS.ErrnoException {
	const error = new Error(
		"operation version already exists",
	) as NodeJS.ErrnoException;
	error.code = "EEXIST";
	return error;
}
function injectFault(point: "before-commit" | "after-commit"): void {
	if (process.env.OPENCUT_LEDGER_TEST_FAULT === point)
		process.exit(point === "before-commit" ? 86 : 87);
}
function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, child]) => child !== undefined)
		.sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
		.join(",")}}`;
}
