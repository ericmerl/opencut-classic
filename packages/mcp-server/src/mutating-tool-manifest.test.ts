import { describe, expect, test } from "bun:test";
import { MUTATING_TOOL_MANIFEST } from "./mutating-tool-manifest";

describe("mutating MCP tool manifest", () => {
	test("defines the complete dependency-map set of 33 mutators", () => {
		expect(Object.keys(MUTATING_TOOL_MANIFEST).sort()).toEqual(
			[
				"opencut_apply_edit_plan",
				"opencut_attach_clean_audio",
				"opencut_attach_matte",
				"opencut_cancel_comparison",
				"opencut_cancel_export_batch",
				"opencut_cancel_export_job",
				"opencut_cancel_job",
				"opencut_cancel_preview_range",
				"opencut_clean_audio",
				"opencut_compare_project_states",
				"opencut_create_project",
				"opencut_export_project",
				"opencut_export_subtitles",
				"opencut_generate_matte",
				"opencut_import_media",
				"opencut_import_subtitles",
				"opencut_normalize_audio",
				"opencut_open_project",
				"opencut_rename_project",
				"opencut_duplicate_project",
				"opencut_delete_project",
				"opencut_create_scene",
				"opencut_clone_scene",
				"opencut_switch_scene",
				"opencut_rename_scene",
				"opencut_delete_scene",
				"opencut_set_main_scene",
				"opencut_reorder_scenes",
				"opencut_import_media_asset",
				"opencut_rename_media_asset",
				"opencut_relink_media_asset",
				"opencut_remove_media_asset",
				"opencut_queue_export",
				"opencut_queue_export_batch",
				"opencut_record_export_inspection",
				"opencut_resolve_job",
				"opencut_retry_job",
				"opencut_render_preview_frame",
				"opencut_render_preview_range",
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
		expect(Object.keys(MUTATING_TOOL_MANIFEST)).toHaveLength(47);
	});

	test("exempts only pre-affinity worker lifecycle controls from the v2 gate", () => {
		const bootstrapControls = Object.entries(MUTATING_TOOL_MANIFEST)
			.filter(
				([, definition]) =>
					definition.protocolMutationPolicy === "bootstrap-control",
			)
			.map(([toolName]) => toolName)
			.sort();
		expect(bootstrapControls).toEqual([
			"opencut_start_editor_worker",
			"opencut_stop_editor_worker",
		]);
		expect(
			Object.values(MUTATING_TOOL_MANIFEST).filter(
				(definition) => definition.protocolMutationPolicy === "v2-required",
			),
		).toHaveLength(45);
	});

	test("declares target-specific persistence verification for project lifecycle mutations", () => {
		for (const toolName of [
			"opencut_rename_project",
			"opencut_duplicate_project",
			"opencut_delete_project",
		] as const) {
			const definition = MUTATING_TOOL_MANIFEST[toolName];
			expect(definition.requiresSaveVerification).toBeFalse();
			expect(definition.selfVerifiesPersistence).toBeTrue();
		}
	});
});
