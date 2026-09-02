import { describe, expect, test } from "bun:test";
import { MUTATING_TOOL_MANIFEST } from "./mutating-tool-manifest";

describe("mutating MCP tool manifest", () => {
	test("defines the complete dependency-map set of 25 mutators", () => {
		expect(Object.keys(MUTATING_TOOL_MANIFEST).sort()).toEqual(
			[
				"opencut_apply_edit_plan",
				"opencut_attach_clean_audio",
				"opencut_attach_matte",
				"opencut_cancel_export_batch",
				"opencut_cancel_export_job",
				"opencut_clean_audio",
				"opencut_create_project",
				"opencut_export_project",
				"opencut_export_subtitles",
				"opencut_generate_matte",
				"opencut_import_media",
				"opencut_import_subtitles",
				"opencut_normalize_audio",
				"opencut_open_project",
				"opencut_queue_export",
				"opencut_queue_export_batch",
				"opencut_record_export_inspection",
				"opencut_run_export_jobs",
				"opencut_save_project",
				"opencut_start_editor_worker",
				"opencut_stop_editor_worker",
				"opencut_sync_audio",
				"opencut_track_subject",
				"opencut_transcribe_timeline",
				"opencut_undo",
			].sort(),
		);
		expect(Object.keys(MUTATING_TOOL_MANIFEST)).toHaveLength(25);
	});
});
