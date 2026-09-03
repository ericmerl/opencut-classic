import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { join } from "node:path";
import { EditorBridge, type BridgeConnectionIdentity } from "./editor-bridge";
import { AudioCleanupService } from "./clean-audio";
import { CapabilitySnapshotService } from "./capability-snapshot";
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
import { MatteGenerationService } from "./generate-matte";
import { ManagedEditorWorker } from "./managed-editor-worker";
import { NormalizeAudioOperation } from "./normalize-audio-operation";
import { SubtitleFiles } from "./subtitle-files";
import { SubtitleImportOperation } from "./subtitle-import-operation";
import { SubjectTrackingService } from "./track-subject";
import { OperationLedger } from "./operation-ledger";
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
	editPlanInputSchema,
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
	importMediaInputSchema,
	importSubtitlesInputSchema,
	listExportJobsInputSchema,
	listExportBatchesInputSchema,
	normalizeAudioInputSchema,
	exportSubtitlesInputSchema,
	openProjectInputSchema,
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
	runExportJobsInputSchema,
	searchStickersInputSchema,
	startEditorWorkerInputSchema,
	stopEditorWorkerInputSchema,
	syncAudioInputSchema,
	timelineQueryInputSchema,
	trackSubjectInputSchema,
	transcribeTimelineInputSchema,
	withConnectionAffinity,
	withMutationOperationId,
	withProjectMutationSafety,
	undoInputSchema,
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
const normalizeAudio = new NormalizeAudioOperation(bridge);
const audioCleanup = new AudioCleanupService(
	bridge,
	undefined,
	join(exportReceipts.directory, "provider-operations", "audio-cleanup"),
	jobStoreDirectory,
);
const exportValidator = new ExportValidator(exportReceipts);
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
const subjectTracking = new SubjectTrackingService(
	bridge,
	undefined,
	join(
		exportReceipts.directory,
		"provider-operations",
		"subject-tracking",
		"provider-results",
	),
	jobStoreDirectory,
);
const operationLedger = new OperationLedger(
	process.env.OPENCUT_OPERATION_LEDGER_DIR ??
		join(exportReceipts.directory, "operation-ledger"),
);
await operationLedger.readiness();
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
				await ledgerBoundary.execute("opencut_start_editor_worker", input, () =>
					editorWorker.ensureConnected(input.projectId),
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
				await ledgerBoundary.execute("opencut_stop_editor_worker", input, () =>
					editorWorker.stop(),
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
				"Validate and deterministically expand a complete edit plan against a verified saved project without changing editor, playback, history, or persistence state.",
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
				"Clean the complete uploaded source audio through the configured external provider and attach the result non-destructively to the selected audio or video clip. Existing trim, retime, fades, ducking, mute, and volume automation remain on the clip.",
			inputSchema: withProjectMutationSafety(cleanAudioInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_clean_audio",
					input,
					(context) =>
						audioCleanup.clean(
							input,
							observeProvider(context, input.operationId),
						),
					async (context) => {
						const artifact = retainedProviderArtifact(
							context,
							"audio-cleaner-command",
						);
						return artifact
							? audioCleanup.attachRecovered(
									input,
									artifact,
									observeProvider(context, input.operationId),
								)
							: null;
					},
				),
			),
	);

	server.registerTool(
		"opencut_apply_edit_plan",
		{
			description:
				"Apply a previously validated edit plan atomically. Bridge protocol v2 requires the immutable receipt returned by opencut_preflight_edit_plan; receipt-less v2 requests are rejected without mutation.",
			inputSchema: withProjectMutationSafety(editPlanInputSchema),
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
		"opencut_undo",
		{
			description:
				"Undo one OpenCut command after checking the current revision.",
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
				"Render the active timeline audio mix, transcribe it with OpenCut's local Whisper worker, chunk the result into captions, and atomically insert a new text track. The first model use may download model files and can take several minutes.",
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
				"Track a subject through a video clip with the configured local provider, map source samples through trim and retime, smooth the motion, and atomically create focal-point or crop reframe keyframes.",
			inputSchema: withProjectMutationSafety(trackSubjectInputSchema),
		},
		async (input) =>
			toolResult(
				await ledgerBoundary.execute(
					"opencut_track_subject",
					input,
					(context) =>
						subjectTracking.track(
							input,
							observeProvider(context, input.operationId),
						),
					async (context) => {
						const recovery = retainedTrackingRecovery(context);
						return recovery
							? subjectTracking.applyRecovered(
									input,
									recovery,
									observeProvider(context, input.operationId),
								)
							: null;
					},
				),
			),
	);

	server.registerTool(
		"opencut_export_project",
		{
			description:
				"Render the active project to a new absolute local file, fully decode and probe it, extract hash-locked opening, middle, and ending frame samples, and persist a durable receipt for watermark inspection.",
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
				"Persist and enqueue a restart-safe matrix of platform-specific export variants. Each variant gets an independent durable job, validation receipt, canvas override, and output path.",
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
								{ ...input, operationId: requiredOperationId(input.operationId) },
								context,
							),
						(context) =>
							recoverCancelUnifiedJob(
								jobService,
								{ ...input, operationId: requiredOperationId(input.operationId) },
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
								{ ...input, operationId: requiredOperationId(input.operationId) },
								context,
							),
						(context) =>
							recoverRetryJob(
								jobService,
								{ ...input, operationId: requiredOperationId(input.operationId) },
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
								{ ...input, operationId: requiredOperationId(input.operationId) },
								context,
							),
						(context) =>
							recoverResolveJob(
								jobService,
								{ ...input, operationId: requiredOperationId(input.operationId) },
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

	return server;
}

const handle = serveStdio(createServer);
console.error(
	`OpenCut MCP server listening for the editor on 127.0.0.1:${port}`,
);

function shutdown(): void {
	exportJobs.stop();
	void editorWorker.stop();
	bridge.stop();
	operationLedger.close();
	previewEvidence.close();
	editPlanPreflightStore.close();
	void handle.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
async function jobToolResult(
	run: () => Promise<unknown>,
): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof JobServiceError) {
			return { status: "rejected", code: error.code, reason: error.message };
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

function retainedTrackingRecovery(context: OperationExecutionContext): {
	samples: Array<{
		sourceTime: number;
		box: { x: number; y: number; width: number; height: number };
		confidence?: number;
	}>;
	modelId: string;
	modelVersion: string;
} | null {
	const checkpoint = context
		.record()
		.checkpoints.find(
			(candidate) =>
				candidate.kind === "provider" &&
				Array.isArray(candidate.metadata.samples),
		);
	const provenance = context
		.record()
		.providerProvenance.find(
			(candidate) => candidate.provider === "subject-tracker-command",
		);
	if (
		!checkpoint ||
		!provenance?.modelId ||
		!provenance.modelVersion ||
		!Array.isArray(checkpoint.metadata.samples)
	)
		return null;
	const samples = checkpoint.metadata.samples.map(parseTrackingSample);
	return samples.every((sample) => sample !== null)
		? {
				samples: samples as NonNullable<(typeof samples)[number]>[],
				modelId: provenance.modelId,
				modelVersion: provenance.modelVersion,
			}
		: null;
}

function parseTrackingSample(value: JsonValue) {
	if (!isRecord(value) || !isRecord(value.box)) return null;
	const box = value.box;
	if (
		typeof value.sourceTime !== "number" ||
		!Number.isInteger(value.sourceTime) ||
		value.sourceTime < 0 ||
		![box.x, box.y, box.width, box.height].every(
			(candidate) =>
				typeof candidate === "number" && Number.isFinite(candidate),
		) ||
		(value.confidence !== undefined && typeof value.confidence !== "number")
	)
		return null;
	return {
		sourceTime: value.sourceTime,
		box: {
			x: box.x as number,
			y: box.y as number,
			width: box.width as number,
			height: box.height as number,
		},
		...(typeof value.confidence === "number"
			? { confidence: value.confidence }
			: {}),
	};
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
	format: "srt" | "vtt";
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
		(record.format === "srt" || record.format === "vtt") &&
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
