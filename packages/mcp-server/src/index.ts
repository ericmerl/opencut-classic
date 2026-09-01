import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { EditorBridge } from "./editor-bridge";
import { calculateNormalizationGain } from "./audio-normalization";
import {
	createProjectInputSchema,
	editPlanInputSchema,
	importMediaInputSchema,
	openProjectInputSchema,
	timelineQueryInputSchema,
} from "./tool-schemas";

const token = process.env.OPENCUT_BRIDGE_TOKEN;
if (!token || token.length < 32) {
	throw new Error("OPENCUT_BRIDGE_TOKEN must contain at least 32 characters");
}
const port = parsePort(process.env.OPENCUT_BRIDGE_PORT ?? "32191");
const bridge = new EditorBridge({ token, port });
const completedExports = new Map<
	string,
	{ fingerprint: string; result: Record<string, unknown> }
>();
const completedProjectOperations = new Map<
	string,
	{ fingerprint: string; result: Record<string, unknown> }
>();
const completedNormalizations = new Map<
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
		async () => toolResult(bridge.getStatus()),
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
				"List the clip effects registered by the connected OpenCut editor, including validated parameter types, ranges, defaults, and keyframe support.",
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
		"opencut_apply_edit_plan",
		{
			description:
				"Atomically update project settings, create or configure tracks, set per-clip audio gain, mute, linear fades, or uniform mix gain, create, update, reorder, enable, or remove clip effects, create, update, retime, or remove keyframes, create, update, or remove clip transitions, insert text or timed caption batches, delete, move, retime, set validated element parameters, split, or trim timeline elements. Read the project first and use its current revision.",
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
		"opencut_export_project",
		{
			description:
				"Render the active project in the connected editor and write it to a new absolute local file without opening a browser download dialog.",
			inputSchema: z.object({
				projectId: z.string().min(1),
				operationId: z.string().min(1),
				expectedRevision: z.number().int().nonnegative(),
				outputPath: z.string().min(1),
				format: z.enum(["mp4", "webm"]),
				quality: z.enum(["low", "medium", "high", "very_high"]).default("high"),
				fps: z
					.object({
						numerator: z.number().int().positive(),
						denominator: z.number().int().positive(),
					})
					.optional(),
				includeAudio: z.boolean().default(true),
			}),
		},
		async (input) => {
			const fingerprint = exportFingerprint(input);
			const prior = completedExports.get(input.operationId);
			if (prior) {
				if (prior.fingerprint !== fingerprint) {
					throw new Error(
						"operationId was already used for a different export",
					);
				}
				return toolResult({ ...prior.result, status: "replayed" });
			}

			const { outputPath, format, ...params } = input;
			const ticket = await bridge.exportTickets.create(outputPath, format);
			const result = await bridge.request(
				"export_project",
				{
					...params,
					format,
					outputPath: ticket.outputPath,
					url: ticket.url,
				},
				30 * 60_000,
			);
			if (isCompletedExport(result)) {
				completedExports.set(input.operationId, {
					fingerprint,
					result: { ...result, status: "exported" },
				});
			}
			return toolResult(result);
		},
	);

	return server;
}

const handle = serveStdio(createServer);
console.error(
	`OpenCut MCP server listening for the editor on 127.0.0.1:${port}`,
);

process.on("SIGINT", () => {
	bridge.stop();
	void handle.close();
});

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

function exportFingerprint(input: {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	outputPath: string;
	format: "mp4" | "webm";
	quality: "low" | "medium" | "high" | "very_high";
	fps?: { numerator: number; denominator: number };
	includeAudio: boolean;
}): string {
	return JSON.stringify([
		input.projectId,
		input.operationId,
		input.expectedRevision,
		input.outputPath,
		input.format,
		input.quality,
		input.fps?.numerator ?? null,
		input.fps?.denominator ?? null,
		input.includeAudio,
	]);
}

function isCompletedExport(
	value: unknown,
): value is Record<string, unknown> & { status: "exported" | "replayed" } {
	if (!value || typeof value !== "object") return false;
	const status = (value as Record<string, unknown>).status;
	return status === "exported" || status === "replayed";
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
