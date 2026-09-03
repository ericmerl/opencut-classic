import {
	canonicalJsonEqual,
	createLease,
	fingerprintOperation,
	normalizeAffectedObjects,
	normalizeDiagnostics,
	redactActor,
	redactArtifacts,
	redactCheckpoints,
	redactDiagnostics,
	redactObject,
	redactProviders,
	redactValue,
	relationships,
	validateHistoryLimit,
	validateLeaseDuration,
	validateRecordDraft,
} from "./operation-ledger-codec";
import {
	OperationLedgerGuardError,
	OperationLedgerStorage,
	type OperationLedgerReadiness,
} from "./operation-ledger-storage";
import {
	OPERATION_LEDGER_SCHEMA_VERSION,
	type OperationActor,
	type OperationAffectedObject,
	type OperationArtifact,
	type OperationCheckpoint,
	type OperationConnectionAffinity,
	type OperationDiagnostics,
	type OperationDisposition,
	type OperationLedgerRecord,
	type OperationPhase,
	type OperationProviderProvenance,
	type OperationRelationships,
	type OperationSaveReceipt,
	type OperationStatus,
	type OperationType,
} from "./operation-ledger-schema";

const ledgerLocks = new Map<string, Promise<void>>();

export * from "./operation-ledger-schema";
export {
	checksumRecord,
	OperationLedgerCorruptionError,
	OperationLedgerReadinessError,
} from "./operation-ledger-storage";

export interface OperationFingerprintInput {
	operationKind: string;
	operationType: OperationType;
	canonicalInput: unknown;
	projectId?: string | null;
	sceneId?: string | null;
	connectionAffinity?: OperationConnectionAffinity | null;
	revisionBefore?: number | null;
	contentHashBefore?: string | null;
	contentHashProjectionVersionBefore?: 1 | 2 | 3;
}

export interface OperationClaimInput extends OperationFingerprintInput {
	operationId: string;
	description: string;
	ownerId: string;
	leaseDurationMs: number;
	requiresSaveVerification: boolean;
	phase?: Exclude<OperationPhase, "completed" | "failed">;
	actor: OperationActor;
	requestIdentity?: string | null;
	providerProvenance?: OperationProviderProvenance[];
	affectedObjects?: OperationAffectedObject[];
	artifacts?: OperationArtifact[];
	checkpoints?: OperationCheckpoint[];
	relationships?: Partial<OperationRelationships>;
}

export interface OperationTerminalInput {
	ownerId: string;
	fencingToken: string;
	projectId?: string | null;
	sceneId?: string | null;
	revisionAfter?: number | null;
	contentHashAfter?: string | null;
	contentHashProjectionVersionAfter?: 1 | 2 | 3;
	saveReceipt?: OperationSaveReceipt | null;
	providerProvenance?: OperationProviderProvenance[];
	affectedObjects?: OperationAffectedObject[];
	artifacts?: OperationArtifact[];
	checkpoints?: OperationCheckpoint[];
	relationships?: Partial<OperationRelationships>;
}

export interface OperationFailureInput extends OperationTerminalInput {
	diagnostics: OperationDiagnostics | Error;
	result?: unknown;
}

export interface OperationReconcileInput {
	ownerId: string;
	fencingToken: string;
	leaseDurationMs: number;
	phase?: "reconciling" | "saving" | "verifying";
	disposition?: "not-applied" | "unknown";
	revisionAfter?: number | null;
	contentHashAfter?: string | null;
	contentHashProjectionVersionAfter?: 1 | 2 | 3;
	saveReceipt?: OperationSaveReceipt | null;
	providerProvenance?: OperationProviderProvenance[];
	affectedObjects?: OperationAffectedObject[];
	artifacts?: OperationArtifact[];
	checkpoints?: OperationCheckpoint[];
}

export interface OperationHistoryEntry {
	record: OperationLedgerRecord;
	recoveryWarnings: string[];
}

export interface OperationHistoryQuery {
	limit: number;
	cursor?: string;
	projectId?: string;
	sceneId?: string;
	operationKinds?: string[];
	statuses?: OperationStatus[];
	dispositions?: OperationDisposition[];
	actorId?: string;
}

export interface OperationHistoryPage {
	entries: OperationHistoryEntry[];
	nextCursor: string | null;
}

export class OperationLedgerReuseError extends Error {
	readonly code = "OPERATION_ID_REUSED";
	constructor(readonly operationId: string) {
		super(
			`operationId was already used with different semantic input: ${operationId}`,
		);
		this.name = "OperationLedgerReuseError";
	}
}

export class OperationLedgerLeaseError extends Error {
	readonly code = "OPERATION_LEASE_CONFLICT";
	constructor(
		message: string,
		readonly operationId: string,
	) {
		super(message);
		this.name = "OperationLedgerLeaseError";
	}
}

export class OperationLedgerReplayMismatchError extends Error {
	readonly code = "OPERATION_TERMINAL_MISMATCH";
	constructor(readonly operationId: string) {
		super("terminal operation replay does not match the committed result");
		this.name = "OperationLedgerReplayMismatchError";
	}
}

/**
 * Persists the operation lifecycle observed by the MCP server. This ledger does
 * not make a browser edit atomic or independently prove that editor state was
 * saved. Mutation completion requires revisions, content hashes, and a save
 * receipt supplied only after the editor save and readback barriers succeed.
 */
export class OperationLedger {
	readonly directory: string;
	private initialized: Promise<void> | null = null;
	private storage: OperationLedgerStorage;

	constructor(
		directory: string,
		private options: { now?: () => Date } = {},
	) {
		this.storage = new OperationLedgerStorage(directory);
		this.directory = this.storage.directory;
	}

	fingerprint(input: OperationFingerprintInput): string {
		return fingerprintOperation(input);
	}

	operationDirectory(operationId: string): string {
		return this.storage.operationDirectory(operationId);
	}

	async readiness(): Promise<OperationLedgerReadiness> {
		await this.ensureInitialized();
		return this.storage.readiness();
	}

	close(): void {
		this.storage.close();
		this.initialized = null;
	}

	async claim(input: OperationClaimInput): Promise<{
		state: "claimed" | "in-progress" | "replayed";
		record: OperationLedgerRecord;
	}> {
		validateLeaseDuration(input.leaseDurationMs);
		return this.withLock(input.operationId, async () => {
			await this.ensureInitialized();
			const fingerprint = this.fingerprint(input);
			const current = await this.storage.readJournal(input.operationId);
			const latest = current.versions.at(-1);
			if (latest) {
				assertFingerprint(latest, fingerprint);
				return {
					state: latest.status === "started" ? "in-progress" : "replayed",
					record: latest,
				};
			}
			const timestamp = this.timestamp();
			const draft = {
				schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
				ledgerVersion: 1,
				operationId: input.operationId,
				operationKind: input.operationKind,
				description: input.description,
				operationType: input.operationType,
				requiresSaveVerification: input.requiresSaveVerification,
				status: "started" as const,
				disposition: "not-applied" as const,
				phase: input.phase ?? "claimed",
				attempt: 1,
				lease: createLease(input.ownerId, input.leaseDurationMs, this.now()),
				actor: redactActor(input.actor)!,
				requestIdentity: input.requestIdentity ?? null,
				connectionAffinity: input.connectionAffinity ?? null,
				projectId: input.projectId ?? null,
				sceneId: input.sceneId ?? null,
				inputFingerprint: fingerprint,
				revisionBefore: input.revisionBefore ?? null,
				revisionAfter: null,
				contentHashBefore: input.contentHashBefore ?? null,
				contentHashAfter: null,
				...(input.contentHashProjectionVersionBefore === undefined
					? {}
					: {
							contentHashProjectionVersionBefore:
								input.contentHashProjectionVersionBefore,
						}),
				saveReceipt: null,
				providerProvenance: redactProviders(input.providerProvenance ?? []),
				artifacts: redactArtifacts(input.artifacts ?? []),
				checkpoints: redactCheckpoints(input.checkpoints ?? []),
				createdAt: timestamp,
				updatedAt: timestamp,
				completedAt: null,
				affectedObjects: normalizeAffectedObjects(input.affectedObjects ?? []),
				relationships: relationships(input.relationships),
				diagnostics: null,
				result: null,
			};
			validateRecordDraft(draft);
			return this.publishOrReconcile(
				input.operationId,
				fingerprint,
				draft,
				"claimed",
			);
		});
	}

	async adopt(
		operationId: string,
		inputFingerprint: string,
		input: {
			ownerId: string;
			expectedFencingToken: string;
			leaseDurationMs: number;
			allowUnexpiredOwnerId?: string;
			phase?: Exclude<OperationPhase, "completed" | "failed">;
		},
	): Promise<OperationLedgerRecord> {
		validateLeaseDuration(input.leaseDurationMs);
		return this.withLock(operationId, async () => {
			await this.ensureInitialized();
			try {
				return (
					await this.storage.appendGuarded({
						operationId,
						inputFingerprint,
						mode: "adopt",
						fencingToken: input.expectedFencingToken,
						nowMs: this.now().getTime(),
						allowUnexpiredOwnerId: input.allowUnexpiredOwnerId,
						build: (current) => ({
							...current,
							ledgerVersion: current.ledgerVersion + 1,
							phase: input.phase ?? "reconciling",
							attempt: current.attempt + 1,
							lease: createLease(
								input.ownerId,
								input.leaseDurationMs,
								this.now(),
							),
							updatedAt: this.timestamp(),
						}),
					})
				).record;
			} catch (error) {
				throw mapGuardError(error, operationId);
			}
		});
	}

	async reconcile(
		operationId: string,
		inputFingerprint: string,
		input: OperationReconcileInput,
	): Promise<OperationLedgerRecord> {
		validateLeaseDuration(input.leaseDurationMs);
		return this.withLock(operationId, async () => {
			await this.ensureInitialized();
			try {
				return (
					await this.storage.appendGuarded({
						operationId,
						inputFingerprint,
						mode: "nonterminal",
						ownerId: input.ownerId,
						fencingToken: input.fencingToken,
						build: (current) => ({
							...current,
							ledgerVersion: current.ledgerVersion + 1,
							phase: input.phase ?? "reconciling",
							disposition: input.disposition ?? current.disposition,
							lease: createLease(
								input.ownerId,
								input.leaseDurationMs,
								this.now(),
								current.lease!.fencingToken,
							),
							revisionAfter: input.revisionAfter ?? current.revisionAfter,
							contentHashAfter:
								input.contentHashAfter ?? current.contentHashAfter,
							...(input.contentHashProjectionVersionAfter === undefined
								? {}
								: {
										contentHashProjectionVersionAfter:
											input.contentHashProjectionVersionAfter,
									}),
							saveReceipt:
								input.saveReceipt === undefined
									? current.saveReceipt
									: input.saveReceipt,
							providerProvenance: input.providerProvenance
								? redactProviders(input.providerProvenance)
								: current.providerProvenance,
							artifacts: input.artifacts
								? redactArtifacts(input.artifacts)
								: current.artifacts,
							checkpoints: input.checkpoints
								? redactCheckpoints(input.checkpoints)
								: current.checkpoints,
							affectedObjects:
								input.affectedObjects === undefined
									? current.affectedObjects
									: normalizeAffectedObjects(input.affectedObjects),
							updatedAt: this.timestamp(),
						}),
					})
				).record;
			} catch (error) {
				throw mapGuardError(error, operationId);
			}
		});
	}

	async complete(
		operationId: string,
		inputFingerprint: string,
		result: unknown,
		metadata: OperationTerminalInput,
	): Promise<{ replayed: boolean; record: OperationLedgerRecord }> {
		return this.finish(
			operationId,
			inputFingerprint,
			"completed",
			result,
			null,
			metadata,
		);
	}

	async fail(
		operationId: string,
		inputFingerprint: string,
		input: OperationFailureInput,
	): Promise<{ replayed: boolean; record: OperationLedgerRecord }> {
		return this.finish(
			operationId,
			inputFingerprint,
			"failed",
			input.result ?? null,
			normalizeDiagnostics(input.diagnostics),
			input,
		);
	}

	async get(operationId: string): Promise<OperationHistoryEntry | null> {
		await this.ensureInitialized();
		const journal = await this.storage.readJournal(operationId);
		const record = journal.versions.at(-1);
		return record
			? { record, recoveryWarnings: journal.recoveryWarnings }
			: null;
	}

	async versions(operationId: string): Promise<OperationLedgerRecord[]> {
		await this.ensureInitialized();
		return (await this.storage.readJournal(operationId)).versions;
	}

	async list(options: {
		limit: number;
		projectId?: string;
		statuses?: OperationStatus[];
	}): Promise<OperationHistoryEntry[]> {
		return (
			await this.listPage({
				limit: options.limit,
				projectId: options.projectId,
				statuses: options.statuses,
			})
		).entries;
	}

	async listPage(
		options: OperationHistoryQuery,
	): Promise<OperationHistoryPage> {
		await this.ensureInitialized();
		validateHistoryLimit(options.limit);
		const cursor = parseHistoryCursor(options.cursor);
		const history: OperationHistoryEntry[] = [];
		for (const journal of await this.storage.listJournals()) {
			const record = journal.versions.at(-1);
			if (!record) continue;
			if (cursor !== null && record.eventSequence >= cursor) continue;
			if (options.projectId && record.projectId !== options.projectId) continue;
			if (options.sceneId && record.sceneId !== options.sceneId) continue;
			if (
				options.operationKinds &&
				!options.operationKinds.includes(record.operationKind)
			)
				continue;
			if (options.statuses && !options.statuses.includes(record.status))
				continue;
			if (
				options.dispositions &&
				!options.dispositions.includes(record.disposition)
			)
				continue;
			if (options.actorId && record.actor.id !== options.actorId) continue;
			history.push({ record, recoveryWarnings: journal.recoveryWarnings });
		}
		const ordered = history.sort(
			(a, b) => b.record.eventSequence - a.record.eventSequence,
		);
		const entries = ordered.slice(0, options.limit);
		return {
			entries,
			nextCursor:
				ordered.length > options.limit
					? String(entries.at(-1)!.record.eventSequence)
					: null,
		};
	}

	async listRecoverable(options: {
		limit: number;
	}): Promise<OperationHistoryEntry[]> {
		validateHistoryLimit(options.limit);
		const now = this.now().getTime();
		return (await this.list({ limit: 100, statuses: ["started"] }))
			.filter((entry) => Date.parse(entry.record.lease!.expiresAt) <= now)
			.slice(0, options.limit);
	}

	private async finish(
		operationId: string,
		fingerprint: string,
		status: "completed" | "failed",
		result: unknown,
		diagnostics: OperationDiagnostics | null,
		metadata: OperationTerminalInput,
	) {
		return this.withLock(operationId, async () => {
			await this.ensureInitialized();
			const redactedResult = redactValue(result);
			const redactedDiagnostics = diagnostics
				? redactDiagnostics(diagnostics)
				: null;
			try {
				const disposition = await this.storage.appendGuarded({
					operationId,
					inputFingerprint: fingerprint,
					mode: "terminal",
					ownerId: metadata.ownerId,
					fencingToken: metadata.fencingToken,
					build: (current) =>
						terminalDraft(
							current,
							status,
							redactedResult,
							redactedDiagnostics,
							metadata,
							this.timestamp(),
						),
					replayMatches: (terminal) =>
						canonicalJsonEqual(
							terminalSemantics(
								terminalDraft(
									terminal,
									status,
									redactedResult,
									redactedDiagnostics,
									metadata,
									terminal.updatedAt,
								),
							),
							terminalSemantics(terminal),
						),
				});
				return {
					replayed: !disposition.published,
					record: disposition.record,
				};
			} catch (error) {
				throw mapGuardError(error, operationId);
			}
		});
	}

	private async publishOrReconcile(
		operationId: string,
		fingerprint: string,
		draft: Parameters<OperationLedgerStorage["publish"]>[0],
		state: "claimed",
	) {
		try {
			return { state, record: await this.storage.publish(draft) };
		} catch (error) {
			if (!isPublishConflict(error)) throw error;
			const winner = (await this.storage.readJournal(operationId)).versions.at(
				-1,
			);
			if (!winner) throw error;
			assertFingerprint(winner, fingerprint);
			return {
				state:
					winner.status === "started"
						? ("in-progress" as const)
						: ("replayed" as const),
				record: winner,
			};
		}
	}

	private async ensureInitialized() {
		this.initialized ??= this.storage.initialize(this.timestamp());
		return this.initialized;
	}
	private now(): Date {
		return this.options.now?.() ?? new Date();
	}
	private timestamp(): string {
		return this.now().toISOString();
	}
	private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
		const lockKey = `${this.directory}:${key}`;
		const prior = ledgerLocks.get(lockKey) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		ledgerLocks.set(lockKey, current);
		await prior;
		try {
			return await work();
		} finally {
			release();
			if (ledgerLocks.get(lockKey) === current) ledgerLocks.delete(lockKey);
		}
	}
}

function assertFingerprint(record: OperationLedgerRecord, fingerprint: string) {
	if (record.inputFingerprint !== fingerprint)
		throw new OperationLedgerReuseError(record.operationId);
}

function terminalDraft(
	current: OperationLedgerRecord,
	status: "completed" | "failed",
	result: OperationLedgerRecord["result"],
	diagnostics: OperationDiagnostics | null,
	metadata: OperationTerminalInput,
	timestamp: string,
): Parameters<OperationLedgerStorage["publish"]>[0] {
	return {
		...current,
		ledgerVersion: current.ledgerVersion + 1,
		status,
		disposition: status === "completed" ? "applied-verified" : "not-applied",
		phase: status,
		lease: null,
		projectId: metadata.projectId ?? current.projectId,
		sceneId: metadata.sceneId ?? current.sceneId,
		revisionAfter: metadata.revisionAfter ?? current.revisionAfter,
		contentHashAfter: metadata.contentHashAfter ?? current.contentHashAfter,
		...(metadata.contentHashProjectionVersionAfter === undefined
			? {}
			: {
					contentHashProjectionVersionAfter:
						metadata.contentHashProjectionVersionAfter,
				}),
		saveReceipt:
			metadata.saveReceipt === undefined
				? current.saveReceipt
				: metadata.saveReceipt,
		providerProvenance: metadata.providerProvenance
			? redactProviders(metadata.providerProvenance)
			: current.providerProvenance,
		artifacts: metadata.artifacts
			? redactArtifacts(metadata.artifacts)
			: current.artifacts,
		checkpoints: metadata.checkpoints
			? redactCheckpoints(metadata.checkpoints)
			: current.checkpoints,
		affectedObjects:
			metadata.affectedObjects === undefined
				? current.affectedObjects
				: normalizeAffectedObjects(metadata.affectedObjects),
		relationships: { ...current.relationships, ...metadata.relationships },
		updatedAt: timestamp,
		completedAt: timestamp,
		diagnostics,
		result,
	};
}

function terminalSemantics(
	record: Pick<
		OperationLedgerRecord,
		| "status"
		| "disposition"
		| "projectId"
		| "sceneId"
		| "revisionAfter"
		| "contentHashAfter"
		| "contentHashProjectionVersionAfter"
		| "saveReceipt"
		| "providerProvenance"
		| "artifacts"
		| "checkpoints"
		| "affectedObjects"
		| "relationships"
		| "diagnostics"
		| "result"
	>,
) {
	return {
		status: record.status,
		disposition: record.disposition,
		projectId: record.projectId,
		sceneId: record.sceneId,
		revisionAfter: record.revisionAfter,
		contentHashAfter: record.contentHashAfter,
		...(record.contentHashProjectionVersionAfter === undefined
			? {}
			: {
					contentHashProjectionVersionAfter:
						record.contentHashProjectionVersionAfter,
				}),
		saveReceipt: record.saveReceipt,
		providerProvenance: record.providerProvenance,
		artifacts: record.artifacts,
		checkpoints: record.checkpoints,
		affectedObjects: record.affectedObjects,
		relationships: record.relationships,
		diagnostics: record.diagnostics,
		result: record.result,
	};
}

function mapGuardError(error: unknown, operationId: string): unknown {
	if (!(error instanceof OperationLedgerGuardError)) return error;
	if (error.reason === "fingerprint")
		return new OperationLedgerReuseError(operationId);
	if (error.reason === "terminal-mismatch") {
		return new OperationLedgerReplayMismatchError(operationId);
	}
	if (error.reason === "missing")
		return new Error(`operation is not claimed: ${operationId}`);
	return new OperationLedgerLeaseError(
		`operation lease rejected: ${error.reason}`,
		operationId,
	);
}

function isPublishConflict(error: unknown) {
	return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

function parseHistoryCursor(value: string | undefined): number | null {
	if (value === undefined) return null;
	if (!/^[1-9]\d*$/.test(value))
		throw new Error("invalid operation history cursor");
	const cursor = Number(value);
	if (!Number.isSafeInteger(cursor))
		throw new Error("invalid operation history cursor");
	return cursor;
}
