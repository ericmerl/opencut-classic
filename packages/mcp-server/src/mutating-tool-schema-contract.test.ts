import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type * as z from "zod/v4";
import {
	MUTATING_TOOL_MANIFEST,
	type MutatingToolName,
} from "./mutating-tool-manifest";
import {
	attachCleanAudioInputSchema,
	attachMatteInputSchema,
	cancelComparisonInputSchema,
	cancelExportBatchInputSchema,
	cancelExportJobInputSchema,
	cancelJobInputSchema,
	cancelPreviewRangeInputSchema,
	cleanAudioInputSchema,
	compareProjectStatesInputSchema,
	createDeliveryPackageInputSchema,
	createProjectInputSchema,
	createReviewAnnotationInputSchema,
	createHistoryCheckpointInputSchema,
	applyEditPlanInputSchema,
	exportProjectInputSchema,
	exportSubtitlesInputSchema,
	evaluateExportQcInputSchema,
	generateMatteInputSchema,
	importMediaInputSchema,
	importSubtitlesInputSchema,
	normalizeAudioInputSchema,
	openProjectInputSchema,
	renameProjectInputSchema,
	duplicateProjectInputSchema,
	deleteProjectInputSchema,
	createSceneInputSchema,
	cloneSceneInputSchema,
	switchSceneInputSchema,
	renameSceneInputSchema,
	deleteSceneInputSchema,
	setMainSceneInputSchema,
	reorderScenesInputSchema,
	importMediaAssetInputSchema,
	renameMediaAssetInputSchema,
	relinkMediaAssetInputSchema,
	removeMediaAssetInputSchema,
	queueExportBatchInputSchema,
	queueExportInputSchema,
	recordExportInspectionInputSchema,
	recordWatermarkInspectionInputSchema,
	renderPreviewFrameInputSchema,
	renderPreviewRangeInputSchema,
	resolveJobInputSchema,
	retryJobInputSchema,
	runExportJobsInputSchema,
	saveProjectInputSchema,
	startEditorWorkerInputSchema,
	signOffExportReviewInputSchema,
	stopEditorWorkerInputSchema,
	syncAudioInputSchema,
	trackSubjectInputSchema,
	transcribeTimelineInputSchema,
	undoInputSchema,
	updateReviewAnnotationStatusInputSchema,
	redoInputSchema,
	restoreHistoryCheckpointInputSchema,
	transcribeSourceInputSchema,
	correctTranscriptInputSchema,
	analyzeSpeechInputSchema,
	createEditorialDecisionInputSchema,
	createMediaAnalysisInputSchema,
	reapplyEditorialDecisionInputSchema,
	exportEditorialDecisionInputSchema,
	importEditorialDecisionInputSchema,
	withMutationOperationId,
	withProjectMutationSafety,
	withLifecycleProjectMutationSafety,
	withLifecycleTargetProjectMutationSafety,
} from "./tool-schemas";

const identity = {
	serverInstanceId: "server-1",
	editorInstanceId: "editor-1",
	editorSessionId: "session-1",
	connectionGeneration: 1,
};
const hash = "a".repeat(64);
const fixturePath = (...segments: string[]) =>
	resolve(import.meta.dir, "fixtures", ...segments);

type SchemaCase = {
	name: MutatingToolName;
	schema: z.ZodType;
	input: Record<string, unknown>;
	operationField?: string;
	v2Only?: boolean;
};

const project = (input: Record<string, unknown>) => ({
	projectId: "project-1",
	expectedRevision: 1,
	expectedProjectContentHash: hash,
	preflightFingerprint: hash,
	...input,
});

const cases: SchemaCase[] = [
	{
		name: "opencut_start_editor_worker",
		schema: startEditorWorkerInputSchema,
		input: {},
	},
	{
		name: "opencut_stop_editor_worker",
		schema: stopEditorWorkerInputSchema,
		input: {},
	},
	{
		name: "opencut_create_project",
		schema: withMutationOperationId(createProjectInputSchema),
		input: { name: "Project" },
	},
	{
		name: "opencut_create_review_annotation",
		schema: createReviewAnnotationInputSchema,
		v2Only: true,
		input: {
			annotationId: "annotation-1",
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: hash,
			target: {
				kind: "export",
				evidenceOperationId: "export-1",
				evidenceReceiptId: "export-1",
				artifactSha256: hash,
			},
			location: { kind: "time", ticks: 0 },
			region: { x: 0, y: 0, width: 1, height: 1 },
			category: "watermark",
			severity: "warning",
			finding: { kind: "human" },
			reviewer: "reviewer-1",
			notes: "Needs review.",
		},
	},
	{
		name: "opencut_update_review_annotation_status",
		schema: updateReviewAnnotationStatusInputSchema,
		v2Only: true,
		input: {
			annotationId: "annotation-1",
			expectedVersionId: "annotation-1:1",
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: hash,
			status: "dismissed",
			reviewer: "reviewer-1",
			notes: "False positive.",
		},
	},
	{
		name: "opencut_record_watermark_inspection",
		schema: recordWatermarkInspectionInputSchema,
		v2Only: true,
		input: {
			inspectionId: "inspection-1",
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: hash,
			exportEvidence: {
				evidenceOperationId: "export-1",
				evidenceReceiptId: "export-1",
				artifactSha256: hash,
			},
			renderEvidence: [],
			policy: {
				schemaVersion: "opencut.watermark-sampling-policy.v1",
				fullFrameSamples: ["opening", "middle", "ending"],
				corners: ["top-left", "top-right", "bottom-left", "bottom-right"],
				requireFinalExportBytesInspection: true,
				requireHumanReview: true,
			},
			review: { kind: "human", reviewer: "reviewer-1" },
			samples: ["opening", "middle", "ending"].map((position) => ({
				position,
				fullFrame: "clean",
				corners: {
					"top-left": "clean",
					"top-right": "clean",
					"bottom-left": "clean",
					"bottom-right": "clean",
				},
			})),
			finalExportBytes: { status: "clean" },
			notes: "Human watermark review complete.",
		},
	},
	{
		name: "opencut_sign_off_export_review",
		schema: signOffExportReviewInputSchema,
		v2Only: true,
		input: {
			signoffId: "signoff-1",
			inspectionId: "inspection-1",
			exportOperationId: "export-1",
			outputSha256: hash,
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: hash,
			reviewer: "reviewer-1",
			notes: "Approved after human review.",
		},
	},
	{
		name: "opencut_open_project",
		schema: withMutationOperationId(openProjectInputSchema),
		input: { projectId: "project-1" },
	},
	{
		name: "opencut_rename_project",
		schema: withLifecycleTargetProjectMutationSafety(renameProjectInputSchema),
		input: {
			projectId: "project-1",
			name: "Renamed",
			expectedTargetContentHash: hash,
			expectedTargetWriteVersion: 1,
			preflightFingerprint: hash,
		},
	},
	{
		name: "opencut_duplicate_project",
		schema: withLifecycleTargetProjectMutationSafety(
			duplicateProjectInputSchema,
		),
		input: {
			projectId: "project-1",
			expectedTargetContentHash: hash,
			expectedTargetWriteVersion: 1,
			preflightFingerprint: hash,
		},
	},
	{
		name: "opencut_delete_project",
		schema: withLifecycleTargetProjectMutationSafety(deleteProjectInputSchema),
		input: {
			projectId: "project-1",
			expectedTargetContentHash: hash,
			expectedTargetWriteVersion: 1,
			preflightFingerprint: hash,
		},
	},
	{
		name: "opencut_create_scene",
		schema: withLifecycleProjectMutationSafety(createSceneInputSchema),
		input: project({ name: "Scene 2" }),
	},
	{
		name: "opencut_clone_scene",
		schema: withLifecycleProjectMutationSafety(cloneSceneInputSchema),
		input: project({ sceneId: "scene-1" }),
	},
	{
		name: "opencut_switch_scene",
		schema: withLifecycleProjectMutationSafety(switchSceneInputSchema),
		input: project({ sceneId: "scene-2" }),
	},
	{
		name: "opencut_rename_scene",
		schema: withLifecycleProjectMutationSafety(renameSceneInputSchema),
		input: project({ sceneId: "scene-1", name: "Intro" }),
	},
	{
		name: "opencut_delete_scene",
		schema: withLifecycleProjectMutationSafety(deleteSceneInputSchema),
		input: project({ sceneId: "scene-2" }),
	},
	{
		name: "opencut_set_main_scene",
		schema: withLifecycleProjectMutationSafety(setMainSceneInputSchema),
		input: project({ sceneId: "scene-2" }),
	},
	{
		name: "opencut_reorder_scenes",
		schema: withLifecycleProjectMutationSafety(reorderScenesInputSchema),
		input: project({ sceneIds: ["scene-2", "scene-1"] }),
	},
	{
		name: "opencut_import_media_asset",
		schema: withLifecycleProjectMutationSafety(importMediaAssetInputSchema),
		input: project({ path: fixturePath("clip.mp4") }),
	},
	{
		name: "opencut_rename_media_asset",
		schema: withLifecycleProjectMutationSafety(renameMediaAssetInputSchema),
		input: project({ assetId: "asset-1", name: "B-roll" }),
	},
	{
		name: "opencut_relink_media_asset",
		schema: withLifecycleProjectMutationSafety(relinkMediaAssetInputSchema),
		input: project({ assetId: "asset-1", path: fixturePath("clip-v2.mp4") }),
	},
	{
		name: "opencut_remove_media_asset",
		schema: withLifecycleProjectMutationSafety(removeMediaAssetInputSchema),
		input: project({ assetId: "asset-1" }),
	},
	{
		name: "opencut_save_project",
		schema: saveProjectInputSchema,
		input: {
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 1,
			expectedContentHash: hash,
		},
	},
	{
		name: "opencut_normalize_audio",
		schema: withProjectMutationSafety(normalizeAudioInputSchema),
		input: project({}),
	},
	{
		name: "opencut_sync_audio",
		schema: withProjectMutationSafety(syncAudioInputSchema),
		input: project({
			reference: { trackId: "a", elementId: "a" },
			target: { trackId: "b", elementId: "b" },
		}),
	},
	{
		name: "opencut_attach_clean_audio",
		schema: withProjectMutationSafety(attachCleanAudioInputSchema),
		input: project({
			trackId: "a",
			elementId: "a",
			path: fixturePath("clean.wav"),
			modelId: "cleaner",
			modelVersion: "1",
		}),
	},
	{
		name: "opencut_clean_audio",
		schema: withProjectMutationSafety(cleanAudioInputSchema),
		input: project({ trackId: "a", elementId: "a" }),
	},
	{
		name: "opencut_apply_edit_plan",
		schema: applyEditPlanInputSchema,
		input: project({
			description: "Mute",
			operations: [{ kind: "set_track_state", trackId: "a", muted: true }],
		}),
	},
	{
		name: "opencut_undo",
		schema: withProjectMutationSafety(undoInputSchema),
		input: project({ sceneId: "scene-1" }),
	},
	{
		name: "opencut_redo",
		schema: withProjectMutationSafety(redoInputSchema),
		input: project({ sceneId: "scene-1", redoOfOperationId: "undo-1" }),
	},
	{
		name: "opencut_create_checkpoint",
		schema: withProjectMutationSafety(createHistoryCheckpointInputSchema),
		input: project({
			sceneId: "scene-1",
			checkpointId: "checkpoint-1",
			name: "Before titles",
		}),
	},
	{
		name: "opencut_restore_checkpoint",
		schema: withProjectMutationSafety(restoreHistoryCheckpointInputSchema),
		input: project({ sceneId: "scene-1", checkpointId: "checkpoint-1" }),
	},
	{
		name: "opencut_import_media",
		schema: withProjectMutationSafety(importMediaInputSchema),
		input: project({ path: fixturePath("clip.mp4"), startTime: 0 }),
	},
	{
		name: "opencut_import_subtitles",
		schema: withProjectMutationSafety(importSubtitlesInputSchema),
		input: project({ path: fixturePath("captions.srt") }),
	},
	{
		name: "opencut_transcribe_timeline",
		schema: withProjectMutationSafety(transcribeTimelineInputSchema),
		input: project({}),
	},
	{
		name: "opencut_export_subtitles",
		schema: withProjectMutationSafety(exportSubtitlesInputSchema),
		input: project({ outputPath: fixturePath("captions.vtt"), format: "vtt" }),
	},
	{
		name: "opencut_attach_matte",
		schema: withProjectMutationSafety(attachMatteInputSchema),
		input: project({
			trackId: "a",
			elementId: "a",
			path: fixturePath("matte.webm"),
			modelId: "matte",
			modelVersion: "1",
		}),
	},
	{
		name: "opencut_generate_matte",
		schema: withProjectMutationSafety(generateMatteInputSchema),
		input: project({ trackId: "a", elementId: "a" }),
	},
	{
		name: "opencut_track_subject",
		schema: withProjectMutationSafety(trackSubjectInputSchema),
		input: project({ trackId: "a", elementId: "a" }),
	},
	{
		name: "opencut_export_project",
		schema: withProjectMutationSafety(exportProjectInputSchema),
		input: project({ outputPath: fixturePath("video.mp4"), format: "mp4" }),
	},
	{
		name: "opencut_evaluate_export_qc",
		schema: withMutationOperationId(evaluateExportQcInputSchema),
		input: { exportOperationId: "export-1", policy: { version: 1 } },
	},
	{
		name: "opencut_create_delivery_package",
		schema: withMutationOperationId(createDeliveryPackageInputSchema),
		input: {
			packageName: "Delivery",
			outputDirectory: fixturePath("deliveries"),
			master: { exportOperationId: "master", qcOperationId: "qc-master" },
			variants: [
				{
					variantId: "clean",
					captionMode: "clean",
					exportOperationId: "clean",
					qcOperationId: "qc-clean",
				},
				{
					variantId: "burned",
					captionMode: "burned-in",
					exportOperationId: "burned",
					qcOperationId: "qc-burned",
				},
			],
			sidecars: [{ name: "captions", sourcePath: fixturePath("captions.vtt") }],
		},
	},
	{
		name: "opencut_queue_export",
		schema: withProjectMutationSafety(queueExportInputSchema),
		input: project({
			jobId: "job-1",
			outputPath: fixturePath("video.mp4"),
			format: "mp4",
		}),
	},
	{
		name: "opencut_queue_export_batch",
		schema: withProjectMutationSafety(queueExportBatchInputSchema),
		input: project({
			batchId: "batch-1",
			variants: [
				{
					variantId: "v1",
					preset: "tiktok_9_16",
					outputPath: fixturePath("v1.mp4"),
				},
			],
		}),
	},
	{
		name: "opencut_cancel_export_batch",
		schema: cancelExportBatchInputSchema,
		input: { batchId: "batch-1" },
	},
	{
		name: "opencut_cancel_export_job",
		schema: cancelExportJobInputSchema,
		input: { jobId: "job-1" },
	},
	{
		name: "opencut_cancel_job",
		schema: cancelJobInputSchema,
		input: { jobId: "job-1" },
	},
	{
		name: "opencut_retry_job",
		schema: retryJobInputSchema,
		input: { jobId: "job-1" },
	},
	{
		name: "opencut_resolve_job",
		schema: resolveJobInputSchema,
		input: { jobId: "job-1", resolution: "mark-failed" },
	},
	{
		name: "opencut_run_export_jobs",
		schema: runExportJobsInputSchema,
		input: { limit: 1 },
	},
	{
		name: "opencut_record_export_inspection",
		schema: recordExportInspectionInputSchema,
		input: {
			operationId: "export-1",
			outputSha256: hash,
			watermarkStatus: "verified-clean",
		},
		operationField: "inspectionOperationId",
	},
	{
		name: "opencut_render_preview_frame",
		schema: renderPreviewFrameInputSchema,
		input: {
			contractVersion: 2,
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 1,
			expectedProjectContentHash: hash,
			expectedWriteVersion: 1,
			saveReceiptOperationId: "save-operation",
			expectedSaveReceiptId: "save:project-1:1",
			time: { kind: "frame-index", frameIndex: 0 },
			canvasSize: { width: 320, height: 180 },
			format: "png",
		},
		v2Only: true,
	},
	{
		name: "opencut_render_preview_range",
		schema: renderPreviewRangeInputSchema,
		input: {
			contractVersion: 1,
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 1,
			expectedProjectContentHash: hash,
			expectedWriteVersion: 1,
			saveReceiptOperationId: "save-operation",
			expectedSaveReceiptId: "save:project-1:1",
			range: { kind: "media-time", startTicks: 0, endTicksExclusive: 120_000 },
			canvasSize: { width: 320, height: 180 },
			output: {
				kind: "frame-sequence",
				frameFormat: "png",
				includeAudio: false,
			},
		},
		v2Only: true,
	},
	{
		name: "opencut_compare_project_states",
		schema: compareProjectStatesInputSchema,
		input: {
			contractVersion: 1,
			projectId: "project-1",
			sceneId: "scene-1",
			before: {
				revision: 1,
				projectContentHash: hash,
				projectionName: "opencut-project-content",
				projectionVersion: 2,
				writeVersion: 1,
				saveReceiptOperationId: "save-before",
				saveReceiptId: "save:before",
			},
			after: {
				revision: 2,
				projectContentHash: "b".repeat(64),
				projectionName: "opencut-project-content",
				projectionVersion: 2,
				writeVersion: 2,
				saveReceiptOperationId: "save-after",
				saveReceiptId: "save:after",
			},
			range: {
				kind: "frame-index",
				startFrameIndex: 0,
				endFrameIndexExclusive: 1,
			},
			canvasSize: { width: 320, height: 180 },
			normalization: {
				canvas: "none",
				color: "none",
				fonts: "exact",
				timing: "shared-schedule",
			},
			output: {
				frameFormat: "png",
				comparison: "side-by-side",
				includeAudio: true,
			},
			pixelTolerance: 0,
			audioSampleTolerance: 0,
		},
		v2Only: true,
	},
	{
		name: "opencut_cancel_preview_range",
		schema: cancelPreviewRangeInputSchema,
		input: { targetOperationId: "range-operation" },
	},
	{
		name: "opencut_cancel_comparison",
		schema: cancelComparisonInputSchema,
		input: { targetOperationId: "comparison-operation" },
		v2Only: true,
	},
	{
		name: "opencut_transcribe_source",
		schema: transcribeSourceInputSchema,
		input: {
			projectId: "project-1",
			transcriptId: "transcript-1",
			expectedRevision: 1,
			expectedProjectContentHash: hash,
			trackId: "track-1",
			elementId: "clip-1",
		},
		v2Only: true,
	},
	{
		name: "opencut_correct_transcript",
		schema: withMutationOperationId(correctTranscriptInputSchema),
		input: {
			transcriptId: "transcript-1",
			expectedVersion: 1,
			correctionId: "correction-1",
			policy: "transcript-only",
			changes: [{ wordId: "word-1", text: "Hello" }],
		},
	},
	{
		name: "opencut_analyze_speech",
		schema: withMutationOperationId(analyzeSpeechInputSchema),
		input: {
			analysisId: "analysis-1",
			transcriptId: "transcript-1",
			expectedTranscriptVersion: 1,
			parameters: {
				minimumSilenceTicks: 12_000,
				rangePolicy: { kind: "visible-clip" },
			},
		},
	},
	{
		name: "opencut_create_editorial_decision",
		schema: withMutationOperationId(createEditorialDecisionInputSchema),
		input: {
			decisionId: "decision-1",
			projectId: "project-1",
			sceneId: "scene-1",
			baseRevision: 1,
			baseProjectContentHash: hash,
			description: "Remove a word",
			rationale: "Tighten pacing",
			selection: {
				kind: "word-range",
				transcriptId: "transcript-1",
				expectedTranscriptVersion: 1,
				startWordId: "word-1",
				endWordId: "word-1",
			},
		},
	},
	{
		name: "opencut_create_media_analysis",
		schema: createMediaAnalysisInputSchema,
		input: {
			analysis: {
				schemaVersion: "opencut.media-analysis.v1",
				analysisId: "tracking-1",
				projectId: "project-1",
				sceneId: "scene-1",
				taskId: "opencut.task.subject-tracking.v1",
				source: {
					assetId: "asset-1",
					mediaKind: "video",
					durationTicks: 120_000,
					contentSha256: hash,
					bytes: 1,
				},
				semanticInputs: {
					kind: "subject-tracking",
					sampling: { intervalTicks: 120_000, maxSamples: 2 },
					prompt: null,
					initialBox: null,
					maxSubjects: 1,
					range: { startTicks: 0, endTicks: 120_000 },
				},
				provenance: {
					origin: "external-result",
					approvalStatus: "unverified",
					providerId: "external-provider",
					adapterId: "external-adapter-v1",
					adapterVersion: "1",
					model: {
						id: "fixture-model",
						version: "1",
						sha256: hash,
						source: "fixture",
						license: "fixture-only",
					},
					runtime: "fixture-runtime",
					device: "cpu",
					warnings: [],
					fallbackReason: null,
					lifecycleEvents: [
						{
							sequence: 1,
							attempt: 1,
							kind: "submitted",
							occurredAt: "2026-09-05T00:00:00.000Z",
						},
						{
							sequence: 2,
							attempt: 1,
							kind: "started",
							occurredAt: "2026-09-05T00:00:01.000Z",
						},
						{
							sequence: 3,
							attempt: 1,
							kind: "progress",
							occurredAt: "2026-09-05T00:00:02.000Z",
						},
						{
							sequence: 4,
							attempt: 1,
							kind: "completed",
							occurredAt: "2026-09-05T00:00:03.000Z",
						},
					],
					cost: { status: "not-incurred", amount: 0, currency: null },
					outputArtifacts: [],
				},
				payload: {
					kind: "subject-tracking",
					coverage: { startTicks: 0, endTicks: 120_000 },
					subjects: [
						{
							subjectId: "subject-1",
							samples: [
								{
									sampleId: "sample-1",
									sourceTimeTicks: 0,
									box: { x: 0, y: 0, width: 1, height: 1 },
									confidence: 1,
									occlusion: "visible",
								},
								{
									sampleId: "sample-2",
									sourceTimeTicks: 120_000,
									box: { x: 0, y: 0, width: 1, height: 1 },
									confidence: 1,
									occlusion: "visible",
								},
							],
							corrections: [],
						},
					],
					attachments: [],
				},
			},
		},
	},
	{
		name: "opencut_reapply_editorial_decision",
		schema: withMutationOperationId(reapplyEditorialDecisionInputSchema),
		input: {
			decisionId: "decision-1",
			newDecisionId: "decision-2",
			currentRevision: 2,
			currentProjectContentHash: hash,
		},
	},
	{
		name: "opencut_export_editorial_decision_json",
		schema: withMutationOperationId(exportEditorialDecisionInputSchema),
		input: {
			decisionId: "decision-1",
			outputPath: fixturePath("decisions", "decision-1.json"),
		},
	},
	{
		name: "opencut_import_editorial_decision_json",
		schema: withMutationOperationId(importEditorialDecisionInputSchema),
		input: { path: fixturePath("decisions", "decision-1.json") },
	},
];

describe("all mutating public MCP schema versions", () => {
	test("covers every registered mutation identity", () => {
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

			if (entry.v2Only) {
				expect(entry.schema.safeParse(entry.input).success).toBe(false);
			} else {
				const legacy = entry.schema.parse(entry.input) as Record<
					string,
					unknown
				>;
				expect(String(legacy[operationField])).toStartWith("legacy:");
			}
		});
	}

	test("requires an apply-bound preflight fingerprint for every v2 lifecycle mutation", () => {
		const lifecycleNames = new Set([
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
		]);
		for (const entry of cases.filter(({ name }) => lifecycleNames.has(name))) {
			const { preflightFingerprint: _preflight, ...input } = entry.input;
			expect(
				entry.schema.safeParse({
					...input,
					operationId: `${entry.name}:v2`,
					bridgeProtocolVersion: 2,
					expectedConnectionIdentity: identity,
				}).success,
			).toBe(false);
		}
	});
});
