import { createHash, randomUUID } from "node:crypto";
import {
	parseJsonValue,
	parseCurrentOperationLedgerRecord,
	type JsonValue,
	type OperationActor,
	type OperationAffectedObject,
	type OperationArtifact,
	type OperationCheckpoint,
	type OperationConnectionAffinity,
	type OperationDiagnostics,
	type OperationLedgerRecord,
	type OperationProviderProvenance,
	type OperationRelationships,
	type OperationType,
} from "./operation-ledger-schema";

export interface FingerprintFields {
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

export function fingerprintOperation(input: FingerprintFields): string {
	const canonicalInput = parseJsonValue(input.canonicalInput);
	return sha256(
		stableSerialize({
			operationKind: input.operationKind,
			operationType: input.operationType,
			projectId: input.projectId ?? null,
			sceneId: input.sceneId ?? null,
			editorScope: input.connectionAffinity?.editorInstanceId ?? null,
			revisionBefore: input.revisionBefore ?? null,
			contentHashBefore: input.contentHashBefore ?? null,
			...(input.contentHashProjectionVersionBefore === undefined
				? {}
				: {
						contentHashProjectionVersionBefore:
							input.contentHashProjectionVersionBefore,
					}),
			canonicalInput,
		}),
	);
}

export function validateRecordDraft(
	draft: Omit<OperationLedgerRecord, "eventSequence" | "previousChecksum">,
): void {
	parseCurrentOperationLedgerRecord({
		...draft,
		eventSequence: 1,
		previousChecksum: draft.ledgerVersion === 1 ? null : "0".repeat(64),
	});
}

export function validateLeaseDuration(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 86_400_000) {
		throw new Error("leaseDurationMs must be from 1 through 86400000");
	}
}

export function validateHistoryLimit(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new Error("operation history limit must be from 1 through 100");
	}
}

export function createLease(
	ownerId: string,
	duration: number,
	now: Date,
	fencingToken: string = randomUUID(),
) {
	return {
		ownerId,
		fencingToken,
		expiresAt: new Date(now.getTime() + duration).toISOString(),
	};
}

export function relationships(
	value: Partial<OperationRelationships> = {},
): OperationRelationships {
	return {
		undoOf: value.undoOf ?? null,
		redoOf: value.redoOf ?? null,
		checkpointId: value.checkpointId ?? null,
		restoresCheckpointId: value.restoresCheckpointId ?? null,
		nativeCommandId: value.nativeCommandId ?? null,
		annotationId: value.annotationId ?? null,
		evidenceOperationId: value.evidenceOperationId ?? null,
		supersedesAnnotationVersionId: value.supersedesAnnotationVersionId ?? null,
		resolutionOperationId: value.resolutionOperationId ?? null,
		inspectionId: value.inspectionId ?? null,
		signoffId: value.signoffId ?? null,
	};
}

export function redactArtifacts(
	values: OperationArtifact[],
): OperationArtifact[] {
	return values.map((value) => ({
		...value,
		path: value.path ? (redactValue(value.path) as string) : null,
	}));
}

export function redactCheckpoints(
	values: OperationCheckpoint[],
): OperationCheckpoint[] {
	return values.map((value) => ({
		...value,
		metadata: redactObject(value.metadata) ?? {},
	}));
}

export function normalizeAffectedObjects(
	values: OperationAffectedObject[],
): OperationAffectedObject[] {
	const unique = new Map(
		values.map((value) => [
			`${value.objectType}\0${value.objectId}\0${value.action}`,
			value,
		]),
	);
	return [...unique.entries()]
		.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
		.map(([, value]) => value);
}

export function normalizeDiagnostics(
	value: OperationDiagnostics | Error,
): OperationDiagnostics {
	return value instanceof Error
		? { code: value.name || "ERROR", message: value.message, details: null }
		: value;
}

export function redactActor(
	value: OperationActor | null,
): OperationActor | null {
	return value
		? { ...value, label: value.label ? redactText(value.label) : undefined }
		: null;
}

export function redactProviders(
	values: OperationProviderProvenance[],
): OperationProviderProvenance[] {
	return values.map((value) => {
		const metadata = value.metadata ? redactObject(value.metadata) : undefined;
		return { ...value, metadata: metadata ?? undefined };
	});
}

export function redactDiagnostics(
	value: OperationDiagnostics,
): OperationDiagnostics {
	return {
		...value,
		message: redactText(value.message),
		details: value.details ? redactObject(value.details) : null,
	};
}

export function redactObject(
	value: Record<string, unknown> | null,
): Record<string, JsonValue> | null {
	if (value === null) return null;
	const parsed = parseJsonValue(value);
	return parseJsonValue(redactPayload(parsed)) as Record<string, JsonValue>;
}

export function redactValue(value: unknown): JsonValue {
	return parseJsonValue(redactPayload(parseJsonValue(value)));
}

export function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) =>
		Buffer.from(left).compare(Buffer.from(right)),
	);
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
	return (
		stableSerialize(parseJsonValue(left)) ===
		stableSerialize(parseJsonValue(right))
	);
}

function redactPayload(value: unknown, key = ""): unknown {
	if (isSecretKey(key)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map((child) => redactPayload(child));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [
				childKey,
				redactPayload(child, childKey),
			]),
		);
	}
	return typeof value === "string" ? redactText(value) : value;
}

function isSecretKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	if (
		normalized === "editorsessionid" ||
		normalized === "signoff" ||
		normalized === "signoffid"
	)
		return false;
	return /(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|passphrase|secret|token|apikey|privatekey|credential|sessionid|clientsecret|signature|sig)/i.test(
		normalized,
	);
}

function redactText(value: string): string {
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
		.replace(
			/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
			(match) => `${match.split(" ")[0]} [REDACTED]`,
		)
		.replace(
			/([?&](?:(?:x-amz-)?(?:credential|signature|security-token)|access_token|refresh_token|id_token|token|key|secret|password|api_key|sig)=)[^&#\s]+/gi,
			"$1[REDACTED]",
		)
		.replace(
			/\b((?:API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE_?KEY)=)[^\s]+/gi,
			"$1[REDACTED]",
		)
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(
			/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g,
			"[REDACTED TOKEN]",
		);
}

function stableSerialize(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, child]) => child !== undefined)
		.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
		.join(",")}}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
