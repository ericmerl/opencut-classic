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
		} finally {
			await worker.stop();
			bridge.stop();
		}
	},
	120_000,
);
