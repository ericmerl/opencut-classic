import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOOTSTRAP_PROJECT_ID,
	ManagedEditorWorker,
	type ManagedEditorBridge,
} from "./managed-editor-worker";

describe("ManagedEditorWorker", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-headless-worker-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("a bootstrap launch opens the placeholder editor but reports no project", async () => {
		const browserPath = join(directory, "browser.exe");
		await writeFile(browserPath, "fixture");
		let connected = false;
		let launchedArgs: readonly string[] = [];
		const child = new EventEmitter() as EventEmitter & {
			exitCode: number | null;
			kill: () => boolean;
		};
		child.exitCode = null;
		child.kill = () => {
			child.exitCode = 0;
			child.emit("exit", 0, null);
			return true;
		};
		const spawnProcess = ((_command: string, args: readonly string[]) => {
			launchedArgs = args;
			return child as unknown as ChildProcess;
		}) as typeof spawn;
		const bridge: ManagedEditorBridge = {
			getStatus: () => ({ connected, port: 32191 }),
			createBootstrapTicket: () => ({
				id: "one-time-ticket",
				expiresAt: "2026-09-01T00:01:00.000Z",
			}),
			waitForConnection: async () => {
				connected = true;
			},
		};
		const worker = new ManagedEditorWorker(bridge, {
			baseUrl: "http://127.0.0.1:3000",
			browserPath,
			profileDirectory: join(directory, "profile"),
			spawnProcess,
		});

		const status = await worker.ensureConnected();

		expect(new URL(launchedArgs.at(-1)!).pathname).toBe(
			`/editor/${BOOTSTRAP_PROJECT_ID}`,
		);
		expect(status).toMatchObject({ connected: true, projectId: null });
		expect(worker.getStatus().projectId).toBeNull();
	});

	test("launches a hidden browser with a one-time bootstrap ticket", async () => {
		const browserPath = join(directory, "browser.exe");
		await writeFile(browserPath, "fixture");
		let connected = false;
		let launchedCommand = "";
		let launchedArgs: readonly string[] = [];
		let killed = false;
		const child = new EventEmitter() as EventEmitter & {
			exitCode: number | null;
			kill: () => boolean;
		};
		child.exitCode = null;
		child.kill = () => {
			killed = true;
			child.exitCode = 0;
			child.emit("exit", 0, null);
			return true;
		};
		const spawnProcess = ((command: string, args: readonly string[]) => {
			launchedCommand = command;
			launchedArgs = args;
			return child as unknown as ChildProcess;
		}) as typeof spawn;
		const bridge: ManagedEditorBridge = {
			getStatus: () => ({ connected, port: 32191 }),
			createBootstrapTicket: () => ({
				id: "one-time-ticket",
				expiresAt: "2026-09-01T00:01:00.000Z",
			}),
			waitForConnection: async () => {
				connected = true;
			},
		};
		const worker = new ManagedEditorWorker(bridge, {
			baseUrl: "http://127.0.0.1:3000",
			browserPath,
			profileDirectory: join(directory, "profile"),
			spawnProcess,
			testDropResponseOperationId: "drop-after-receipt",
		});

		const status = await worker.ensureConnected("project-1");

		expect(launchedCommand).toBe(browserPath);
		expect(launchedArgs).toContain("--headless=new");
		expect(launchedArgs).toContain("--use-webgpu-adapter=swiftshader");
		expect(launchedArgs).toContain("--enable-webgpu-developer-features");
		expect(launchedArgs).toContain("--use-gpu-in-tests");
		expect(launchedArgs).toContain("--enable-accelerated-2d-canvas");
		expect(launchedArgs).not.toContain("--use-gl=angle");
		expect(launchedArgs).not.toContain("--use-angle=swiftshader");
		expect(launchedArgs).not.toContain("--use-vulkan=swiftshader");
		const launchedUrl = new URL(launchedArgs.at(-1)!);
		expect(launchedUrl.pathname).toBe("/editor/project-1");
		expect(launchedUrl.searchParams.get("automationBootstrap")).toBe(
			"one-time-ticket",
		);
		expect(launchedUrl.searchParams.get("automationBridgePort")).toBe("32191");
		expect(launchedUrl.searchParams.get("automationRendererClass")).toBe(
			"software",
		);
		expect(launchedUrl.searchParams.get("automationCompositorBackend")).toBe(
			"webgpu",
		);
		expect(
			launchedUrl.searchParams.get("automationTestDropResponseOperationId"),
		).toBe("drop-after-receipt");
		expect(status).toMatchObject({
			running: true,
			connected: true,
			rendererClass: "software",
			pinnedCompositorBackend: "webgpu",
		});

		await worker.stop();
		expect(killed).toBe(true);
	});

	const windowsTest = process.platform === "win32" ? test : test.skip;
	windowsTest("terminates the complete browser process tree", async () => {
		const browserPath = join(directory, "browser.exe");
		await writeFile(browserPath, "fixture");
		let connected = false;
		const browser = new EventEmitter() as EventEmitter & {
			pid: number;
			exitCode: number | null;
			kill: () => boolean;
		};
		browser.pid = 4321;
		browser.exitCode = null;
		browser.kill = () => false;
		const killer = new EventEmitter() as EventEmitter & {
			exitCode: number | null;
		};
		killer.exitCode = null;
		const termination: {
			value: {
				command: string;
				args: readonly string[];
				windowsHide: boolean | undefined;
			} | null;
		} = { value: null };
		const terminateProcessTree = ((
			command: string,
			args: readonly string[],
			options: { windowsHide?: boolean },
		) => {
			termination.value = { command, args, windowsHide: options.windowsHide };
			queueMicrotask(() => {
				killer.exitCode = 0;
				killer.emit("exit", 0, null);
				browser.exitCode = 0;
				browser.emit("exit", 0, null);
			});
			return killer as unknown as ChildProcess;
		}) as typeof spawn;
		const worker = new ManagedEditorWorker(
			{
				getStatus: () => ({ connected, port: 32191 }),
				createBootstrapTicket: () => ({ id: "ticket", expiresAt: "unused" }),
				waitForConnection: async () => {
					connected = true;
				},
			},
			{
				baseUrl: "http://127.0.0.1:3000",
				browserPath,
				profileDirectory: join(directory, "profile"),
				spawnProcess: (() =>
					browser as unknown as ChildProcess) as typeof spawn,
				terminateProcessTree,
			},
		);
		await worker.ensureConnected();

		await worker.stop();

		expect(termination.value).toEqual({
			command: "taskkill.exe",
			args: ["/PID", "4321", "/T", "/F"],
			windowsHide: true,
		});
	});

	test("requires explicit headless-editor enablement", async () => {
		const worker = new ManagedEditorWorker(
			{
				getStatus: () => ({ connected: false, port: 32191 }),
				createBootstrapTicket: () => ({ id: "unused", expiresAt: "unused" }),
				waitForConnection: async () => undefined,
			},
			{ profileDirectory: join(directory, "profile") },
		);

		await expect(worker.ensureConnected()).rejects.toThrow(
			"OPENCUT_HEADLESS_EDITOR_URL",
		);
	});
});
