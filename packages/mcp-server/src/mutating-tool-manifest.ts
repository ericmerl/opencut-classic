export const MUTATING_TOOL_MANIFEST = {
	opencut_start_editor_worker: {
		operationKind: "start-editor-worker",
		requiresSaveVerification: false,
	},
	opencut_stop_editor_worker: {
		operationKind: "stop-editor-worker",
		requiresSaveVerification: false,
	},
	opencut_create_project: {
		operationKind: "create-project",
		requiresSaveVerification: true,
	},
	opencut_open_project: {
		operationKind: "open-project",
		requiresSaveVerification: false,
	},
	opencut_save_project: {
		operationKind: "save-project",
		requiresSaveVerification: true,
	},
	opencut_normalize_audio: {
		operationKind: "normalize-audio",
		requiresSaveVerification: true,
	},
	opencut_sync_audio: {
		operationKind: "sync-audio",
		requiresSaveVerification: true,
	},
	opencut_attach_clean_audio: {
		operationKind: "attach-clean-audio",
		requiresSaveVerification: true,
	},
	opencut_clean_audio: {
		operationKind: "clean-audio",
		requiresSaveVerification: true,
	},
	opencut_apply_edit_plan: {
		operationKind: "apply-edit-plan",
		requiresSaveVerification: true,
	},
	opencut_undo: {
		operationKind: "undo",
		requiresSaveVerification: true,
	},
	opencut_import_media: {
		operationKind: "import-media",
		requiresSaveVerification: true,
	},
	opencut_import_subtitles: {
		operationKind: "import-subtitles",
		requiresSaveVerification: true,
	},
	opencut_transcribe_timeline: {
		operationKind: "transcribe-timeline",
		requiresSaveVerification: true,
	},
	opencut_export_subtitles: {
		operationKind: "export-subtitles",
		requiresSaveVerification: false,
	},
	opencut_attach_matte: {
		operationKind: "attach-matte",
		requiresSaveVerification: true,
	},
	opencut_generate_matte: {
		operationKind: "generate-matte",
		requiresSaveVerification: true,
	},
	opencut_track_subject: {
		operationKind: "track-subject",
		requiresSaveVerification: true,
	},
	opencut_export_project: {
		operationKind: "export-project",
		requiresSaveVerification: false,
	},
	opencut_render_preview_frame: {
		operationKind: "render-preview-frame",
		requiresSaveVerification: false,
	},
	opencut_queue_export: {
		operationKind: "queue-export",
		requiresSaveVerification: false,
	},
	opencut_queue_export_batch: {
		operationKind: "queue-export-batch",
		requiresSaveVerification: false,
	},
	opencut_cancel_export_batch: {
		operationKind: "cancel-export-batch",
		requiresSaveVerification: false,
	},
	opencut_cancel_export_job: {
		operationKind: "cancel-export-job",
		requiresSaveVerification: false,
	},
	opencut_run_export_jobs: {
		operationKind: "run-export-jobs",
		requiresSaveVerification: false,
	},
	opencut_record_export_inspection: {
		operationKind: "record-export-inspection",
		requiresSaveVerification: false,
	},
} as const;

export type MutatingToolName = keyof typeof MUTATING_TOOL_MANIFEST;

export function mutatingToolDefinition(name: MutatingToolName) {
	return MUTATING_TOOL_MANIFEST[name];
}
