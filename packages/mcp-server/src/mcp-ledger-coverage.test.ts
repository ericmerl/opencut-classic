import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorBridge } from "./editor-bridge";
import { McpLedgerBoundary } from "./mcp-ledger-boundary";
import {
	MUTATING_TOOL_MANIFEST,
	type MutatingToolName,
} from "./mutating-tool-manifest";
import { OperationLedger } from "./operation-ledger";

describe("complete mutating handler ledger coverage", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-handler-ledger-"));
	});

	afterEach(async () => {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	});

	test("exactly replays and rejects changed reuse for all mutators", async () => {
		const ledger = new OperationLedger(directory);
		const boundary = new McpLedgerBoundary(ledger, verificationBridge());
		try {
			for (const [index, toolName] of Object.keys(
				MUTATING_TOOL_MANIFEST,
			).entries()) {
				const operationId = `coverage-${index}`;
				const input = operationInput(toolName as MutatingToolName, operationId);
				let effects = 0;
				const value = successValue(toolName as MutatingToolName, operationId);
				const first = await boundary.execute(
					toolName as MutatingToolName,
					input,
					async () => {
						effects += 1;
						return value;
					},
				);
				const replay = await boundary.execute(
					toolName as MutatingToolName,
					input,
					async () => {
						effects += 1;
						throw new Error("replay must not invoke the handler effect");
					},
				);
				expect(first).toMatchObject({ durableOperationStatus: "completed" });
				expect(replay).toMatchObject({ durableOperationStatus: "replayed" });
				expect(effects).toBe(1);
				await expect(
					boundary.execute(
						toolName as MutatingToolName,
						{ ...input, changedSemanticInput: true },
						async () => value,
					),
				).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
			}
		} finally {
			ledger.close();
		}
	});

	test("recovers browser receipts for every editor mutation family", async () => {
		const tools: MutatingToolName[] = [
			"opencut_create_project",
			"opencut_open_project",
			"opencut_save_project",
			"opencut_apply_edit_plan",
			"opencut_undo",
			"opencut_import_media",
			"opencut_transcribe_timeline",
			"opencut_attach_clean_audio",
			"opencut_attach_matte",
		];
		for (const [index, toolName] of tools.entries()) {
			const operationId = `browser-receipt-${index}`;
			const input = operationInput(toolName, operationId);
			const firstLedger = new OperationLedger(join(directory, String(index)));
			const ownerId = `browser-receipt-owner-${index}`;
			const first = await new McpLedgerBoundary(firstLedger, inertBridge(), {
				ownerId,
			}).execute(toolName, input, async (context) => {
				await context.prepareBrowserMutation(directMethod(toolName), input);
				throw new Error("simulated lost browser response");
			});
			expect(first).toMatchObject({ status: "recoverable" });
			firstLedger.close();

			let effects = 0;
			const receiptResult = successValue(toolName, operationId);
			const restartedLedger = new OperationLedger(
				join(directory, String(index)),
			);
			try {
				const recovered = await new McpLedgerBoundary(
					restartedLedger,
					browserReceiptBridge(operationId, receiptResult),
					{ ownerId },
				).execute(toolName, input, async () => {
					effects += 1;
					throw new Error("browser-recovered operation must not redispatch");
				});
				expect(recovered).toMatchObject({
					durableOperationStatus: "completed",
					operationDisposition: "applied-verified",
				});
				expect(effects).toBe(0);
			} finally {
				restartedLedger.close();
			}
		}
	});

	test("recovers committed job, batch, cancellation, inspection, and subtitle effects", async () => {
		const tools: MutatingToolName[] = [
			"opencut_queue_export",
			"opencut_queue_export_batch",
			"opencut_cancel_export_job",
			"opencut_cancel_export_batch",
			"opencut_record_export_inspection",
			"opencut_export_subtitles",
		];
		const durableResults = new Map<string, Record<string, unknown>>();
		for (const [index, toolName] of tools.entries()) {
			const operationId = `composite-receipt-${index}`;
			const input = operationInput(toolName, operationId);
			const ownerId = `composite-receipt-owner-${index}`;
			const firstLedger = new OperationLedger(
				join(directory, `composite-${index}`),
			);
			const firstBoundary = new McpLedgerBoundary(firstLedger, inertBridge(), {
				ownerId,
			});
			const first = await firstBoundary.execute(
				toolName,
				input,
				async (context) => {
					await context.checkpoint({
						checkpoint: checkpoint(operationId, "prepared"),
					});
					const result = successValue(toolName, operationId);
					durableResults.set(operationId, result);
					await context.checkpoint({
						checkpoint: checkpoint(operationId, "committed"),
					});
					throw new Error("simulated response loss after durable commit");
				},
			);
			expect(first).toMatchObject({ status: "recoverable" });
			firstLedger.close();

			let effects = 0;
			const restartedLedger = new OperationLedger(
				join(directory, `composite-${index}`),
			);
			const recovered = await new McpLedgerBoundary(
				restartedLedger,
				inertBridge(),
				{ ownerId },
			).execute(
				toolName,
				input,
				async () => {
					effects += 1;
					throw new Error("committed effect must not repeat");
				},
				async () => durableResults.get(operationId) ?? null,
			);
			expect(recovered).toMatchObject({ durableOperationStatus: "completed" });
			expect(effects).toBe(0);
			restartedLedger.close();
		}
	});
});

function operationInput(
	toolName: MutatingToolName,
	operationId: string,
): Record<string, unknown> {
	if (toolName === "opencut_create_checkpoint") {
		return {
			bridgeProtocolVersion: 2,
			operationId,
			checkpointId: `checkpoint-${operationId}`,
			name: `Checkpoint ${operationId}`,
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 0,
			expectedProjectContentHash: "b".repeat(64),
		};
	}
	if (toolName === "opencut_compare_project_states") {
		return {
			bridgeProtocolVersion: 2,
			operationId,
			projectId: "project-1",
			sceneId: "scene-1",
			before: {
				revision: 0,
				projectContentHash: "b".repeat(64),
				projectionName: "opencut-project-content",
				projectionVersion: 2,
			},
		};
	}
	if (toolName === "opencut_record_export_inspection") {
		return {
			bridgeProtocolVersion: 2,
			operationId: `export-${operationId}`,
			inspectionOperationId: operationId,
		};
	}
	if (
		toolName === "opencut_create_review_annotation" ||
		toolName === "opencut_update_review_annotation_status" ||
		toolName === "opencut_record_watermark_inspection" ||
		toolName === "opencut_sign_off_export_review"
	) {
		return {
			bridgeProtocolVersion: 2,
			operationId,
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: "b".repeat(64),
		};
	}
	if (
		toolName === "opencut_transcribe_source" ||
		toolName === "opencut_correct_transcript" ||
		toolName === "opencut_analyze_speech" ||
		toolName === "opencut_create_editorial_decision" ||
		toolName === "opencut_reapply_editorial_decision" ||
		toolName === "opencut_export_editorial_decision_json" ||
		toolName === "opencut_import_editorial_decision_json"
	) {
		return { bridgeProtocolVersion: 2, operationId };
	}
	if (
		(MUTATING_TOOL_MANIFEST[toolName].requiresSaveVerification ||
			[
				"opencut_export_subtitles",
				"opencut_export_project",
				"opencut_evaluate_export_qc",
				"opencut_create_delivery_package",
			].includes(toolName)) &&
		toolName !== "opencut_create_project"
	) {
		return {
			bridgeProtocolVersion: 2,
			operationId,
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 0,
			expectedProjectContentHash: "b".repeat(64),
		};
	}
	return { bridgeProtocolVersion: 2, operationId };
}

function verifiedSave(operationId: string) {
	return {
		status: "saved",
		receiptId: `receipt:${operationId}`,
		operationId,
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 1,
		contentHash: "a".repeat(64),
		contentHashProjectionVersion: 2,
		persistedAt: "2026-09-02T00:00:00.000Z",
		completedAt: "2026-09-02T00:00:01.000Z",
		storageSchemaVersion: 1,
		writeVersion: 1,
		reloadVerified: true,
		readbackContentHash: "a".repeat(64),
	};
}

function successValue(toolName: MutatingToolName, operationId: string) {
	const projectResult = appliedMutation(operationId);
	const statusByTool: Partial<Record<MutatingToolName, string>> = {
		opencut_create_project: "created",
		opencut_open_project: "opened",
		opencut_rename_project: "renamed",
		opencut_duplicate_project: "duplicated",
		opencut_delete_project: "deleted",
		opencut_create_scene: "applied",
		opencut_clone_scene: "applied",
		opencut_switch_scene: "applied",
		opencut_rename_scene: "applied",
		opencut_delete_scene: "applied",
		opencut_set_main_scene: "applied",
		opencut_reorder_scenes: "applied",
		opencut_import_media_asset: "applied",
		opencut_rename_media_asset: "applied",
		opencut_relink_media_asset: "applied",
		opencut_remove_media_asset: "applied",
		opencut_normalize_audio: "normalized",
		opencut_sync_audio: "applied",
		opencut_attach_clean_audio: "applied",
		opencut_clean_audio: "cleaned-and-attached",
		opencut_apply_edit_plan: "applied",
		opencut_undo: "undone",
		opencut_redo: "redone",
		opencut_create_checkpoint: "checkpoint-created",
		opencut_restore_checkpoint: "restored",
		opencut_import_media: "applied",
		opencut_import_subtitles: "applied",
		opencut_transcribe_timeline: "applied",
		opencut_export_subtitles: "exported",
		opencut_attach_matte: "applied",
		opencut_generate_matte: "generated-and-attached",
		opencut_track_subject: "tracked-and-reframed",
		opencut_export_project: "exported",
		opencut_evaluate_export_qc: "evaluated",
		opencut_create_delivery_package: "packaged",
		opencut_transcribe_source: "transcribed",
		opencut_correct_transcript: "corrected",
		opencut_analyze_speech: "analyzed",
		opencut_create_editorial_decision: "created",
		opencut_reapply_editorial_decision: "created",
		opencut_export_editorial_decision_json: "exported",
		opencut_import_editorial_decision_json: "imported",
	};
	if (toolName === "opencut_save_project") return verifiedSave(operationId);
	if (toolName === "opencut_start_editor_worker") {
		return { enabled: true, running: true, connected: true };
	}
	if (toolName === "opencut_stop_editor_worker") {
		return { enabled: true, running: false, connected: false };
	}
	if (toolName === "opencut_queue_export") {
		return { job: { jobId: "job-1", status: "queued", storeRevision: 1 } };
	}
	if (toolName === "opencut_queue_export_batch") {
		return {
			summary: { batch: { batchId: "batch-1" }, status: "queued" },
		};
	}
	if (toolName === "opencut_cancel_export_job") {
		return { status: "cancelled", jobId: "job-1", storeRevision: 1 };
	}
	if (
		toolName === "opencut_cancel_job" ||
		toolName === "opencut_retry_job" ||
		toolName === "opencut_resolve_job"
	) {
		return { status: "found", job: { jobId: "job-1", state: "queued" } };
	}
	if (toolName === "opencut_cancel_export_batch") {
		return { status: "found", summary: { batchId: "batch-1" } };
	}
	if (toolName === "opencut_run_export_jobs") {
		return { connected: true, processed: [] };
	}
	if (toolName === "opencut_record_export_inspection") {
		return {
			receipt: { operationId: `export-${operationId}` },
			path: "receipt.json",
		};
	}
	if (toolName === "opencut_create_review_annotation") {
		return {
			status: "annotation-created",
			annotation: { versionId: `annotation:${operationId}:1` },
		};
	}
	if (toolName === "opencut_update_review_annotation_status") {
		return {
			status: "annotation-status-updated",
			annotation: { versionId: `annotation:${operationId}:2` },
		};
	}
	if (toolName === "opencut_record_watermark_inspection") {
		return {
			status: "watermark-inspection-recorded",
			inspection: { inspectionId: `inspection:${operationId}` },
		};
	}
	if (toolName === "opencut_sign_off_export_review") {
		return {
			status: "export-review-signed-off",
			signoff: { signoffId: `signoff:${operationId}` },
		};
	}
	if (toolName === "opencut_render_preview_frame") {
		return {
			status: "rendered",
			operationId,
			receiptId: `preview:${operationId}`,
		};
	}
	if (toolName === "opencut_render_preview_range") {
		return {
			status: "rendered",
			operationId,
			receiptId: `preview-range:${operationId}`,
		};
	}
	if (toolName === "opencut_compare_project_states") {
		return {
			status: "rendered",
			operationId,
			receiptId: `comparison:${operationId}`,
			projectId: "project-1",
			sceneId: "scene-1",
		};
	}
	if (toolName === "opencut_cancel_preview_range") {
		return {
			status: "cancellation-requested",
			operationId,
			targetOperationId: "range-1",
		};
	}
	if (toolName === "opencut_cancel_comparison") {
		return {
			status: "cancellation-requested",
			operationId,
			targetOperationId: "comparison-1",
		};
	}
	const status = statusByTool[toolName];
	if (!status) throw new Error(`missing success fixture for ${toolName}`);
	return {
		...projectResult,
		status,
		...(toolName === "opencut_export_project" ||
		toolName === "opencut_export_subtitles"
			? {
					outputPath: `C:/exports/${operationId}.mp4`,
					sha256: "a".repeat(64),
					bytesWritten: 123,
				}
			: {}),
	};
}

function appliedMutation(operationId: string) {
	return {
		status: "applied",
		operationId,
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 1,
		snapshot: projectSnapshot(),
	};
}

function projectSnapshot() {
	return {
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 1,
		contentIdentity: {
			status: "hashed",
			hash: {
				algorithm: "SHA-256",
				projectionVersion: 2,
				digest: "a".repeat(64),
			},
		},
	};
}

function checkpoint(operationId: string, state: "prepared" | "committed") {
	return {
		checkpointId: operationId,
		kind: "job" as const,
		state,
		recordedAt: new Date().toISOString(),
		metadata: {},
	};
}

function inertBridge(): EditorBridge {
	return {
		request: async () => ({ status: "not-found" }),
	} as unknown as EditorBridge;
}

function verificationBridge(): EditorBridge {
	return {
		request: async (method: string, params: unknown) => {
			const input = params as Record<string, unknown>;
			if (method === "save_project") {
				return verifiedSave(String(input.operationId));
			}
			if (method === "read_project") return projectSnapshot();
			return { status: "not-found" };
		},
	} as unknown as EditorBridge;
}

function directMethod(toolName: MutatingToolName): string {
	const methods: Partial<Record<MutatingToolName, string>> = {
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
	};
	const method = methods[toolName];
	if (!method) throw new Error(`missing direct browser method for ${toolName}`);
	return method;
}

function browserReceiptBridge(
	operationId: string,
	result: Record<string, unknown>,
): EditorBridge {
	return {
		request: async (method: string, params: unknown) => {
			const request = params as Record<string, unknown>;
			if (method === "get_operation_receipt") {
				return {
					status: "found",
					operationId,
					binding: request.binding,
					afterState: {
						projectId: "project-1",
						sceneId: "scene-1",
						revisionAfter: 1,
						sessionRevisionAfter: 1,
						durableWriteVersion: 1,
						contentHashAfter: "a".repeat(64),
						contentHashProjectionVersion: 2,
					},
					result,
				};
			}
			if (method === "get_save_receipt") {
				return {
					...verifiedSave(`${operationId}:ledger-save`),
					status: "found",
				};
			}
			if (method === "read_project") return projectSnapshot();
			throw new Error(`unexpected bridge request: ${method}`);
		},
	} as unknown as EditorBridge;
}
