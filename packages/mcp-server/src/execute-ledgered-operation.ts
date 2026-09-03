import {
	OperationLedger,
	type OperationActor,
	type OperationAffectedObject,
	type OperationArtifact,
	type OperationCheckpoint,
	type OperationConnectionAffinity,
	type OperationDiagnostics,
	type OperationLedgerRecord,
	type OperationProviderProvenance,
	type OperationRelationships,
	type OperationSaveReceipt,
} from "./operation-ledger";

const TRANSIENT_INPUT_KEYS = new Set([
	"url",
	"ticketUrl",
	"uploadUrl",
	"downloadUrl",
	"expectedConnectionIdentity",
]);

export interface OperationBeforeState {
	projectId?: string | null;
	sceneId?: string | null;
	revision?: number | null;
	contentHash?: string | null;
	contentHashProjectionVersion?: 1 | 2;
}

export interface VerifiedOperationEvidence {
	projectId?: string | null;
	sceneId?: string | null;
	revisionAfter?: number | null;
	contentHashAfter?: string | null;
	contentHashProjectionVersionAfter?: 1 | 2;
	saveReceipt?: OperationSaveReceipt | null;
	providerProvenance?: OperationProviderProvenance[];
	artifacts?: OperationArtifact[];
	checkpoints?: OperationCheckpoint[];
	affectedObjects?: OperationAffectedObject[];
	relationships?: Partial<OperationRelationships>;
}

export type OperationExecutionOutcome<TResult> =
	| {
			disposition: "applied-verified";
			value: TResult;
			evidence: VerifiedOperationEvidence;
	  }
	| {
			disposition: "not-applied";
			value: TResult;
			diagnostics: OperationDiagnostics | Error;
			evidence?: VerifiedOperationEvidence;
	  }
	| {
			disposition: "unknown";
			value?: TResult;
			reason: string;
	  };

export interface OperationExecutionContext {
	record(): OperationLedgerRecord;
	checkpoint(input: {
		phase?: "reconciling" | "saving" | "verifying";
		checkpoint: OperationCheckpoint;
		providerProvenance?: OperationProviderProvenance[];
		artifacts?: OperationArtifact[];
		affectedObjects?: OperationAffectedObject[];
	}): Promise<OperationLedgerRecord>;
}

export interface LedgeredOperationSpec<TInput, TResult> {
	ledger: OperationLedger;
	input: TInput;
	operationId: string;
	operationKind: string;
	description: string;
	actor: OperationActor;
	requestIdentity: string;
	ownerId: string;
	leaseDurationMs: number;
	connectionAffinity?: OperationConnectionAffinity | null;
	before?: OperationBeforeState;
	requiresSaveVerification: boolean;
	affectedObjects?: OperationAffectedObject[];
	relationships?: Partial<OperationRelationships>;
	recover?: (
		context: OperationExecutionContext,
	) => Promise<OperationExecutionOutcome<TResult> | null>;
	execute: (
		context: OperationExecutionContext,
	) => Promise<OperationExecutionOutcome<TResult>>;
}

export type LedgeredOperationResult<TResult> =
	| {
			status: "completed" | "replayed";
			disposition: "applied-verified" | "not-applied";
			value: TResult;
			operation: OperationLedgerRecord;
	  }
	| {
			status: "recoverable";
			disposition: "unknown";
			reason: string;
			operation: OperationLedgerRecord;
	  };

/**
 * Claims the globally unique operation ID before invoking any callback that may
 * have side effects. Existing incomplete operations are recovered from durable
 * evidence only and are never blindly executed again.
 */
export async function executeLedgeredOperation<TInput, TResult>(
	spec: LedgeredOperationSpec<TInput, TResult>,
): Promise<LedgeredOperationResult<TResult>> {
	const claim = await spec.ledger.claim({
		operationId: spec.operationId,
		operationKind: spec.operationKind,
		description: spec.description,
		operationType: "mutation",
		requiresSaveVerification: spec.requiresSaveVerification,
		canonicalInput: semanticOperationInput(spec.input),
		ownerId: spec.ownerId,
		leaseDurationMs: spec.leaseDurationMs,
		actor: spec.actor,
		requestIdentity: spec.requestIdentity,
		connectionAffinity: spec.connectionAffinity ?? null,
		projectId: spec.before?.projectId ?? null,
		sceneId: spec.before?.sceneId ?? null,
		revisionBefore: spec.before?.revision ?? null,
		contentHashBefore: spec.before?.contentHash ?? null,
		contentHashProjectionVersionBefore:
			spec.before?.contentHashProjectionVersion,
		// Request targets are preliminary intent, not verified effects. Terminal
		// affected objects are supplied only by authoritative outcome evidence.
		affectedObjects: [],
		relationships: spec.relationships,
	});

	if (claim.state === "replayed") return replayResult<TResult>(claim.record);

	let record = claim.record;
	let ownsFence =
		claim.state === "claimed" || record.lease?.ownerId === spec.ownerId;
	const ownerState =
		!ownsFence && record.lease ? processOwnerState(record.lease.ownerId) : "unscoped";
	const abandonedOwner = ownerState === "dead" ? record.lease!.ownerId : null;
	if (
		!ownsFence &&
		(abandonedOwner !== null || (leaseExpired(record) && ownerState !== "live"))
	) {
		record = await spec.ledger.adopt(
			spec.operationId,
			record.inputFingerprint,
			{
				ownerId: spec.ownerId,
				expectedFencingToken: record.lease!.fencingToken,
				leaseDurationMs: spec.leaseDurationMs,
				...(abandonedOwner
					? { allowUnexpiredOwnerId: abandonedOwner }
					: {}),
			},
		);
		ownsFence = true;
	}

	const context = operationContext(
		spec,
		() => record,
		(next) => {
			record = next;
		},
	);

	if (claim.state === "in-progress") {
		if (!ownsFence || !spec.recover) {
			return recoverable(record, "operation requires durable reconciliation");
		}
		const recovered = await spec.recover(context);
		if (!recovered) {
			return recoverable(record, "durable side-effect state is unresolved");
		}
		return applyOutcome(spec, record, recovered);
	}

	record = await spec.ledger.reconcile(
		spec.operationId,
		record.inputFingerprint,
		{
			ownerId: spec.ownerId,
			fencingToken: record.lease!.fencingToken,
			leaseDurationMs: spec.leaseDurationMs,
			phase: "reconciling",
			disposition: "unknown",
		},
	);
	try {
		const outcome = await spec.execute(context);
		return await applyOutcome(spec, record, outcome);
	} catch (error) {
		return recoverable(
			record,
			error instanceof Error ? error.name : "operation execution failed",
		);
	}
}

function processOwnerState(ownerId: string): "live" | "dead" | "unscoped" {
	const match = /^opencut-mcp:(\d+):[A-Za-z0-9-]+$/.exec(ownerId);
	if (!match) return "unscoped";
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return "unscoped";
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		return code === "ESRCH" ? "dead" : "live";
	}
}

export function semanticOperationInput(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(semanticOperationInput);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !TRANSIENT_INPUT_KEYS.has(key))
			.map(([key, child]) => [key, semanticOperationInput(child)]),
	);
}

function operationContext<TInput, TResult>(
	spec: LedgeredOperationSpec<TInput, TResult>,
	current: () => OperationLedgerRecord,
	update: (record: OperationLedgerRecord) => void,
): OperationExecutionContext {
	return {
		record: current,
		checkpoint: async (input) => {
			const record = current();
			const next = await spec.ledger.reconcile(
				spec.operationId,
				record.inputFingerprint,
				{
					ownerId: spec.ownerId,
					fencingToken: record.lease!.fencingToken,
					leaseDurationMs: spec.leaseDurationMs,
					phase: input.phase,
					disposition: "unknown",
					checkpoints: mergeById(
						record.checkpoints,
						[input.checkpoint],
						"checkpointId",
					),
					providerProvenance: input.providerProvenance
						? mergeById(
								record.providerProvenance,
								input.providerProvenance,
								"provider",
							)
						: undefined,
					artifacts: input.artifacts
						? mergeById(record.artifacts, input.artifacts, "artifactId")
						: undefined,
					affectedObjects: input.affectedObjects
						? mergeAffected(record.affectedObjects, input.affectedObjects)
						: undefined,
				},
			);
			update(next);
			return next;
		},
	};
}

async function applyOutcome<TInput, TResult>(
	spec: LedgeredOperationSpec<TInput, TResult>,
	record: OperationLedgerRecord,
	outcome: OperationExecutionOutcome<TResult>,
): Promise<LedgeredOperationResult<TResult>> {
	if (outcome.disposition === "unknown") {
		return recoverable(record, outcome.reason);
	}
	if (outcome.disposition === "not-applied") {
		const evidence = {
			...mergeTerminalEvidence(record, outcome.evidence),
			affectedObjects: [],
		};
		const failed = await spec.ledger.fail(
			spec.operationId,
			record.inputFingerprint,
			{
				ownerId: spec.ownerId,
				fencingToken: record.lease!.fencingToken,
				diagnostics: outcome.diagnostics,
				result: outcome.value,
				...evidence,
			},
		);
		return {
			status: failed.replayed ? "replayed" : "completed",
			disposition: "not-applied",
			value: outcome.value,
			operation: failed.record,
		};
	}
	const completed = await spec.ledger.complete(
		spec.operationId,
		record.inputFingerprint,
		outcome.value,
		{
			ownerId: spec.ownerId,
			fencingToken: record.lease!.fencingToken,
			...mergeTerminalEvidence(record, outcome.evidence),
		},
	);
	return {
		status: completed.replayed ? "replayed" : "completed",
		disposition: "applied-verified",
		value: outcome.value,
		operation: completed.record,
	};
}

function mergeTerminalEvidence(
	record: OperationLedgerRecord,
	evidence: VerifiedOperationEvidence | undefined,
): VerifiedOperationEvidence {
	if (!evidence) return {};
	return {
		...evidence,
		providerProvenance: evidence.providerProvenance
			? mergeById(
					record.providerProvenance,
					evidence.providerProvenance,
					"provider",
				)
			: undefined,
		artifacts: evidence.artifacts
			? mergeById(record.artifacts, evidence.artifacts, "artifactId")
			: undefined,
		checkpoints: evidence.checkpoints
			? mergeById(record.checkpoints, evidence.checkpoints, "checkpointId")
			: undefined,
		affectedObjects: evidence.affectedObjects
			? mergeAffected(record.affectedObjects, evidence.affectedObjects)
			: undefined,
	};
}

function replayResult<TResult>(
	record: OperationLedgerRecord,
): LedgeredOperationResult<TResult> {
	return {
		status: "replayed",
		disposition:
			record.disposition === "applied-verified"
				? "applied-verified"
				: "not-applied",
		value: record.result as TResult,
		operation: record,
	};
}

function recoverable(
	record: OperationLedgerRecord,
	reason: string,
): LedgeredOperationResult<never> {
	return {
		status: "recoverable",
		disposition: "unknown",
		reason,
		operation: record,
	};
}

function leaseExpired(record: OperationLedgerRecord): boolean {
	return Boolean(
		record.lease && Date.parse(record.lease.expiresAt) <= Date.now(),
	);
}

function mergeById<T, K extends keyof T>(
	current: T[],
	updates: T[],
	key: K,
): T[] {
	const values = new Map(current.map((value) => [String(value[key]), value]));
	for (const value of updates) values.set(String(value[key]), value);
	return [...values.values()];
}

function mergeAffected(
	current: OperationAffectedObject[],
	updates: OperationAffectedObject[],
): OperationAffectedObject[] {
	const values = new Map(
		current.map((value) => [
			`${value.objectType}:${value.objectId}:${value.action}`,
			value,
		]),
	);
	for (const value of updates) {
		values.set(`${value.objectType}:${value.objectId}:${value.action}`, value);
	}
	return [...values.values()];
}
