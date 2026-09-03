import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorBridge } from "./editor-bridge";
import { McpLedgerBoundary } from "./mcp-ledger-boundary";
import {
	NormalizeAudioOperation,
	type NormalizeAudioInput,
} from "./normalize-audio-operation";
import { OperationLedger } from "./operation-ledger";

const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);

describe("NormalizeAudioOperation durable recovery", () => {
	test("reconstructs the canonical outer result after a bound composite receipt without a second analysis or apply", async () => {
		const referenceDirectory = await mkdtemp(
			join(tmpdir(), "opencut-normalize-reference-"),
		);
		const recoveryDirectory = await mkdtemp(
			join(tmpdir(), "opencut-normalize-recovery-"),
		);
		let referenceLedger: OperationLedger | undefined;
		let recoveryLedger: OperationLedger | undefined;
		try {
			const referenceBridge = normalizationBridge(false);
			referenceLedger = new OperationLedger(referenceDirectory);
			const reference = await new McpLedgerBoundary(
				referenceLedger,
				referenceBridge.bridge,
				{
					ownerId: "normalize-reference-owner",
					allowProtocolV1Mutation: true,
				},
			).execute("opencut_normalize_audio", INPUT, (context) =>
				new NormalizeAudioOperation(referenceBridge.bridge).execute(
					INPUT,
					context,
				),
			);
			const referenceResult = operationResult(reference);
			expect(referenceResult).toMatchObject({
				status: "normalized",
				before: { warnings: ["before-warning"], integratedLufs: -24 },
				after: { warnings: ["after-warning"], integratedLufs: -16 },
				appliedGainDb: 2,
				limitedBy: "true_peak_ceiling",
			});
			referenceLedger.close();
			referenceLedger = undefined;

			const interruptedBridge = normalizationBridge(true);
			recoveryLedger = new OperationLedger(recoveryDirectory);
			let operation = new NormalizeAudioOperation(interruptedBridge.bridge);
			const interrupted = await new McpLedgerBoundary(
				recoveryLedger,
				interruptedBridge.bridge,
				{
					ownerId: "normalize-recovery-owner",
					allowProtocolV1Mutation: true,
				},
			).execute(
				"opencut_normalize_audio",
				INPUT,
				(context) => operation.execute(INPUT, context),
				(context) => operation.recover(INPUT, context),
			);
			expect(interrupted).toMatchObject({
				status: "recoverable",
				disposition: "unknown",
			});
			recoveryLedger.close();
			recoveryLedger = undefined;

			recoveryLedger = new OperationLedger(recoveryDirectory);
			operation = new NormalizeAudioOperation(interruptedBridge.bridge);
			let restartedExecuteCalls = 0;
			const recovered = await new McpLedgerBoundary(
				recoveryLedger,
				interruptedBridge.bridge,
				{
					ownerId: "normalize-recovery-owner",
					allowProtocolV1Mutation: true,
				},
			).execute(
				"opencut_normalize_audio",
				INPUT,
				async (context) => {
					restartedExecuteCalls += 1;
					return operation.execute(INPUT, context);
				},
				(context) => operation.recover(INPUT, context),
			);
			expect(operationResult(recovered)).toEqual(referenceResult);
			expect(interruptedBridge.counts()).toEqual({
				beforeAnalysis: 1,
				afterAnalysis: 1,
				apply: 1,
				save: 1,
				read: 1,
				receiptLookup: 1,
			});
			expect(restartedExecuteCalls).toBe(0);
			recoveryLedger.close();
			recoveryLedger = undefined;
		} finally {
			referenceLedger?.close();
			recoveryLedger?.close();
			await Promise.all([
				rm(referenceDirectory, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 50,
				}),
				rm(recoveryDirectory, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 50,
				}),
			]);
		}
	});
});

const INPUT: NormalizeAudioInput & Record<string, unknown> = {
	projectId: "project-1",
	operationId: "normalize-restart-1",
	expectedRevision: 7,
	expectedProjectContentHash: BEFORE_HASH,
	targetLufs: -16,
	maxTruePeakDbtp: -1,
	maxGainDb: 12,
};

function normalizationBridge(interruptAfterApply: boolean) {
	let beforeAnalysis = 0;
	let afterAnalysis = 0;
	let apply = 0;
	let save = 0;
	let read = 0;
	let receiptLookup = 0;
	let capturedBinding: unknown = null;
	const mutation = {
		status: "applied",
		operationId: INPUT.operationId,
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision: 8,
		snapshot: snapshot(AFTER_HASH, 8),
		plan: {
			description: "Normalize timeline audio to -16 LUFS",
			operations: [{ kind: "adjust_mix_gain", gainDb: 2 }],
		},
	};
	const bridge = {
		request: async (method: string, params: Record<string, unknown>) => {
			if (method === "analyze_audio") {
				if (params.expectedRevision === 7) {
					beforeAnalysis += 1;
					return analyzed(7, BEFORE_HASH, -24, -3, "before-warning");
				}
				if (params.expectedRevision === 8) {
					afterAnalysis += 1;
					return analyzed(8, AFTER_HASH, -16, -1.5, "after-warning");
				}
				throw new Error(
					`unexpected analysis revision ${params.expectedRevision}`,
				);
			}
			if (method === "apply_edit_plan") {
				apply += 1;
				capturedBinding = params.operationReceiptBinding;
				if (interruptAfterApply) {
					throw new Error("response lost after bound composite receipt commit");
				}
				return mutation;
			}
			if (method === "get_operation_receipt") {
				receiptLookup += 1;
				if (
					JSON.stringify(params.binding) !== JSON.stringify(capturedBinding)
				) {
					return { status: "not-found", operationId: INPUT.operationId };
				}
				return {
					status: "found",
					operationId: INPUT.operationId,
					binding: capturedBinding,
					afterState: {
						projectId: INPUT.projectId,
						sceneId: "scene-1",
						revisionAfter: 8,
						sessionRevisionAfter: 8,
						durableWriteVersion: 1,
						contentHashAfter: AFTER_HASH,
					},
					result: mutation,
				};
			}
			if (method === "save_project") {
				save += 1;
				return saveReceipt();
			}
			if (method === "read_project") {
				read += 1;
				return snapshot(AFTER_HASH, 8);
			}
			throw new Error(`unexpected bridge method ${method}`);
		},
	} as unknown as EditorBridge;
	return {
		bridge,
		counts: () => ({
			beforeAnalysis,
			afterAnalysis,
			apply,
			save,
			read,
			receiptLookup,
		}),
	};
}

function analyzed(
	revision: number,
	contentHash: string,
	integratedLufs: number,
	estimatedTruePeakDbtp: number,
	warning: string,
) {
	return {
		status: "analyzed",
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision,
		contentIdentity: {
			status: "hashed",
			hash: { algorithm: "SHA-256", digest: contentHash },
		},
		analysis: {
			integratedLufs,
			estimatedTruePeakDbtp,
			minimumGainDb: -60,
			maximumGainDb: 12,
			peakSample: 0.84,
			warnings: [warning],
		},
	};
}

function snapshot(contentHash: string, revision: number) {
	return {
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision,
		contentIdentity: {
			status: "hashed",
			hash: { algorithm: "SHA-256", digest: contentHash },
		},
	};
}

function saveReceipt() {
	return {
		status: "saved",
		receiptId: "receipt:normalize-restart-1",
		operationId: `${INPUT.operationId}:ledger-save`,
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision: 8,
		contentHash: AFTER_HASH,
		persistedAt: "2026-09-02T00:00:00.000Z",
		completedAt: "2026-09-02T00:00:01.000Z",
		storageSchemaVersion: 1,
		writeVersion: 1,
		reloadVerified: true,
		readbackContentHash: AFTER_HASH,
	};
}

function operationResult(value: unknown): unknown {
	if (!value || typeof value !== "object") {
		throw new Error("ledger result is not an object");
	}
	const operationRecord = (value as Record<string, unknown>).operationRecord;
	if (!operationRecord || typeof operationRecord !== "object") {
		throw new Error(
			`ledger result lacks operationRecord: ${JSON.stringify(value)}`,
		);
	}
	return (operationRecord as Record<string, unknown>).result;
}
