import { describe, expect, test } from "bun:test";
import { classifyMutatorResult } from "./mcp-ledger-boundary";
import { MUTATING_TOOL_MANIFEST, type MutatingToolName } from "./mutating-tool-manifest";

const successes: Record<MutatingToolName, Record<string, unknown>> = {
	opencut_start_editor_worker: { running: true, connected: true },
	opencut_stop_editor_worker: { running: false, connected: false },
	opencut_create_project: { status: "created" },
	opencut_open_project: { status: "opened" },
	opencut_save_project: { status: "saved" },
	opencut_normalize_audio: { status: "normalized" },
	opencut_sync_audio: { status: "applied" },
	opencut_attach_clean_audio: { status: "applied" },
	opencut_clean_audio: { status: "cleaned-and-attached" },
	opencut_apply_edit_plan: { status: "applied" },
	opencut_undo: { status: "undone" },
	opencut_import_media: { status: "applied" },
	opencut_import_subtitles: { status: "applied" },
	opencut_transcribe_timeline: { status: "applied" },
	opencut_export_subtitles: { status: "exported" },
	opencut_attach_matte: { status: "applied" },
	opencut_generate_matte: { status: "generated-and-attached" },
	opencut_track_subject: { status: "tracked-and-reframed" },
	opencut_export_project: { status: "exported" },
	opencut_queue_export: { job: { jobId: "job-1" } },
	opencut_queue_export_batch: { summary: { batchId: "batch-1" } },
	opencut_cancel_export_batch: { status: "found" },
	opencut_cancel_export_job: { status: "cancelled" },
	opencut_run_export_jobs: { connected: true, processed: [] },
	opencut_record_export_inspection: { receipt: {}, path: "C:/receipt.json" },
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
		for (const toolName of Object.keys(MUTATING_TOOL_MANIFEST) as MutatingToolName[]) {
			expect(classifyMutatorResult(toolName, { status: "conflict" })).toBe(
				"not-applied",
			);
			expect(classifyMutatorResult(toolName, { status: "done" })).toBe("unknown");
		}
	});
});
