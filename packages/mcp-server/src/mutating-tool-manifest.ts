export const MUTATING_TOOL_MANIFEST = {
	opencut_start_editor_worker: {
		operationKind: "start-editor-worker",
		requiresSaveVerification: false,
		protocolMutationPolicy: "bootstrap-control",
	},
	opencut_stop_editor_worker: {
		operationKind: "stop-editor-worker",
		requiresSaveVerification: false,
		protocolMutationPolicy: "bootstrap-control",
	},
	opencut_create_project: {
		operationKind: "create-project",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_open_project: {
		operationKind: "open-project",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_save_project: {
		operationKind: "save-project",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_normalize_audio: {
		operationKind: "normalize-audio",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_sync_audio: {
		operationKind: "sync-audio",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_attach_clean_audio: {
		operationKind: "attach-clean-audio",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_clean_audio: {
		operationKind: "clean-audio",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_apply_edit_plan: {
		operationKind: "apply-edit-plan",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_undo: {
		operationKind: "undo",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_import_media: {
		operationKind: "import-media",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_import_subtitles: {
		operationKind: "import-subtitles",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_transcribe_timeline: {
		operationKind: "transcribe-timeline",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_export_subtitles: {
		operationKind: "export-subtitles",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_attach_matte: {
		operationKind: "attach-matte",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_generate_matte: {
		operationKind: "generate-matte",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_track_subject: {
		operationKind: "track-subject",
		requiresSaveVerification: true,
		protocolMutationPolicy: "v2-required",
	},
	opencut_export_project: {
		operationKind: "export-project",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_render_preview_frame: {
		operationKind: "render-preview-frame",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_render_preview_range: {
		operationKind: "render-preview-range",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_cancel_preview_range: {
		operationKind: "cancel-preview-range",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_queue_export: {
		operationKind: "queue-export",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_queue_export_batch: {
		operationKind: "queue-export-batch",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_cancel_export_batch: {
		operationKind: "cancel-export-batch",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_cancel_export_job: {
		operationKind: "cancel-export-job",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_run_export_jobs: {
		operationKind: "run-export-jobs",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
	opencut_record_export_inspection: {
		operationKind: "record-export-inspection",
		requiresSaveVerification: false,
		protocolMutationPolicy: "v2-required",
	},
} as const;

export type MutatingToolName = keyof typeof MUTATING_TOOL_MANIFEST;

export function mutatingToolDefinition(name: MutatingToolName) {
	return MUTATING_TOOL_MANIFEST[name];
}
