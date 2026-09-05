import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { join } from "node:path";
import { EditorBridge, type BridgeConnectionIdentity } from "./editor-bridge";
import { CapabilitySnapshotService } from "./capability-snapshot";
import {
	readMediaTreatmentCatalog,
	readTransitionCatalog,
} from "./native-catalog";
import { ExportBatchQueue } from "./export-batches";
import { ExportJobStore } from "./export-job-store";
import { InlineJobMirror } from "./inline-jobs";
import {
	executeCancelJob as executeCancelUnifiedJob,
	executeResolveJob,
	executeRetryJob,
	recoverCancelJob as recoverCancelUnifiedJob,
	recoverResolveJob,
	recoverRetryJob,
} from "./job-ledger-operations";
import { JobService, JobServiceError } from "./job-service";
import { JobStore } from "./job-store";
import { stableSerialize } from "./matte-generation-data";
import { DurableProviderSupervisor } from "./provider-supervisor";
import { ExportJobQueue } from "./export-jobs";
import { ExportProjectService } from "./export-project";
import { ExportReceiptStore } from "./export-receipts";
import { ExportValidator } from "./export-validator";
import { ExportQcService } from "./export-qc";
import { DeliveryPackageService } from "./delivery-package";
import { MatteGenerationService } from "./generate-matte";
import { ManagedEditorWorker } from "./managed-editor-worker";
import { NormalizeAudioOperation } from "./normalize-audio-operation";
import { SubtitleFiles } from "./subtitle-files";
import { SubtitleImportOperation } from "./subtitle-import-operation";
import { OperationLedger, OperationLedgerReuseError } from "./operation-ledger";
import {
	HistoryCheckpointStore,
	HISTORY_CHECKPOINT_SCHEMA,
	type HistoryCheckpointRecord,
} from "./history-checkpoint-store";
import {
	ReviewEvidenceIntegrityError,
	ReviewEvidenceStore,
} from "./review-evidence-store";
import { ReviewEvidenceService } from "./review-evidence-service";
import { PreviewEvidenceStore } from "./preview-evidence-store";
import { PreviewFrameService } from "./preview-frame-service";
import { RangePreviewEvidenceStore } from "./range-preview-evidence-store";
import { RangePreviewService } from "./range-preview-service";
import { ComparisonEvidenceStore } from "./comparison-evidence-store";
import { ComparisonService } from "./comparison-service";
import { nativeComparison } from "./native-comparison";
import { readPreviewRangeLimits } from "./range-preview-config";
import { EditPlanPreflightStore } from "./edit-plan-preflight-store";
import { EditPlanPreflightService } from "./edit-plan-preflight-service";
import { EDIT_PLAN_PREFLIGHT_SCHEMA } from "./edit-plan-preflight-contract";
import { TranscriptStore } from "./transcript-store";
import { TranscriptService } from "./transcript-service";
import {
	parakeetTranscriberFromEnvironment,
	readParakeetReadiness,
} from "./parakeet-transcriber";
import { SpeechAnalysisService } from "./speech-analysis";
import {
	getMediaCapabilityCatalog,
	getMediaExecutionBlocker,
	planAudioPost,
} from "./native-media-foundation";
import { MediaAnalysisStore } from "./media-analysis-store";
import { EditorialDecisionService } from "./editorial-decision";
import { parseJsonValue, type JsonValue } from "./operation-ledger-schema";
import {
	McpLedgerBoundary,
	requestLedgeredBrowserMutation,
	requestLedgeredBrowserStep,
} from "./mcp-ledger-boundary";
import type { OperationExecutionContext } from "./execute-ledgered-operation";
import type {
	CompositeOperationObserver,
	CompositeProviderEvent,
} from "./composite-operation-observer";
import {
	executeRunExportJobs,
	recoverRunExportJobs,
} from "./run-export-jobs-operation";
import {
	executeSubtitleExport,
	recoverSubtitleExport,
} from "./subtitle-export-operation";
import {
	executeCancelBatch,
	executeCancelJob,
	executeQueueBatch,
	executeQueueExport,
	executeRecordInspection,
	recoverCancelBatch,
	recoverCancelJob,
	recoverQueueBatch,
	recoverQueueExport,
	recoverRecordInspection,
} from "./export-queue-ledger-operations";
import {
	getOperationInputSchema,
	listOperationHistoryInputSchema,
} from "./operation-tool-schemas";
import { readProtocolCompatibility } from "./protocol-compatibility";
import {
	attachMatteInputSchema,
	attachCleanAudioInputSchema,
	cleanAudioInputSchema,
	cancelExportBatchInputSchema,
	cancelExportJobInputSchema,
	createProjectInputSchema,
	applyEditPlanInputSchema,
	exportProjectInputSchema,
	generateMatteInputSchema,
	getExportBatchInputSchema,
	getExportJobInputSchema,
	getJobInputSchema,
	listJobsInputSchema,
	cancelJobInputSchema,
	retryJobInputSchema,
	resolveJobInputSchema,
	getExportReceiptInputSchema,
	evaluateExportQcInputSchema,
	getExportQcInputSchema,
	createDeliveryPackageInputSchema,
	verifyDeliveryPackageInputSchema,
	importMediaInputSchema,
	importSubtitlesInputSchema,
	listExportJobsInputSchema,
	listExportBatchesInputSchema,
	normalizeAudioInputSchema,
	exportSubtitlesInputSchema,
	openProjectInputSchema,
	renameProjectInputSchema,
	duplicateProjectInputSchema,
	deleteProjectInputSchema,
	listScenesInputSchema,
	createSceneInputSchema,
	cloneSceneInputSchema,
	switchSceneInputSchema,
	renameSceneInputSchema,
	deleteSceneInputSchema,
	setMainSceneInputSchema,
	reorderScenesInputSchema,
	listMediaUsagesInputSchema,
	importMediaAssetInputSchema,
	renameMediaAssetInputSchema,
	preflightMediaRelinkInputSchema,
	preflightLifecycleMutationInputSchema,
	relinkMediaAssetInputSchema,
	removeMediaAssetInputSchema,
	saveProjectInputSchema,
	getSaveReceiptInputSchema,
	getPreviewFrameInputSchema,
	getPreviewRangeInputSchema,
	getEditPlanPreflightInputSchema,
	listEditPlanPreflightsInputSchema,
	listPreviewFramesInputSchema,
	listPreviewRangesInputSchema,
	renderPreviewFrameInputSchema,
	renderPreviewRangeInputSchema,
	cancelPreviewRangeInputSchema,
	compareProjectStatesInputSchema,
	cancelComparisonInputSchema,
	getComparisonInputSchema,
	listComparisonsInputSchema,
	preflightEditPlanInputSchema,
	queueExportInputSchema,
	queueExportBatchInputSchema,
	recordExportInspectionInputSchema,
	createReviewAnnotationInputSchema,
	getReviewAnnotationInputSchema,
	listReviewAnnotationsInputSchema,
	updateReviewAnnotationStatusInputSchema,
	recordWatermarkInspectionInputSchema,
	getWatermarkInspectionInputSchema,
	signOffExportReviewInputSchema,
	runExportJobsInputSchema,
	searchStickersInputSchema,
	startEditorWorkerInputSchema,
	stopEditorWorkerInputSchema,
	syncAudioInputSchema,
	timelineQueryInputSchema,
	trackSubjectInputSchema,
	transcribeTimelineInputSchema,
	withConnectionAffinity,
	withLifecycleProjectMutationSafety,
	withLifecycleTargetProjectMutationSafety,
	withMutationOperationId,
	withProjectMutationSafety,
	undoInputSchema,
	redoInputSchema,
	historyStateInputSchema,
	createHistoryCheckpointInputSchema,
	getHistoryCheckpointInputSchema,
	listHistoryCheckpointsInputSchema,
	restoreHistoryCheckpointInputSchema,
	transcribeSourceInputSchema,
	getTranscriptInputSchema,
	listTranscriptsInputSchema,
	searchTranscriptInputSchema,
	correctTranscriptInputSchema,
	analyzeSpeechInputSchema,
	getSpeechAnalysisInputSchema,
	getMediaCapabilityCatalogInputSchema,
	createMediaAnalysisInputSchema,
	getMediaAnalysisInputSchema,
	planAudioPostInputSchema,
	createEditorialDecisionInputSchema,
	getEditorialDecisionInputSchema,
	listEditorialDecisionsInputSchema,
	diffEditorialDecisionInputSchema,
	reapplyEditorialDecisionInputSchema,
	exportEditorialDecisionInputSchema,
	importEditorialDecisionInputSchema,
} from "./tool-schemas";

const token =
	process.env.OPENCUT_BRIDGE_TOKEN ??
	process.env.NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN;
if (!token || token.length < 32) {
	throw new Error("OPENCUT_BRIDGE_TOKEN must contain at least 32 characters");
}
const serverPackageMetadata: unknown = await Bun.file(
	join(import.meta.dir, "../package.json"),
).json();
if (
	!isRecord(serverPackageMetadata) ||
	typeof serverPackageMetadata.version !== "string"
) {
	throw new Error("MCP server package version is unavailable");
}
const serverVersion = serverPackageMetadata.version;
const port = parsePort(
	process.env.OPENCUT_BRIDGE_PORT ??
		process.env.NEXT_PUBLIC_OPENCUT_BRIDGE_PORT ??
		"32191",
);
const exportReceipts = new ExportReceiptStore();
const previewEvidence = new PreviewEvidenceStore(
	process.env.OPENCUT_PREVIEW_EVIDENCE_DIR ??
		join(exportReceipts.directory, "preview-evidence"),
	port,
);
await previewEvidence.readiness();
const previewRangeLimits = readPreviewRangeLimits();
const rangePreviewEvidence = new RangePreviewEvidenceStore(
	process.env.OPENCUT_PREVIEW_RANGE_EVIDENCE_DIR ??
		join(exportReceipts.directory, "preview-range-evidence"),
	port,
	previewRangeLimits,
);
await rangePreviewEvidence.readiness();
const comparisonEvidence = new ComparisonEvidenceStore(
	process.env.OPENCUT_COMPARISON_EVIDENCE_DIR ??
		join(exportReceipts.directory, "comparison-evidence"),
	port,
	previewRangeLimits,
	nativeComparison,
);
await comparisonEvidence.readiness();
const bridge = new EditorBridge({
	token,
	port,
	previewEvidence,
	rangePreviewEvidence,
	comparisonEvidence,
});
let capabilitySnapshots: CapabilitySnapshotService;
const jobStoreDirectory =
	process.env.OPENCUT_JOB_STORE_DIR ?? join(exportReceipts.directory, "jobs");
const jobStore = new JobStore(jobStoreDirectory);
await jobStore.initialize();
const inlineJobs = new InlineJobMirror(jobStore);
const previewFrames = new PreviewFrameService(bridge, previewEvidence, () =>
	capabilitySnapshots.capture(),
);
const previewRanges = new RangePreviewService(
	bridge,
	rangePreviewEvidence,
	previewRangeLimits,
	() => capabilitySnapshots.capture(),
	inlineJobs,
);
const comparisons = new ComparisonService(
	bridge,
	comparisonEvidence,
	previewRangeLimits,
	() => capabilitySnapshots.capture(),
	inlineJobs,
);
const editPlanPreflightStore = new EditPlanPreflightStore(
	process.env.OPENCUT_EDIT_PLAN_PREFLIGHT_DIR ??
		join(exportReceipts.directory, "edit-plan-preflights"),
);
await editPlanPreflightStore.readiness();
const editPlanPreflights = new EditPlanPreflightService(
	bridge,
	editPlanPreflightStore,
	undefined,
	{ captureCapabilitySnapshot: () => capabilitySnapshots.capture() },
);
const transcriptStore = new TranscriptStore(
	process.env.OPENCUT_TRANSCRIPT_DIR ??
		join(exportReceipts.directory, "transcripts"),
);
await transcriptStore.readiness();
const transcripts = new TranscriptService(
	bridge,
	transcriptStore,
	parakeetTranscriberFromEnvironment,
);
const speechAnalysis = new SpeechAnalysisService(transcriptStore);
const mediaAnalysisStore = new MediaAnalysisStore(
	process.env.OPENCUT_MEDIA_ANALYSIS_DIR ??
		join(exportReceipts.directory, "media-analysis"),
);
await mediaAnalysisStore.readiness();
const editorialDecisions = new EditorialDecisionService(
	transcriptStore,
	speechAnalysis,
);
await editorialDecisions.readiness();
const normalizeAudio = new NormalizeAudioOperation(bridge);
const exportValidator = new ExportValidator(exportReceipts);
const exportQc = new ExportQcService(exportReceipts);
const deliveryPackages = new DeliveryPackageService(exportReceipts, exportQc);
const projectExports = new ExportProjectService(
	bridge,
	exportReceipts,
	exportValidator,
	() => capabilitySnapshots.capture(),
);
const editorWorker = ManagedEditorWorker.fromEnvironment(
	bridge,
	exportReceipts.directory,
);
const exportJobs = new ExportJobQueue(
	bridge,
	projectExports,
	new ExportJobStore(jobStoreDirectory, jobStore),
	{
		ensureEditor: (projectId) => editorWorker.ensureConnected(projectId),
		capabilitySnapshotHash: () => capabilitySnapshots.snapshotHash(),
		receipts: exportReceipts,
	},
);
await exportJobs.store.initialize();
const exportBatches = new ExportBatchQueue(
	exportJobs,
	ExportBatchQueue.storeForReceiptDirectory(exportReceipts.directory),
);
const providerSupervisor = new DurableProviderSupervisor({
	directory: jobStoreDirectory,
	jobs: jobStore,
});
const jobService = new JobService({
	jobs: jobStore,
	exportJobs,
	providers: providerSupervisor,
	mirror: inlineJobs,
	cancelInline: {
		"preview-range": (record) => previewRanges.cancel(record.operationId),
		comparison: (record) => comparisons.cancel(record.operationId),
	},
});
// Inline work cannot survive a process restart: fail the evidence records
// and job rows that a dead owner left running before serving requests.
await inlineJobs.reconcileInterrupted(async (record) => {
	const reason = "MCP process stopped while inline work was running";
	if (record.jobType === "preview-range") {
		await rangePreviewEvidence.fail(record.operationId, reason);
	} else if (record.jobType === "comparison") {
		await comparisonEvidence.fail(record.operationId, reason);
	}
});
await exportJobs.reconcileInterrupted();
capabilitySnapshots = new CapabilitySnapshotService({
	bridge,
	worker: editorWorker,
	stateDirectory: exportReceipts.directory,
	parakeetReadiness: readParakeetReadiness,
	mediaCapabilityCatalog: () => getMediaCapabilityCatalog({}),
	queueState: async () => {
		await exportJobs.store.initialize();
		const summary = exportJobs.store.jobs.summary();
		const counts = summary.counts;
		return {
			jobs: {
				total: Object.values(counts).reduce((sum, count) => sum + count, 0),
				queued: counts.queued,
				running: counts.starting + counts.running,
				completed: counts.succeeded,
				failed: counts.failed,
				cancelled: counts.cancelled,
				cancelling: counts.cancelling,
				blocked: counts.blocked,
				recoveryRequired: counts["recovery-required"],
			},
			batches: (await exportBatches.store.list()).length,
			depth: summary.depth,
			running: summary.running
				? {
						jobId: summary.running.jobId,
						jobType: summary.running.jobType,
						state: summary.running.state,
						phase: summary.running.progress.phase,
						completed: summary.running.progress.completed,
						total: summary.running.progress.total,
						heartbeatAt: summary.running.heartbeatAt,
						cancellationRequestedAt: summary.running.cancellationRequestedAt,
					}
				: null,
			recoveryRequired: summary.recoveryRequired,
			byType: summary.byType,
		};
	},
});
const matteGeneration = new MatteGenerationService(
	bridge,
	undefined,
	join(exportReceipts.directory, "provider-operations", "matte-generation"),
	jobStoreDirectory,
);
const subtitleFiles = new SubtitleFiles();
const subtitleImport = new SubtitleImportOperation(bridge, subtitleFiles);
const operationLedger = new OperationLedger(
	process.env.OPENCUT_OPERATION_LEDGER_DIR ??
		join(exportReceipts.directory, "operation-ledger"),
);
await operationLedger.readiness();
const historyCheckpointStore = new HistoryCheckpointStore(
	process.env.OPENCUT_HISTORY_CHECKPOINT_DIR ??
		join(exportReceipts.directory, "history-checkpoints"),
);
await historyCheckpointStore.readiness();
const reviewEvidenceStore = new ReviewEvidenceStore(
	process.env.OPENCUT_REVIEW_EVIDENCE_DIR ??
		join(exportReceipts.directory, "review-evidence"),
);
await reviewEvidenceStore.readiness();
const reviewEvidence = new ReviewEvidenceService(
	reviewEvidenceStore,
	exportReceipts,
	undefined,
	previewEvidence,
	rangePreviewEvidence,
);
const protocolCompatibility = readProtocolCompatibility();
const ledgerBoundary = new McpLedgerBoundary(operationLedger, bridge, {
	allowProtocolV1Mutation: protocolCompatibility.protocolV1Mutation.enabled,
});
const completedProjectOperations = new Map<
	string,
	{ fingerprint: string; result: Record<string, unknown> }
>();

function createServer(): McpServer {
	const server = new McpServer(
		{ name: "opencut-classic", version: serverVersion },
		{
			instructions:
				"Call opencut_capabilities first. List, create, or open a project as needed. Read the active project before editing and pass its exact projectId and revision into every mutation.",
		},
	);

	server.registerTool(
		"opencut_capabilities",
		{
			description:
				"Return a hashable build, instance, tool, editor, renderer, provider, font, media-tool, queue, and disk readiness snapshot without starting the editor or spending provider credits.",
		},
		async () => toolResult(await capabilitySnapshots.capture()),
	);

	server.registerTool(
		"opencut_get_media_capability_catalog",
		{
			description:
				"Discover the Rust-owned tracker, cleanup, stem, and VAD task contracts and their truthful model-selection readiness without provider execution or cost.",
			inputSchema: getMediaCapabilityCatalogInputSchema,
		},
		async (input) => toolResult(getMediaCapabilityCatalog(input)),
	);

	server.registerTool(
		"opencut_create_media_analysis",
		{
			description:
				"Persist a Rust-validated external tracking or voice-activity result with canonical source-time data, corrections, provenance, semantic input hash, and deterministic cache identity. This never executes a provider or approves its model.",
			inputSchema: createMediaAnalysisInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_create_media_analysis",
					input,
					() => mediaAnalysisStore.create(input.operationId, input.analysis),
					() => mediaAnalysisStore.create(input.operationId, input.analysis),
				),
			),
	);

	server.registerTool(
		"opencut_get_media_analysis",
		{
			description:
				"Read one durable tracking or voice-activity analysis after Rust-owned integrity and source-binding verification.",
			inputSchema: getMediaAnalysisInputSchema,
		},
		async ({ analysisId }) => {
			const analysis = await mediaAnalysisStore.get(analysisId);
			return toolResult(
				analysis
					? { status: "found", analysis }
					: { status: "not-found", analysisId },
			);
		},
	);

	server.registerTool(
		"opencut_plan_audio_post",
		{
			description:
				"Deterministically plan a Rust-owned ordered clip/track/master audio graph and non-destructive ducking envelopes from a durable VAD object. Rejects stale source or analysis identity and never executes a provider.",
			inputSchema: planAudioPostInputSchema,
		},
		async (input) => {
			const analysis = await mediaAnalysisStore.get(input.analysisId);
			if (!analysis) {
				return toolResult({
					status: "not-found",
					analysisId: input.analysisId,
				});
			}
			return toolResult(planAudioPost({ ...input, analysis }));
		},
	);

	server.registerTool(
		"opencut_connection_status",
		{
			description:
				"Report whether an authenticated OpenCut editor is connected.",
		},
		async () =>
			toolResult({
				...bridge.getStatus(),
				worker: editorWorker.getStatus(),
				protocolCompatibility,
			}),
	);

	server.registerTool(
		"opencut_start_editor_worker",
		{
			description:
				"Start a managed hidden headless Chrome or Edge editor using the persistent automation profile, then wait for its authenticated bridge connection.",
			inputSchema: startEditorWorkerInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_start_editor_worker",
					input,
					() => editorWorker.ensureConnected(input.projectId),
					undefined,
					() => editorWorker.ensureConnected(input.projectId),
				),
			),
	);

	server.registerTool(
		"opencut_stop_editor_worker",
		{
			description:
				"Stop the headless editor process launched by this MCP server. Manually opened editor sessions are not stopped.",
			inputSchema: stopEditorWorkerInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_stop_editor_worker",
					input,
					() => editorWorker.stop(),
					undefined,
					() => editorWorker.stop(),
				),
			),
	);

	server.registerTool(
		"opencut_list_projects",
		{
			description:
				"List saved OpenCut projects in descending update order and identify the active project.",
			inputSchema: withConnectionAffinity(z.object({})),
		},
		async (params) => toolResult(await bridge.request("list_projects", params)),
	);

	server.registerTool(
		"opencut_create_project",
		{
			description:
				"Create and activate a new OpenCut project, then navigate the connected editor to it.",
			inputSchema: withMutationOperationId(createProjectInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_create_project",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"create_project",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_open_project",
		{
			description:
				"Open an existing OpenCut project and navigate the connected editor to it.",
			inputSchema: withMutationOperationId(openProjectInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_open_project",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"open_project",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_rename_project",
		{
			description:
				"Rename a saved OpenCut project by ID. Renaming the active project bumps its revision; other projects are updated in storage without switching.",
			inputSchema: withLifecycleTargetProjectMutationSafety(
				renameProjectInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_rename_project",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"rename_project",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_duplicate_project",
		{
			description:
				"Duplicate a saved project into a new project with independent scene, track, element, transition, and bookmark IDs. Media assets are shared by content identity. The editor stays on the current project.",
			inputSchema: withLifecycleTargetProjectMutationSafety(
				duplicateProjectInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_duplicate_project",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"duplicate_project",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_delete_project",
		{
			description:
				"Irreversibly delete a saved project and its project-scoped media bytes. Deleting the active project first activates fallbackProjectId, else the most recently updated remaining project, else a new blank project.",
			inputSchema: withLifecycleTargetProjectMutationSafety(
				deleteProjectInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_delete_project",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"delete_project",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_preflight_lifecycle_mutation",
		{
			description:
				"Validate a project, scene, or media-bin lifecycle mutation without changing editor, storage, history, or selection state. The returned fingerprint must be supplied to the matching mutation.",
			inputSchema: withConnectionAffinity(
				preflightLifecycleMutationInputSchema,
			),
		},
		async (input) => {
			const { method, request, ...connection } = input;
			let stagedRequest: Record<string, unknown> = request;
			if (method === "import_media_asset" || method === "relink_media_asset") {
				const path = request.path;
				if (typeof path !== "string") throw new Error("media path is required");
				const ticket = await bridge.mediaTickets.create(path);
				const { path: _path, ...rest } = request;
				stagedRequest = {
					...rest,
					url: ticket.url,
					name: ticket.name,
					mimeType: ticket.mimeType,
					sourceFingerprint: ticket.sourceFingerprint,
				};
			}
			return toolResult(
				await bridge.request("preflight_lifecycle_mutation", {
					...connection,
					method,
					request: stagedRequest,
				}),
			);
		},
	);

	server.registerTool(
		"opencut_list_scenes",
		{
			description:
				"List every scene of the active project with main and active flags, order, counts, bookmarks with stable IDs, and a per-scene canonical content hash.",
			inputSchema: withConnectionAffinity(listScenesInputSchema),
		},
		async (params) => toolResult(await bridge.request("list_scenes", params)),
	);

	server.registerTool(
		"opencut_create_scene",
		{
			description:
				"Create a new empty scene in the active project, optionally activating it.",
			inputSchema: withLifecycleProjectMutationSafety(createSceneInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_create_scene",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"create_scene",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_clone_scene",
		{
			description:
				"Clone a scene with fresh track, element, transition, and bookmark IDs, optionally activating the copy.",
			inputSchema: withLifecycleProjectMutationSafety(cloneSceneInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute("opencut_clone_scene", params, (context) =>
					requestLedgeredBrowserMutation(
						context,
						bridge,
						"clone_scene",
						params,
					),
				),
			),
	);

	server.registerTool(
		"opencut_switch_scene",
		{
			description:
				"Make another scene of the active project the active scene as an undoable, ledgered mutation.",
			inputSchema: withLifecycleProjectMutationSafety(switchSceneInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_switch_scene",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"switch_scene",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_rename_scene",
		{
			description: "Rename a scene of the active project.",
			inputSchema: withLifecycleProjectMutationSafety(renameSceneInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_rename_scene",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"rename_scene",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_delete_scene",
		{
			description:
				"Delete a scene. Deleting the active scene activates replacementSceneId (default: the main scene); deleting the main scene requires newMainSceneId to promote another scene first.",
			inputSchema: withLifecycleProjectMutationSafety(deleteSceneInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_delete_scene",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"delete_scene",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_set_main_scene",
		{
			description: "Promote a scene to be the project's main scene.",
			inputSchema: withLifecycleProjectMutationSafety(setMainSceneInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_set_main_scene",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"set_main_scene",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_reorder_scenes",
		{
			description:
				"Reorder the project's scenes; sceneIds must list every scene exactly once.",
			inputSchema: withLifecycleProjectMutationSafety(reorderScenesInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_reorder_scenes",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"reorder_scenes",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_list_media_usages",
		{
			description:
				"List every timeline, compound, matte, audio-replacement, provider, and package reference to media assets across the active project, plus the assets nothing references.",
			inputSchema: withConnectionAffinity(listMediaUsagesInputSchema),
		},
		async (params) =>
			toolResult(await bridge.request("list_media_usages", params)),
	);

	server.registerTool(
		"opencut_import_media_asset",
		{
			description:
				"Import an image, audio file, or video from an absolute local path into the project media bin without placing it on the timeline. Use the instantiate_asset edit-plan operation to place it later.",
			inputSchema: withLifecycleProjectMutationSafety(
				importMediaAssetInputSchema,
			),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_import_media_asset",
					input,
					async (context) => {
						const { path, ...params } = input;
						const [ticket, preflightTicket] = await Promise.all([
							bridge.mediaTickets.create(path),
							bridge.mediaTickets.create(path),
						]);
						return requestLedgeredBrowserMutation(
							context,
							bridge,
							"import_media_asset",
							{
								...params,
								url: ticket.url,
								preflightUrl: preflightTicket.url,
								name: ticket.name,
								mimeType: ticket.mimeType,
								sourceFingerprint: ticket.sourceFingerprint,
							},
						);
					},
				),
			),
	);

	server.registerTool(
		"opencut_rename_media_asset",
		{
			description: "Rename a media bin asset without changing its identity.",
			inputSchema: withLifecycleProjectMutationSafety(
				renameMediaAssetInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_rename_media_asset",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"rename_media_asset",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_preflight_media_relink",
		{
			description:
				"Inspect a replacement media file without mutation. Returns compatibility, every metadata difference, and the number of affected usages at the exact project revision and content hash.",
			inputSchema: withConnectionAffinity(preflightMediaRelinkInputSchema),
		},
		async (input) => {
			const { path, ...params } = input;
			const ticket = await bridge.mediaTickets.create(path);
			return toolResult(
				await bridge.request("preflight_media_relink", {
					...params,
					url: ticket.url,
					name: ticket.name,
					mimeType: ticket.mimeType,
					sourceFingerprint: ticket.sourceFingerprint,
				}),
			);
		},
	);

	server.registerTool(
		"opencut_relink_media_asset",
		{
			description:
				"Replace the file behind a media bin asset while every timeline reference keeps its asset ID. Returns the compatibility differences (dimensions, duration, fps, audio, size); a media type change requires allowIncompatible.",
			inputSchema: withLifecycleProjectMutationSafety(
				relinkMediaAssetInputSchema,
			),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_relink_media_asset",
					input,
					async (context) => {
						const { path, ...params } = input;
						const [ticket, preflightTicket] = await Promise.all([
							bridge.mediaTickets.create(path),
							bridge.mediaTickets.create(path),
						]);
						return requestLedgeredBrowserMutation(
							context,
							bridge,
							"relink_media_asset",
							{
								...params,
								url: ticket.url,
								preflightUrl: preflightTicket.url,
								name: ticket.name,
								mimeType: ticket.mimeType,
								sourceFingerprint: ticket.sourceFingerprint,
							},
						);
					},
				),
			),
	);

	server.registerTool(
		"opencut_remove_media_asset",
		{
			description:
				"Remove a media bin asset. The unused-only policy refuses referenced assets; cascade also removes every element, matte, and audio replacement that references it in every scene and compound.",
			inputSchema: withLifecycleProjectMutationSafety(
				removeMediaAssetInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_remove_media_asset",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"remove_media_asset",
							params,
						),
				),
			),
	);

	server.registerTool(
		"opencut_get_project",
		{
			description:
				"Read the active project, canvas settings, scene, revision, track roles, media assets, and parameterized timeline elements in canonical media ticks.",
			inputSchema: withConnectionAffinity(z.object({})),
		},
		async (params) => toolResult(await bridge.request("read_project", params)),
	);

	server.registerTool(
		"opencut_save_project",
		{
			description:
				"Flush every queued editor write, reopen the persisted project and media through fresh storage handles, verify its canonical content hash, and return a durable save receipt.",
			inputSchema: saveProjectInputSchema,
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_save_project",
					params,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"save_project",
							params,
							5 * 60_000,
						),
					() => bridge.request("recover_save_project", params, 5 * 60_000),
				),
			),
	);

	server.registerTool(
		"opencut_get_save_receipt",
		{
			description:
				"Read a previously verified browser-persisted save receipt by operation ID.",
			inputSchema: withConnectionAffinity(getSaveReceiptInputSchema),
		},
		async (params) =>
			toolResult(await bridge.request("get_save_receipt", params)),
	);

	server.registerTool(
		"opencut_get_operation",
		{
			description:
				"Read the latest durable record and versions for one operation.",
			inputSchema: getOperationInputSchema,
		},
		async ({ operationId }) =>
			toolResult({
				operation: await operationLedger.get(operationId),
				versions: await operationLedger.versions(operationId),
			}),
	);

	server.registerTool(
		"opencut_preflight_edit_plan",
		{
			description:
				"Validate and deterministically expand a complete edit plan against an explicit active or non-active saved scene without changing editor, playback, selection, history, or persistence state.",
			inputSchema: preflightEditPlanInputSchema,
		},
		async (input) => toolResult(await editPlanPreflights.preflight(input)),
	);

	server.registerTool(
		"opencut_get_edit_plan_preflight",
		{
			description:
				"Read and integrity-verify one immutable edit-plan preflight receipt.",
			inputSchema: getEditPlanPreflightInputSchema,
		},
		async ({ receiptId }) => {
			const receipt = await editPlanPreflightStore.get(receiptId);
			return toolResult(
				receipt
					? {
							schemaVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
							status: "found",
							receipt,
						}
					: {
							schemaVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
							status: "not-found",
							receiptId,
						},
			);
		},
	);

	server.registerTool(
		"opencut_list_edit_plan_preflights",
		{
			description:
				"List immutable edit-plan preflight receipts with stable cursor pagination.",
			inputSchema: listEditPlanPreflightsInputSchema,
		},
		async (input) =>
			toolResult({
				schemaVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
				...(await editPlanPreflightStore.list(input)),
			}),
	);

	server.registerTool(
		"opencut_list_operation_history",
		{
			description:
				"List append-only durable operation history with bounded filters and cursor pagination.",
			inputSchema: listOperationHistoryInputSchema,
		},
		async (input) => toolResult(await operationLedger.listPage(input)),
	);

	server.registerTool(
		"opencut_render_preview_frame",
		{
			description:
				"Render one exact export-quality PNG frame from a verified persisted project without changing playback or selection, then persist hash-verified evidence.",
			inputSchema: renderPreviewFrameInputSchema,
		},
		async (input) => {
			await assertSaveReceiptEditorAffinity(input);
			const ledgerRecord = await operationLedger.get(input.operationId);
			if (ledgerRecord?.record.status === "completed") {
				const receipt = await previewFrames.verifyOperationReceipt(
					input.operationId,
				);
				if (!receipt)
					throw new Error(
						"terminal preview operation has no durable evidence receipt",
					);
			}
			return toolResult(
				await ledgerBoundary.execute(
					"opencut_render_preview_frame",
					input,
					(context) => previewFrames.render(input, context),
					(context) => previewFrames.recover(input, context),
				),
			);
		},
	);

	server.registerTool(
		"opencut_get_preview_frame",
		{
			description:
				"Read and integrity-verify one durable exact-frame receipt and PNG artifact.",
			inputSchema: getPreviewFrameInputSchema,
		},
		async ({ receiptId }) => toolResult(await previewFrames.get(receiptId)),
	);

	server.registerTool(
		"opencut_list_preview_frames",
		{
			description:
				"List durable exact-frame receipts and verify every returned PNG artifact.",
			inputSchema: listPreviewFramesInputSchema,
		},
		async (input) => toolResult(await previewFrames.list(input)),
	);

	server.registerTool(
		"opencut_render_preview_range",
		{
			description:
				"Render a configuration-bounded export-quality PNG frame sequence with exact Rust-scheduled timestamps and hashes, plus optional PCM WAV audio, durable progress, and cancellation.",
			inputSchema: renderPreviewRangeInputSchema,
		},
		async (input) => {
			await assertSaveReceiptEditorAffinity(input);
			const ledgerRecord = await operationLedger.get(input.operationId);
			if (ledgerRecord?.record.status === "completed") {
				const receipt = await previewRanges.verifyOperationReceipt(
					input.operationId,
				);
				if (!receipt)
					throw new Error(
						"terminal preview-range operation has no durable evidence receipt",
					);
			}
			return toolResult(
				await ledgerBoundary.execute(
					"opencut_render_preview_range",
					input,
					(context) => previewRanges.render(input, context),
					(context) => previewRanges.recover(input, context),
				),
			);
		},
	);

	server.registerTool(
		"opencut_cancel_preview_range",
		{
			description:
				"Durably request cancellation of a running inline preview range; the renderer observes it no later than the next frame upload.",
			inputSchema: cancelPreviewRangeInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_cancel_preview_range",
					input,
					() => previewRanges.cancel(input.targetOperationId),
				),
			),
	);

	server.registerTool(
		"opencut_get_preview_range",
		{
			description:
				"Read live progress or an integrity-verified terminal preview-range receipt.",
			inputSchema: getPreviewRangeInputSchema,
		},
		async ({ receiptId }) => toolResult(await previewRanges.get(receiptId)),
	);

	server.registerTool(
		"opencut_list_preview_ranges",
		{
			description: "List durable preview-range progress and receipts.",
			inputSchema: listPreviewRangesInputSchema,
		},
		async (input) => toolResult(await previewRanges.list(input)),
	);

	server.registerTool(
		"opencut_compare_project_states",
		{
			description:
				"Render two retained, hash-locked project states on one exact schedule and produce durable source, side-by-side or wipe, pixel-diff, region, and optional audio comparison evidence.",
			inputSchema: compareProjectStatesInputSchema,
		},
		async (input) => {
			await Promise.all([
				assertSaveReceiptEditorAffinity({
					saveReceiptOperationId: input.before.saveReceiptOperationId,
					expectedConnectionIdentity: input.expectedConnectionIdentity,
				}),
				assertSaveReceiptEditorAffinity({
					saveReceiptOperationId: input.after.saveReceiptOperationId,
					expectedConnectionIdentity: input.expectedConnectionIdentity,
				}),
			]);
			const ledgerRecord = await operationLedger.get(input.operationId);
			if (ledgerRecord?.record.status === "completed") {
				const receipt = await comparisons.verifyOperationReceipt(
					input.operationId,
				);
				if (!receipt)
					throw new Error(
						"terminal comparison operation has no durable evidence receipt",
					);
			}
			return toolResult(
				await ledgerBoundary.execute(
					"opencut_compare_project_states",
					input,
					(context) => comparisons.compare(input, context),
					(context) => comparisons.recover(input, context),
				),
			);
		},
	);

	server.registerTool(
		"opencut_cancel_comparison",
		{
			description:
				"Durably request cancellation of an inline before/after comparison.",
			inputSchema: cancelComparisonInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute("opencut_cancel_comparison", input, () =>
					comparisons.cancel(input.targetOperationId),
				),
			),
	);

	server.registerTool(
		"opencut_get_comparison",
		{
			description:
				"Read live progress or an integrity-verified terminal comparison receipt.",
			inputSchema: getComparisonInputSchema,
		},
		async ({ receiptId }) => toolResult(await comparisons.get(receiptId)),
	);

	server.registerTool(
		"opencut_list_comparisons",
		{
			description: "List durable before/after comparison jobs and receipts.",
			inputSchema: listComparisonsInputSchema,
		},
		async (input) => toolResult(await comparisons.list(input)),
	);

	server.registerTool(
		"opencut_query_timeline",
		{
			description:
				"Query a revision-stable time range of the active timeline and return compact ordered elements, uncovered gaps, pairwise overlaps, and cut, gap, or overlap relationships per track.",
			inputSchema: withConnectionAffinity(timelineQueryInputSchema),
		},
		async (params) =>
			toolResult(await bridge.request("query_timeline", params)),
	);

	server.registerTool(
		"opencut_list_effects",
		{
			description:
				"List effects registered by the connected OpenCut editor for clip-effect stacks and adjustment layers, including validated parameter types, ranges, defaults, named presets, and keyframe support.",
			inputSchema: withConnectionAffinity(z.object({})),
		},
		async (params) => toolResult(await bridge.request("list_effects", params)),
	);

	server.registerTool(
		"opencut_list_treatments",
		{
			description:
				"List the Rust-owned named Simple Media treatment catalog, or resolve one stable treatment ID, including deterministic OpenCut-defined rendering behavior. External pixel equivalence is not claimed.",
			inputSchema: z
				.object({ treatmentId: z.string().trim().min(1).optional() })
				.strict(),
		},
		async ({ treatmentId }) =>
			toolResult(readMediaTreatmentCatalog(treatmentId)),
	);

	server.registerTool(
		"opencut_list_transitions",
		{
			description:
				"List the Rust-owned transition catalog, or resolve one stable transition ID, including duration, adjacency, mask, track, and compound-boundary policies.",
			inputSchema: z
				.object({ transitionId: z.string().trim().min(1).optional() })
				.strict(),
		},
		async ({ transitionId }) => toolResult(readTransitionCatalog(transitionId)),
	);

	server.registerTool(
		"opencut_list_visual_assets",
		{
			description:
				"List native graphic definitions, authored mask types, their validated parameter schemas, and sticker categories available in the connected editor.",
			inputSchema: withConnectionAffinity(z.object({})),
		},
		async (params) =>
			toolResult(await bridge.request("list_visual_assets", params)),
	);

	server.registerTool(
		"opencut_search_stickers",
		{
			description:
				"Search native sticker providers and return stable sticker IDs, provider names, previews, and metadata for insertion through an edit plan.",
			inputSchema: withConnectionAffinity(searchStickersInputSchema),
		},
		async (params) =>
			toolResult(await bridge.request("search_stickers", params)),
	);

	server.registerTool(
		"opencut_analyze_audio",
		{
			description:
				"Measure the active timeline mix before export mastering, including integrated LUFS, sample peak, estimated true peak, and the uniform gain range available without clipping OpenCut volume controls.",
			inputSchema: withConnectionAffinity(
				z.object({
					projectId: z.string().min(1),
					expectedRevision: z.number().int().nonnegative(),
				}),
			),
		},
		async (params) =>
			toolResult(await bridge.request("analyze_audio", params, 5 * 60_000)),
	);

	server.registerTool(
		"opencut_normalize_audio",
		{
			description:
				"Measure and normalize the active timeline mix to a target integrated loudness while respecting a true-peak ceiling and preserving relative clip levels and volume automation.",
			inputSchema: withProjectMutationSafety(normalizeAudioInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_normalize_audio",
					input,
					(context) => normalizeAudio.execute(input, context),
					(context) => normalizeAudio.recover(input, context),
				),
			),
	);

	server.registerTool(
		"opencut_sync_audio",
		{
			description:
				"Synchronize a target video or audio clip to a reference clip by decoding both sources locally, estimating waveform lag with bounded normalized cross-correlation, and moving the target on the current track.",
			inputSchema: withProjectMutationSafety(syncAudioInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute("opencut_sync_audio", input, (context) =>
					requestLedgeredBrowserMutation(
						context,
						bridge,
						"sync_audio",
						input,
						10 * 60_000,
					),
				),
			),
	);

	server.registerTool(
		"opencut_attach_clean_audio",
		{
			description:
				"Attach a precomputed cleaned-audio file to an uploaded audio or video clip while preserving the clip's timing, trim, retime, fades, ducking, mute, and volume automation. Use apply_edit_plan to enable, disable, or detach it.",
			inputSchema: withProjectMutationSafety(attachCleanAudioInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_attach_clean_audio",
					input,
					async (context) => {
						const { path, ...params } = input;
						const ticket = await bridge.mediaTickets.create(path);
						const request = {
							...params,
							url: ticket.url,
							name: ticket.name,
							mimeType: ticket.mimeType,
							artifactHash: ticket.contentHash,
							artifactFingerprint: ticket.sourceFingerprint,
						};
						return requestLedgeredBrowserMutation(
							context,
							bridge,
							"attach_clean_audio",
							request,
						);
					},
				),
			),
	);

	server.registerTool(
		"opencut_clean_audio",
		{
			description:
				"Reserved cleanup execution surface. Returns MODEL_SELECTION_REQUIRED without provider execution until the owner approves an exact model identity, source, license, and artifact hash; attach precomputed audio with opencut_attach_clean_audio.",
			inputSchema: withProjectMutationSafety(cleanAudioInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_clean_audio",
					input,
					async () => modelSelectionRequired("opencut.task.audio-cleanup.v1"),
					async () => modelSelectionRequired("opencut.task.audio-cleanup.v1"),
				),
			),
	);

	server.registerTool(
		"opencut_apply_edit_plan",
		{
			description:
				"Apply a previously validated edit plan atomically to its explicit scene, including a non-active scene without changing the active UI scene or selection. Bridge protocol v2 requires the immutable receipt returned by opencut_preflight_edit_plan; receipt-less v2 requests are rejected without mutation.",
			inputSchema: applyEditPlanInputSchema,
		},
		async (plan) => {
			const { preflight, ...browserPlan } = plan;
			if (plan.bridgeProtocolVersion === 2 && !preflight) {
				return toolResult({
					status: "rejected",
					code: "PREFLIGHT_REQUIRED",
					retryable: false,
					operationId: plan.operationId,
					reason:
						"Bridge protocol v2 edit plans require a verified preflight receipt",
				});
			}
			return toolResult(
				await ledgerBoundary.execute(
					"opencut_apply_edit_plan",
					plan,
					async (context) => {
						let browserRequest: Record<string, unknown> = browserPlan;
						if (preflight) {
							if (
								plan.bridgeProtocolVersion !== 2 ||
								!plan.expectedConnectionIdentity ||
								!plan.expectedProjectContentHash
							) {
								throw new Error(
									"a verified preflight requires bridge protocol v2, connection affinity, and a project content hash",
								);
							}
							const verified = await editPlanPreflights.verifiedApplication({
								projectId: plan.projectId,
								sceneId: plan.sceneId,
								expectedRevision: plan.expectedRevision,
								expectedProjectContentHash: plan.expectedProjectContentHash,
								expectedConnectionIdentity: plan.expectedConnectionIdentity,
								description: plan.description,
								operations: plan.operations,
								preflight,
							});
							const source = verified.evaluation.source;
							browserRequest = {
								...browserPlan,
								contractVersion: 2,
								bridgeProtocolVersion: 2,
								expectedConnectionIdentity: plan.expectedConnectionIdentity,
								sceneId: source.sceneId,
								expectedProjectContentHash: source.canonicalProjectHash,
								expectedWriteVersion: source.durableWriteVersion,
								saveReceiptOperationId: source.saveOperationId,
								expectedSaveReceiptId: source.saveReceiptId,
								operations: verified.evaluation.resolvedOperations,
								preflight: {
									preflightId: verified.receipt.preflightId,
									receiptId: verified.receipt.receiptId,
									evaluation: {
										...verified.evaluation,
										source: {
											...source,
											sessionRevision: plan.expectedRevision,
											connectionIdentity: {
												...plan.expectedConnectionIdentity,
												bridgeProtocolVersion: 2 as const,
											},
										},
									},
								},
							};
						}
						return requestLedgeredBrowserMutation(
							context,
							bridge,
							"apply_edit_plan",
							browserRequest,
						);
					},
				),
			);
		},
	);

	server.registerTool(
		"opencut_get_history_state",
		{
			description:
				"Read the active editor session's exact native undo and redo entry sequence after revision, content-hash, scene, and connection checks.",
			inputSchema: historyStateInputSchema,
		},
		async (params) =>
			toolResult(await bridge.request("get_history_state", params)),
	);

	server.registerTool(
		"opencut_undo",
		{
			description:
				"Undo one to 100 native OpenCut commands after revision, content-hash, scene, and connection checks.",
			inputSchema: withProjectMutationSafety(undoInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute("opencut_undo", params, (context) => {
					const { undoOfOperationId: _undoOf, ...request } = params;
					return requestLedgeredBrowserMutation(
						context,
						bridge,
						"undo",
						request,
					);
				}),
			),
	);

	server.registerTool(
		"opencut_redo",
		{
			description:
				"Redo one to 100 native OpenCut commands after revision, content-hash, scene, and connection checks.",
			inputSchema: withProjectMutationSafety(redoInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute("opencut_redo", params, (context) => {
					const { redoOfOperationId: _redoOf, ...request } = params;
					return requestLedgeredBrowserMutation(
						context,
						bridge,
						"redo",
						request,
					);
				}),
			),
	);

	server.registerTool(
		"opencut_create_checkpoint",
		{
			description:
				"Create durable named checkpoint metadata bound to the exact project revision, content hash, active scene, editor session, and native undo/redo sequence.",
			inputSchema: withProjectMutationSafety(
				createHistoryCheckpointInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_create_checkpoint",
					params,
					async () => {
						const existing = await historyCheckpointStore.get(
							params.checkpointId,
						);
						if (existing) {
							return {
								status: "rejected",
								operationId: params.operationId,
								reason: `checkpoint ${params.checkpointId} already exists`,
							};
						}
						const history = await bridge.request("get_history_state", params);
						if (!isHistoryState(history)) return history;
						const identity = readConnectionIdentity(
							params.expectedConnectionIdentity,
						);
						if (!identity) {
							throw new Error(
								"checkpoint creation requires v2 connection identity",
							);
						}
						const checkpoint: HistoryCheckpointRecord = {
							schemaVersion: HISTORY_CHECKPOINT_SCHEMA,
							checkpointId: params.checkpointId,
							operationId: requiredOperationId(params.operationId),
							name: params.name,
							projectId: history.projectId,
							sceneId: history.sceneId,
							revision: history.revision,
							contentHash: history.contentHash,
							contentHashProjectionVersion:
								history.contentHashProjectionVersion,
							createdAt: new Date().toISOString(),
							connectionIdentity: {
								...identity,
								bridgeProtocolVersion: 2,
							},
							nativeHistory: history.nativeHistory,
						};
						await historyCheckpointStore.create(checkpoint);
						return historyCheckpointCreated(checkpoint);
					},
					async () => {
						const checkpoint = await historyCheckpointStore.get(
							params.checkpointId,
						);
						return checkpoint?.operationId ===
							requiredOperationId(params.operationId)
							? historyCheckpointCreated(checkpoint)
							: null;
					},
				),
			),
	);

	server.registerTool(
		"opencut_get_checkpoint",
		{
			description:
				"Read and checksum-verify one durable named history checkpoint.",
			inputSchema: getHistoryCheckpointInputSchema,
		},
		async ({ checkpointId }) => {
			const checkpoint = await historyCheckpointStore.get(checkpointId);
			return toolResult(
				checkpoint
					? { status: "found", checkpoint }
					: { status: "not-found", checkpointId },
			);
		},
	);

	server.registerTool(
		"opencut_list_checkpoints",
		{
			description:
				"List durable named history checkpoints with project/scene filters and stable bounded cursor pagination.",
			inputSchema: listHistoryCheckpointsInputSchema,
		},
		async (input) =>
			toolResult({
				schemaVersion: HISTORY_CHECKPOINT_SCHEMA,
				...(await historyCheckpointStore.list(input)),
			}),
	);

	server.registerTool(
		"opencut_restore_checkpoint",
		{
			description:
				"Restore a named checkpoint only through the current editor session's reconstructible native undo/redo stacks; rejects reloads and divergent history without rebuilding project data.",
			inputSchema: withProjectMutationSafety(
				restoreHistoryCheckpointInputSchema,
			),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_restore_checkpoint",
					params,
					async (context) => {
						const operationId = requiredOperationId(params.operationId);
						const currentIdentity = readConnectionIdentity(
							params.expectedConnectionIdentity,
						);
						if (!currentIdentity) {
							throw new Error(
								"checkpoint restore requires v2 connection identity",
							);
						}
						const checkpoint = await historyCheckpointStore.get(
							params.checkpointId,
						);
						if (!checkpoint) {
							return {
								status: "not-found",
								operationId,
								checkpointId: params.checkpointId,
							};
						}
						const history = await bridge.request("get_history_state", params);
						if (!isHistoryState(history)) return history;
						if (
							checkpoint.projectId !== params.projectId ||
							checkpoint.sceneId !== params.sceneId
						) {
							return historyDiverged(
								params,
								history,
								"checkpoint belongs to a different project or scene",
							);
						}
						if (
							checkpoint.connectionIdentity.editorInstanceId !==
								currentIdentity.editorInstanceId ||
							checkpoint.connectionIdentity.editorSessionId !==
								currentIdentity.editorSessionId
						) {
							return historyDiverged(
								params,
								history,
								"checkpoint native history belongs to a different editor session",
							);
						}
						const restored = await requestLedgeredBrowserMutation(
							context,
							bridge,
							"restore_history_state",
							{
								...params,
								expectedTargetProjectContentHash: checkpoint.contentHash,
								nativeHistory: checkpoint.nativeHistory,
							},
						);
						return isRecord(restored)
							? { ...restored, checkpointId: checkpoint.checkpointId }
							: restored;
					},
				),
			),
	);

	server.registerTool(
		"opencut_import_media",
		{
			description:
				"Import an image, audio file, or video from an absolute local path and place it automatically or on an explicit compatible track without a browser file picker. Project canvas and frame rate are preserved unless adoptMediaSettings is true.",
			inputSchema: withProjectMutationSafety(importMediaInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_import_media",
					input,
					async (context) => {
						const { path, ...params } = input;
						const ticket = await bridge.mediaTickets.create(path);
						const request = {
							...params,
							url: ticket.url,
							name: ticket.name,
							mimeType: ticket.mimeType,
							sourceFingerprint: ticket.sourceFingerprint,
						};
						return requestLedgeredBrowserMutation(
							context,
							bridge,
							"import_media",
							request,
						);
					},
				),
			),
	);

	server.registerTool(
		"opencut_import_subtitles",
		{
			description:
				"Import SRT, ASS, or WebVTT captions from an absolute local UTF-8 file onto a new text track without a browser file picker. Parsed ASS styling is preserved where OpenCut supports it, and an optional shared style can override imported styling.",
			inputSchema: withProjectMutationSafety(importSubtitlesInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_import_subtitles",
					input,
					(context) => subtitleImport.execute(input, context),
					(context) => subtitleImport.recover(input, context),
				),
			),
	);

	server.registerTool(
		"opencut_transcribe_timeline",
		{
			description:
				"Render the active timeline audio mix, transcribe it with OpenCut's local NVIDIA Parakeet worker, chunk the result into captions, and atomically insert a new text track. The first model use may load cached model files and can take several minutes.",
			inputSchema: withProjectMutationSafety(transcribeTimelineInputSchema),
		},
		async (input) => {
			const operationId = requiredOperationId(input.operationId);
			const jobId = `transcription:${operationId}`;
			await inlineJobs.start({
				jobId,
				jobType: "transcription",
				operationId,
				semanticInputHash: createHash("sha256")
					.update(stableSerialize(input))
					.digest("hex"),
				preconditions: {
					projectId: input.projectId,
					revision: input.expectedRevision,
				},
				input: input as unknown as Parameters<
					typeof inlineJobs.start
				>[0]["input"],
				progressUnits: "phases",
				phase: "transcribing",
			});
			try {
				const result = await ledgerBoundary.execute(
					"opencut_transcribe_timeline",
					input,
					(context) =>
						requestLedgeredBrowserMutation(
							context,
							bridge,
							"transcribe_timeline",
							input,
							2 * 60 * 60_000,
						),
				);
				const status =
					result && typeof result === "object" && "status" in result
						? String((result as { status: unknown }).status)
						: "unknown";
				if (status === "recoverable") {
					await inlineJobs.fail(
						jobId,
						"transcription outcome is unresolved",
						"recoverable",
					);
				} else {
					await inlineJobs.succeed(jobId, { status });
				}
				return toolResult(result);
			} catch (error) {
				await inlineJobs.fail(
					jobId,
					error instanceof Error ? error.message : "transcription failed",
				);
				throw error;
			}
		},
	);

	server.registerTool(
		"opencut_export_subtitles",
		{
			description:
				"Export caption text elements from all text tracks, or selected text tracks, to a new absolute local SRT or WebVTT file with a SHA-256 receipt.",
			inputSchema: withProjectMutationSafety(exportSubtitlesInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_export_subtitles",
					input,
					(context) =>
						executeSubtitleExport(bridge, subtitleFiles, input, context),
					(context) =>
						recoverSubtitleExport(bridge, subtitleFiles, input, context),
				),
			),
	);

	server.registerTool(
		"opencut_attach_matte",
		{
			description:
				"Attach a precomputed image or video foreground matte to a video clip. The artifact must match the source aspect ratio; video mattes must cover the full source duration. Use apply_edit_plan to enable, disable, or detach it.",
			inputSchema: withProjectMutationSafety(attachMatteInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_attach_matte",
					input,
					async (context) => {
						const { path, ...params } = input;
						const ticket = await bridge.mediaTickets.create(path);
						const request = {
							...params,
							url: ticket.url,
							name: ticket.name,
							mimeType: ticket.mimeType,
							artifactHash: ticket.contentHash,
							artifactFingerprint: ticket.sourceFingerprint,
						};
						return requestLedgeredBrowserMutation(
							context,
							bridge,
							"attach_matte",
							request,
						);
					},
				),
			),
	);

	server.registerTool(
		"opencut_generate_matte",
		{
			description:
				"Generate and attach a foreground matte for one video clip through the configured external provider. The source stays local, model provenance is persisted, and the current project revision is required.",
			inputSchema: withProjectMutationSafety(generateMatteInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_generate_matte",
					input,
					(context) =>
						matteGeneration.generate(
							input,
							observeProvider(context, input.operationId),
						),
					async (context) => {
						const artifact = retainedProviderArtifact(
							context,
							"matte-producer-command",
						);
						const channel = providerCheckpointChannel(context);
						return artifact && channel
							? matteGeneration.attachRecovered(
									input,
									{ ...artifact, channel },
									observeProvider(context, input.operationId),
								)
							: null;
					},
				),
			),
	);

	server.registerTool(
		"opencut_track_subject",
		{
			description:
				"Reserved subject-tracking execution surface. Returns MODEL_SELECTION_REQUIRED without provider execution until the owner approves an exact model identity, source, license, and artifact hash; persist external tracking data with opencut_create_media_analysis.",
			inputSchema: withProjectMutationSafety(trackSubjectInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_track_subject",
					input,
					async () =>
						modelSelectionRequired("opencut.task.subject-tracking.v1"),
					async () =>
						modelSelectionRequired("opencut.task.subject-tracking.v1"),
				),
			),
	);

	server.registerTool(
		"opencut_export_project",
		{
			description:
				"Render the verified persisted project readback with an optional immutable variant overlay to a new absolute local file, fully decode and probe it, extract hash-locked frame samples, and persist the requested overlay and resolved render specification for inspection.",
			inputSchema: withProjectMutationSafety(exportProjectInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_export_project",
					input,
					async (context) => {
						await context.checkpoint({
							checkpoint: operationCheckpoint(
								requiredOperationId(input.operationId),
								"filesystem",
								"prepared",
								{ outputPath: input.outputPath },
							),
						});
						const result = await projectExports.export(input);
						const receipt = await exportReceipts.get(input.operationId);
						if (receipt) {
							await context.checkpoint({
								phase: "verifying",
								checkpoint: operationCheckpoint(
									input.operationId,
									"filesystem",
									"verified",
									{
										receiptPath: exportReceipts.receiptPath(input.operationId),
									},
								),
							});
						}
						return result;
					},
					async (context) => {
						const receipt = await exportReceipts.get(input.operationId);
						if (!receipt) return null;
						await context.checkpoint({
							phase: "verifying",
							checkpoint: operationCheckpoint(
								requiredOperationId(input.operationId),
								"filesystem",
								"verified",
								{ receiptPath: exportReceipts.receiptPath(input.operationId) },
							),
						});
						return {
							...receipt.result,
							status: "replayed",
							replayed: true,
							inspection: receipt.inspection,
							receiptPath: exportReceipts.receiptPath(input.operationId),
						};
					},
				),
			),
	);

	server.registerTool(
		"opencut_queue_export",
		{
			description:
				"Persist an export job and run it automatically when an authenticated editor worker is connected. The job survives MCP restarts.",
			inputSchema: withProjectMutationSafety(queueExportInputSchema),
		},
		async (params) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_queue_export",
					params,
					(context) => executeQueueExport(exportJobs, params, context),
					(context) => recoverQueueExport(exportJobs, params, context),
				),
			),
	);

	server.registerTool(
		"opencut_queue_export_batch",
		{
			description:
				"Persist and enqueue a restart-safe matrix of platform-specific export variants. Each variant gets an independent durable job, immutable render overlay, validation receipt, resolved frame schedule, manifest entry, and output path.",
			inputSchema: withProjectMutationSafety(queueExportBatchInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_queue_export_batch",
					input,
					(context) =>
						executeQueueBatch(
							exportBatches,
							{ ...input, operationId: requiredOperationId(input.operationId) },
							context,
						),
					(context) =>
						recoverQueueBatch(
							exportBatches,
							{ ...input, operationId: requiredOperationId(input.operationId) },
							context,
						),
				),
			),
	);

	server.registerTool(
		"opencut_get_export_batch",
		{
			description:
				"Read one durable export batch with aggregate status and every variant job.",
			inputSchema: getExportBatchInputSchema,
		},
		async ({ batchId }) => {
			const summary = await exportBatches.get(batchId);
			return toolResult(
				summary
					? { status: "found", summary }
					: { status: "not-found", batchId },
			);
		},
	);

	server.registerTool(
		"opencut_list_export_batches",
		{
			description:
				"List durable platform export batches in descending creation order.",
			inputSchema: listExportBatchesInputSchema,
		},
		async ({ limit }) =>
			toolResult({ batches: await exportBatches.list(limit) }),
	);

	server.registerTool(
		"opencut_cancel_export_batch",
		{
			description:
				"Cancel every still-queued variant in one export batch. Running or terminal variants are preserved and reported.",
			inputSchema: cancelExportBatchInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_cancel_export_batch",
					input,
					(context) =>
						executeCancelBatch(
							exportBatches,
							{ ...input, operationId: requiredOperationId(input.operationId) },
							context,
						),
					(context) =>
						recoverCancelBatch(
							exportBatches,
							{ ...input, operationId: requiredOperationId(input.operationId) },
							context,
						),
				),
			),
	);

	server.registerTool(
		"opencut_get_export_job",
		{
			description: "Read the latest durable state of one export job.",
			inputSchema: getExportJobInputSchema,
		},
		async ({ jobId }) => {
			const job = await exportJobs.get(jobId);
			return toolResult(
				job ? { status: "found", job } : { status: "not-found", jobId },
			);
		},
	);

	server.registerTool(
		"opencut_list_export_jobs",
		{
			description: "List durable export jobs, optionally filtered by status.",
			inputSchema: listExportJobsInputSchema,
		},
		async (input) => toolResult({ jobs: await exportJobs.list(input) }),
	);

	server.registerTool(
		"opencut_cancel_export_job",
		{
			description:
				"Cancel a queued or running export job. A running renderer observes the signal through its export ticket within about 250 ms and the job reports cancelling until the renderer confirms it stopped; no output file is written for a cancelled render.",
			inputSchema: cancelExportJobInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_cancel_export_job",
					input,
					(context) =>
						executeCancelJob(
							exportJobs,
							{ ...input, operationId: requiredOperationId(input.operationId) },
							context,
						),
					(context) =>
						recoverCancelJob(
							exportJobs,
							{ ...input, operationId: requiredOperationId(input.operationId) },
							context,
						),
				),
			),
	);

	server.registerTool(
		"opencut_run_export_jobs",
		{
			description:
				"Run queued export jobs now through the connected editor worker, up to the requested limit.",
			inputSchema: runExportJobsInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_run_export_jobs",
					input,
					(context) =>
						executeRunExportJobs(
							exportJobs,
							bridge.getStatus().connected,
							{
								operationId: requiredOperationId(input.operationId),
								limit: input.limit,
							},
							context,
						),
					(context) =>
						recoverRunExportJobs(
							exportJobs,
							{
								operationId: requiredOperationId(input.operationId),
								limit: input.limit,
							},
							context,
						),
				),
			),
	);

	server.registerTool(
		"opencut_get_job",
		{
			description:
				"Read one job from the unified durable job store (export, preview range, comparison, transcription, provider, QC, packaging) with its attempt history, progress, lease, cancellation, diagnostics, and artifacts.",
			inputSchema: getJobInputSchema,
		},
		async ({ jobId, includeHistory }) => {
			const job = await jobService.get(jobId);
			return toolResult(
				job
					? {
							status: "found",
							job,
							...(includeHistory
								? { history: await jobService.history(jobId) }
								: {}),
						}
					: { status: "not-found", jobId },
			);
		},
	);

	server.registerTool(
		"opencut_list_jobs",
		{
			description:
				"List jobs in the unified durable job store, optionally filtered by type, state, and project, newest first, together with the queue depth and the job holding the compositor lease.",
			inputSchema: listJobsInputSchema,
		},
		async (input) => {
			const summary = await jobService.summary();
			return toolResult({
				jobs: await jobService.list(input),
				queue: {
					depth: summary.depth,
					running: summary.running,
					counts: summary.counts,
					byType: summary.byType,
					recoveryRequired: summary.recoveryRequired,
				},
			});
		},
	);

	server.registerTool(
		"opencut_cancel_job",
		{
			description:
				"Cancel any job by id. Queued jobs cancel immediately; running exports, previews, comparisons, and providers observe the signal within their declared bound and report cancelling until they confirm. Terminal jobs are unchanged, so the call is idempotent.",
			inputSchema: cancelJobInputSchema,
		},
		async (input) =>
			toolResult(
				await jobToolResult(() =>
					ledgerBoundary.execute(
						"opencut_cancel_job",
						input,
						(context) =>
							executeCancelUnifiedJob(
								jobService,
								{
									...input,
									operationId: requiredOperationId(input.operationId),
								},
								context,
							),
						(context) =>
							recoverCancelUnifiedJob(
								jobService,
								{
									...input,
									operationId: requiredOperationId(input.operationId),
								},
								context,
							),
					),
				),
			),
	);

	server.registerTool(
		"opencut_retry_job",
		{
			description:
				"Explicitly retry a failed export or provider job as a new attempt under the same job id, within its attempt policy. Attempt history is preserved.",
			inputSchema: retryJobInputSchema,
		},
		async (input) =>
			toolResult(
				await jobToolResult(() =>
					ledgerBoundary.execute(
						"opencut_retry_job",
						input,
						(context) =>
							executeRetryJob(
								jobService,
								{
									...input,
									operationId: requiredOperationId(input.operationId),
								},
								context,
							),
						(context) =>
							recoverRetryJob(
								jobService,
								{
									...input,
									operationId: requiredOperationId(input.operationId),
								},
								context,
							),
					),
				),
			),
	);

	server.registerTool(
		"opencut_resolve_job",
		{
			description:
				"Resolve a job in recovery-required (its owner died before publishing an outcome): rerun-as-new-attempt requeues it under the same job id after quarantining any partial output, mark-failed terminalizes it. The original attempt history is preserved.",
			inputSchema: resolveJobInputSchema,
		},
		async (input) =>
			toolResult(
				await jobToolResult(() =>
					ledgerBoundary.execute(
						"opencut_resolve_job",
						input,
						(context) =>
							executeResolveJob(
								jobService,
								{
									...input,
									operationId: requiredOperationId(input.operationId),
								},
								context,
							),
						(context) =>
							recoverResolveJob(
								jobService,
								{
									...input,
									operationId: requiredOperationId(input.operationId),
								},
								context,
							),
					),
				),
			),
	);

	server.registerTool(
		"opencut_get_export_receipt",
		{
			description:
				"Read a durable export validation and watermark-inspection receipt by operation ID.",
			inputSchema: getExportReceiptInputSchema,
		},
		async ({ operationId }) => {
			const receipt = await exportReceipts.get(operationId);
			return toolResult(
				receipt
					? {
							status: "found",
							receiptPath: exportReceipts.receiptPath(operationId),
							receipt,
						}
					: { status: "not-found", operationId },
			);
		},
	);

	server.registerTool(
		"opencut_create_review_annotation",
		{
			description:
				"Create an immutable structured review annotation tied to hash-locked evidence.",
			inputSchema: createReviewAnnotationInputSchema,
		},
		async (input) =>
			toolResult(
				await reviewMutationResult(() =>
					ledgerBoundary.execute(
						"opencut_create_review_annotation",
						input,
						() => reviewEvidence.createAnnotation(input),
						() => reviewEvidence.createAnnotation(input),
					),
				),
			),
	);

	server.registerTool(
		"opencut_get_review_annotation",
		{
			description:
				"Read one checksum-verified immutable review annotation version.",
			inputSchema: getReviewAnnotationInputSchema,
		},
		async ({ annotationId, version }) => {
			return toolResult(
				await reviewReadResult(async () => {
					const annotation = await reviewEvidence.getAnnotation(
						annotationId,
						version,
					);
					return annotation
						? { status: "found", annotation }
						: { status: "not-found", annotationId, version: version ?? null };
				}),
			);
		},
	);

	server.registerTool(
		"opencut_list_review_annotations",
		{
			description:
				"List checksum-verified review annotation versions with bounded pagination.",
			inputSchema: listReviewAnnotationsInputSchema,
		},
		async (input) =>
			toolResult(
				await reviewReadResult(async () => ({
					status: "listed",
					...(await reviewEvidence.listAnnotations(input)),
				})),
			),
	);

	server.registerTool(
		"opencut_update_review_annotation_status",
		{
			description: "Append an immutable status version to a review annotation.",
			inputSchema: updateReviewAnnotationStatusInputSchema,
		},
		async (input) =>
			toolResult(
				await reviewMutationResult(() =>
					ledgerBoundary.execute(
						"opencut_update_review_annotation_status",
						input,
						() => reviewEvidence.updateAnnotationStatus(input),
						() => reviewEvidence.updateAnnotationStatus(input),
					),
				),
			),
	);

	server.registerTool(
		"opencut_record_watermark_inspection",
		{
			description:
				"Record a declared opening, middle, ending, four-corner, and final-export-byte watermark inspection.",
			inputSchema: recordWatermarkInspectionInputSchema,
		},
		async (input) =>
			toolResult(
				await reviewMutationResult(() =>
					ledgerBoundary.execute(
						"opencut_record_watermark_inspection",
						input,
						() => reviewEvidence.recordWatermarkInspection(input),
						() => reviewEvidence.recordWatermarkInspection(input),
					),
				),
			),
	);

	server.registerTool(
		"opencut_get_watermark_inspection",
		{
			description: "Read a checksum-verified immutable watermark inspection.",
			inputSchema: getWatermarkInspectionInputSchema,
		},
		async ({ inspectionId }) => {
			return toolResult(
				await reviewReadResult(async () => {
					const inspection =
						await reviewEvidence.getWatermarkInspection(inspectionId);
					return inspection
						? { status: "found", inspection }
						: { status: "not-found", inspectionId };
				}),
			);
		},
	);

	server.registerTool(
		"opencut_sign_off_export_review",
		{
			description:
				"Record human final sign-off only after complete watermark and blocking-finding checks.",
			inputSchema: signOffExportReviewInputSchema,
		},
		async (input) =>
			toolResult(
				await reviewMutationResult(() =>
					ledgerBoundary.execute(
						"opencut_sign_off_export_review",
						input,
						() => reviewEvidence.signOffExportReview(input),
						() => reviewEvidence.signOffExportReview(input),
					),
				),
			),
	);

	server.registerTool(
		"opencut_evaluate_export_qc",
		{
			description:
				"Evaluate a durable export receipt against an explicit versioned QC policy. Returns pass, warn, or fail for every container, video, caption, audio, inspection, hash, and platform check with measured evidence.",
			inputSchema: withMutationOperationId(evaluateExportQcInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_evaluate_export_qc",
					input,
					() => exportQc.evaluate(input),
					() => exportQc.evaluate(input),
				),
			),
	);

	server.registerTool(
		"opencut_get_export_qc",
		{
			description:
				"Read a durable structured export QC report and verify all referenced output and evidence hashes.",
			inputSchema: getExportQcInputSchema,
		},
		async ({ operationId }) => {
			const report = await exportQc.get(operationId);
			return toolResult(
				report
					? {
							status: "found",
							reportPath: exportQc.reportPath(operationId),
							report: await exportQc.verify(operationId),
						}
					: { status: "not-found", operationId },
			);
		},
	);

	server.registerTool(
		"opencut_create_delivery_package",
		{
			description:
				"Create a deterministic collision-safe delivery directory containing a master, clean and burned-in variants, sidecars, exact covers, inspection evidence, export receipts, QC reports, and a hash/provenance manifest.",
			inputSchema: withMutationOperationId(createDeliveryPackageInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_create_delivery_package",
					input,
					() => deliveryPackages.create(input),
					() => deliveryPackages.create(input),
				),
			),
	);

	server.registerTool(
		"opencut_verify_delivery_package",
		{
			description:
				"Re-read a durable delivery manifest and fail if the manifest or any packaged media, sidecar, cover, receipt, QC report, or evidence file is missing or changed.",
			inputSchema: verifyDeliveryPackageInputSchema,
		},
		async ({ operationId }) =>
			toolResult(await deliveryPackages.verify(operationId)),
	);

	server.registerTool(
		"opencut_record_export_inspection",
		{
			description:
				"Record a completed human or vision review of the hash-locked export frame samples. Use verified-clean only after inspecting the opening, middle, and ending full frames including all four corners.",
			inputSchema: recordExportInspectionInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_record_export_inspection",
					input,
					(context) =>
						executeRecordInspection(
							exportReceipts,
							{
								...input,
								inspectionOperationId: requiredOperationId(
									input.inspectionOperationId,
								),
							},
							context,
						),
					(context) =>
						recoverRecordInspection(
							exportReceipts,
							{
								...input,
								inspectionOperationId: requiredOperationId(
									input.inspectionOperationId,
								),
							},
							context,
						),
				),
			),
	);

	server.registerTool(
		"opencut_transcribe_source",
		{
			description:
				"Transcribe one uploaded audio or video source with the configured local NVIDIA Parakeet workflow. The model runs offline with fallback disabled and produces durable word IDs, source/timeline mappings, and hash-pinned provenance.",
			inputSchema: transcribeSourceInputSchema,
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_transcribe_source",
					input,
					() => transcripts.transcribe(input),
					() => transcripts.transcribe(input),
				),
			),
	);

	server.registerTool(
		"opencut_get_transcript",
		{
			description:
				"Read one immutable transcript version, verifying its durable content hash and Parakeet provider artifacts.",
			inputSchema: getTranscriptInputSchema,
		},
		async ({ transcriptId, version }) => {
			const transcript = await transcripts.get(transcriptId, version);
			return toolResult(
				transcript
					? { status: "found", transcript }
					: { status: "not-found", transcriptId, version: version ?? null },
			);
		},
	);

	server.registerTool(
		"opencut_list_transcripts",
		{
			description:
				"List the latest durable transcripts, optionally scoped to a project.",
			inputSchema: listTranscriptsInputSchema,
		},
		async ({ projectId, limit }) =>
			toolResult({
				status: "listed",
				transcripts: (await transcriptStore.list(projectId)).slice(0, limit),
			}),
	);

	server.registerTool(
		"opencut_search_transcript",
		{
			description:
				"Search a transcript with bounded results and stable word-range selectors suitable for preview and edit-plan preflight.",
			inputSchema: searchTranscriptInputSchema,
		},
		async (input) =>
			toolResult({
				status: "found",
				matches: await transcripts.search(input),
			}),
	);

	server.registerTool(
		"opencut_correct_transcript",
		{
			description:
				"Append a durable transcript correction while retaining original recognition. Caption propagation occurs only under the explicit propagate-linked-captions policy and returns reviewable edit operations.",
			inputSchema: withMutationOperationId(correctTranscriptInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_correct_transcript",
					input,
					() => transcripts.correct(input),
					() => transcripts.correct(input),
				),
			),
	);

	server.registerTool(
		"opencut_analyze_speech",
		{
			description:
				"Derive durable speech and silence ranges from Parakeet word activity using typed confidence, duration, padding, channel, and range parameters.",
			inputSchema: withMutationOperationId(analyzeSpeechInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_analyze_speech",
					input,
					() => speechAnalysis.analyze(input),
					() => speechAnalysis.analyze(input),
				),
			),
	);

	server.registerTool(
		"opencut_get_speech_analysis",
		{
			description:
				"Read one hash-verified speech/silence analysis and revalidate its transcript evidence binding.",
			inputSchema: getSpeechAnalysisInputSchema,
		},
		async ({ analysisId }) => {
			const analysis = await speechAnalysis.get(analysisId);
			return toolResult(
				analysis
					? { status: "found", analysis }
					: { status: "not-found", analysisId },
			);
		},
	);

	server.registerTool(
		"opencut_create_editorial_decision",
		{
			description:
				"Create an immutable editorial decision from stable transcript words or analyzed silence. The returned deterministic edit operations are a dry-run cut plan; pass them through opencut_preflight_edit_plan before atomic apply.",
			inputSchema: withMutationOperationId(createEditorialDecisionInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_create_editorial_decision",
					input,
					() => editorialDecisions.create(input),
					() => editorialDecisions.create(input),
				),
			),
	);

	server.registerTool(
		"opencut_get_editorial_decision",
		{
			description:
				"Read one hash-verified editorial decision and its exact transcript/analysis evidence bindings.",
			inputSchema: getEditorialDecisionInputSchema,
		},
		async ({ decisionId }) => {
			const decision = await editorialDecisions.get(decisionId);
			return toolResult(
				decision
					? { status: "found", decision }
					: { status: "not-found", decisionId },
			);
		},
	);

	server.registerTool(
		"opencut_list_editorial_decisions",
		{
			description:
				"List durable editorial decisions, optionally scoped to one project.",
			inputSchema: listEditorialDecisionsInputSchema,
		},
		async ({ projectId, limit }) =>
			toolResult({
				status: "listed",
				decisions: (await editorialDecisions.list(projectId)).slice(0, limit),
			}),
	);

	server.registerTool(
		"opencut_diff_editorial_decision",
		{
			description:
				"Compare a durable decision's source revision/hash with the current project binding before reapply or preflight.",
			inputSchema: diffEditorialDecisionInputSchema,
		},
		async (input) => toolResult(await editorialDecisions.diff(input)),
	);

	server.registerTool(
		"opencut_reapply_editorial_decision",
		{
			description:
				"Create a new immutable decision derived from an earlier one and rebound to an explicitly supplied current revision/hash. The new operations still require edit-plan preflight.",
			inputSchema: withMutationOperationId(reapplyEditorialDecisionInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_reapply_editorial_decision",
					input,
					() => editorialDecisions.reapply(input),
					() => editorialDecisions.reapply(input),
				),
			),
	);

	server.registerTool(
		"opencut_export_editorial_decision_json",
		{
			description:
				"Export a durable decision as strict, versioned, hash-protected OpenCut editorial-decision JSON. Refuses to overwrite an existing file.",
			inputSchema: withMutationOperationId(exportEditorialDecisionInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_export_editorial_decision_json",
					input,
					() =>
						editorialDecisions.exportJson(input.decisionId, input.outputPath),
				),
			),
	);

	server.registerTool(
		"opencut_import_editorial_decision_json",
		{
			description:
				"Import strict OpenCut editorial-decision v1 JSON losslessly, verifying interchange, decision, transcript, and analysis hashes.",
			inputSchema: withMutationOperationId(importEditorialDecisionInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_import_editorial_decision_json",
					input,
					() => editorialDecisions.importJson(input.path),
					() => editorialDecisions.importJson(input.path),
				),
			),
	);

	return server;
}

const handle = serveStdio(createServer);
console.error(
	`OpenCut MCP server listening for the editor on 127.0.0.1:${port}`,
);

let shutdownPromise: Promise<void> | null = null;

function shutdown(): Promise<void> {
	shutdownPromise ??= (async () => {
		exportJobs.stop();
		await editorWorker.stop();
		bridge.stop();
		operationLedger.close();
		historyCheckpointStore.close();
		previewEvidence.close();
		editPlanPreflightStore.close();
		await handle.close();
	})();
	return shutdownPromise;
}

function shutdownAndExit(): void {
	void shutdown().then(
		() => process.exit(0),
		(error) => {
			console.error(
				"[opencut-mcp] shutdown failed:",
				error instanceof Error ? (error.stack ?? error.message) : String(error),
			);
			process.exit(1);
		},
	);
}

process.once("SIGINT", shutdownAndExit);
process.once("SIGTERM", shutdownAndExit);
process.stdin.once("end", shutdownAndExit);

function toolResult(value: unknown) {
	const status = bridge.getStatus();
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: { value };
	const resultIdentity = readConnectionIdentity(record.connectionIdentity);
	const enriched = {
		...record,
		serverInstanceId:
			resultIdentity?.serverInstanceId ?? status.serverInstanceId,
		bridgeProtocolVersion:
			typeof record.bridgeProtocolVersion === "number"
				? record.bridgeProtocolVersion
				: typeof record.negotiatedProtocolVersion === "number"
					? record.negotiatedProtocolVersion
					: null,
		connectionIdentity: resultIdentity,
	};
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(enriched, null, 2) },
		],
	};
}

function modelSelectionRequired(taskId: string) {
	return {
		...getMediaExecutionBlocker(taskId),
		affectedObjects: [] as [],
	};
}

type BrowserHistoryState = {
	status: "history-state";
	projectId: string;
	sceneId: string;
	revision: number;
	contentHash: string;
	contentHashProjectionVersion: 1 | 2 | 3;
	nativeHistory: HistoryCheckpointRecord["nativeHistory"];
};

function isHistoryState(value: unknown): value is BrowserHistoryState {
	if (!isRecord(value) || value.status !== "history-state") return false;
	return (
		typeof value.projectId === "string" &&
		typeof value.sceneId === "string" &&
		Number.isSafeInteger(value.revision) &&
		typeof value.contentHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.contentHash) &&
		(value.contentHashProjectionVersion === 1 ||
			value.contentHashProjectionVersion === 2 ||
			value.contentHashProjectionVersion === 3) &&
		isRecord(value.nativeHistory) &&
		Array.isArray(value.nativeHistory.history) &&
		Array.isArray(value.nativeHistory.redo) &&
		value.nativeHistory.pending === null
	);
}

function historyCheckpointCreated(checkpoint: HistoryCheckpointRecord) {
	return {
		status: "checkpoint-created" as const,
		operationId: checkpoint.operationId,
		checkpointId: checkpoint.checkpointId,
		projectId: checkpoint.projectId,
		sceneId: checkpoint.sceneId,
		revision: checkpoint.revision,
		contentHash: checkpoint.contentHash,
		contentHashProjectionVersion: checkpoint.contentHashProjectionVersion,
		checkpoint,
		affectedObjects: [
			{
				objectType: "checkpoint" as const,
				objectId: checkpoint.checkpointId,
				action: "created" as const,
			},
		],
	};
}

function historyDiverged(
	params: {
		operationId?: string;
		checkpointId: string;
	},
	history: BrowserHistoryState,
	reason: string,
) {
	return {
		status: "history-diverged" as const,
		operationId: requiredOperationId(params.operationId),
		checkpointId: params.checkpointId,
		reason,
		revision: history.revision,
		contentIdentity: {
			status: "hashed" as const,
			hash: {
				algorithm: "SHA-256" as const,
				projectionVersion: history.contentHashProjectionVersion,
				digest: history.contentHash,
			},
		},
		nativeHistory: history.nativeHistory,
	};
}

function operationCheckpoint(
	checkpointId: string,
	kind: "editor" | "provider" | "filesystem" | "job" | "save",
	state: "prepared" | "committed" | "verified",
	metadata: Record<string, JsonValue>,
) {
	return {
		checkpointId,
		kind,
		state,
		recordedAt: new Date().toISOString(),
		metadata,
	};
}

/**
 * Job tool failures that are the caller's to fix (unknown job, illegal
 * transition, exhausted attempts) are returned as structured rejections
 * rather than thrown, so the ledger records the outcome and the agent can act.
 */
async function jobToolResult(run: () => Promise<unknown>): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof JobServiceError) {
			return { status: "rejected", code: error.code, reason: error.message };
		}
		throw error;
	}
}

async function reviewMutationResult(
	run: () => Promise<unknown>,
): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof OperationLedgerReuseError) {
			return {
				status: "rejected",
				code: error.code,
				operationId: error.operationId,
				reason: error.message,
			};
		}
		throw error;
	}
}

async function reviewReadResult(run: () => Promise<unknown>): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof ReviewEvidenceIntegrityError) {
			return {
				status: "integrity-failed",
				code: error.code,
				reason: error.message,
			};
		}
		throw error;
	}
}

function requiredOperationId(value: string | undefined): string {
	if (!value) throw new Error("operationId is required for mutations");
	return value;
}

async function assertSaveReceiptEditorAffinity(input: {
	saveReceiptOperationId: string;
	expectedConnectionIdentity: BridgeConnectionIdentity;
}): Promise<void> {
	const candidates = [
		input.saveReceiptOperationId,
		...(input.saveReceiptOperationId.endsWith(":ledger-save")
			? [input.saveReceiptOperationId.slice(0, -":ledger-save".length)]
			: []),
	];
	let affinity: { editorInstanceId: string } | null = null;
	for (const operationId of candidates) {
		const entry = await operationLedger.get(operationId);
		if (entry?.record.connectionAffinity) {
			affinity = entry.record.connectionAffinity;
			break;
		}
	}
	if (
		!affinity ||
		affinity.editorInstanceId !==
			input.expectedConnectionIdentity.editorInstanceId
	) {
		throw new Error(
			"save receipt was not produced by the durable editor instance targeted for rendering",
		);
	}
}

function observeProvider(
	context: OperationExecutionContext,
	operationId: string,
): CompositeOperationObserver {
	return async (event: CompositeProviderEvent) => {
		await context.checkpoint({
			checkpoint: operationCheckpoint(operationId, "provider", event.state, {
				provider: event.provider,
				...(event.metadata ?? {}),
			}),
			providerProvenance: [
				{
					provider: event.provider,
					...(event.modelId ? { modelId: event.modelId } : {}),
					...(event.modelVersion ? { modelVersion: event.modelVersion } : {}),
					...(event.artifact ? { artifactHash: event.artifact.sha256 } : {}),
					...(event.metadata
						? {
								metadata: parseJsonValue(event.metadata) as Record<
									string,
									JsonValue
								>,
							}
						: {}),
				},
			],
			...(event.artifact
				? {
						artifacts: [
							{
								artifactId: event.artifact.sha256,
								kind: "provider-output" as const,
								state:
									event.state === "verified"
										? ("verified" as const)
										: ("created" as const),
								sha256: event.artifact.sha256,
								bytes: event.artifact.bytes ?? null,
								path: event.artifact.path ?? null,
								mimeType: event.artifact.mimeType ?? null,
							},
						],
					}
				: {}),
		});
	};
}

function retainedProviderArtifact(
	context: OperationExecutionContext,
	provider: string,
): {
	path: string;
	sha256: string;
	modelId: string;
	modelVersion: string;
} | null {
	const record = context.record();
	const artifact = record.artifacts.find(
		(candidate) =>
			candidate.kind === "provider-output" &&
			candidate.path !== null &&
			candidate.sha256 !== null,
	);
	const provenance = record.providerProvenance.find(
		(candidate) => candidate.provider === provider,
	);
	return artifact && provenance?.modelId && provenance.modelVersion
		? {
				path: artifact.path!,
				sha256: artifact.sha256!,
				modelId: provenance.modelId,
				modelVersion: provenance.modelVersion,
			}
		: null;
}

function providerCheckpointChannel(
	context: OperationExecutionContext,
): "alpha" | "red" | null {
	for (const checkpoint of context.record().checkpoints) {
		const channel = checkpoint.metadata.channel;
		if (channel === "alpha" || channel === "red") return channel;
	}
	return null;
}

async function runProjectOperation({
	method,
	input,
}: {
	method: "create_project" | "open_project";
	input: { operationId: string } & Record<string, unknown>;
}): Promise<unknown> {
	const fingerprint = JSON.stringify([method, input]);
	const prior = completedProjectOperations.get(input.operationId);
	if (prior) {
		if (prior.fingerprint !== fingerprint) {
			throw new Error(
				"operationId was already used for a different project operation",
			);
		}
		return { ...prior.result, status: "replayed" };
	}

	const result = await bridge.request(method, input);
	if (isActivatedProject(result)) {
		completedProjectOperations.set(input.operationId, {
			fingerprint,
			result: { ...result },
		});
	}
	return result;
}

function parsePort(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
		throw new Error(
			"OPENCUT_BRIDGE_PORT must be an integer from 1024 through 65535",
		);
	}
	return parsed;
}

function isSerializedSubtitles(value: unknown): value is {
	status: "serialized";
	projectId: string;
	sceneId: string;
	revision: number;
	format: "srt" | "vtt" | "ass";
	trackIds: string[];
	cueCount: number;
	content: string;
	bridgeProtocolVersion?: 1 | 2;
	connectionIdentity?: BridgeConnectionIdentity;
	requestConnectionIdentity?: BridgeConnectionIdentity;
	contentIdentity?: unknown;
} {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.status === "serialized" &&
		typeof record.projectId === "string" &&
		typeof record.sceneId === "string" &&
		typeof record.revision === "number" &&
		(record.format === "srt" ||
			record.format === "vtt" ||
			record.format === "ass") &&
		Array.isArray(record.trackIds) &&
		typeof record.cueCount === "number" &&
		typeof record.content === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConnectionIdentity(
	value: unknown,
): BridgeConnectionIdentity | null {
	if (!isRecord(value)) return null;
	return typeof value.serverInstanceId === "string" &&
		typeof value.editorInstanceId === "string" &&
		typeof value.editorSessionId === "string" &&
		typeof value.connectionGeneration === "number"
		? (value as unknown as BridgeConnectionIdentity)
		: null;
}

function expectedV2Identity(input: {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
}): BridgeConnectionIdentity | undefined {
	if (input.bridgeProtocolVersion !== 2) return undefined;
	if (!input.expectedConnectionIdentity) {
		throw new Error("bridge protocol v2 requires expectedConnectionIdentity");
	}
	return input.expectedConnectionIdentity;
}

function bridgeProtocolContext(input: {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
}): {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
} {
	return {
		...(input.bridgeProtocolVersion !== undefined
			? { bridgeProtocolVersion: input.bridgeProtocolVersion }
			: {}),
		...(input.expectedConnectionIdentity
			? { expectedConnectionIdentity: input.expectedConnectionIdentity }
			: {}),
	};
}

function isActivatedProject(
	value: unknown,
): value is Record<string, unknown> & { status: "created" | "opened" } {
	if (!value || typeof value !== "object") return false;
	const status = (value as Record<string, unknown>).status;
	return status === "created" || status === "opened";
}

interface AudioAnalysisRecord {
	integratedLufs: number | null;
	estimatedTruePeakDbtp: number | null;
	minimumGainDb: number;
	maximumGainDb: number;
	[key: string]: unknown;
}

function isAnalyzedAudio(value: unknown): value is Record<string, unknown> & {
	status: "analyzed";
	analysis: AudioAnalysisRecord;
} {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.status !== "analyzed" || !record.analysis) return false;
	const analysis = record.analysis as Record<string, unknown>;
	return (
		(analysis.integratedLufs === null ||
			typeof analysis.integratedLufs === "number") &&
		(analysis.estimatedTruePeakDbtp === null ||
			typeof analysis.estimatedTruePeakDbtp === "number") &&
		typeof analysis.minimumGainDb === "number" &&
		typeof analysis.maximumGainDb === "number"
	);
}

function isAppliedMutation(value: unknown): value is Record<string, unknown> & {
	status: "applied" | "replayed";
	revision: number;
} {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		(record.status === "applied" || record.status === "replayed") &&
		typeof record.revision === "number"
	);
}
