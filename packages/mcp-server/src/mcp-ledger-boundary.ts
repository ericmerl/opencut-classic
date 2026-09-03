import { createHash, randomUUID } from "node:crypto";
import type { BridgeConnectionIdentity, EditorBridge } from "./editor-bridge";
import {
	browserRequestFingerprint,
	browserReceiptCheckpoint,
	type BrowserOperationReceiptContract,
	readBrowserReceiptContract,
} from "./browser-operation-receipt-contract";
import {
	executeLedgeredOperation,
	type LedgeredOperationResult,
	type OperationExecutionContext,
	type OperationExecutionOutcome,
} from "./execute-ledgered-operation";
import {
	mutatingToolDefinition,
	type MutatingToolName,
} from "./mutating-tool-manifest";
import {
	OperationLedger,
	type OperationAffectedObject,
	type OperationConnectionAffinity,
	type OperationSaveReceipt,
} from "./operation-ledger";
import { protocolMutationRejection } from "./protocol-compatibility";
import {
	CURRENT_PROJECT_CONTENT_PROJECTION_VERSION,
	readPersistedProjectContentProjectionVersion,
} from "./project-content-version";

type ToolInput = Record<string, unknown>;

export interface McpOperationExecutionContext extends OperationExecutionContext {
	prepareBrowserMutation(
		method: string,
		request: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	prepareBrowserStep(
		method: string,
		request: Record<string, unknown>,
		stepId: string,
	): Promise<Record<string, unknown>>;
	recoverBrowserStep(stepId: string): Promise<unknown | null>;
}

export class McpLedgerBoundary {
	private readonly ownerId: string;

	constructor(
		readonly ledger: OperationLedger,
		private bridge: EditorBridge,
		private options: {
			ownerId?: string;
			allowProtocolV1Mutation?: boolean;
			afterEffect?: (details: {
				toolName: MutatingToolName;
				operationId: string;
				value: unknown;
			}) => Promise<void> | void;
		} = {},
	) {
		this.ownerId =
			options.ownerId ?? `opencut-mcp:${process.pid}:${randomUUID()}`;
	}

	async execute(
		toolName: MutatingToolName,
		input: ToolInput,
		effect: (context: McpOperationExecutionContext) => Promise<unknown>,
		recoverEffect?: (
			context: McpOperationExecutionContext,
		) => Promise<unknown | null>,
	): Promise<unknown> {
		const definition = mutatingToolDefinition(toolName);
		const operationId = readOperationId(toolName, input);
		const compatibilityRejection = protocolMutationRejection({
			input,
			operationId,
			allowProtocolV1Mutation: this.options.allowProtocolV1Mutation ?? false,
			protocolMutationPolicy: definition.protocolMutationPolicy,
		});
		if (compatibilityRejection) return compatibilityRejection;
		const existing = await this.ledger.get(operationId);
		const suppliedContentHash =
			stringField(input, "expectedProjectContentHash") ??
			stringField(input, "expectedContentHash");
		const requiresVerifiedBrowserHash =
			toolName === "opencut_apply_edit_plan" &&
			input.bridgeProtocolVersion === 2;
		const before = !operationUsesProjectPreconditions(toolName)
			? {}
			: existing
				? {
						projectId:
							definition.operationKind === "create-project"
								? null
								: (stringField(input, "projectId") ??
									existing.record.projectId),
						sceneId:
							definition.operationKind === "create-project"
								? null
								: (stringField(input, "sceneId") ??
									(requiresVerifiedBrowserHash
										? existing.record.sceneId
										: suppliedContentHash
											? null
											: existing.record.sceneId)),
						revision: existing.record.revisionBefore,
						contentHash: existing.record.contentHashBefore,
						contentHashProjectionVersion:
							existing.record.contentHashProjectionVersionBefore,
					}
				: await this.resolveBeforeState(input, requiresVerifiedBrowserHash);
		const result = await executeLedgeredOperation({
			ledger: this.ledger,
			input,
			operationId,
			operationKind: definition.operationKind,
			description: describe(toolName, input),
			actor: { type: "service", id: "opencut-mcp" },
			requestIdentity: `mcp:${operationId}`,
			ownerId: this.ownerId,
			leaseDurationMs: 15 * 60_000,
			connectionAffinity: connectionAffinity(input),
			before,
			requiresSaveVerification: definition.requiresSaveVerification,
			// Inputs describe intended targets, not verified effects. Terminal evidence
			// is populated only from authoritative result data after the effect commits.
			affectedObjects: [],
			relationships:
				typeof input.undoOfOperationId === "string"
					? { undoOf: input.undoOfOperationId }
					: undefined,
			recover: async (context) => {
				const operationContext = this.withBrowserContext(
					context,
					operationId,
					toolName,
				);
				try {
					const contract = readBrowserReceiptContract(
						context.record().checkpoints,
						operationId,
					);
					if (
						browserReceiptIsTerminal(toolName) &&
						contract?.role === "direct-terminal" &&
						contract.outerToolName === toolName
					) {
						const receipt = await this.bridge.request("get_operation_receipt", {
							...protocolContext(input),
							operationId,
							binding: contract,
						});
						if (
							isRecord(receipt) &&
							receipt.status === "found" &&
							isRecord(receipt.binding) &&
							receipt.binding.outerOperationId === contract.outerOperationId &&
							receipt.binding.outerRequestFingerprint ===
								contract.outerRequestFingerprint &&
							receipt.binding.browserMethod === contract.browserMethod &&
							receipt.binding.browserRequestFingerprint ===
								contract.browserRequestFingerprint
						) {
							return this.classifyRecoveredBrowserReceipt(
								toolName,
								definition.requiresSaveVerification,
								input,
								receipt,
								context.record(),
							);
						}
					}
				} catch {
					// A disconnected editor does not prevent server-side durable recovery.
				}
				if (!recoverEffect) return null;
				const recovered = await recoverEffect(operationContext);
				return recovered === null
					? null
					: this.classify(
							toolName,
							definition.requiresSaveVerification,
							input,
							recovered,
						);
			},
			execute: async (context) => {
				const value = await effect(
					this.withBrowserContext(context, operationId, toolName),
				);
				const outcome = await this.classify(
					toolName,
					definition.requiresSaveVerification,
					input,
					value,
				);
				await this.options.afterEffect?.({ toolName, operationId, value });
				return outcome;
			},
		});
		return exposeResult(result);
	}

	private withBrowserContext(
		context: OperationExecutionContext,
		operationId: string,
		toolName: MutatingToolName,
	): McpOperationExecutionContext {
		return {
			...context,
			prepareBrowserMutation: async (method, request) => {
				assertDirectBrowserMethod(toolName, method);
				const contract: BrowserOperationReceiptContract = {
					version: 1,
					outerOperationId: operationId,
					outerToolName: toolName,
					outerRequestFingerprint: context.record().inputFingerprint,
					role: "direct-terminal",
					stepId: `${toolName}:direct`,
					browserMethod: method,
					browserRequestFingerprint: browserRequestFingerprint(request),
				};
				await context.checkpoint({
					phase: "reconciling",
					checkpoint: browserReceiptCheckpoint(operationId, contract),
				});
				return { ...request, operationReceiptBinding: contract };
			},
			prepareBrowserStep: async (method, request, stepId) => {
				const contract: BrowserOperationReceiptContract = {
					version: 1,
					outerOperationId: operationId,
					outerToolName: toolName,
					outerRequestFingerprint: context.record().inputFingerprint,
					role: "composite-step",
					stepId,
					browserMethod: method,
					browserRequestFingerprint: browserRequestFingerprint(request),
				};
				await context.checkpoint({
					phase: "reconciling",
					checkpoint: browserReceiptCheckpoint(operationId, contract),
				});
				return { ...request, operationReceiptBinding: contract };
			},
			recoverBrowserStep: async (stepId) => {
				const contract = readBrowserReceiptContract(
					context.record().checkpoints,
					operationId,
					stepId,
				);
				if (!contract || contract.role !== "composite-step") return null;
				const receipt = await this.bridge.request("get_operation_receipt", {
					operationId,
					binding: contract,
				});
				return isMatchingBrowserReceipt(receipt, contract)
					? receipt.result
					: null;
			},
		};
	}

	private async resolveBeforeState(
		input: ToolInput,
		requiresVerifiedBrowserHash: boolean,
	) {
		const projectId = stringField(input, "projectId");
		if (!projectId) return {};
		let contentHash = requiresVerifiedBrowserHash
			? null
			: (stringField(input, "expectedProjectContentHash") ??
				stringField(input, "expectedContentHash"));
		let sceneId = stringField(input, "sceneId");
		let contentHashProjectionVersion: 1 | 2 | null = contentHash
			? CURRENT_PROJECT_CONTENT_PROJECTION_VERSION
			: null;
		if (!contentHash || requiresVerifiedBrowserHash) {
			const snapshot = await this.bridge.request("read_project", {
				...protocolContext(input),
				projectId,
			});
			if (isRecord(snapshot)) {
				contentHash ??= contentHashOf(snapshot);
				contentHashProjectionVersion ??=
					contentHashProjectionVersionOf(snapshot);
				sceneId ??= stringField(snapshot, "sceneId");
			}
		}
		return {
			projectId,
			sceneId,
			revision:
				typeof input.expectedRevision === "number"
					? input.expectedRevision
					: null,
			contentHash,
			contentHashProjectionVersion: contentHashProjectionVersion ?? undefined,
		};
	}

	private async classify(
		toolName: MutatingToolName,
		requiresSaveVerification: boolean,
		input: ToolInput,
		value: unknown,
	): Promise<OperationExecutionOutcome<unknown>> {
		const resultDisposition = classifyMutatorResult(toolName, value);
		if (resultDisposition === "not-applied") {
			return {
				disposition: "not-applied",
				value,
				diagnostics: {
					code: resultCode(value),
					message: resultMessage(value),
					details: null,
				},
			};
		}
		if (resultDisposition === "unknown") {
			return {
				disposition: "unknown",
				reason: `unrecognized terminal result for ${toolName}`,
			};
		}
		if (!requiresSaveVerification) {
			return {
				disposition: "applied-verified",
				value,
				evidence: {
					...terminalEvidence(value),
					affectedObjects: verifiedAffectedObjects(toolName, input, value),
				},
			};
		}
		const directReceipt = parseSaveReceipt(
			isRecord(value) && isRecord(value.saveReceipt)
				? value.saveReceipt
				: value,
		);
		if (directReceipt) {
			return {
				disposition: "applied-verified",
				value,
				evidence: {
					...receiptEvidence(directReceipt),
					...terminalEvidence(value),
					affectedObjects: verifiedAffectedObjects(toolName, input, value),
				},
			};
		}
		const result = isRecord(value) ? value : null;
		const mutation =
			result && isRecord(result.mutation) ? result.mutation : null;
		const snapshot =
			result && isRecord(result.snapshot)
				? result.snapshot
				: mutation && isRecord(mutation.snapshot)
					? mutation.snapshot
					: null;
		const projectId =
			(result && stringField(result, "projectId")) ??
			stringField(input, "projectId") ??
			(snapshot && stringField(snapshot, "projectId"));
		const sceneId =
			(result && stringField(result, "sceneId")) ??
			(snapshot && stringField(snapshot, "sceneId"));
		const revision =
			result && typeof result.revision === "number" ? result.revision : null;
		const hash = snapshot ? contentHashOf(snapshot) : null;
		const hashProjectionVersion = snapshot
			? contentHashProjectionVersionOf(snapshot)
			: null;
		if (
			!projectId ||
			!sceneId ||
			revision === null ||
			!hash ||
			!hashProjectionVersion
		) {
			return {
				disposition: "unknown",
				reason: "mutation response lacks revision, scene, or content hash",
			};
		}
		const operationId = readOperationIdFromInput(input);
		const saved = await this.bridge.request(
			"save_project",
			{
				...protocolContext(input),
				projectId,
				sceneId,
				operationId: `${operationId}:ledger-save`,
				expectedRevision: revision,
				expectedContentHash: hash,
			},
			5 * 60_000,
		);
		const receipt = parseSaveReceipt(saved);
		if (
			!receipt ||
			receipt.contentHashProjectionVersion !== hashProjectionVersion
		) {
			return { disposition: "unknown", reason: "verified save barrier failed" };
		}
		const readback = await this.bridge.request("read_project", {
			...protocolContext(input),
			projectId,
			projectContentProjectionVersion: receipt.contentHashProjectionVersion,
		});
		if (
			!isRecord(readback) ||
			readback.revision !== receipt.revision ||
			contentHashOf(readback) !== receipt.contentHash ||
			contentHashProjectionVersionOf(readback) !==
				receipt.contentHashProjectionVersion
		) {
			return {
				disposition: "unknown",
				reason: "live project readback differs from verified save receipt",
			};
		}
		return {
			disposition: "applied-verified",
			value,
			evidence: {
				...receiptEvidence(receipt),
				affectedObjects: verifiedAffectedObjects(toolName, input, value),
			},
		};
	}

	private async classifyRecoveredBrowserReceipt(
		toolName: MutatingToolName,
		requiresSaveVerification: boolean,
		input: ToolInput,
		receiptEnvelope: Record<string, unknown>,
		ledgerRecord: {
			revisionBefore: number | null;
			revisionAfter: number | null;
		},
	): Promise<OperationExecutionOutcome<unknown>> {
		const value = receiptEnvelope.result;
		const afterState = isRecord(receiptEnvelope.afterState)
			? receiptEnvelope.afterState
			: null;
		if (!afterState || !validDirectBrowserResult(toolName, value)) {
			return {
				disposition: "unknown",
				reason:
					"browser operation receipt violates its per-tool result contract",
			};
		}
		const projectId = stringField(afterState, "projectId");
		const sceneId = stringField(afterState, "sceneId");
		const revision =
			typeof afterState.revisionAfter === "number"
				? afterState.revisionAfter
				: null;
		const sessionRevision =
			typeof afterState.sessionRevisionAfter === "number"
				? afterState.sessionRevisionAfter
				: null;
		const durableWriteVersion =
			typeof afterState.durableWriteVersion === "number"
				? afterState.durableWriteVersion
				: null;
		const contentHash = stringField(afterState, "contentHashAfter");
		const contentHashProjectionVersion =
			readPersistedProjectContentProjectionVersion(
				afterState.contentHashProjectionVersion,
			);
		if (
			!projectId ||
			!sceneId ||
			revision === null ||
			sessionRevision !== revision ||
			durableWriteVersion === null ||
			durableWriteVersion <= 0 ||
			!contentHash ||
			!contentHashProjectionVersion
		) {
			return {
				disposition: "unknown",
				reason: "browser operation receipt lacks immutable after-state",
			};
		}
		const resultState = immutableResultState(value);
		if (
			!resultState ||
			resultState.projectId !== projectId ||
			resultState.sceneId !== sceneId ||
			resultState.revision !== revision ||
			resultState.contentHash !== contentHash ||
			(resultState.contentHashProjectionVersion !== null &&
				resultState.contentHashProjectionVersion !==
					contentHashProjectionVersion)
		) {
			return {
				disposition: "unknown",
				reason: "browser receipt result differs from its immutable after-state",
			};
		}
		if (
			ledgerRecord.revisionAfter !== null &&
			ledgerRecord.revisionAfter !== revision
		) {
			return {
				disposition: "unknown",
				reason: "browser receipt revision differs from durable ledger state",
			};
		}
		if (
			typeof input.expectedRevision === "number" &&
			ledgerRecord.revisionBefore !== input.expectedRevision
		) {
			return {
				disposition: "unknown",
				reason:
					"browser receipt revision chain differs from the ledger precondition",
			};
		}
		const readback = await this.bridge.request("read_project", {
			...protocolContext(input),
			projectId,
			projectContentProjectionVersion: contentHashProjectionVersion,
		});
		if (
			!matchesLiveProjectState(readback, {
				projectId,
				sceneId,
				contentHash,
				contentHashProjectionVersion,
			})
		) {
			return {
				disposition: "unknown",
				reason:
					"live project identity differs from the browser receipt after-state",
			};
		}
		if (!requiresSaveVerification) {
			return {
				disposition: "applied-verified",
				value,
				evidence: {
					projectId,
					sceneId,
					revisionAfter: revision,
					contentHashAfter: contentHash,
					contentHashProjectionVersionAfter: contentHashProjectionVersion,
				},
			};
		}
		const directReceipt = parseSaveReceipt(value);
		if (directReceipt) {
			return receiptMatchesState(directReceipt, {
				projectId,
				sceneId,
				revision,
				contentHash,
				contentHashProjectionVersion,
			})
				? {
						disposition: "applied-verified",
						value,
						evidence: receiptEvidence(directReceipt),
					}
				: {
						disposition: "unknown",
						reason:
							"live project content differs from the original save receipt",
					};
		}
		const saveOperationId = `${readOperationIdFromInput(input)}:ledger-save`;
		let stored = await this.bridge.request("get_save_receipt", {
			...protocolContext(input),
			operationId: saveOperationId,
		});
		let saveReceipt = parseSaveReceipt(stored);
		if (!saveReceipt) {
			stored = await this.bridge.request(
				"verify_operation_receipt",
				{
					...protocolContext(input),
					binding: receiptEnvelope.binding,
					saveOperationId,
				},
				5 * 60_000,
			);
			saveReceipt = parseSaveReceipt(stored);
		}
		if (
			!saveReceipt ||
			saveReceipt.operationId !== saveOperationId ||
			saveReceipt.writeVersion !== durableWriteVersion ||
			!receiptMatchesState(saveReceipt, {
				projectId,
				sceneId,
				revision,
				contentHash,
				contentHashProjectionVersion,
			})
		) {
			return {
				disposition: "unknown",
				reason: "original verified save receipt is missing or mismatched",
			};
		}
		return {
			disposition: "applied-verified",
			value,
			evidence: {
				...receiptEvidence(saveReceipt),
				affectedObjects: verifiedAffectedObjects(toolName, input, value),
			},
		};
	}
}

export async function requestLedgeredBrowserMutation(
	context: McpOperationExecutionContext,
	bridge: EditorBridge,
	method: Parameters<EditorBridge["request"]>[0],
	request: Record<string, unknown>,
	timeoutMs?: number,
): Promise<unknown> {
	const boundRequest = await context.prepareBrowserMutation(method, request);
	return bridge.request(method, boundRequest, timeoutMs);
}

export async function requestLedgeredBrowserStep(
	context: McpOperationExecutionContext,
	bridge: EditorBridge,
	method: Parameters<EditorBridge["request"]>[0],
	request: Record<string, unknown>,
	stepId: string,
	timeoutMs?: number,
): Promise<unknown> {
	const boundRequest = await context.prepareBrowserStep(
		method,
		request,
		stepId,
	);
	return bridge.request(method, boundRequest, timeoutMs);
}

function operationUsesProjectPreconditions(
	toolName: MutatingToolName,
): boolean {
	return !new Set<MutatingToolName>([
		"opencut_start_editor_worker",
		"opencut_stop_editor_worker",
		"opencut_create_project",
		"opencut_open_project",
	]).has(toolName);
}

function browserReceiptIsTerminal(toolName: MutatingToolName): boolean {
	return toolName in DIRECT_BROWSER_METHODS;
}

const DIRECT_BROWSER_METHODS = {
	opencut_create_project: "create_project",
	opencut_open_project: "open_project",
	opencut_save_project: "save_project",
	opencut_sync_audio: "sync_audio",
	opencut_attach_clean_audio: "attach_clean_audio",
	opencut_apply_edit_plan: "apply_edit_plan",
	opencut_undo: "undo",
	opencut_import_media: "import_media",
	opencut_transcribe_timeline: "transcribe_timeline",
	opencut_attach_matte: "attach_matte",
} as const satisfies Partial<Record<MutatingToolName, string>>;

function assertDirectBrowserMethod(
	toolName: MutatingToolName,
	method: string,
): void {
	const expected =
		DIRECT_BROWSER_METHODS[toolName as keyof typeof DIRECT_BROWSER_METHODS];
	if (expected !== method) {
		throw new Error(
			`browser receipt contract for ${toolName} requires ${expected ?? "no direct browser mutation"}, received ${method}`,
		);
	}
}

function readOperationId(toolName: MutatingToolName, input: ToolInput): string {
	if (toolName === "opencut_record_export_inspection") {
		const value = stringField(input, "inspectionOperationId");
		if (value) return value;
	}
	return readOperationIdFromInput(input);
}

function readOperationIdFromInput(input: ToolInput): string {
	const operationId = stringField(input, "operationId");
	if (!operationId) throw new Error("operationId is required for mutations");
	return operationId;
}

function describe(toolName: MutatingToolName, input: ToolInput): string {
	return (
		stringField(input, "description") ??
		toolName.replace("opencut_", "").replaceAll("_", " ")
	);
}

function connectionAffinity(
	input: ToolInput,
): OperationConnectionAffinity | null {
	if (
		input.bridgeProtocolVersion !== 2 ||
		!isRecord(input.expectedConnectionIdentity)
	)
		return null;
	const identity =
		input.expectedConnectionIdentity as unknown as BridgeConnectionIdentity;
	return { ...identity, protocolVersion: 2 };
}

function protocolContext(input: ToolInput): ToolInput {
	return {
		...(input.bridgeProtocolVersion === 1 || input.bridgeProtocolVersion === 2
			? { bridgeProtocolVersion: input.bridgeProtocolVersion }
			: {}),
		...(isRecord(input.expectedConnectionIdentity)
			? { expectedConnectionIdentity: input.expectedConnectionIdentity }
			: {}),
	};
}

function verifiedAffectedObjects(
	toolName: MutatingToolName,
	_input: ToolInput,
	value: unknown,
): OperationAffectedObject[] {
	const result = isRecord(value) ? value : {};
	const action = operationAction(toolName);
	const values = new Map<string, OperationAffectedObject>();
	const add = (
		objectType: OperationAffectedObject["objectType"],
		objectId: unknown,
		objectAction: OperationAffectedObject["action"] = action,
	) => {
		if (typeof objectId !== "string" || objectId.length === 0) return;
		const entry = { objectType, objectId, action: objectAction };
		values.set(`${objectType}\0${objectId}\0${objectAction}`, entry);
	};

	if (toolName === "opencut_create_project") {
		add("project", result.projectId, "created");
		return [...values.values()];
	}
	const snapshot = isRecord(result.snapshot) ? result.snapshot : null;
	for (const [field, objectType] of [
		["projectId", "project"],
		["sceneId", "scene"],
		["trackId", "track"],
		["elementId", "element"],
		["jobId", "export-job"],
		["batchId", "export-batch"],
	] as const) {
		add(objectType, result[field] ?? snapshot?.[field]);
	}
	if (Array.isArray(result.affectedObjects)) {
		for (const candidate of result.affectedObjects) {
			if (!isRecord(candidate)) continue;
			if (
				typeof candidate.objectType === "string" &&
				typeof candidate.objectId === "string" &&
				typeof candidate.action === "string"
			) {
				add(
					candidate.objectType as OperationAffectedObject["objectType"],
					candidate.objectId,
					candidate.action as OperationAffectedObject["action"],
				);
			}
		}
	}
	add(
		"media",
		result.assetId ?? result.mediaId,
		toolName === "opencut_import_media" ? "imported" : action,
	);
	const outputPath = result.outputPath;
	if (typeof outputPath === "string") {
		add(
			"file",
			stringField(result, "sha256") ??
				stringField(result, "sourceSha256") ??
				`path:${createHash("sha256").update(outputPath).digest("hex")}`,
			action,
		);
	}
	add("provider-artifact", result.artifactHash ?? result.sha256, "generated");
	add(
		"export-receipt",
		result.exportReceiptId,
		toolName === "opencut_record_export_inspection" ? "inspected" : "exported",
	);
	if (isRecord(result.job)) add("export-job", result.job.jobId, "queued");
	if (isRecord(result.summary))
		add("export-batch", result.summary.batchId, action);

	return [...values.values()];
}

function operationAction(
	toolName: MutatingToolName,
): OperationAffectedObject["action"] {
	if (toolName === "opencut_open_project") return "opened";
	if (toolName === "opencut_save_project") return "saved";
	if (
		toolName === "opencut_import_media" ||
		toolName === "opencut_import_subtitles"
	)
		return "imported";
	if (
		toolName === "opencut_attach_clean_audio" ||
		toolName === "opencut_attach_matte"
	)
		return "attached";
	if (
		toolName === "opencut_clean_audio" ||
		toolName === "opencut_generate_matte" ||
		toolName === "opencut_track_subject"
	)
		return "generated";
	if (
		toolName === "opencut_export_project" ||
		toolName === "opencut_export_subtitles"
	)
		return "exported";
	if (
		toolName === "opencut_render_preview_frame" ||
		toolName === "opencut_render_preview_range"
	)
		return "processed";
	if (
		toolName === "opencut_queue_export" ||
		toolName === "opencut_queue_export_batch"
	)
		return "queued";
	if (
		toolName === "opencut_cancel_export_job" ||
		toolName === "opencut_cancel_export_batch" ||
		toolName === "opencut_cancel_preview_range"
	)
		return "cancelled";
	if (toolName === "opencut_record_export_inspection") return "inspected";
	if (toolName === "opencut_undo") return "undone";
	return "updated";
}

function exposeResult(result: LedgeredOperationResult<unknown>): unknown {
	if (result.status === "recoverable") return result;
	return isRecord(result.value)
		? {
				...result.value,
				durableOperationStatus: result.status,
				operationDisposition: result.disposition,
				operationRecord: result.operation,
			}
		: result;
}

function parseSaveReceipt(value: unknown): OperationSaveReceipt | null {
	if (
		!isRecord(value) ||
		(value.status !== "saved" &&
			value.status !== "replayed" &&
			value.status !== "found")
	)
		return null;
	if (
		![
			"receiptId",
			"operationId",
			"projectId",
			"sceneId",
			"contentHash",
			"persistedAt",
			"completedAt",
			"readbackContentHash",
		].every((field) => typeof value[field] === "string") ||
		typeof value.revision !== "number" ||
		typeof value.storageSchemaVersion !== "number" ||
		typeof value.writeVersion !== "number" ||
		value.reloadVerified !== true
	)
		return null;
	const contentHashProjectionVersion =
		readPersistedProjectContentProjectionVersion(
			value.contentHashProjectionVersion,
		);
	if (!contentHashProjectionVersion) return null;
	return {
		receiptId: value.receiptId as string,
		operationId: value.operationId as string,
		projectId: value.projectId as string,
		sceneId: value.sceneId as string,
		revision: value.revision,
		contentHash: value.contentHash as string,
		contentHashProjectionVersion,
		persistedAt: value.persistedAt as string,
		completedAt: value.completedAt as string,
		storageSchemaVersion: value.storageSchemaVersion,
		writeVersion: value.writeVersion,
		reloadVerified: true,
		readbackContentHash: value.readbackContentHash as string,
	};
}

function receiptEvidence(receipt: OperationSaveReceipt) {
	return {
		projectId: receipt.projectId,
		sceneId: receipt.sceneId,
		revisionAfter: receipt.revision,
		contentHashAfter: receipt.contentHash,
		contentHashProjectionVersionAfter: receipt.contentHashProjectionVersion,
		saveReceipt: receipt,
	};
}

function terminalEvidence(value: unknown) {
	if (!isRecord(value)) return {};
	const rangeEvidence = previewRangeTerminalEvidence(value);
	if (rangeEvidence) return rangeEvidence;
	const outputPath = stringField(value, "outputPath");
	const sha256 = stringField(value, "sha256");
	const bytes =
		typeof value.bytesWritten === "number" ? value.bytesWritten : null;
	const container = stringField(value, "container");
	const exportReceiptId = stringField(value, "exportReceiptId");
	const saveReceiptId = stringField(value, "saveReceiptId");
	const renderer = isRecord(value.renderer) ? value.renderer : null;
	const mimeType =
		stringField(value, "mimeType") ??
		(isRecord(value.artifact) ? stringField(value.artifact, "mimeType") : null);
	const previewReceiptId = stringField(value, "receiptId");
	if (!outputPath || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return {};
	return {
		artifacts: [
			{
				artifactId: previewReceiptId ?? exportReceiptId ?? sha256,
				kind:
					mimeType === "image/png" ? ("receipt" as const) : ("export" as const),
				state: "verified" as const,
				sha256,
				bytes,
				path: outputPath,
				mimeType:
					mimeType ??
					(container === "mp4"
						? "video/mp4"
						: container === "webm"
							? "video/webm"
							: null),
			},
		],
		providerProvenance: renderer
			? [
					{
						provider: stringField(renderer, "provider") ?? "opencut-renderer",
						artifactHash: sha256,
						metadata: {
							pipeline: stringField(renderer, "pipeline") ?? "unknown",
							protocolVersion:
								typeof renderer.bridgeProtocolVersion === "number"
									? renderer.bridgeProtocolVersion
									: typeof renderer.protocolVersion === "number"
										? renderer.protocolVersion
										: 1,
						},
					},
				]
			: undefined,
		checkpoints: [
			{
				checkpointId: previewReceiptId ?? exportReceiptId ?? sha256,
				kind: "filesystem" as const,
				state: "verified" as const,
				recordedAt: new Date().toISOString(),
				metadata: {
					outputPath,
					bytes,
					container,
					exportReceiptId,
					saveReceiptId,
				},
			},
		],
		affectedObjects: previewReceiptId
			? [
					{
						objectType: "file" as const,
						objectId: previewReceiptId,
						action: "processed" as const,
					},
				]
			: exportReceiptId
				? [
						{
							objectType: "export-receipt" as const,
							objectId: exportReceiptId,
							action: "exported" as const,
						},
					]
				: undefined,
	};
}

function previewRangeTerminalEvidence(value: Record<string, unknown>) {
	if (!Array.isArray(value.frames) || typeof value.receiptId !== "string")
		return null;
	const artifacts = value.frames.flatMap((candidate) => {
		if (!isRecord(candidate)) return [];
		const sha256 = stringField(candidate, "pngSha256");
		const path = stringField(candidate, "path");
		if (!sha256 || !path) return [];
		return [
			{
				artifactId: sha256,
				kind: "receipt" as const,
				state: "verified" as const,
				sha256,
				bytes: typeof candidate.bytes === "number" ? candidate.bytes : null,
				path,
				mimeType: "image/png",
			},
		];
	});
	if (isRecord(value.audio)) {
		const sha256 = stringField(value.audio, "sha256");
		const path = stringField(value.audio, "path");
		if (sha256 && path)
			artifacts.push({
				artifactId: sha256,
				kind: "receipt" as const,
				state: "verified" as const,
				sha256,
				bytes: typeof value.audio.bytes === "number" ? value.audio.bytes : null,
				path,
				mimeType: "audio/wav",
			});
	}
	return {
		artifacts,
		checkpoints: [
			{
				checkpointId: value.receiptId,
				kind: "job" as const,
				state: "verified" as const,
				recordedAt: new Date().toISOString(),
				metadata: {
					frameCount: artifacts.filter(
						(artifact) => artifact.mimeType === "image/png",
					).length,
					scheduleSha256: stringField(value, "scheduleSha256"),
					checksum: stringField(value, "checksum"),
				},
			},
		],
		affectedObjects: [
			{
				objectType: "file" as const,
				objectId: value.receiptId,
				action:
					value.status === "cancelled"
						? ("cancelled" as const)
						: ("processed" as const),
			},
		],
	};
}

function contentHashOf(value: Record<string, unknown>): string | null {
	const identity = isRecord(value.contentIdentity)
		? value.contentIdentity
		: null;
	const hash = identity && isRecord(identity.hash) ? identity.hash : null;
	return identity?.status === "hashed" && typeof hash?.digest === "string"
		? hash.digest
		: null;
}

function contentHashProjectionVersionOf(
	value: Record<string, unknown>,
): 1 | 2 | null {
	const identity = isRecord(value.contentIdentity)
		? value.contentIdentity
		: null;
	const hash = identity && isRecord(identity.hash) ? identity.hash : null;
	return identity?.status === "hashed" &&
		(hash?.projectionVersion === 1 || hash?.projectionVersion === 2)
		? hash.projectionVersion
		: null;
}

function immutableResultState(value: unknown): {
	projectId: string;
	sceneId: string;
	revision: number;
	contentHash: string;
	contentHashProjectionVersion: 1 | 2 | null;
} | null {
	if (!isRecord(value)) return null;
	const snapshot = isRecord(value.snapshot) ? value.snapshot : null;
	const projectId =
		stringField(value, "projectId") ??
		(snapshot ? stringField(snapshot, "projectId") : null);
	const sceneId =
		stringField(value, "sceneId") ??
		(snapshot ? stringField(snapshot, "sceneId") : null);
	const revision = typeof value.revision === "number" ? value.revision : null;
	const contentHash =
		stringField(value, "contentHash") ??
		(snapshot ? contentHashOf(snapshot) : null);
	const contentHashProjectionVersion =
		value.contentHashProjectionVersion === 1 ||
		value.contentHashProjectionVersion === 2
			? value.contentHashProjectionVersion
			: snapshot
				? contentHashProjectionVersionOf(snapshot)
				: null;
	return projectId && sceneId && revision !== null && contentHash
		? {
				projectId,
				sceneId,
				revision,
				contentHash,
				contentHashProjectionVersion,
			}
		: null;
}

function matchesLiveProjectState(
	value: unknown,
	expected: {
		projectId: string;
		sceneId: string;
		contentHash: string;
		contentHashProjectionVersion: 1 | 2;
	},
): boolean {
	if (!isRecord(value)) return false;
	return (
		stringField(value, "projectId") === expected.projectId &&
		stringField(value, "sceneId") === expected.sceneId &&
		contentHashOf(value) === expected.contentHash &&
		contentHashProjectionVersionOf(value) ===
			expected.contentHashProjectionVersion
	);
}

function receiptMatchesState(
	receipt: OperationSaveReceipt,
	expected: {
		projectId: string;
		sceneId: string;
		revision: number;
		contentHash: string;
		contentHashProjectionVersion: 1 | 2;
	},
): boolean {
	return (
		receipt.projectId === expected.projectId &&
		receipt.sceneId === expected.sceneId &&
		receipt.revision === expected.revision &&
		receipt.contentHash === expected.contentHash &&
		receipt.contentHashProjectionVersion ===
			expected.contentHashProjectionVersion &&
		receipt.readbackContentHash === expected.contentHash &&
		receipt.reloadVerified === true
	);
}

const DIRECT_BROWSER_SUCCESS: Partial<
	Record<MutatingToolName, ReadonlySet<string>>
> = {
	opencut_create_project: new Set(["created", "replayed"]),
	opencut_open_project: new Set(["opened", "replayed"]),
	opencut_save_project: new Set(["saved", "replayed"]),
	opencut_sync_audio: new Set(["applied", "replayed"]),
	opencut_attach_clean_audio: new Set(["applied", "replayed"]),
	opencut_apply_edit_plan: new Set(["applied", "replayed"]),
	opencut_undo: new Set(["undone"]),
	opencut_import_media: new Set(["applied", "replayed"]),
	opencut_transcribe_timeline: new Set(["applied", "replayed"]),
	opencut_attach_matte: new Set(["applied", "replayed"]),
};

function validDirectBrowserResult(
	toolName: MutatingToolName,
	value: unknown,
): boolean {
	return (
		isRecord(value) &&
		typeof value.status === "string" &&
		(DIRECT_BROWSER_SUCCESS[toolName]?.has(value.status) ?? false)
	);
}

function isMatchingBrowserReceipt(
	value: unknown,
	contract: BrowserOperationReceiptContract,
): value is Record<string, unknown> {
	if (
		!isRecord(value) ||
		value.status !== "found" ||
		!isRecord(value.binding)
	) {
		return false;
	}
	return (
		value.binding.outerOperationId === contract.outerOperationId &&
		value.binding.outerToolName === contract.outerToolName &&
		value.binding.outerRequestFingerprint ===
			contract.outerRequestFingerprint &&
		value.binding.role === contract.role &&
		value.binding.stepId === contract.stepId &&
		value.binding.browserMethod === contract.browserMethod &&
		value.binding.browserRequestFingerprint ===
			contract.browserRequestFingerprint
	);
}

type ResultDisposition = "success" | "not-applied" | "unknown";

interface MutatorResultContract {
	successStatuses: ReadonlySet<string>;
	notAppliedStatuses: ReadonlySet<string>;
	structuralSuccess?: (value: Record<string, unknown>) => boolean;
}

const rejected = new Set([
	"conflict",
	"rejected",
	"verification-failed",
	"content-identity-blocked",
	"content-hash-conflict",
	"validation-failed",
]);
const rejectedOrMissing = new Set([...rejected, "not-found"]);

const MUTATOR_RESULT_CONTRACTS = {
	opencut_start_editor_worker: contract(
		[],
		rejected,
		(value) => value.running === true && value.connected === true,
	),
	opencut_stop_editor_worker: contract(
		[],
		rejected,
		(value) => value.running === false,
	),
	opencut_create_project: contract(["created", "replayed"], rejected),
	opencut_open_project: contract(["opened", "replayed"], rejectedOrMissing),
	opencut_save_project: contract(["saved", "replayed"], rejected),
	opencut_normalize_audio: contract(["normalized", "replayed"], rejected),
	opencut_sync_audio: contract(["applied", "replayed"], rejected),
	opencut_attach_clean_audio: contract(["applied", "replayed"], rejected),
	opencut_clean_audio: contract(["cleaned-and-attached", "replayed"], rejected),
	opencut_apply_edit_plan: contract(["applied", "replayed"], rejected),
	opencut_undo: contract(["undone"], new Set([...rejected, "nothing-to-undo"])),
	opencut_import_media: contract(["applied", "replayed"], rejected),
	opencut_import_subtitles: contract(["applied", "replayed"], rejected),
	opencut_transcribe_timeline: contract(["applied", "replayed"], rejected),
	opencut_export_subtitles: contract(["exported", "replayed"], rejected),
	opencut_attach_matte: contract(["applied", "replayed"], rejected),
	opencut_generate_matte: contract(
		["generated-and-attached", "replayed"],
		rejected,
	),
	opencut_track_subject: contract(
		["tracked-and-reframed", "replayed"],
		rejected,
	),
	opencut_export_project: contract(["exported", "replayed"], rejected),
	opencut_render_preview_frame: contract(["rendered", "replayed"], rejected),
	opencut_render_preview_range: contract(
		["rendered", "replayed", "cancelled"],
		rejected,
	),
	opencut_cancel_preview_range: contract(
		[
			"cancellation-requested",
			"cancelled",
			"already-succeeded",
			"already-failed",
		],
		rejectedOrMissing,
	),
	opencut_queue_export: contract(
		[],
		rejected,
		(value) => isRecord(value.job) && typeof value.job.jobId === "string",
	),
	opencut_queue_export_batch: contract(
		[],
		rejected,
		(value) =>
			isRecord(value.summary) && typeof value.summary.batchId === "string",
	),
	opencut_cancel_export_batch: contract(["found"], rejectedOrMissing),
	opencut_cancel_export_job: contract(["cancelled"], rejectedOrMissing),
	opencut_run_export_jobs: contract(
		[],
		rejected,
		(value) =>
			typeof value.connected === "boolean" && Array.isArray(value.processed),
	),
	opencut_record_export_inspection: contract(
		[],
		rejectedOrMissing,
		(value) => isRecord(value.receipt) && typeof value.path === "string",
	),
} as const satisfies Record<MutatingToolName, MutatorResultContract>;

function contract(
	successStatuses: readonly string[],
	notAppliedStatuses: ReadonlySet<string>,
	structuralSuccess?: (value: Record<string, unknown>) => boolean,
): MutatorResultContract {
	return {
		successStatuses: new Set(successStatuses),
		notAppliedStatuses,
		structuralSuccess,
	};
}

export function classifyMutatorResult(
	toolName: MutatingToolName,
	value: unknown,
): ResultDisposition {
	if (!isRecord(value)) return "unknown";
	const contract = MUTATOR_RESULT_CONTRACTS[toolName];
	const status = typeof value.status === "string" ? value.status : null;
	if (status && contract.notAppliedStatuses.has(status)) return "not-applied";
	if (status && contract.successStatuses.has(status)) return "success";
	return contract.structuralSuccess?.(value) ? "success" : "unknown";
}

function resultCode(value: unknown): string {
	return isRecord(value) && typeof value.status === "string"
		? value.status.toUpperCase().replaceAll("-", "_")
		: "NOT_APPLIED";
}

function resultMessage(value: unknown): string {
	return isRecord(value) && typeof value.reason === "string"
		? value.reason
		: "operation was not applied";
}

function stringField(
	value: Record<string, unknown>,
	field: string,
): string | null {
	return typeof value[field] === "string" ? value[field] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
