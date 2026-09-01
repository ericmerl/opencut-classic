import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { EditorBridge } from "./editor-bridge";
import { editPlanInputSchema, importMediaInputSchema } from "./tool-schemas";

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

function createServer(): McpServer {
	const server = new McpServer(
		{ name: "opencut-classic", version: "0.1.0" },
		{
			instructions:
				"Call opencut_connection_status first. Read the project before editing and pass its exact projectId and revision into every mutation.",
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
		"opencut_get_project",
		{
			description:
				"Read the active project, canvas settings, scene, revision, track roles, media assets, and parameterized timeline elements in canonical media ticks.",
		},
		async () => toolResult(await bridge.request("read_project", {})),
	);

	server.registerTool(
		"opencut_apply_edit_plan",
		{
			description:
				"Atomically update project settings, create or configure tracks, insert text or timed caption batches, delete, move, retime, set validated element parameters, split, or trim timeline elements. Read the project first and use its current revision.",
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
				"Import an image, audio file, or video from an absolute local path and place it automatically or on an explicit compatible track without a browser file picker.",
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
