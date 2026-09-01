import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { EditorBridge } from "./editor-bridge";

const token = process.env.OPENCUT_BRIDGE_TOKEN;
if (!token || token.length < 32) {
	throw new Error("OPENCUT_BRIDGE_TOKEN must contain at least 32 characters");
}
const port = parsePort(process.env.OPENCUT_BRIDGE_PORT ?? "32191");
const bridge = new EditorBridge({ token, port });

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
				"Read the active project, scene, revision, tracks, and timeline elements in canonical media ticks.",
		},
		async () => toolResult(await bridge.request("read_project", {})),
	);

	server.registerTool(
		"opencut_apply_edit_plan",
		{
			description:
				"Atomically move or trim existing timeline elements. Read the project first and use its current revision.",
			inputSchema: z.object({
				projectId: z.string().min(1),
				operationId: z.string().min(1),
				expectedRevision: z.number().int().nonnegative(),
				description: z.string().min(1),
				operations: z
					.array(
						z.discriminatedUnion("kind", [
							z.object({
								kind: z.literal("move"),
								trackId: z.string().min(1),
								elementId: z.string().min(1),
								startTime: z.number().int().nonnegative(),
							}),
							z.object({
								kind: z.literal("trim"),
								trackId: z.string().min(1),
								elementId: z.string().min(1),
								startTime: z.number().int().nonnegative(),
								duration: z.number().int().positive(),
								trimStart: z.number().int().nonnegative(),
								trimEnd: z.number().int().positive(),
							}),
						]),
					)
					.min(1),
			}),
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
