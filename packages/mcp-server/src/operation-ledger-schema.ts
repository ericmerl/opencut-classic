import * as z from "zod/v4";

export const OPERATION_LEDGER_SCHEMA_VERSION = 1 as const;

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

const identifierSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const checksumSchema = sha256Schema;
const timestampSchema = z.iso.datetime({ offset: true });

export const operationActorSchema = z
	.object({
		type: z.enum(["user", "agent", "service", "system"]),
		id: identifierSchema,
		label: z.string().max(256).optional(),
	})
	.strict();

export const operationConnectionAffinitySchema = z
	.object({
		serverInstanceId: identifierSchema,
		editorInstanceId: identifierSchema,
		editorSessionId: identifierSchema,
		connectionGeneration: z.number().int().positive(),
		protocolVersion: z.number().int().positive(),
	})
	.strict();

export const operationProviderProvenanceSchema = z
	.object({
		provider: identifierSchema,
		modelId: identifierSchema.optional(),
		modelVersion: identifierSchema.optional(),
		artifactHash: sha256Schema.optional(),
		optionsFingerprint: checksumSchema.optional(),
		metadata: z.record(z.string(), jsonValueSchema).optional(),
	})
	.strict();

export const operationRelationshipsSchema = z
	.object({
		undoOf: identifierSchema.nullable(),
		redoOf: identifierSchema.nullable(),
		checkpointId: identifierSchema.nullable(),
		restoresCheckpointId: identifierSchema.nullable(),
		nativeCommandId: identifierSchema.nullable(),
	})
	.strict();

export const operationDispositionSchema = z.enum([
	"not-applied",
	"applied-verified",
	"unknown",
]);

export const operationAffectedObjectSchema = z
	.object({
		objectType: z.enum([
			"server",
			"editor",
			"project",
			"scene",
			"track",
			"element",
			"media",
			"transition",
			"relationship",
			"file",
			"provider-artifact",
			"export-job",
			"export-batch",
			"export-receipt",
		]),
		objectId: identifierSchema,
		action: z.enum([
			"started",
			"stopped",
			"created",
			"opened",
			"saved",
			"updated",
			"deleted",
			"imported",
			"attached",
			"generated",
			"exported",
			"queued",
			"cancelled",
			"processed",
			"inspected",
			"undone",
		]),
	})
	.strict();

export const operationArtifactSchema = z
	.object({
		artifactId: identifierSchema,
		kind: z.enum([
			"source",
			"provider-output",
			"media",
			"subtitle",
			"export",
			"receipt",
		]),
		state: z.enum([
			"prepared",
			"created",
			"transferred",
			"attached",
			"verified",
		]),
		sha256: sha256Schema.nullable(),
		bytes: z.number().int().nonnegative().nullable(),
		path: z.string().min(1).max(4_096).nullable(),
		mimeType: z.string().min(1).max(256).nullable(),
	})
	.strict();

export const operationCheckpointSchema = z
	.object({
		checkpointId: identifierSchema,
		kind: z.enum(["editor", "provider", "filesystem", "job", "save"]),
		state: z.enum(["prepared", "committed", "verified"]),
		recordedAt: timestampSchema,
		metadata: z.record(z.string(), jsonValueSchema),
	})
	.strict();

export const operationSaveReceiptSchema = z
	.object({
		receiptId: identifierSchema,
		operationId: identifierSchema,
		projectId: identifierSchema,
		sceneId: identifierSchema,
		revision: z.number().int().nonnegative(),
		contentHash: sha256Schema,
		persistedAt: timestampSchema,
		completedAt: timestampSchema,
		storageSchemaVersion: z.number().int().positive(),
		writeVersion: z.number().int().positive(),
		reloadVerified: z.literal(true),
		readbackContentHash: sha256Schema,
	})
	.strict()
	.superRefine((receipt, context) => {
		if (receipt.contentHash !== receipt.readbackContentHash) {
			context.addIssue({
				code: "custom",
				message: "save receipt readback hash must match content hash",
			});
		}
	});

export const operationDiagnosticsSchema = z
	.object({
		code: identifierSchema,
		message: z.string().min(1).max(8_192),
		details: z.record(z.string(), jsonValueSchema).nullable(),
	})
	.strict();

export const operationLeaseSchema = z
	.object({
		ownerId: identifierSchema,
		fencingToken: z.string().uuid(),
		expiresAt: timestampSchema,
	})
	.strict();

export const operationStatusSchema = z.enum(["started", "completed", "failed"]);
export const operationTypeSchema = z.enum(["mutation", "nonmutation"]);
export const operationPhaseSchema = z.enum([
	"claimed",
	"dispatching",
	"awaiting-editor",
	"awaiting-provider",
	"saving",
	"verifying",
	"reconciling",
	"completed",
	"failed",
]);

export const operationLedgerRecordSchema = z
	.object({
		schemaVersion: z.literal(OPERATION_LEDGER_SCHEMA_VERSION),
		ledgerVersion: z.number().int().positive(),
		eventSequence: z.number().int().positive(),
		previousChecksum: checksumSchema.nullable(),
		operationId: identifierSchema,
		operationKind: identifierSchema,
		description: z.string().trim().min(1).max(1_024),
		operationType: operationTypeSchema,
		requiresSaveVerification: z.boolean(),
		status: operationStatusSchema,
		disposition: operationDispositionSchema,
		phase: operationPhaseSchema,
		attempt: z.number().int().positive(),
		lease: operationLeaseSchema.nullable(),
		actor: operationActorSchema,
		requestIdentity: identifierSchema.nullable(),
		connectionAffinity: operationConnectionAffinitySchema.nullable(),
		projectId: identifierSchema.nullable(),
		sceneId: identifierSchema.nullable(),
		inputFingerprint: checksumSchema,
		revisionBefore: z.number().int().nonnegative().nullable(),
		revisionAfter: z.number().int().nonnegative().nullable(),
		contentHashBefore: sha256Schema.nullable(),
		contentHashAfter: sha256Schema.nullable(),
		saveReceipt: operationSaveReceiptSchema.nullable(),
		providerProvenance: z.array(operationProviderProvenanceSchema).max(100),
		artifacts: z.array(operationArtifactSchema).max(1_000),
		checkpoints: z.array(operationCheckpointSchema).max(1_000),
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		completedAt: timestampSchema.nullable(),
		affectedObjects: z.array(operationAffectedObjectSchema).max(10_000),
		relationships: operationRelationshipsSchema,
		diagnostics: operationDiagnosticsSchema.nullable(),
		result: jsonValueSchema.nullable(),
	})
	.strict()
	.superRefine((record, context) => {
		if (
			record.operationType === "nonmutation" &&
			record.requiresSaveVerification
		) {
			context.addIssue({
				code: "custom",
				message: "nonmutation operations cannot require save verification",
			});
		}
		if ((record.ledgerVersion === 1) !== (record.previousChecksum === null)) {
			context.addIssue({
				code: "custom",
				message: "only the first ledger version may omit previousChecksum",
			});
		}
		if (record.status === "started") {
			if (record.lease === null || record.completedAt !== null) {
				context.addIssue({
					code: "custom",
					message:
						"started records require a lease and no completion timestamp",
				});
			}
			if (record.phase === "completed" || record.phase === "failed") {
				context.addIssue({ code: "custom", message: "invalid started phase" });
			}
			if (record.diagnostics !== null || record.result !== null) {
				context.addIssue({
					code: "custom",
					message: "started records cannot contain terminal output",
				});
			}
			if (record.disposition === "applied-verified") {
				context.addIssue({
					code: "custom",
					message: "started records cannot be applied-verified",
				});
			}
		} else {
			if (record.lease !== null || record.completedAt === null) {
				context.addIssue({
					code: "custom",
					message: "terminal records require completion and no lease",
				});
			}
			if (record.phase !== record.status) {
				context.addIssue({
					code: "custom",
					message: "terminal phase mismatch",
				});
			}
			if (record.status === "completed" && record.diagnostics !== null) {
				context.addIssue({
					code: "custom",
					message: "completed records cannot contain diagnostics",
				});
			}
			if (record.status === "failed" && record.diagnostics === null) {
				context.addIssue({
					code: "custom",
					message: "failed records require diagnostics",
				});
			}
			if (
				record.operationType === "mutation" &&
				record.status === "completed" &&
				record.disposition !== "applied-verified"
			) {
				context.addIssue({
					code: "custom",
					message: "completed mutations must be applied-verified",
				});
			}
			if (record.disposition === "unknown") {
				context.addIssue({
					code: "custom",
					message: "unknown outcomes must remain recoverable and nonterminal",
				});
			}
			if (
				record.requiresSaveVerification &&
				record.status === "completed" &&
				(record.revisionAfter === null ||
					record.contentHashAfter === null ||
					record.saveReceipt === null)
			) {
				context.addIssue({
					code: "custom",
					message:
						"completed project mutations require revision, content hash, and save receipt evidence",
				});
			}
			if (
				record.saveReceipt &&
				(record.saveReceipt.projectId !== record.projectId ||
					record.saveReceipt.sceneId !== record.sceneId ||
					record.saveReceipt.revision !== record.revisionAfter ||
					record.saveReceipt.contentHash !== record.contentHashAfter)
			) {
				context.addIssue({
					code: "custom",
					message: "save receipt must link to the terminal operation state",
				});
			}
		}
	});

export type OperationActor = z.infer<typeof operationActorSchema>;
export type OperationConnectionAffinity = z.infer<
	typeof operationConnectionAffinitySchema
>;
export type OperationProviderProvenance = z.infer<
	typeof operationProviderProvenanceSchema
>;
export type OperationDisposition = z.infer<typeof operationDispositionSchema>;
export type OperationAffectedObject = z.infer<
	typeof operationAffectedObjectSchema
>;
export type OperationArtifact = z.infer<typeof operationArtifactSchema>;
export type OperationCheckpoint = z.infer<typeof operationCheckpointSchema>;
export type OperationSaveReceipt = z.infer<typeof operationSaveReceiptSchema>;
export type OperationRelationships = z.infer<
	typeof operationRelationshipsSchema
>;
export type OperationDiagnostics = z.infer<typeof operationDiagnosticsSchema>;
export type OperationLease = z.infer<typeof operationLeaseSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type OperationType = z.infer<typeof operationTypeSchema>;
export type OperationPhase = z.infer<typeof operationPhaseSchema>;
export type OperationLedgerRecord = z.infer<typeof operationLedgerRecordSchema>;

export class OperationLedgerUnsupportedVersionError extends Error {
	readonly code = "OPERATION_LEDGER_UNSUPPORTED_VERSION";

	constructor(readonly version: unknown) {
		super(
			`operation ledger schema version ${String(version)} is unsupported; no automatic migration is available`,
		);
		this.name = "OperationLedgerUnsupportedVersionError";
	}
}

export function parseOperationLedgerRecord(
	value: unknown,
): OperationLedgerRecord {
	if (
		value !== null &&
		typeof value === "object" &&
		"schemaVersion" in value &&
		(value as { schemaVersion?: unknown }).schemaVersion !==
			OPERATION_LEDGER_SCHEMA_VERSION
	) {
		throw new OperationLedgerUnsupportedVersionError(
			(value as { schemaVersion?: unknown }).schemaVersion,
		);
	}
	return operationLedgerRecordSchema.parse(value);
}

export function parseJsonValue(value: unknown): JsonValue {
	assertStrictJson(value);
	return jsonValueSchema.parse(value);
}

function assertStrictJson(value: unknown): void {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new TypeError("JSON numbers must be finite");
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			if (!(index in value))
				throw new TypeError("sparse arrays are not JSON values");
			assertStrictJson(value[index]);
		}
		return;
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("only plain objects are JSON values");
		}
		for (const child of Object.values(value as Record<string, unknown>)) {
			assertStrictJson(child);
		}
		return;
	}
	throw new TypeError(`unsupported JSON value type: ${typeof value}`);
}
