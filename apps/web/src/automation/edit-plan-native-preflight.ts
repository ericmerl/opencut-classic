import type { EditorCore } from "@/core";
import {
	evaluateEditPlan,
	type EditPlanError,
	type EditPlanEvaluationResponse,
	type EvaluateEditPlanOptions,
	type SourceBinding,
} from "opencut-wasm";
import { buildEditorProjectContentInput } from "./project-content-identity";
import {
	buildCanonicalProjectState,
	canonicalSerialize,
} from "./project-content-hash";
import { captureEditPlanPreflightSource } from "./edit-plan-preflight-source";
import { toNativeEditOperations } from "./edit-plan-operation-adapter";
import { materializeEditPlanCaptions } from "./edit-plan-caption-materialization";
import { verifyEditPlanEvaluationIntegrity } from "./edit-plan-evaluation-integrity";
import {
	editPlanPreflightReceiptStore,
	editPlanPreflightFingerprints,
	verifyEditPlanPreflightReceipt,
} from "./edit-plan-preflight-receipt";
import type {
	AutomationEditPlanPreflightRequest,
	AutomationEditPlanPreflightResult,
	AutomationGetEditPlanPreflightReceiptResult,
} from "./types";

interface EditPlanPreflightReceiptRepository {
	query(input: {
		preflightId: string;
		requestFingerprint: string;
	}): Promise<AutomationGetEditPlanPreflightReceiptResult>;
	save(
		receipt: Omit<
			import("./edit-plan-preflight-receipt").PersistedEditPlanPreflightReceipt,
			"id" | "checksum"
		>,
	): Promise<
		import("./edit-plan-preflight-receipt").PersistedEditPlanPreflightReceipt
	>;
}

const EDIT_PLAN_CONTRACT = "opencut.edit-plan-preflight.v2";

export async function evaluateNativeEditPlanPreflight({
	editor,
	request,
	sessionRevision,
	knownStateFingerprint,
	captureSource = captureEditPlanPreflightSource,
	materializeCaptions = materializeEditPlanCaptions,
	evaluate = evaluateEditPlan,
	store = editPlanPreflightReceiptStore,
}: {
	editor: EditorCore;
	request: AutomationEditPlanPreflightRequest;
	sessionRevision: number;
	knownStateFingerprint: string;
	captureSource?: typeof captureEditPlanPreflightSource;
	materializeCaptions?: typeof materializeEditPlanCaptions;
	evaluate?: (options: EvaluateEditPlanOptions) => EditPlanEvaluationResponse;
	store?: EditPlanPreflightReceiptRepository;
}): Promise<AutomationEditPlanPreflightResult> {
	const fingerprints = await editPlanPreflightFingerprints(request);
	const prior = await store.query({
		preflightId: request.preflightId,
		requestFingerprint: fingerprints.requestFingerprint,
	});
	if (prior.status === "found") {
		await verifyEditPlanPreflightReceipt(prior.receipt);
		if (
			prior.receipt.planFingerprint !== fingerprints.planFingerprint ||
			canonicalSerialize(prior.receipt.source) !==
				canonicalSerialize(buildSourceBinding(request))
		) {
			throw new Error("durable preflight receipt source binding mismatch");
		}
		return prior.receipt.result;
	}
	if (prior.status === "mismatched") {
		return {
			status: "rejected",
			preflightId: request.preflightId,
			code: "PREFLIGHT_ID_REUSED",
			reason: "preflightId was already used for a different request",
		};
	}
	const sourceBinding = buildSourceBinding(request);
	const finish = async (
		result: AutomationEditPlanPreflightResult,
	): Promise<AutomationEditPlanPreflightResult> => {
		const receipt = await store.save({
			receiptVersion: 1,
			preflightId: request.preflightId,
			requestFingerprint: fingerprints.requestFingerprint,
			planFingerprint: fingerprints.planFingerprint,
			source: sourceBinding,
			result,
			recordedAt: new Date().toISOString(),
		});
		await verifyEditPlanPreflightReceipt(receipt);
		return receipt.result;
	};
	const before = await captureSource({
		editor,
		request,
		sessionRevision,
		knownStateFingerprint,
	});
	if (before.status !== "captured") {
		return finish({ ...before, preflightId: request.preflightId });
	}

	const source = sourceBinding;
	const capabilitySnapshot = request.capabilitySnapshot;
	const beforeSnapshot = buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: before.readback.project,
			mediaAssets: before.readback.mediaAssets,
		}),
	);
	const beforeSnapshotHash = await sha256(canonicalSerialize(beforeSnapshot));
	if (beforeSnapshotHash !== source.canonicalProjectHash) {
		return finish(
			rejected({
				preflightId: request.preflightId,
				error: {
					code: "SOURCE_MISMATCH",
					message: `browser canonical before hash ${beforeSnapshotHash} does not match source ${source.canonicalProjectHash}`,
					operationIndex: null,
					path: "source.canonicalProjectHash",
				},
			}),
		);
	}
	let materialized: Awaited<ReturnType<typeof materializeEditPlanCaptions>>;
	try {
		materialized = await materializeCaptions({
			operations: request.operations,
			canvasSize: before.readback.project.settings.canvasSize,
		});
	} catch (error) {
		return finish(
			rejected({
				preflightId: request.preflightId,
				error: {
					code: "INVALID_VALUE",
					message:
						error instanceof Error
							? error.message
							: "caption layout materialization failed",
					operationIndex: null,
					path: "operations",
				},
			}),
		);
	}
	const options: EvaluateEditPlanOptions = {
		contractVersion: EDIT_PLAN_CONTRACT,
		source,
		capabilitySnapshot,
		policy: request.policy,
		description: request.description,
		operations: toNativeEditOperations(materialized.operations),
		before: beforeSnapshot,
	};
	const evaluated = evaluateSafely({ evaluate, options });
	if (evaluated.status === "rejected") {
		return finish(
			rejected({ preflightId: request.preflightId, error: evaluated.error }),
		);
	}
	const integrityError = await verifyEditPlanEvaluationIntegrity({
		evaluation: evaluated.result,
		expectedSource: source,
		expectedOperations: evaluated.result.resolvedOperations,
	});
	const expectedPreflightFingerprint = await sha256(
		canonicalSerialize({
			planFingerprint: fingerprints.planFingerprint,
			source,
			capabilitySnapshot,
			policy: request.policy,
		}),
	);
	if (
		integrityError ||
		evaluated.result.planFingerprint !== fingerprints.planFingerprint ||
		evaluated.result.preflightFingerprint !== expectedPreflightFingerprint ||
		!evaluationBindingsMatch({ evaluation: evaluated.result, options })
	) {
		return finish(
			rejected({
				preflightId: request.preflightId,
				error: {
					code: "SOURCE_MISMATCH",
					message:
						integrityError ??
						"native evaluation returned evidence for a different source or plan",
					operationIndex: null,
					path: "source",
				},
			}),
		);
	}

	const after = await captureSource({
		editor,
		request,
		sessionRevision,
		knownStateFingerprint,
	});
	if (after.status !== "captured") {
		return finish({
			status: "conflict",
			preflightId: request.preflightId,
			code: "STATE_CHANGED_DURING_PREFLIGHT",
			reason: after.reason,
		});
	}
	if (
		canonicalSerialize(before.observation) !==
		canonicalSerialize(after.observation)
	) {
		return finish({
			status: "conflict",
			preflightId: request.preflightId,
			code: "STATE_CHANGED_DURING_PREFLIGHT",
			reason: "editor or persisted source changed during read-only preflight",
		});
	}

	return finish({
		status: "validated",
		preflightId: request.preflightId,
		evaluation: evaluated.result,
		sourceObservation: before.observation,
		noMutationProof: {
			unchanged: true,
			before: before.observation,
			after: after.observation,
		},
		...(materialized.captionLayout
			? { captionLayout: materialized.captionLayout }
			: {}),
	});
}

function buildSourceBinding(
	request: AutomationEditPlanPreflightRequest,
): SourceBinding {
	return {
		connectionIdentity: {
			...request.expectedConnectionIdentity,
			bridgeProtocolVersion: 2,
		},
		projectId: request.projectId,
		sceneId: request.sceneId,
		sessionRevision: request.expectedRevision,
		canonicalProjectHash: request.expectedProjectContentHash,
		durableWriteVersion: request.expectedWriteVersion,
		saveReceiptId: request.expectedSaveReceiptId,
		saveOperationId: request.saveReceiptOperationId,
	};
}

function evaluateSafely({
	evaluate,
	options,
}: {
	evaluate: (options: EvaluateEditPlanOptions) => EditPlanEvaluationResponse;
	options: EvaluateEditPlanOptions;
}): EditPlanEvaluationResponse {
	try {
		return evaluate(options);
	} catch (error) {
		return {
			status: "rejected",
			error: {
				code: "INVALID_VALUE",
				message:
					error instanceof Error
						? error.message
						: "native edit-plan evaluation failed",
				operationIndex: null,
				path: null,
			},
		};
	}
}

function evaluationBindingsMatch({
	evaluation,
	options,
}: {
	evaluation: Extract<
		EditPlanEvaluationResponse,
		{ status: "validated" }
	>["result"];
	options: EvaluateEditPlanOptions;
}): boolean {
	return (
		canonicalSerialize(evaluation.source) ===
			canonicalSerialize(options.source) &&
		canonicalSerialize(evaluation.before) ===
			canonicalSerialize(options.before) &&
		canonicalSerialize(evaluation.requirements) ===
			canonicalSerialize(options.capabilitySnapshot) &&
		canonicalSerialize(evaluation.cost) ===
			canonicalSerialize(options.capabilitySnapshot.cost)
	);
}

function rejected({
	preflightId,
	error,
}: {
	preflightId: string;
	error: EditPlanError;
}): AutomationEditPlanPreflightResult {
	return {
		status: "rejected",
		preflightId,
		code: "NATIVE_EVALUATION_REJECTED",
		reason: error.message,
		error,
	};
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
