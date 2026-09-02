import { describe, expect, test } from "bun:test";
import type * as z from "zod/v4";
import { MUTATING_TOOL_MANIFEST, type MutatingToolName } from "./mutating-tool-manifest";
import {
	attachCleanAudioInputSchema,
	attachMatteInputSchema,
	cancelExportBatchInputSchema,
	cancelExportJobInputSchema,
	cleanAudioInputSchema,
	createProjectInputSchema,
	editPlanInputSchema,
	exportProjectInputSchema,
	exportSubtitlesInputSchema,
	generateMatteInputSchema,
	importMediaInputSchema,
	importSubtitlesInputSchema,
	normalizeAudioInputSchema,
	openProjectInputSchema,
	queueExportBatchInputSchema,
	queueExportInputSchema,
	recordExportInspectionInputSchema,
	runExportJobsInputSchema,
	saveProjectInputSchema,
	startEditorWorkerInputSchema,
	stopEditorWorkerInputSchema,
	syncAudioInputSchema,
	trackSubjectInputSchema,
	transcribeTimelineInputSchema,
	undoInputSchema,
	withMutationOperationId,
	withProjectMutationSafety,
} from "./tool-schemas";

const identity = {
	serverInstanceId: "server-1",
	editorInstanceId: "editor-1",
	editorSessionId: "session-1",
	connectionGeneration: 1,
};
const hash = "a".repeat(64);

type SchemaCase = {
	name: MutatingToolName;
	schema: z.ZodType;
	input: Record<string, unknown>;
	operationField?: string;
};

const project = (input: Record<string, unknown>) => ({
	projectId: "project-1",
	expectedRevision: 1,
	expectedProjectContentHash: hash,
	...input,
});

const cases: SchemaCase[] = [
	{ name: "opencut_start_editor_worker", schema: startEditorWorkerInputSchema, input: {} },
	{ name: "opencut_stop_editor_worker", schema: stopEditorWorkerInputSchema, input: {} },
	{ name: "opencut_create_project", schema: withMutationOperationId(createProjectInputSchema), input: { name: "Project" } },
	{ name: "opencut_open_project", schema: withMutationOperationId(openProjectInputSchema), input: { projectId: "project-1" } },
	{ name: "opencut_save_project", schema: saveProjectInputSchema, input: { projectId: "project-1", sceneId: "scene-1", expectedRevision: 1, expectedContentHash: hash } },
	{ name: "opencut_normalize_audio", schema: withProjectMutationSafety(normalizeAudioInputSchema), input: project({}) },
	{ name: "opencut_sync_audio", schema: withProjectMutationSafety(syncAudioInputSchema), input: project({ reference: { trackId: "a", elementId: "a" }, target: { trackId: "b", elementId: "b" } }) },
	{ name: "opencut_attach_clean_audio", schema: withProjectMutationSafety(attachCleanAudioInputSchema), input: project({ trackId: "a", elementId: "a", path: "C:/clean.wav", modelId: "cleaner", modelVersion: "1" }) },
	{ name: "opencut_clean_audio", schema: withProjectMutationSafety(cleanAudioInputSchema), input: project({ trackId: "a", elementId: "a" }) },
	{ name: "opencut_apply_edit_plan", schema: withProjectMutationSafety(editPlanInputSchema), input: project({ description: "Mute", operations: [{ kind: "set_track_state", trackId: "a", muted: true }] }) },
	{ name: "opencut_undo", schema: withProjectMutationSafety(undoInputSchema), input: project({}) },
	{ name: "opencut_import_media", schema: withProjectMutationSafety(importMediaInputSchema), input: project({ path: "C:/clip.mp4", startTime: 0 }) },
	{ name: "opencut_import_subtitles", schema: withProjectMutationSafety(importSubtitlesInputSchema), input: project({ path: "C:/captions.srt" }) },
	{ name: "opencut_transcribe_timeline", schema: withProjectMutationSafety(transcribeTimelineInputSchema), input: project({}) },
	{ name: "opencut_export_subtitles", schema: withProjectMutationSafety(exportSubtitlesInputSchema), input: project({ outputPath: "C:/captions.vtt", format: "vtt" }) },
	{ name: "opencut_attach_matte", schema: withProjectMutationSafety(attachMatteInputSchema), input: project({ trackId: "a", elementId: "a", path: "C:/matte.webm", modelId: "matte", modelVersion: "1" }) },
	{ name: "opencut_generate_matte", schema: withProjectMutationSafety(generateMatteInputSchema), input: project({ trackId: "a", elementId: "a" }) },
	{ name: "opencut_track_subject", schema: withProjectMutationSafety(trackSubjectInputSchema), input: project({ trackId: "a", elementId: "a" }) },
	{ name: "opencut_export_project", schema: withProjectMutationSafety(exportProjectInputSchema), input: project({ outputPath: "C:/video.mp4", format: "mp4" }) },
	{ name: "opencut_queue_export", schema: withProjectMutationSafety(queueExportInputSchema), input: project({ jobId: "job-1", outputPath: "C:/video.mp4", format: "mp4" }) },
	{ name: "opencut_queue_export_batch", schema: withProjectMutationSafety(queueExportBatchInputSchema), input: project({ batchId: "batch-1", variants: [{ variantId: "v1", preset: "tiktok_9_16", outputPath: "C:/v1.mp4" }] }) },
	{ name: "opencut_cancel_export_batch", schema: cancelExportBatchInputSchema, input: { batchId: "batch-1" } },
	{ name: "opencut_cancel_export_job", schema: cancelExportJobInputSchema, input: { jobId: "job-1" } },
	{ name: "opencut_run_export_jobs", schema: runExportJobsInputSchema, input: { limit: 1 } },
	{ name: "opencut_record_export_inspection", schema: recordExportInspectionInputSchema, input: { operationId: "export-1", outputSha256: hash, watermarkStatus: "verified-clean" }, operationField: "inspectionOperationId" },
];

describe("all mutating public MCP schema versions", () => {
	test("covers exactly the 25 registered mutation identities", () => {
		expect(cases.map(({ name }) => String(name)).sort()).toEqual(
			Object.keys(MUTATING_TOOL_MANIFEST).map(String).sort(),
		);
	});

	for (const entry of cases) {
		test(`${entry.name} requires its durable operation ID only for explicit v2`, () => {
			const operationField = entry.operationField ?? "operationId";
			const v2 = {
				...entry.input,
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: identity,
			};
			expect(entry.schema.safeParse(v2).success).toBe(false);
			expect(
				entry.schema.safeParse({ ...v2, [operationField]: `${entry.name}:v2` })
					.success,
			).toBe(true);

			const legacy = entry.schema.parse(entry.input) as Record<string, unknown>;
			expect(String(legacy[operationField])).toStartWith("legacy:");
		}	);
	}
});
