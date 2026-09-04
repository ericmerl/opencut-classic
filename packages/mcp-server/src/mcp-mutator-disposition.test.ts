import { describe, expect, test } from "bun:test";
import { classifyMutatorResult } from "./mcp-ledger-boundary";
import {
	MUTATING_TOOL_MANIFEST,
	type MutatingToolName,
} from "./mutating-tool-manifest";

const successes: Record<MutatingToolName, Record<string, unknown>> = {
	opencut_start_editor_worker: { running: true, connected: true },
	opencut_stop_editor_worker: { running: false, connected: false },
	opencut_create_project: { status: "created" },
	opencut_open_project: { status: "opened" },
	opencut_rename_project: { status: "renamed" },
	opencut_duplicate_project: { status: "duplicated" },
	opencut_delete_project: { status: "deleted" },
	opencut_create_scene: { status: "applied" },
	opencut_clone_scene: { status: "applied" },
	opencut_switch_scene: { status: "applied" },
	opencut_rename_scene: { status: "applied" },
	opencut_delete_scene: { status: "applied" },
	opencut_set_main_scene: { status: "applied" },
	opencut_reorder_scenes: { status: "applied" },
	opencut_import_media_asset: { status: "applied" },
	opencut_rename_media_asset: { status: "applied" },
	opencut_relink_media_asset: { status: "applied" },
	opencut_remove_media_asset: { status: "applied" },
	opencut_save_project: { status: "saved" },
	opencut_normalize_audio: { status: "normalized" },
	opencut_sync_audio: { status: "applied" },
	opencut_attach_clean_audio: { status: "applied" },
	opencut_clean_audio: { status: "cleaned-and-attached" },
	opencut_apply_edit_plan: { status: "applied" },
	opencut_undo: { status: "undone" },
	opencut_redo: { status: "redone" },
	opencut_create_checkpoint: { status: "checkpoint-created" },
	opencut_restore_checkpoint: { status: "restored" },
	opencut_import_media: { status: "applied" },
	opencut_import_subtitles: { status: "applied" },
	opencut_transcribe_timeline: { status: "applied" },
	opencut_export_subtitles: { status: "exported" },
	opencut_attach_matte: { status: "applied" },
	opencut_generate_matte: { status: "generated-and-attached" },
	opencut_track_subject: { status: "tracked-and-reframed" },
	opencut_export_project: { status: "exported" },
	opencut_evaluate_export_qc: { status: "evaluated" },
	opencut_create_delivery_package: { status: "packaged" },
	opencut_render_preview_frame: { status: "rendered" },
	opencut_render_preview_range: { status: "rendered" },
	opencut_compare_project_states: { status: "rendered" },
	opencut_cancel_preview_range: { status: "cancellation-requested" },
	opencut_cancel_comparison: { status: "cancellation-requested" },
	opencut_queue_export: { job: { jobId: "job-1" } },
	opencut_queue_export_batch: {
		summary: { batch: { batchId: "batch-1" }, status: "queued" },
	},
	opencut_cancel_export_batch: { status: "found" },
	opencut_cancel_export_job: { status: "cancelled" },
	opencut_cancel_job: { status: "found", job: {} },
	opencut_retry_job: { status: "found", job: {} },
	opencut_resolve_job: { status: "found", job: {} },
	opencut_run_export_jobs: { connected: true, processed: [] },
	opencut_record_export_inspection: { receipt: {}, path: "C:/receipt.json" },
	opencut_transcribe_source: { status: "transcribed" },
	opencut_correct_transcript: { status: "corrected" },
	opencut_analyze_speech: { status: "analyzed" },
	opencut_create_editorial_decision: { status: "created" },
	opencut_reapply_editorial_decision: { status: "created" },
	opencut_export_editorial_decision_json: { status: "exported" },
	opencut_import_editorial_decision_json: { status: "imported" },
};

describe("typed per-mutator terminal disposition contracts", () => {
	test("defines a recognized success shape for every mutator", () => {
		expect(Object.keys(successes).sort()).toEqual(
			Object.keys(MUTATING_TOOL_MANIFEST).sort(),
		);
		for (const [toolName, value] of Object.entries(successes)) {
			expect(classifyMutatorResult(toolName as MutatingToolName, value)).toBe(
				"success",
			);
		}
	});

	test("maps explicit conflicts to not-applied and unknown statuses to recoverable", () => {
		for (const toolName of Object.keys(
			MUTATING_TOOL_MANIFEST,
		) as MutatingToolName[]) {
			expect(classifyMutatorResult(toolName, { status: "conflict" })).toBe(
				"not-applied",
			);
			expect(classifyMutatorResult(toolName, { status: "done" })).toBe(
				"unknown",
			);
		}
	});
});
