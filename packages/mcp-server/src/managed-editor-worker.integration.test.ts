import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorBridge } from "./editor-bridge";
import { ManagedEditorWorker } from "./managed-editor-worker";

const integrationTest =
	process.env.OPENCUT_RUN_HEADLESS_INTEGRATION === "1" ? test : test.skip;

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-headless-integration-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

integrationTest(
	"connects the real web editor through a one-time bootstrap ticket",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl)
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		const port = Number(
			process.env.OPENCUT_HEADLESS_INTEGRATION_BRIDGE_PORT ?? "32291",
		);
		const bridge = new EditorBridge({
			token: randomBytes(32).toString("hex"),
			port,
		});
		let browserDiagnostics = "";
		const spawnWithDiagnostics = ((
			command: string,
			args: readonly string[],
		) => {
			const child = spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			child.stdout?.on("data", (data) => {
				browserDiagnostics += String(data);
			});
			child.stderr?.on("data", (data) => {
				browserDiagnostics += String(data);
			});
			return child;
		}) as typeof spawn;
		const worker = new ManagedEditorWorker(bridge, {
			baseUrl,
			browserPath: process.env.OPENCUT_HEADLESS_BROWSER_PATH,
			profileDirectory: join(directory, "profile"),
			connectionTimeoutMs: 90_000,
			spawnProcess: spawnWithDiagnostics,
			browserArguments: ["--enable-logging=stderr", "--v=0"],
		});

		try {
			const status = await worker.ensureConnected().catch((error) => {
				const focusedDiagnostics = browserDiagnostics
					.split(/\r?\n/)
					.filter((line) =>
						/CONSOLE|ERROR|bootstrap|WebSocket|127\.0\.0\.1:3100|127\.0\.0\.1:32291/i.test(
							line,
						),
					)
					.join("\n");
				console.error(focusedDiagnostics.slice(-30_000));
				throw error;
			});
			expect(status).toMatchObject({ running: true, connected: true });
			expect(bridge.getStatus().connected).toBe(true);

			const catalog = requireRecord(
				await bridge.request("list_visual_assets", {}),
			);
			expect(catalog.graphics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ definitionId: "rectangle" }),
				]),
			);
			expect(catalog.masks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ maskType: "ellipse" }),
				]),
			);

			const initial = requireRecord(await bridge.request("read_project", {}));
			const projectId = requireString(initial.projectId, "projectId");
			const revision = requireNumber(initial.revision, "revision");
			const inserted = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "visual-integration-insert",
					expectedRevision: revision,
					description: "Insert native visual automation fixtures",
					operations: [
						{
							kind: "insert_graphic",
							definitionId: "rectangle",
							startTime: 0,
							duration: 120_000,
							params: { fill: "#ff0000", cornerRadius: 24 },
						},
						{
							kind: "insert_adjustment_layer",
							effectType: "color-grade",
							startTime: 0,
							duration: 120_000,
							params: { contrast: 12, highlights: -35 },
						},
					],
				}),
			);
			expect(inserted.status).toBe("applied");
			const insertedSnapshot = requireRecord(inserted.snapshot);
			const elements = requireRecords(insertedSnapshot.elements, "elements");
			const graphic = elements.find((element) => element.type === "graphic");
			expect(graphic).toMatchObject({
				graphicDefinitionId: "rectangle",
				params: expect.objectContaining({ fill: "#ff0000", cornerRadius: 24 }),
			});
			expect(elements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "effect",
						effectType: "color-grade",
						params: expect.objectContaining({ contrast: 12, highlights: -35 }),
					}),
				]),
			);

			if (!graphic) throw new Error("inserted graphic missing from snapshot");
			const masked = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "visual-integration-mask",
					expectedRevision: requireNumber(inserted.revision, "revision"),
					description: "Author a native ellipse mask",
					operations: [
						{
							kind: "set_mask",
							trackId: requireString(graphic.trackId, "trackId"),
							elementId: requireString(graphic.elementId, "elementId"),
							maskId: "ellipse-mask-1",
							maskType: "ellipse",
							params: { feather: 12 },
						},
					],
				}),
			);
			const maskedElements = requireRecords(
				requireRecord(masked.snapshot).elements,
				"elements",
			);
			expect(
				maskedElements.find(
					(element) => element.elementId === graphic.elementId,
				),
			).toMatchObject({
				masks: [
					expect.objectContaining({
						maskId: "ellipse-mask-1",
						maskType: "ellipse",
						params: expect.objectContaining({ feather: 12 }),
					}),
				],
			});
		} finally {
			await worker.stop();
			bridge.stop();
		}
	},
	120_000,
);

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object response");
	}
	return Object.fromEntries(Object.entries(value));
}

function requireRecords(
	value: unknown,
	name: string,
): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map(requireRecord);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number") throw new Error(`${name} must be a number`);
	return value;
}
