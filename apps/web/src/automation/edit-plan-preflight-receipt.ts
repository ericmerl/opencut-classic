import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import type { SourceBinding } from "opencut-wasm";
import { verifyEditPlanEvaluationIntegrity } from "./edit-plan-evaluation-integrity";
import { canonicalSerialize } from "./project-content-hash";
import { toNativeEditOperations } from "./edit-plan-operation-adapter";
import type {
	AutomationEditPlanPreflightRequest,
	AutomationEditPlanPreflightResult,
	AutomationGetEditPlanPreflightReceiptResult,
	AutomationNoMutationObservation,
} from "./types";

const RECEIPT_VERSION = 1 as const;
const DB_NAME = "opencut-edit-plan-preflight-receipts";

export interface PersistedEditPlanPreflightReceipt {
	id: string;
	receiptVersion: typeof RECEIPT_VERSION;
	preflightId: string;
	requestFingerprint: string;
	planFingerprint: string;
	source: SourceBinding;
	result: AutomationEditPlanPreflightResult;
	recordedAt: string;
	checksum: string;
}

type ReceiptInput = Omit<PersistedEditPlanPreflightReceipt, "id" | "checksum">;

export class EditPlanPreflightReceiptStore {
	private readonly adapter = new IndexedDBAdapter<unknown>({
		dbName: DB_NAME,
		storeName: "receipts",
		version: 1,
	});
	private readonly writeTails = new Map<string, Promise<void>>();

	async save(
		receipt: ReceiptInput,
	): Promise<PersistedEditPlanPreflightReceipt> {
		const prior = this.writeTails.get(receipt.preflightId) ?? Promise.resolve();
		let stored: PersistedEditPlanPreflightReceipt | null = null;
		const next = prior.then(async () => {
			stored = await this.saveNow(receipt);
		});
		this.writeTails.set(receipt.preflightId, next);
		try {
			await next;
		} finally {
			if (this.writeTails.get(receipt.preflightId) === next) {
				this.writeTails.delete(receipt.preflightId);
			}
		}
		if (!stored)
			throw new Error("preflight receipt publication did not complete");
		return stored;
	}

	async query({
		preflightId,
		requestFingerprint,
	}: {
		preflightId: string;
		requestFingerprint: string;
	}): Promise<AutomationGetEditPlanPreflightReceiptResult> {
		const receipt = await this.load(preflightId);
		if (!receipt) return { status: "not-found", preflightId };
		await verifyEditPlanPreflightReceipt(receipt);
		return receipt.requestFingerprint === requestFingerprint
			? { status: "found", receipt }
			: { status: "mismatched", preflightId };
	}

	async load(
		preflightId: string,
	): Promise<PersistedEditPlanPreflightReceipt | null> {
		const value = await this.adapter.get(preflightId);
		if (value === null) return null;
		const receipt = parseReceipt({ value, preflightId });
		await verifyEditPlanPreflightReceipt(receipt);
		return receipt;
	}

	private async saveNow(
		receipt: ReceiptInput,
	): Promise<PersistedEditPlanPreflightReceipt> {
		validateReceiptInput(receipt);
		const prior = await this.load(receipt.preflightId);
		const complete: PersistedEditPlanPreflightReceipt = {
			id: receipt.preflightId,
			...receipt,
			checksum: await receiptChecksum(receipt),
		};
		await verifyEditPlanPreflightReceipt(complete);
		if (prior) {
			if (
				prior.requestFingerprint === receipt.requestFingerprint &&
				prior.checksum === complete.checksum
			) {
				return prior;
			}
			throw new Error(
				`preflight ID ${receipt.preflightId} already records different evidence`,
			);
		}
		await this.adapter.set({ key: receipt.preflightId, value: complete });
		const published = await this.load(receipt.preflightId);
		if (!published || published.checksum !== complete.checksum) {
			throw new Error("preflight receipt publication could not be verified");
		}
		return complete;
	}
}

export const editPlanPreflightReceiptStore =
	new EditPlanPreflightReceiptStore();

export async function editPlanPreflightFingerprints(
	request: AutomationEditPlanPreflightRequest,
): Promise<{ planFingerprint: string; requestFingerprint: string }> {
	const normalizedOperations = normalizeEditPlanFingerprintOperations(
		request.operations,
	);
	const planFingerprint = await sha256(
		canonicalSerialize({
			contractVersion: "opencut.edit-plan-preflight.v2",
			description: request.description,
			operations: normalizedOperations,
		}),
	);
	const requestFingerprint = await sha256(
		canonicalSerialize({
			schemaVersion: "opencut.edit-plan-preflight.v2",
			planFingerprint,
			projectId: request.projectId,
			sceneId: request.sceneId,
			revision: request.expectedRevision,
			contentHash: request.expectedProjectContentHash,
			writeVersion: request.expectedWriteVersion,
			saveReceiptOperationId: request.saveReceiptOperationId,
			saveReceiptId: request.expectedSaveReceiptId,
			connectionIdentity: request.expectedConnectionIdentity,
			policy: request.policy,
		}),
	);
	return { planFingerprint, requestFingerprint };
}

export function normalizeEditPlanFingerprintOperations(
	operations: readonly AutomationEditPlanPreflightRequest["operations"][number][],
): unknown {
	return toJsonDomain({
		value: toNativeEditOperations(operations).map(
			normalizeRustOperationOptions,
		),
		options: { undefinedObjectValue: null },
	});
}

function normalizeRustOperationOptions(
	operation: ReturnType<typeof toNativeEditOperations>[number],
): Record<string, unknown> {
	const value = { ...operation } as Record<string, unknown>;
	// Output-only native allocation evidence must never enter the raw-plan
	// fingerprint, including when the TypeScript adapter materializes it as
	// `undefined` for operations such as set_audio.
	delete value.resolvedAllocations;
	delete value.resolvedCascadeElementIds;
	if (value.autoTrackId === undefined) delete value.autoTrackId;
	const optional: Partial<Record<typeof operation.kind, string[]>> = {
		insert_text: ["elementId"],
		insert_graphic: ["elementId", "name", "trackId", "params"],
		insert_sticker: ["elementId", "name", "trackId", "params"],
		insert_adjustment_layer: ["elementId", "name", "trackId", "params"],
		set_track_state: ["muted", "hidden"],
		set_project_settings: ["fps", "canvasSize", "background"],
		insert_captions: ["trackId", "style"],
		update_caption: ["text", "startTime", "duration"],
		duplicate_elements: ["duplicateIds"],
		create_compound: ["name", "targetTrackId"],
		break_apart_compound: ["restoredElementIds"],
		move: ["targetTrackId"],
		set_reframe: ["mode", "crop", "focalPoint", "targetRect", "layout"],
		set_audio: ["volumeDb", "muted", "fade"],
		separate_source_audio: ["audioTrackId", "audioElementId", "linkId"],
		upsert_effect: ["params", "enabled"],
		upsert_keyframe: ["interpolation", "keyframeId"],
		set_retime: ["maintainPitch"],
		trim: ["startTime", "duration"],
		split: ["rightElementId", "retainSide"],
		set_mask: ["params"],
		reorder_tracks: ["overlayTrackIds", "audioTrackIds"],
		remove_track: ["targetTrackId"],
		duplicate_track: ["newTrackId", "name"],
		add_bookmark: ["bookmarkId", "duration", "note", "color"],
		update_bookmark: ["note", "color", "duration"],
		instantiate_asset: ["elementId", "name", "duration", "trackId"],
	};
	for (const key of optional[operation.kind] ?? []) {
		if (!(key in value) || value[key] === undefined) value[key] = null;
	}
	if (operation.kind === "insert_captions") {
		value.captions = operation.captions.map((caption) => ({
			elementId: caption.elementId ?? null,
			text: caption.text,
			startTime: caption.startTime,
			duration: caption.duration,
		}));
	}
	return value;
}

function parseReceipt({
	value,
	preflightId,
}: {
	value: unknown;
	preflightId: string;
}): PersistedEditPlanPreflightReceipt {
	if (!isRecord(value)) {
		throw corrupt({ preflightId, reason: "receipt is not an object" });
	}
	if (
		!hasOnlyKeys({
			value,
			allowed: [
				"id",
				"receiptVersion",
				"preflightId",
				"requestFingerprint",
				"planFingerprint",
				"source",
				"result",
				"recordedAt",
				"checksum",
			],
		}) ||
		value.id !== preflightId ||
		value.preflightId !== preflightId ||
		value.receiptVersion !== RECEIPT_VERSION ||
		!isDigest(value.requestFingerprint) ||
		!isDigest(value.planFingerprint) ||
		!isSourceBinding(value.source) ||
		!isPreflightResult(value.result) ||
		typeof value.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(value.recordedAt)) ||
		!isDigest(value.checksum)
	) {
		throw corrupt({ preflightId, reason: "receipt fields are invalid" });
	}
	return {
		id: value.id,
		receiptVersion: value.receiptVersion,
		preflightId: value.preflightId,
		requestFingerprint: value.requestFingerprint,
		planFingerprint: value.planFingerprint,
		source: value.source,
		result: value.result,
		recordedAt: value.recordedAt,
		checksum: value.checksum,
	};
}

export async function verifyEditPlanPreflightReceipt(
	receipt: PersistedEditPlanPreflightReceipt,
): Promise<void> {
	const expected = await receiptChecksum(receipt);
	if (expected !== receipt.checksum) {
		throw corrupt({
			preflightId: receipt.preflightId,
			reason: "receipt checksum mismatch",
		});
	}
	if (receipt.result.preflightId !== receipt.preflightId) {
		throw corrupt({
			preflightId: receipt.preflightId,
			reason: "terminal result ID mismatch",
		});
	}
	if (receipt.result.status !== "validated") return;
	const result = receipt.result;
	if (
		canonicalSerialize(result.evaluation.source) !==
			canonicalSerialize(receipt.source) ||
		result.evaluation.planFingerprint !== receipt.planFingerprint ||
		!isObservationBoundToSource({
			observation: result.sourceObservation,
			source: receipt.source,
		}) ||
		canonicalSerialize(result.noMutationProof.before) !==
			canonicalSerialize(result.sourceObservation) ||
		canonicalSerialize(result.noMutationProof.after) !==
			canonicalSerialize(result.sourceObservation)
	) {
		throw corrupt({
			preflightId: receipt.preflightId,
			reason: "validated evidence binding mismatch",
		});
	}
	try {
		const integrityError = await verifyEditPlanEvaluationIntegrity({
			evaluation: result.evaluation,
			expectedSource: receipt.source,
			expectedOperations: result.evaluation.resolvedOperations,
		});
		if (integrityError) throw new Error(integrityError);
	} catch (error) {
		throw corrupt({
			preflightId: receipt.preflightId,
			reason: `invalid native evaluation: ${error instanceof Error ? error.message : "unknown error"}`,
		});
	}
}

async function receiptChecksum(
	receipt: Omit<PersistedEditPlanPreflightReceipt, "id" | "checksum">,
): Promise<string> {
	return sha256(
		canonicalSerialize(
			toJsonDomain({
				value: {
					receiptVersion: receipt.receiptVersion,
					preflightId: receipt.preflightId,
					requestFingerprint: receipt.requestFingerprint,
					planFingerprint: receipt.planFingerprint,
					source: receipt.source,
					result: receipt.result,
					recordedAt: receipt.recordedAt,
				},
			}),
		),
	);
}

function validateReceiptInput(receipt: ReceiptInput): void {
	if (
		!receipt.preflightId ||
		!isDigest(receipt.requestFingerprint) ||
		!isDigest(receipt.planFingerprint) ||
		!isSourceBinding(receipt.source) ||
		!isPreflightResult(receipt.result) ||
		!Number.isFinite(Date.parse(receipt.recordedAt))
	) {
		throw new Error("preflight receipt input is invalid");
	}
}

function isPreflightResult(
	value: unknown,
): value is AutomationEditPlanPreflightResult {
	if (!isRecord(value) || !isNonemptyString(value.preflightId)) return false;
	if (value.status === "validated") {
		return (
			hasOnlyKeys({
				value,
				allowed: [
					"status",
					"preflightId",
					"evaluation",
					"sourceObservation",
					"noMutationProof",
					"captionLayout",
				],
			}) &&
			(value.captionLayout === undefined || isRecord(value.captionLayout)) &&
			isRecord(value.evaluation) &&
			isEvaluationEnvelope(value.evaluation) &&
			isNoMutationObservation(value.sourceObservation) &&
			isRecord(value.noMutationProof) &&
			hasOnlyKeys({
				value: value.noMutationProof,
				allowed: ["unchanged", "before", "after"],
			}) &&
			value.noMutationProof.unchanged === true &&
			isNoMutationObservation(value.noMutationProof.before) &&
			isNoMutationObservation(value.noMutationProof.after)
		);
	}
	if (!isNonemptyString(value.reason)) return false;
	if (value.status === "conflict") {
		return (
			hasOnlyKeys({
				value,
				allowed: ["status", "preflightId", "code", "reason"],
			}) &&
			(value.code === "SOURCE_STATE_CONFLICT" ||
				value.code === "STATE_CHANGED_DURING_PREFLIGHT")
		);
	}
	if (value.status !== "rejected") return false;
	if (value.code === "NATIVE_EVALUATION_REJECTED") {
		return (
			hasOnlyKeys({
				value,
				allowed: ["status", "preflightId", "code", "reason", "error"],
			}) && isEditPlanError(value.error)
		);
	}
	return (
		hasOnlyKeys({
			value,
			allowed: ["status", "preflightId", "code", "reason"],
		}) &&
		(value.code === "PERSISTED_SOURCE_UNAVAILABLE" ||
			value.code === "PERSISTED_SOURCE_MISMATCH" ||
			value.code === "SAVE_RECEIPT_MISMATCH" ||
			value.code === "PREFLIGHT_ID_REUSED")
	);
}

function isSourceBinding(value: unknown): value is SourceBinding {
	if (!isRecord(value) || !isRecord(value.connectionIdentity)) return false;
	const identity = value.connectionIdentity;
	return (
		hasOnlyKeys({
			value,
			allowed: [
				"connectionIdentity",
				"projectId",
				"sceneId",
				"sessionRevision",
				"canonicalProjectHash",
				"durableWriteVersion",
				"saveReceiptId",
				"saveOperationId",
			],
		}) &&
		hasOnlyKeys({
			value: identity,
			allowed: [
				"serverInstanceId",
				"editorInstanceId",
				"editorSessionId",
				"connectionGeneration",
				"bridgeProtocolVersion",
			],
		}) &&
		isNonemptyString(value.projectId) &&
		isNonemptyString(value.sceneId) &&
		isNonnegativeSafeInteger(value.sessionRevision) &&
		isDigest(value.canonicalProjectHash) &&
		isPositiveSafeInteger(value.durableWriteVersion) &&
		isNonemptyString(value.saveReceiptId) &&
		isNonemptyString(value.saveOperationId) &&
		isNonemptyString(identity.serverInstanceId) &&
		isNonemptyString(identity.editorInstanceId) &&
		isNonemptyString(identity.editorSessionId) &&
		isPositiveSafeInteger(identity.connectionGeneration) &&
		identity.bridgeProtocolVersion === 2
	);
}

function isNoMutationObservation(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys({
			value,
			allowed: [
				"projectId",
				"sceneId",
				"sessionRevision",
				"canonicalProjectHash",
				"durableWriteVersion",
				"saveReceiptId",
				"saveOperationId",
				"connectionIdentity",
				"activeProjectId",
				"activeSceneId",
				"playheadTicks",
				"isPlaying",
				"selectionFingerprint",
				"historyFingerprint",
				"persistenceFingerprint",
			],
		}) &&
		isSourceBinding({
			connectionIdentity: value.connectionIdentity,
			projectId: value.projectId,
			sceneId: value.sceneId,
			sessionRevision: value.sessionRevision,
			canonicalProjectHash: value.canonicalProjectHash,
			durableWriteVersion: value.durableWriteVersion,
			saveReceiptId: value.saveReceiptId,
			saveOperationId: value.saveOperationId,
		}) &&
		isNonemptyString(value.activeProjectId) &&
		isNonemptyString(value.activeSceneId) &&
		typeof value.playheadTicks === "number" &&
		Number.isSafeInteger(value.playheadTicks) &&
		typeof value.isPlaying === "boolean" &&
		isDigest(value.selectionFingerprint) &&
		isDigest(value.historyFingerprint) &&
		isDigest(value.persistenceFingerprint)
	);
}

function isObservationBoundToSource({
	observation,
	source,
}: {
	observation: AutomationNoMutationObservation;
	source: SourceBinding;
}): boolean {
	return (
		observation.projectId === source.projectId &&
		observation.sceneId === source.sceneId &&
		observation.sessionRevision === source.sessionRevision &&
		observation.canonicalProjectHash === source.canonicalProjectHash &&
		observation.durableWriteVersion === source.durableWriteVersion &&
		observation.saveReceiptId === source.saveReceiptId &&
		observation.saveOperationId === source.saveOperationId &&
		canonicalSerialize(observation.connectionIdentity) ===
			canonicalSerialize(source.connectionIdentity)
	);
}

const EDIT_PLAN_ERROR_CODES = new Set([
	"CONTRACT_VERSION",
	"SNAPSHOT_VERSION",
	"SOURCE_MISMATCH",
	"CAPABILITY_NOT_READY",
	"COST_UNAVAILABLE",
	"EMPTY_PLAN",
	"TOO_MANY_OPERATIONS",
	"INVALID_VALUE",
	"DUPLICATE_ID",
	"UNKNOWN_REFERENCE",
	"INCOMPATIBLE_TRACK",
	"UNSUPPORTED_FRAME_RATE",
	"BOUNDS",
	"SILENT_NO_OP",
	"ARITHMETIC_OVERFLOW",
]);

function isEditPlanError(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys({
			value,
			allowed: ["code", "message", "operationIndex", "path"],
		}) &&
		typeof value.code === "string" &&
		EDIT_PLAN_ERROR_CODES.has(value.code) &&
		isNonemptyString(value.message) &&
		(value.operationIndex === null ||
			isNonnegativeSafeInteger(value.operationIndex)) &&
		(value.path === null || typeof value.path === "string")
	);
}

function isEvaluationEnvelope(value: Record<string, unknown>): boolean {
	return hasOnlyKeys({
		value,
		allowed: [
			"schemaVersion",
			"source",
			"planFingerprint",
			"preflightFingerprint",
			"planDiffHash",
			"predictedProjectHash",
			"beforeSummary",
			"predictedAfterSummary",
			"before",
			"predictedAfter",
			"resolvedOperations",
			"resolvedIds",
			"changedObjects",
			"timingConsequences",
			"rippleExpansion",
			"relationshipExpansion",
			"warnings",
			"requirements",
			"cost",
		],
	});
}

function hasOnlyKeys({
	value,
	allowed,
}: {
	value: Record<string, unknown>;
	allowed: string[];
}): boolean {
	const keys = Object.keys(value);
	return (
		keys.length <= allowed.length && keys.every((key) => allowed.includes(key))
	);
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toJsonDomain({
	value,
	options = {},
}: {
	value: unknown;
	options?: { undefinedObjectValue?: null };
}): unknown {
	if (value === undefined) return options.undefinedObjectValue;
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((child) => toJsonDomain({ value: child, options }));
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).flatMap(([key, child]) => {
				if (child === undefined && options.undefinedObjectValue === undefined) {
					return [];
				}
				return [[key, toJsonDomain({ value: child, options })]];
			}),
		);
	}
	throw new Error("preflight receipt left the strict JSON domain");
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return isNonnegativeSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corrupt({
	preflightId,
	reason,
}: {
	preflightId: string;
	reason: string;
}): Error {
	return new Error(`preflight receipt ${preflightId} is corrupt: ${reason}`);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
