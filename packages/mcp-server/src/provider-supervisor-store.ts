import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PROVIDER_SUPERVISOR_DATABASE = "provider-supervisor.sqlite";

export type ProviderSupervisorKind =
	| "audio-cleaner-command"
	| "matte-producer-command"
	| "subject-tracker-command";

export type ProviderSupervisorState =
	| "queued"
	| "started"
	| "succeeded"
	| "failed"
	| "unknown";

export interface ProviderSupervisorSubmission {
	provider: ProviderSupervisorKind;
	operationId: string;
	semanticFingerprint: string;
	command: string;
	args: string[];
	request: unknown;
	timeoutMs: number;
}

export interface ProviderSupervisorProvenance {
	provider: ProviderSupervisorKind;
	providerProtocolVersion: 1;
	supervisorProtocolVersion: 1;
	modelId: string;
	modelVersion: string;
	artifactSha256: string | null;
	artifactBytes: number | null;
}

export interface ProviderSupervisorRecord {
	provider: ProviderSupervisorKind;
	operationId: string;
	semanticFingerprint: string;
	state: ProviderSupervisorState;
	command: string;
	args: string[];
	request: unknown;
	timeoutMs: number;
	supervisorPid: number | null;
	supervisorNonce: string | null;
	result: unknown | null;
	provenance: ProviderSupervisorProvenance | null;
	diagnostics: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
}

interface ProviderSupervisorRow {
	provider: string;
	operation_id: string;
	semantic_fingerprint: string;
	state: string;
	command: string;
	args_json: string;
	request_json: string;
	timeout_ms: number;
	supervisor_pid: number | null;
	supervisor_nonce: string | null;
	result_json: string | null;
	provenance_json: string | null;
	diagnostics: string | null;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export class ProviderSupervisorReuseError extends Error {
	readonly code = "PROVIDER_OPERATION_REUSED";
	constructor(provider: string, operationId: string) {
		super(`${provider} operation ${operationId} was reused with different semantic input`);
		this.name = "ProviderSupervisorReuseError";
	}
}

export class ProviderSupervisorStore {
	readonly directory: string;
	readonly databasePath: string;
	private database: Database | null = null;

	constructor(directory: string) {
		this.directory = resolve(directory);
		this.databasePath = join(this.directory, PROVIDER_SUPERVISOR_DATABASE);
	}

	async initialize(): Promise<void> {
		if (this.database) return;
		await mkdir(this.directory, { recursive: true });
		const database = new Database(this.databasePath, { create: true, strict: true });
		try {
			database.exec("PRAGMA busy_timeout=10000");
			database.exec("PRAGMA journal_mode=WAL");
			database.exec("PRAGMA synchronous=FULL");
			database.exec("PRAGMA foreign_keys=ON");
			database.exec("BEGIN IMMEDIATE");
			try {
				initializeSchema(database);
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			const check = database.query("PRAGMA quick_check").get() as Record<string, unknown>;
			if (String(Object.values(check)[0]) !== "ok") {
				throw new Error("provider supervisor SQLite integrity check failed");
			}
		} catch (error) {
			database.close();
			throw error;
		}
		this.database = database;
	}

	close(): void {
		this.database?.close();
		this.database = null;
	}

	claim(input: ProviderSupervisorSubmission): ProviderSupervisorRecord {
		validateSubmission(input);
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.read(input.provider, input.operationId);
			if (existing) {
				if (existing.semanticFingerprint !== input.semanticFingerprint) {
					throw new ProviderSupervisorReuseError(input.provider, input.operationId);
				}
				database.exec("COMMIT");
				return existing;
			}
			const createdAt = new Date().toISOString();
			database
				.query(`INSERT INTO provider_jobs (
					provider, operation_id, semantic_fingerprint, state, command,
					args_json, request_json, timeout_ms, created_at
				) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
				.run(
					input.provider,
					input.operationId,
					input.semanticFingerprint,
					input.command,
					JSON.stringify(input.args),
					JSON.stringify(input.request),
					input.timeoutMs,
					createdAt,
				);
			database.exec("COMMIT");
			return this.require(input.provider, input.operationId);
		} catch (error) {
			rollback(database);
			throw error;
		}
	}

	read(
		provider: ProviderSupervisorKind,
		operationId: string,
	): ProviderSupervisorRecord | null {
		const row = this.requireDatabase()
			.query("SELECT * FROM provider_jobs WHERE provider = ? AND operation_id = ?")
			.get(provider, operationId) as ProviderSupervisorRow | null;
		return row ? parseRow(row) : null;
	}

	acquire(
		provider: ProviderSupervisorKind,
		operationId: string,
		supervisorPid: number,
		supervisorNonce: string,
	): ProviderSupervisorRecord | null {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const changed = database
				.query(`UPDATE provider_jobs
					SET state = 'started', supervisor_pid = ?, supervisor_nonce = ?, started_at = ?
					WHERE provider = ? AND operation_id = ? AND state = 'queued'`)
				.run(
					supervisorPid,
					supervisorNonce,
					new Date().toISOString(),
					provider,
					operationId,
				).changes;
			database.exec("COMMIT");
			return changed === 1 ? this.require(provider, operationId) : null;
		} catch (error) {
			rollback(database);
			throw error;
		}
	}

	complete(
		provider: ProviderSupervisorKind,
		operationId: string,
		supervisorPid: number,
		supervisorNonce: string,
		result: unknown,
		provenance: ProviderSupervisorProvenance,
	): ProviderSupervisorRecord {
		return this.finish({
			provider,
			operationId,
			supervisorPid,
			supervisorNonce,
			state: "succeeded",
			result,
			provenance,
			diagnostics: null,
		});
	}

	fail(
		provider: ProviderSupervisorKind,
		operationId: string,
		supervisorPid: number,
		supervisorNonce: string,
		diagnostics: string,
	): ProviderSupervisorRecord {
		return this.finish({
			provider,
			operationId,
			supervisorPid,
			supervisorNonce,
			state: "failed",
			result: null,
			provenance: null,
			diagnostics,
		});
	}

	markUnknownIfOwned(
		provider: ProviderSupervisorKind,
		operationId: string,
		supervisorPid: number,
		supervisorNonce: string,
	): ProviderSupervisorRecord {
		return this.finish({
			provider,
			operationId,
			supervisorPid,
			supervisorNonce,
			state: "unknown",
			result: null,
			provenance: null,
			diagnostics:
				"v1 provider supervisor exited before durable terminal publication; provider invocation will not be repeated",
		});
	}

	private finish(input: {
		provider: ProviderSupervisorKind;
		operationId: string;
		supervisorPid: number;
		supervisorNonce: string;
		state: "succeeded" | "failed" | "unknown";
		result: unknown | null;
		provenance: ProviderSupervisorProvenance | null;
		diagnostics: string | null;
	}): ProviderSupervisorRecord {
		const database = this.requireDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const changed = database
				.query(`UPDATE provider_jobs SET
					state = ?, result_json = ?, provenance_json = ?, diagnostics = ?, completed_at = ?
					WHERE provider = ? AND operation_id = ? AND state = 'started'
					AND supervisor_pid = ? AND supervisor_nonce = ?`)
				.run(
					input.state,
					input.result === null ? null : JSON.stringify(input.result),
					input.provenance === null ? null : JSON.stringify(input.provenance),
					input.diagnostics,
					new Date().toISOString(),
					input.provider,
					input.operationId,
					input.supervisorPid,
					input.supervisorNonce,
				).changes;
			if (changed !== 1) throw new Error("provider supervisor terminal fence was rejected");
			database.exec("COMMIT");
			return this.require(input.provider, input.operationId);
		} catch (error) {
			rollback(database);
			throw error;
		}
	}

	private require(
		provider: ProviderSupervisorKind,
		operationId: string,
	): ProviderSupervisorRecord {
		const record = this.read(provider, operationId);
		if (!record) throw new Error("provider supervisor record is missing");
		return record;
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("provider supervisor store is not initialized");
		return this.database;
	}
}

export function providerSupervisorFingerprint(semanticInput: unknown): string {
	assertJsonValue(semanticInput, "semanticInput");
	return createHash("sha256")
		.update(stableSerialize(semanticInput))
		.digest("hex");
}

function initializeSchema(database: Database): void {
	database.exec(`CREATE TABLE IF NOT EXISTS provider_supervisor_metadata (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`);
	const version = database
		.query("SELECT value FROM provider_supervisor_metadata WHERE key = 'schema_version'")
		.get() as { value: string } | null;
	if (version && version.value !== "1") {
		throw new Error(`unsupported provider supervisor schema ${version.value}`);
	}
	database
		.query("INSERT OR IGNORE INTO provider_supervisor_metadata (key, value) VALUES ('schema_version', '1')")
		.run();
	database.exec(`CREATE TABLE IF NOT EXISTS provider_jobs (
		provider TEXT NOT NULL,
		operation_id TEXT NOT NULL,
		semantic_fingerprint TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('queued','started','succeeded','failed','unknown')),
		command TEXT NOT NULL,
		args_json TEXT NOT NULL,
		request_json TEXT NOT NULL,
		timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
		supervisor_pid INTEGER,
		supervisor_nonce TEXT,
		result_json TEXT,
		provenance_json TEXT,
		diagnostics TEXT,
		created_at TEXT NOT NULL,
		started_at TEXT,
		completed_at TEXT,
		PRIMARY KEY (provider, operation_id)
	)`);
	database.exec(`CREATE TRIGGER IF NOT EXISTS provider_jobs_identity_immutable
		BEFORE UPDATE ON provider_jobs
		WHEN OLD.provider != NEW.provider
			OR OLD.operation_id != NEW.operation_id
			OR OLD.semantic_fingerprint != NEW.semantic_fingerprint
			OR OLD.command != NEW.command
			OR OLD.args_json != NEW.args_json
			OR OLD.request_json != NEW.request_json
		BEGIN SELECT RAISE(ABORT, 'provider job identity is immutable'); END`);
	database.exec(`CREATE TRIGGER IF NOT EXISTS provider_jobs_terminal_immutable
		BEFORE UPDATE ON provider_jobs
		WHEN OLD.state IN ('succeeded','failed','unknown')
		BEGIN SELECT RAISE(ABORT, 'provider terminal result is immutable'); END`);
}

function validateSubmission(input: ProviderSupervisorSubmission): void {
	if (!input.operationId || !input.semanticFingerprint || !input.command) {
		throw new Error("provider, operation ID, fingerprint, and command are required");
	}
	if (!/^[a-f0-9]{64}$/.test(input.semanticFingerprint)) {
		throw new Error("provider semantic fingerprint must be lowercase SHA-256");
	}
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
		throw new Error("provider timeout must be a positive safe integer");
	}
	assertJsonValue(input.request, "request");
}

function assertJsonValue(value: unknown, path: string): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			assertJsonValue(child, `${path}.${key}`);
		}
		return;
	}
	throw new Error(`${path} is outside the strict JSON domain`);
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function parseRow(row: ProviderSupervisorRow): ProviderSupervisorRecord {
	return {
		provider: row.provider as ProviderSupervisorKind,
		operationId: row.operation_id,
		semanticFingerprint: row.semantic_fingerprint,
		state: row.state as ProviderSupervisorState,
		command: row.command,
		args: JSON.parse(row.args_json),
		request: JSON.parse(row.request_json),
		timeoutMs: row.timeout_ms,
		supervisorPid: row.supervisor_pid,
		supervisorNonce: row.supervisor_nonce,
		result: row.result_json === null ? null : JSON.parse(row.result_json),
		provenance:
			row.provenance_json === null ? null : JSON.parse(row.provenance_json),
		diagnostics: row.diagnostics,
		createdAt: row.created_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
	};
}

function rollback(database: Database): void {
	try {
		database.exec("ROLLBACK");
	} catch {
		// The transaction may already have committed.
	}
}
