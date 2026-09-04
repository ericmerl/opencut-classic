import {
	browserEditPlanPreflightReceiptChecksum,
	browserEditPlanPreflightReceiptQuerySchema,
	browserEditPlanPreflightResponseSchema,
	canonicalEditPlanJson,
	canonicalEditPlanSha256,
	deriveProjectChangedObjects,
	deriveProjectSummary,
	EDIT_PLAN_PREFLIGHT_SCHEMA,
	editPlanCapabilitySnapshotSchema,
	editPlanFingerprint,
	editPlanSemanticFingerprint,
	evaluationDiffHash,
	evaluationPreflightFingerprint,
	preflightEditPlanRequestFingerprint,
	type BrowserEditPlanPreflightResponse,
	type BrowserEditPlanPreflightReceipt,
	type PreflightEditPlanInput,
} from "./edit-plan-preflight-contract";
import {
	EditPlanPreflightStore,
	EditPlanPreflightReuseError,
	type EditPlanPreflightReceipt,
} from "./edit-plan-preflight-store";
import { parseJsonValue } from "./operation-ledger-schema";
import {
	connectionIdentitySchema,
	preflightEditPlanInputSchema,
} from "./tool-schemas";

export interface EditPlanPreflightBrowser {
	request(
		method: string,
		params: unknown,
		timeoutMs?: number,
		expectedIdentity?: PreflightEditPlanInput["expectedConnectionIdentity"],
	): Promise<unknown>;
}

export type EditPlanPreflightServiceResult = {
	schemaVersion: typeof EDIT_PLAN_PREFLIGHT_SCHEMA;
	disposition: "evaluated" | "replayed";
	receiptId: string;
	result: BrowserEditPlanPreflightResponse;
};

export interface EditPlanPreflightServiceOptions {
	afterReceiptCommit?: () => void;
	captureCapabilitySnapshot?: () => Promise<Record<string, unknown>>;
}

export class EditPlanPreflightService {
	constructor(
		private readonly browser: EditPlanPreflightBrowser,
		private readonly store: EditPlanPreflightStore,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly options: EditPlanPreflightServiceOptions = {},
	) {}

	async preflight(
		input: PreflightEditPlanInput,
	): Promise<EditPlanPreflightServiceResult> {
		const parsed = preflightEditPlanInputSchema.parse(input);
		const requestFingerprint = preflightEditPlanRequestFingerprint(parsed);
		const claim = await this.store.claim(
			parsed.preflightId,
			requestFingerprint,
		);
		if (claim.status === "replayed") return replayResult(claim.receipt);
		const durableBrowserReceipt = await this.queryBrowserReceipt(
			parsed,
			requestFingerprint,
		);
		if (durableBrowserReceipt) {
			const receipt = buildReceipt(
				parsed,
				requestFingerprint,
				durableBrowserReceipt.result,
				durableBrowserReceipt.recordedAt,
			);
			await this.store.reconcile(receipt);
			return replayResult(receipt);
		}
		if (claim.status === "in-progress") {
			const receipt = await this.waitForTerminal(parsed.preflightId);
			if (receipt) return replayResult(receipt);
			throw new Error(`preflight ${parsed.preflightId} is already in progress`);
		}

		const capabilitySnapshot = this.options.captureCapabilitySnapshot
			? deriveEditPlanCapabilitySnapshot(
					await this.options.captureCapabilitySnapshot(),
				)
			: undefined;
		const raw = await this.browser.request(
			"preflight_edit_plan",
			{ ...parsed, ...(capabilitySnapshot ? { capabilitySnapshot } : {}) },
			5 * 60_000,
			parsed.expectedConnectionIdentity,
		);
		const terminal = browserEditPlanPreflightResponseSchema.parse(
			parseBrowserPayload(raw, parsed.expectedConnectionIdentity),
		);
		if (terminal.preflightId !== parsed.preflightId) {
			throw new Error("browser preflight ID mismatch");
		}
		if (terminal.status === "validated") validateEvidence(parsed, terminal);
		const published = await this.queryBrowserReceipt(
			parsed,
			requestFingerprint,
		);
		if (!published) {
			throw new Error("browser returned a preflight without a durable receipt");
		}
		if (
			canonicalEditPlanJson(published.result) !==
			canonicalEditPlanJson(terminal)
		) {
			throw new Error(
				"browser response differs from its durable preflight receipt",
			);
		}
		const receipt = buildReceipt(
			parsed,
			requestFingerprint,
			terminal,
			published.recordedAt,
		);
		await this.store.complete(receipt);
		this.options.afterReceiptCommit?.();
		return {
			schemaVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
			disposition: "evaluated",
			receiptId: receipt.receiptId,
			result: terminal,
		};
	}

	async verifiedApplication(input: {
		projectId: string;
		sceneId?: string;
		expectedRevision: number;
		expectedProjectContentHash: string;
		expectedConnectionIdentity: PreflightEditPlanInput["expectedConnectionIdentity"];
		description: string;
		operations: PreflightEditPlanInput["operations"];
		preflight: {
			receiptId: string;
			planFingerprint: string;
			preflightFingerprint: string;
			planDiffHash: string;
		};
	}): Promise<{
		receipt: EditPlanPreflightReceipt;
		evaluation: Extract<
			BrowserEditPlanPreflightResponse,
			{ status: "validated" }
		>["evaluation"];
	}> {
		const receipt = await this.store.get(input.preflight.receiptId);
		if (!receipt) throw new Error("preflight receipt was not found");
		if (
			receipt.projectId !== input.projectId ||
			(input.sceneId !== undefined && receipt.sceneId !== input.sceneId) ||
			receipt.contentHash !== input.expectedProjectContentHash ||
			receipt.planFingerprint !== input.preflight.planFingerprint ||
			receipt.preflightFingerprint !== input.preflight.preflightFingerprint ||
			receipt.planDiffHash !== input.preflight.planDiffHash ||
			receipt.planFingerprint !==
				editPlanSemanticFingerprint(input.description, input.operations)
		) {
			throw new Error(
				"apply request does not match the verified preflight receipt",
			);
		}
		const terminal = browserEditPlanPreflightResponseSchema.parse(
			receipt.terminalResult,
		);
		if (terminal.status !== "validated") {
			throw new Error("only a validated preflight can be applied");
		}
		const source = terminal.evaluation.source;
		if (
			source.projectId !== receipt.projectId ||
			source.sceneId !== receipt.sceneId ||
			source.sessionRevision !== receipt.revision ||
			source.canonicalProjectHash !== receipt.contentHash ||
			source.durableWriteVersion !== receipt.writeVersion ||
			source.saveOperationId !== receipt.saveReceiptOperationId ||
			source.saveReceiptId !== receipt.saveReceiptId ||
			source.connectionIdentity.editorInstanceId !==
				input.expectedConnectionIdentity.editorInstanceId
		) {
			throw new Error(
				"verified preflight receipt source binding is inconsistent",
			);
		}
		await this.verifyFreshSource(input, source);
		return { receipt, evaluation: terminal.evaluation };
	}

	private async verifyFreshSource(
		input: {
			expectedConnectionIdentity: PreflightEditPlanInput["expectedConnectionIdentity"];
			expectedRevision: number;
		},
		source: Extract<
			BrowserEditPlanPreflightResponse,
			{ status: "validated" }
		>["evaluation"]["source"],
	): Promise<void> {
		const affinity = {
			bridgeProtocolVersion: 2 as const,
			expectedConnectionIdentity: input.expectedConnectionIdentity,
		};
		const readback = parseBrowserPayload(
			await this.browser.request(
				"read_project",
				{ ...affinity, projectContentProjectionVersion: 3 },
				30_000,
				input.expectedConnectionIdentity,
			),
			input.expectedConnectionIdentity,
		);
		if (!isRecord(readback))
			throw new Error("fresh project readback is invalid");
		const contentIdentity = isRecord(readback.contentIdentity)
			? readback.contentIdentity
			: null;
		const hash =
			contentIdentity && isRecord(contentIdentity.hash)
				? contentIdentity.hash.digest
				: null;
		if (
			readback.projectId !== source.projectId ||
			readback.revision !== input.expectedRevision ||
			contentIdentity?.status !== "hashed" ||
			hash !== source.canonicalProjectHash
		) {
			throw new Error("fresh editor project does not match preflight source");
		}
		const verification = parseBrowserPayload(
			await this.browser.request(
				"verify_edit_plan_preflight_source",
				{
					...affinity,
					projectId: source.projectId,
					sceneId: source.sceneId,
					expectedRevision: input.expectedRevision,
					expectedProjectContentHash: source.canonicalProjectHash,
					expectedWriteVersion: source.durableWriteVersion,
					saveReceiptOperationId: source.saveOperationId,
					expectedSaveReceiptId: source.saveReceiptId,
				},
				30_000,
				input.expectedConnectionIdentity,
			),
			input.expectedConnectionIdentity,
		);
		if (!isRecord(verification) || verification.status !== "verified") {
			throw new Error(
				"fresh persisted project does not match preflight source",
			);
		}
	}

	private async waitForTerminal(
		preflightId: string,
	): Promise<EditPlanPreflightReceipt | null> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const receipt = await this.store.getByPreflightId(preflightId);
			if (receipt) return receipt;
			await Bun.sleep(25);
		}
		return null;
	}

	private async queryBrowserReceipt(
		input: PreflightEditPlanInput,
		requestFingerprint: string,
	): Promise<BrowserEditPlanPreflightReceipt | null> {
		const raw = await this.browser.request(
			"get_edit_plan_preflight_receipt",
			{ preflightId: input.preflightId, requestFingerprint },
			30_000,
		);
		const query = browserEditPlanPreflightReceiptQuerySchema.parse(
			parseBrowserPayload(raw),
		);
		if (query.status === "not-found") return null;
		if (query.status === "mismatched") {
			throw new EditPlanPreflightReuseError(input.preflightId);
		}
		if (query.status !== "found") {
			throw new Error("unsupported browser preflight receipt query status");
		}
		const receipt = query.receipt;
		if (
			receipt.id !== input.preflightId ||
			receipt.preflightId !== input.preflightId ||
			receipt.requestFingerprint !== requestFingerprint ||
			receipt.planFingerprint !== editPlanFingerprint(input) ||
			receipt.result.preflightId !== input.preflightId ||
			canonicalEditPlanJson(receipt.source) !==
				canonicalEditPlanJson(expectedSourceBinding(input)) ||
			receipt.checksum !== browserEditPlanPreflightReceiptChecksum(receipt)
		) {
			throw new Error("durable browser preflight receipt is inconsistent");
		}
		if (receipt.result.status === "validated") {
			validateEvidence(input, receipt.result);
		}
		return receipt;
	}
}

function parseBrowserPayload(
	raw: unknown,
	expectedRequestIdentity?: PreflightEditPlanInput["expectedConnectionIdentity"],
): unknown {
	const parsed = parseJsonValue(JSON.parse(JSON.stringify(raw)));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return parsed;
	}
	const record = parsed as Record<string, unknown>;
	const hasTransportMetadata =
		Object.hasOwn(record, "bridgeProtocolVersion") ||
		Object.hasOwn(record, "connectionIdentity") ||
		Object.hasOwn(record, "requestConnectionIdentity");
	if (!hasTransportMetadata) return parsed;
	if (record.bridgeProtocolVersion !== 2) {
		throw new Error(
			"browser preflight response has invalid bridge protocol metadata",
		);
	}
	connectionIdentitySchema.strict().parse(record.connectionIdentity);
	if (expectedRequestIdentity) {
		if (
			canonicalEditPlanJson(record.requestConnectionIdentity) !==
			canonicalEditPlanJson(expectedRequestIdentity)
		) {
			throw new Error(
				"browser preflight response has invalid request identity metadata",
			);
		}
	} else if (Object.hasOwn(record, "requestConnectionIdentity")) {
		throw new Error(
			"untargeted browser receipt query returned request identity metadata",
		);
	}
	const {
		bridgeProtocolVersion: _bridgeProtocolVersion,
		connectionIdentity: _connectionIdentity,
		requestConnectionIdentity: _requestConnectionIdentity,
		...payload
	} = record;
	return payload;
}

function buildReceipt(
	input: PreflightEditPlanInput,
	requestFingerprint: string,
	terminal: BrowserEditPlanPreflightResponse,
	createdAt: string,
): EditPlanPreflightReceipt {
	const evaluation =
		terminal.status === "validated" ? terminal.evaluation : null;
	return {
		schemaVersion: 1,
		receiptId: `preflight-receipt:${input.preflightId}`,
		preflightId: input.preflightId,
		requestFingerprint,
		planFingerprint: evaluation?.planFingerprint ?? editPlanFingerprint(input),
		preflightFingerprint: evaluation?.preflightFingerprint ?? null,
		planDiffHash: evaluation?.planDiffHash ?? null,
		projectId: input.projectId,
		sceneId: input.sceneId,
		revision: input.expectedRevision,
		contentHash: input.expectedProjectContentHash,
		writeVersion: input.expectedWriteVersion,
		saveReceiptOperationId: input.saveReceiptOperationId,
		saveReceiptId: input.expectedSaveReceiptId,
		createdAt,
		terminalResult: terminal,
	};
}

function replayResult(
	receipt: EditPlanPreflightReceipt,
): EditPlanPreflightServiceResult {
	return {
		schemaVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
		disposition: "replayed",
		receiptId: receipt.receiptId,
		result: browserEditPlanPreflightResponseSchema.parse(
			receipt.terminalResult,
		),
	};
}

function validateEvidence(
	input: PreflightEditPlanInput,
	terminal: Extract<BrowserEditPlanPreflightResponse, { status: "validated" }>,
): void {
	const evaluation = terminal.evaluation;
	validateOperationAttribution(evaluation);
	const source = expectedSourceBinding(input);
	if (
		canonicalEditPlanJson(evaluation.source) !== canonicalEditPlanJson(source)
	) {
		throw new Error(
			"evaluation source does not match the requested source binding",
		);
	}
	if (evaluation.planFingerprint !== editPlanFingerprint(input)) {
		throw new Error("evaluation plan fingerprint mismatch");
	}
	if (
		evaluation.preflightFingerprint !==
		evaluationPreflightFingerprint(
			evaluation.planFingerprint,
			evaluation.source,
			evaluation.requirements,
			input.policy,
		)
	) {
		throw new Error("evaluation preflight fingerprint mismatch");
	}
	if (evaluation.planDiffHash !== evaluationDiffHash(evaluation)) {
		throw new Error("evaluation diff hash mismatch");
	}
	if (
		canonicalEditPlanSha256(evaluation.before) !==
		input.expectedProjectContentHash
	) {
		throw new Error(
			"evaluation before snapshot does not match the source project",
		);
	}
	if (
		canonicalEditPlanSha256(evaluation.predictedAfter) !==
			evaluation.predictedProjectHash ||
		evaluation.predictedAfter.project.activeSceneId !==
			evaluation.before.project.activeSceneId
	) {
		throw new Error("evaluation predicted project hash is not authoritative");
	}
	const beforeTarget = evaluation.before.project.scenes.find(
		(scene) => scene.id === input.sceneId,
	);
	const afterTarget = evaluation.predictedAfter.project.scenes.find(
		(scene) => scene.id === input.sceneId,
	);
	if (
		!beforeTarget ||
		!afterTarget ||
		(input.sceneId !== evaluation.before.project.activeSceneId &&
			canonicalEditPlanJson(beforeTarget) ===
				canonicalEditPlanJson(afterTarget))
	) {
		throw new Error("evaluation does not target the requested scene");
	}
	const derivedChangedObjects = deriveProjectChangedObjects(
		evaluation.before,
		evaluation.predictedAfter,
		input.projectId,
	);
	if (
		canonicalEditPlanJson(evaluation.changedObjects) !==
		canonicalEditPlanJson(derivedChangedObjects)
	) {
		throw new Error(
			"evaluation changed-object evidence does not match snapshots",
		);
	}
	if (
		canonicalEditPlanJson(evaluation.beforeSummary) !==
			canonicalEditPlanJson(deriveProjectSummary(evaluation.before)) ||
		canonicalEditPlanJson(evaluation.predictedAfterSummary) !==
			canonicalEditPlanJson(deriveProjectSummary(evaluation.predictedAfter))
	) {
		throw new Error("evaluation summary evidence does not match snapshots");
	}
	if (
		evaluation.cost.status !== evaluation.requirements.cost.status ||
		evaluation.cost.status !== "not-applicable" ||
		!evaluation.requirements.editPlanReady ||
		evaluation.resolvedOperations.length !== input.operations.length ||
		evaluation.predictedProjectHash === input.expectedProjectContentHash ||
		evaluation.changedObjects.length === 0 ||
		(input.policy.warningPolicy === "reject-any" &&
			evaluation.warnings.length > 0)
	) {
		throw new Error(
			"evaluation result contains inconsistent summary or cost evidence",
		);
	}
	const expectedObservation = {
		projectId: source.projectId,
		sceneId: source.sceneId,
		sessionRevision: source.sessionRevision,
		canonicalProjectHash: source.canonicalProjectHash,
		durableWriteVersion: source.durableWriteVersion,
		saveReceiptId: source.saveReceiptId,
		saveOperationId: source.saveOperationId,
		connectionIdentity: source.connectionIdentity,
		activeProjectId: input.projectId,
		activeSceneId: terminal.sourceObservation.activeSceneId,
	};
	for (const observation of [
		terminal.sourceObservation,
		terminal.noMutationProof.before,
		terminal.noMutationProof.after,
	]) {
		for (const [key, expected] of Object.entries(expectedObservation)) {
			if (
				canonicalEditPlanJson(observation[key as keyof typeof observation]) !==
				canonicalEditPlanJson(expected)
			) {
				throw new Error(`no-mutation observation ${key} does not match source`);
			}
		}
	}
	if (
		canonicalEditPlanJson(terminal.sourceObservation) !==
			canonicalEditPlanJson(terminal.noMutationProof.before) ||
		canonicalEditPlanJson(terminal.noMutationProof.before) !==
			canonicalEditPlanJson(terminal.noMutationProof.after)
	) {
		throw new Error("no-mutation observations changed during preflight");
	}
}

/** Operations whose targets are every caption on `trackId` unless listed. */
const CAPTION_TRACK_OPERATIONS = new Set([
	"shift_captions",
	"merge_captions",
	"restyle_captions",
	"rechunk_captions",
	"repair_caption_overlaps",
]);

function validateOperationAttribution(
	evaluation: Extract<
		BrowserEditPlanPreflightResponse,
		{ status: "validated" }
	>["evaluation"],
): void {
	const operationCount = evaluation.resolvedOperations.length;
	const indexedEvidence = [
		...evaluation.resolvedIds,
		...evaluation.timingConsequences,
		...evaluation.rippleExpansion,
		...evaluation.relationshipExpansion,
		...evaluation.warnings,
	];
	for (const evidence of indexedEvidence) {
		if (evidence.operationIndex >= operationCount) {
			throw new Error("evaluation evidence operation index is out of bounds");
		}
	}
	for (const consequence of evaluation.timingConsequences) {
		const operation = evaluation.resolvedOperations[consequence.operationIndex];
		if (!operation) {
			throw new Error("timing consequence operation is missing");
		}
		const systemWideAudioChange = operation.kind === "adjust_mix_gain";
		const directlyReferenced = operationReferencesElement(
			operation,
			consequence.elementId,
		);
		const rippleAttributed = evaluation.rippleExpansion.some(
			(expansion) =>
				expansion.operationIndex === consequence.operationIndex &&
				expansion.affectedId === consequence.elementId,
		);
		const allocatedByOperation = evaluation.resolvedIds.some(
			(allocation) =>
				allocation.operationIndex === consequence.operationIndex &&
				allocation.resolvedId === consequence.elementId &&
				allocation.role.includes("element"),
		);
		// Caption operations address the listed captions or, when no ids are
		// given, every caption on their track; both scopes are caller-named.
		// The track is read before and after the plan because an earlier
		// operation may have created a caption there.
		const captionTrackScoped =
			CAPTION_TRACK_OPERATIONS.has(operation.kind) &&
			"trackId" in operation &&
			!("elementIds" in operation && Array.isArray(operation.elementIds)) &&
			[evaluation.before, evaluation.predictedAfter].some((snapshot) =>
				snapshot.project.scenes
					.find((scene) => scene.id === evaluation.source.sceneId)
					?.tracks.find((track) => track.id === operation.trackId)
					?.elements.some((element) => element.id === consequence.elementId),
			);
		const removedWithTrack =
			operation.kind === "remove_track" &&
			(operation.resolvedCascadeElementIds?.includes(consequence.elementId) ||
				evaluation.before.project.scenes
					.find((scene) => scene.id === evaluation.source.sceneId)
					?.tracks.find((track) => track.id === operation.trackId)
					?.elements.some((element) => element.id === consequence.elementId));
		if (
			!systemWideAudioChange &&
			!directlyReferenced &&
			!rippleAttributed &&
			!allocatedByOperation &&
			!captionTrackScoped &&
			!removedWithTrack
		) {
			throw new Error(
				"timing consequence is not attributable to its resolved operation",
			);
		}
	}
}

function operationReferencesElement(
	operation: PreflightEditPlanInput["operations"][number],
	elementId: string,
): boolean {
	const record = operation as Record<string, unknown>;
	for (const field of [
		"elementId",
		"fromElementId",
		"toElementId",
		"rightElementId",
		"audioElementId",
		"compoundId",
	]) {
		if (record[field] === elementId) return true;
	}
	for (const field of ["duplicateIds", "restoredElementIds", "elementIds"]) {
		const values = record[field];
		if (Array.isArray(values) && values.includes(elementId)) return true;
	}
	for (const field of ["elements", "captions"]) {
		const values = record[field];
		if (
			Array.isArray(values) &&
			values.some(
				(value) =>
					value !== null &&
					typeof value === "object" &&
					(value as Record<string, unknown>).elementId === elementId,
			)
		) {
			return true;
		}
	}
	return false;
}

export function deriveEditPlanCapabilitySnapshot(
	snapshot: Record<string, unknown>,
) {
	const editor = isRecord(snapshot.editor) ? snapshot.editor : null;
	const tools = isRecord(snapshot.tools) ? snapshot.tools : null;
	const registered = Array.isArray(tools?.registered) ? tools.registered : [];
	const variants = Array.isArray(tools?.editPlanOperationVariants)
		? tools.editPlanOperationVariants
		: [];
	return editPlanCapabilitySnapshotSchema.parse({
		hash: snapshot.snapshotHash,
		editPlanReady:
			editor?.status === "ready" &&
			editor.negotiatedProtocolVersion === 2 &&
			registered.includes("opencut_preflight_edit_plan") &&
			registered.includes("opencut_apply_edit_plan") &&
			variants.length > 0,
		providerExecution: "forbidden",
		cost: { status: "not-applicable" },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedSourceBinding(input: PreflightEditPlanInput) {
	return {
		connectionIdentity: {
			...input.expectedConnectionIdentity,
			bridgeProtocolVersion: 2 as const,
		},
		projectId: input.projectId,
		sceneId: input.sceneId,
		sessionRevision: input.expectedRevision,
		canonicalProjectHash: input.expectedProjectContentHash,
		durableWriteVersion: input.expectedWriteVersion,
		saveReceiptId: input.expectedSaveReceiptId,
		saveOperationId: input.saveReceiptOperationId,
	};
}
