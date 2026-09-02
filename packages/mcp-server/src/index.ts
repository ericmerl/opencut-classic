import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { EditorBridge } from "./editor-bridge";
import { AudioCleanupService } from "./clean-audio";
import { ExportJobQueue } from "./export-jobs";
import { ExportProjectService } from "./export-project";
import { ExportReceiptStore } from "./export-receipts";
import { ExportValidator } from "./export-validator";
import { MatteGenerationService } from "./generate-matte";
import { ManagedEditorWorker } from "./managed-editor-worker";
import { calculateNormalizationGain } from "./audio-normalization";
import { SubtitleFiles } from "./subtitle-files";
import { SubjectTrackingService } from "./track-subject";
import {
	attachMatteInputSchema,
	attachCleanAudioInputSchema,
	cleanAudioInputSchema,
	createProjectInputSchema,
	editPlanInputSchema,
	exportProjectInputSchema,
	generateMatteInputSchema,
	getExportJobInputSchema,
	getExportReceiptInputSchema,
	importMediaInputSchema,
	importSubtitlesInputSchema,
	listExportJobsInputSchema,
	exportSubtitlesInputSchema,
	openProjectInputSchema,
	queueExportInputSchema,
	recordExportInspectionInputSchema,
	runExportJobsInputSchema,
	startEditorWorkerInputSchema,
	syncAudioInputSchema,
	timelineQueryInputSchema,
	trackSubjectInputSchema,
	transcribeTimelineInputSchema,
} from "./tool-schemas";

const token =
	process.env.OPENCUT_BRIDGE_TOKEN ??
	process.env.NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN;
if (!token || token.length < 32) {
	throw new Error("OPENCUT_BRIDGE_TOKEN must contain at least 32 characters");
}
const port = parsePort(
	process.env.OPENCUT_BRIDGE_PORT ??
		process.env.NEXT_PUBLIC_OPENCUT_BRIDGE_PORT ??
		"32191",
);
const bridge = new EditorBridge({ token, port });
const audioCleanup = new AudioCleanupService(bridge);
const exportReceipts = new ExportReceiptStore();
const exportValidator = new ExportValidator(exportReceipts);
const projectExports = new ExportProjectService(
	bridge,
	exportReceipts,
	exportValidator,
);
const editorWorker = ManagedEditorWorker.fromEnvironment(
	bridge,
	exportReceipts.directory,
);
const exportJobs = new ExportJobQueue(
	bridge,
	projectExports,
	ExportJobQueue.storeForReceiptDirectory(exportReceipts.directory),
	{ ensureEditor: (projectId) => editorWorker.ensureConnected(projectId) },
);
const matteGeneration = new MatteGenerationService(bridge);
const subtitleFiles = new SubtitleFiles();
const subjectTracking = new SubjectTrackingService(bridge);
const completedProjectOperations = new Map<
	string,
	{ fingerprint: string; result: Record<string, unknown> }
>();
const completedNormalizations = new Map<
	string,
	{ fingerprint: string; result: Record<string, unknown> }
>();
const completedSubtitleExports = new Map<
	string,
	{ fingerprint: string; result: Record<string, unknown> }
>();

function createServer(): McpServer {
	const server = new McpServer(
		{ name: "opencut-classic", version: "0.1.0" },
		{
			instructions:
				"Call opencut_connection_status first. List, create, or open a project as needed. Read the active project before editing and pass its exact projectId and revision into every mutation.",
		},
	);

	server.registerTool(
		"opencut_connection_status",
		{
			description:
				"Report whether an authenticated OpenCut editor is connected.",
		},
		async () =>
			toolResult({ ...bridge.getStatus(), worker: editorWorker.getStatus() }),
	);

	server.registerTool(
		"opencut_start_editor_worker",
		{
			description:
				"Start a managed hidden headless Chrome or Edge editor using the persistent automation profile, then wait for its authenticated bridge connection.",
			inputSchema: startEditorWorkerInputSchema,
		},
		async ({ projectId }) =>
			toolResult(await editorWorker.ensureConnected(projectId)),
	);

	server.registerTool(
		"opencut_stop_editor_worker",
		{
			description:
				"Stop the headless editor process launched by this MCP server. Manually opened editor sessions are not stopped.",
		},
		async () => toolResult(await editorWorker.stop()),
	);

	server.registerTool(
		"opencut_list_projects",
		{
			description:
				"List saved OpenCut projects in descending update order and identify the active project.",
		},
		async () => toolResult(await bridge.request("list_projects", {})),
	);

	server.registerTool(
		"opencut_create_project",
		{
			description:
				"Create and activate a new OpenCut project, then navigate the connected editor to it.",
			inputSchema: createProjectInputSchema,
		},
		async (params) =>
			toolResult(
				await runProjectOperation({ method: "create_project", input: params }),
			),
	);

	server.registerTool(
		"opencut_open_project",
		{
			description:
				"Open an existing OpenCut project and navigate the connected editor to it.",
			inputSchema: openProjectInputSchema,
		},
		async (params) =>
			toolResult(
				await runProjectOperation({ method: "open_project", input: params }),
			),
	);

	server.registerTool(
		"opencut_get_project",
		{
			description:
				"Read the active project, canvas settings, scene, revision, track roles, media assets, and parameterized timeline elements in canonical media ticks.",
		},
		async () => toolResult(await bridge.request("read_project", {})),
	);

	server.registerTool(
		"opencut_query_timeline",
		{
			description:
				"Query a revision-stable time range of the active timeline and return compact ordered elements, uncovered gaps, pairwise overlaps, and cut, gap, or overlap relationships per track.",
			inputSchema: timelineQueryInputSchema,
		},
		async (params) =>
			toolResult(await bridge.request("query_timeline", params)),
	);

	server.registerTool(
		"opencut_list_effects",
		{
			description:
				"List the clip effects registered by the connected OpenCut editor, including validated parameter types, ranges, defaults, named presets, and keyframe support.",
		},
		async () => toolResult(await bridge.request("list_effects", {})),
	);

	server.registerTool(
		"opencut_analyze_audio",
		{
			description:
				"Measure the active timeline mix before export mastering, including integrated LUFS, sample peak, estimated true peak, and the uniform gain range available without clipping OpenCut volume controls.",
			inputSchema: z.object({
				projectId: z.string().min(1),
				expectedRevision: z.number().int().nonnegative(),
			}),
		},
		async (params) =>
			toolResult(await bridge.request("analyze_audio", params, 5 * 60_000)),
	);

	server.registerTool(
		"opencut_normalize_audio",
		{
			description:
				"Measure and normalize the active timeline mix to a target integrated loudness while respecting a true-peak ceiling and preserving relative clip levels and volume automation.",
			inputSchema: z.object({
				projectId: z.string().min(1),
				operationId: z.string().min(1),
				expectedRevision: z.number().int().nonnegative(),
				targetLufs: z.number().min(-36).max(-5).default(-14),
				maxTruePeakDbtp: z.number().min(-9).max(0).default(-1),
				maxGainDb: z.number().min(0).max(20).default(20),
			}),
		},
		async (input) => toolResult(await normalizeAudio(input)),
	);

	server.registerTool(
		"opencut_sync_audio",
		{
			description:
				"Synchronize a target video or audio clip to a reference clip by decoding both sources locally, estimating waveform lag with bounded normalized cross-correlation, and moving the target on the current track.",
			inputSchema: syncAudioInputSchema,
		},
		async (input) =>
			toolResult(await bridge.request("sync_audio", input, 10 * 60_000)),
	);

	server.registerTool(
		"opencut_attach_clean_audio",
		{
			description:
				"Attach a precomputed cleaned-audio file to an uploaded audio or video clip while preserving the clip's timing, trim, retime, fades, ducking, mute, and volume automation. Use apply_edit_plan to enable, disable, or detach it.",
			inputSchema: attachCleanAudioInputSchema,
		},
		async ({ path, ...params }) => {
			const ticket = await bridge.mediaTickets.create(path);
			return toolResult(
				await bridge.request("attach_clean_audio", {
					...params,
					url: ticket.url,
					name: ticket.name,
					mimeType: ticket.mimeType,
					artifactHash: ticket.contentHash,
					artifactFingerprint: ticket.sourceFingerprint,
				}),
			);
		},
	);

	server.registerTool(
		"opencut_clean_audio",
		{
			description:
				"Clean the complete uploaded source audio through the configured external provider and attach the result non-destructively to the selected audio or video clip. Existing trim, retime, fades, ducking, mute, and volume automation remain on the clip.",
			inputSchema: cleanAudioInputSchema,
		},
		async (input) => toolResult(await audioCleanup.clean(input)),
	);

	server.registerTool(
		"opencut_apply_edit_plan",
		{
			description:
				"Atomically update project settings, create or configure tracks, crop or reframe visual clips, separate video source audio, enable or detach a cleaned source, apply non-destructive dialogue ducking, set per-clip audio gain, mute, linear fades, or uniform mix gain, create, update, reorder, enable, or remove clip effects, create, update, retime, or remove keyframes, create, update, or remove clip transitions, insert text or timed caption batches, delete, move, retime, set validated element parameters, split, or trim timeline elements. Read the project first and use its current revision.",
			inputSchema: editPlanInputSchema,
		},
		async (plan) => toolResult(await bridge.request("apply_edit_plan", plan)),
	);

	server.registerTool(
		"opencut_undo",
		{
			description:
				"Undo one OpenCut command after checking the current revision.",
			inputSchema: z.object({
				projectId: z.string().min(1),
				expectedRevision: z.number().int().nonnegative(),
			}),
		},
		async (params) => toolResult(await bridge.request("undo", params)),
	);

	server.registerTool(
		"opencut_import_media",
		{
			description:
				"Import an image, audio file, or video from an absolute local path and place it automatically or on an explicit compatible track without a browser file picker. Project canvas and frame rate are preserved unless adoptMediaSettings is true.",
			inputSchema: importMediaInputSchema,
		},
		async ({ path, ...params }) => {
			const ticket = await bridge.mediaTickets.create(path);
			return toolResult(
				await bridge.request("import_media", {
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
		"opencut_import_subtitles",
		{
			description:
				"Import SRT, ASS, or WebVTT captions from an absolute local UTF-8 file onto a new text track without a browser file picker. Parsed ASS styling is preserved where OpenCut supports it, and an optional shared style can override imported styling.",
			inputSchema: importSubtitlesInputSchema,
		},
		async ({ path, ...params }) => {
			const source = await subtitleFiles.read(path);
			const result = await bridge.request("import_subtitles", {
				...params,
				fileName: source.fileName,
				input: source.input,
				contentHash: source.contentHash,
			});
			return toolResult(
				result && typeof result === "object"
					? {
							...result,
							sourcePath: path,
							sourceBytes: source.bytesRead,
							sourceSha256: source.contentHash,
						}
					: result,
			);
		},
	);

	server.registerTool(
		"opencut_transcribe_timeline",
		{
			description:
				"Render the active timeline audio mix, transcribe it with OpenCut's local Whisper worker, chunk the result into captions, and atomically insert a new text track. The first model use may download model files and can take several minutes.",
			inputSchema: transcribeTimelineInputSchema,
		},
		async (input) =>
			toolResult(
				await bridge.request("transcribe_timeline", input, 2 * 60 * 60_000),
			),
	);

	server.registerTool(
		"opencut_export_subtitles",
		{
			description:
				"Export caption text elements from all text tracks, or selected text tracks, to a new absolute local SRT or WebVTT file with a SHA-256 receipt.",
			inputSchema: exportSubtitlesInputSchema,
		},
		async (input) => {
			const fingerprint = JSON.stringify(input);
			const prior = completedSubtitleExports.get(input.operationId);
			if (prior) {
				if (prior.fingerprint !== fingerprint) {
					throw new Error(
						"operationId was already used for a different subtitle export",
					);
				}
				return toolResult({ ...prior.result, status: "replayed" });
			}

			const { operationId, outputPath, ...request } = input;
			const result = await bridge.request("export_subtitles", request);
			if (!isSerializedSubtitles(result)) return toolResult(result);
			const receipt = await subtitleFiles.write({
				path: outputPath,
				format: input.format,
				content: result.content,
			});
			const completed = {
				status: "exported",
				operationId,
				revision: result.revision,
				format: result.format,
				trackIds: result.trackIds,
				cueCount: result.cueCount,
				...receipt,
			};
			completedSubtitleExports.set(operationId, {
				fingerprint,
				result: completed,
			});
			return toolResult(completed);
		},
	);

	server.registerTool(
		"opencut_attach_matte",
		{
			description:
				"Attach a precomputed image or video foreground matte to a video clip. The artifact must match the source aspect ratio; video mattes must cover the full source duration. Use apply_edit_plan to enable, disable, or detach it.",
			inputSchema: attachMatteInputSchema,
		},
		async ({ path, ...params }) => {
			const ticket = await bridge.mediaTickets.create(path);
			return toolResult(
				await bridge.request("attach_matte", {
					...params,
					url: ticket.url,
					name: ticket.name,
					mimeType: ticket.mimeType,
					artifactHash: ticket.contentHash,
					artifactFingerprint: ticket.sourceFingerprint,
				}),
			);
		},
	);

	server.registerTool(
		"opencut_generate_matte",
		{
			description:
				"Generate and attach a foreground matte for one video clip through the configured external provider. The source stays local, model provenance is persisted, and the current project revision is required.",
			inputSchema: generateMatteInputSchema,
		},
		async (input) => toolResult(await matteGeneration.generate(input)),
	);

	server.registerTool(
		"opencut_track_subject",
		{
			description:
				"Track a subject through a video clip with the configured local provider, map source samples through trim and retime, smooth the motion, and atomically create focal-point or crop reframe keyframes.",
			inputSchema: trackSubjectInputSchema,
		},
		async (input) => toolResult(await subjectTracking.track(input)),
	);

	server.registerTool(
		"opencut_export_project",
		{
			description:
				"Render the active project to a new absolute local file, fully decode and probe it, extract hash-locked opening, middle, and ending frame samples, and persist a durable receipt for watermark inspection.",
			inputSchema: exportProjectInputSchema,
		},
		async (input) => toolResult(await projectExports.export(input)),
	);

	server.registerTool(
		"opencut_queue_export",
		{
			description:
				"Persist an export job and run it automatically when an authenticated editor worker is connected. The job survives MCP restarts.",
			inputSchema: queueExportInputSchema,
		},
		async ({ jobId, ...input }) =>
			toolResult(await exportJobs.enqueue({ jobId, input })),
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
				"Cancel a queued export job. A running renderer cannot yet be interrupted.",
			inputSchema: getExportJobInputSchema,
		},
		async ({ jobId }) => toolResult(await exportJobs.cancel(jobId)),
	);

	server.registerTool(
		"opencut_run_export_jobs",
		{
			description:
				"Run queued export jobs now through the connected editor worker, up to the requested limit.",
			inputSchema: runExportJobsInputSchema,
		},
		async ({ limit }) =>
			toolResult({
				connected: bridge.getStatus().connected,
				processed: await exportJobs.runQueued(limit),
			}),
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
		async ({ watermarkStatus, ...input }) =>
			toolResult(
				await exportReceipts.recordInspection({
					...input,
					status: watermarkStatus,
				}),
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
	void handle.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
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

async function normalizeAudio(input: {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	targetLufs: number;
	maxTruePeakDbtp: number;
	maxGainDb: number;
}): Promise<unknown> {
	const fingerprint = JSON.stringify(input);
	const prior = completedNormalizations.get(input.operationId);
	if (prior) {
		if (prior.fingerprint !== fingerprint) {
			throw new Error(
				"operationId was already used for a different audio normalization",
			);
		}
		return { ...prior.result, status: "replayed" };
	}
	const beforeResult = await bridge.request(
		"analyze_audio",
		{
			projectId: input.projectId,
			expectedRevision: input.expectedRevision,
		},
		5 * 60_000,
	);
	if (!isAnalyzedAudio(beforeResult)) return beforeResult;
	const before = beforeResult.analysis;
	if (before.integratedLufs === null || before.estimatedTruePeakDbtp === null) {
		return {
			status: "rejected",
			reason: "audible timeline mix is silent or below the loudness gate",
			analysis: before,
		};
	}
	const { appliedGainDb, limitedBy } = calculateNormalizationGain({
		integratedLufs: before.integratedLufs,
		estimatedTruePeakDbtp: before.estimatedTruePeakDbtp,
		targetLufs: input.targetLufs,
		maxTruePeakDbtp: input.maxTruePeakDbtp,
		maxGainDb: input.maxGainDb,
		minimumGainDb: before.minimumGainDb,
		maximumGainDb: before.maximumGainDb,
	});
	const mutation = await bridge.request(
		"apply_edit_plan",
		{
			projectId: input.projectId,
			operationId: input.operationId,
			expectedRevision: input.expectedRevision,
			description: `Normalize timeline audio to ${input.targetLufs} LUFS`,
			operations: [{ kind: "adjust_mix_gain", gainDb: appliedGainDb }],
		},
		5 * 60_000,
	);
	if (!isAppliedMutation(mutation)) return mutation;
	const afterResult = await bridge.request(
		"analyze_audio",
		{ projectId: input.projectId, expectedRevision: mutation.revision },
		5 * 60_000,
	);
	const result = {
		status: "normalized",
		operationId: input.operationId,
		revision: mutation.revision,
		targetLufs: input.targetLufs,
		maxTruePeakDbtp: input.maxTruePeakDbtp,
		appliedGainDb,
		limitedBy,
		before,
		after: isAnalyzedAudio(afterResult) ? afterResult.analysis : afterResult,
		mutation,
	};
	completedNormalizations.set(input.operationId, { fingerprint, result });
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
	revision: number;
	format: "srt" | "vtt";
	trackIds: string[];
	cueCount: number;
	content: string;
} {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.status === "serialized" &&
		typeof record.revision === "number" &&
		(record.format === "srt" || record.format === "vtt") &&
		Array.isArray(record.trackIds) &&
		typeof record.cueCount === "number" &&
		typeof record.content === "string"
	);
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
