import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";

export interface ManagedEditorBridge {
	getStatus(): { connected: boolean; port: number };
	createBootstrapTicket(): { id: string; expiresAt: string };
	waitForConnection(timeoutMs?: number): Promise<void>;
	waitForDisconnection?(timeoutMs?: number): Promise<void>;
}

export interface ManagedEditorWorkerStatus {
	enabled: boolean;
	running: boolean;
	connected: boolean;
	baseUrl: string | null;
	profileDirectory: string;
	browserPath: string | null;
	projectId: string | null;
	lastError: string | null;
}

export class ManagedEditorWorker {
	private child: ChildProcess | null = null;
	private launchPromise: Promise<ManagedEditorWorkerStatus> | null = null;
	private resolvedBrowserPath: string | null = null;
	private projectId: string | null = null;
	private lastError: string | null = null;

	constructor(
		private bridge: ManagedEditorBridge,
		private options: {
			baseUrl?: string;
			browserPath?: string;
			profileDirectory: string;
			connectionTimeoutMs?: number;
			spawnProcess?: typeof spawn;
			browserArguments?: string[];
		},
	) {}

	static fromEnvironment(
		bridge: ManagedEditorBridge,
		stateDirectory: string,
	): ManagedEditorWorker {
		return new ManagedEditorWorker(bridge, {
			baseUrl: globalThis.process.env.OPENCUT_HEADLESS_EDITOR_URL,
			browserPath: globalThis.process.env.OPENCUT_HEADLESS_BROWSER_PATH,
			profileDirectory:
				globalThis.process.env.OPENCUT_HEADLESS_PROFILE_DIR ??
				join(stateDirectory, "headless-profile"),
			connectionTimeoutMs: readTimeout(
				globalThis.process.env.OPENCUT_HEADLESS_CONNECTION_TIMEOUT_MS,
			),
		});
	}

	getStatus(): ManagedEditorWorkerStatus {
		return {
			enabled: !!this.options.baseUrl,
			running: this.child !== null && this.child.exitCode === null,
			connected: this.bridge.getStatus().connected,
			baseUrl: this.options.baseUrl ?? null,
			profileDirectory: resolve(this.options.profileDirectory),
			browserPath: this.resolvedBrowserPath,
			projectId: this.projectId,
			lastError: this.lastError,
		};
	}

	async ensureConnected(
		projectId = "__opencut_automation_bootstrap__",
	): Promise<ManagedEditorWorkerStatus> {
		if (this.bridge.getStatus().connected) return this.getStatus();
		if (!this.options.baseUrl) {
			throw new Error(
				"managed editor worker is disabled; set OPENCUT_HEADLESS_EDITOR_URL",
			);
		}
		this.launchPromise ??= this.launch(projectId).finally(() => {
			this.launchPromise = null;
		});
		return this.launchPromise;
	}

	async stop(): Promise<ManagedEditorWorkerStatus> {
		const child = this.child;
		this.child = null;
		this.projectId = null;
		if (child) {
			await stopChild(child);
			await this.bridge.waitForDisconnection?.(5_000);
		}
		return this.getStatus();
	}

	private async launch(projectId: string): Promise<ManagedEditorWorkerStatus> {
		try {
			const baseUrl = validateBaseUrl(this.options.baseUrl!);
			const browserPath = await findBrowser(this.options.browserPath);
			this.resolvedBrowserPath = browserPath;
			await mkdir(this.options.profileDirectory, { recursive: true });
			const ticket = this.bridge.createBootstrapTicket();
			const editorUrl = new URL(
				`/editor/${encodeURIComponent(projectId)}`,
				baseUrl,
			);
			editorUrl.searchParams.set(
				"automationBridgePort",
				String(this.bridge.getStatus().port),
			);
			editorUrl.searchParams.set("automationBootstrap", ticket.id);

			const child = (this.options.spawnProcess ?? spawn)(
				browserPath,
				[
					"--headless=new",
					`--user-data-dir=${resolve(this.options.profileDirectory)}`,
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-background-networking",
					"--disable-component-update",
					"--disable-sync",
					"--autoplay-policy=no-user-gesture-required",
					"--window-size=1280,720",
					...(this.options.browserArguments ?? []),
					editorUrl.toString(),
				],
				{ stdio: "ignore", windowsHide: true },
			);
			this.child = child;
			this.projectId = projectId;
			this.lastError = null;
			child.once("exit", () => {
				if (this.child === child) this.child = null;
			});

			await Promise.race([
				this.bridge.waitForConnection(
					this.options.connectionTimeoutMs ?? 45_000,
				),
				new Promise<never>((_, reject) => {
					child.once("error", reject);
				}),
			]);
			return this.getStatus();
		} catch (error) {
			this.lastError =
				error instanceof Error ? error.message : "managed editor launch failed";
			const child = this.child;
			this.child = null;
			if (child) await stopChild(child);
			throw error;
		}
	}
}

async function findBrowser(configured?: string): Promise<string> {
	if (configured) {
		const path = resolve(configured);
		if (await isFile(path)) return path;
		throw new Error(`configured headless browser does not exist: ${path}`);
	}
	for (const candidate of browserCandidates()) {
		if (await isFile(candidate)) return candidate;
	}
	throw new Error(
		"Chrome or Edge was not found; set OPENCUT_HEADLESS_BROWSER_PATH",
	);
}

function browserCandidates(): string[] {
	if (globalThis.process.platform === "win32") {
		return [
			join(
				globalThis.process.env.ProgramFiles ?? "C:\\Program Files",
				"Google",
				"Chrome",
				"Application",
				"chrome.exe",
			),
			join(
				globalThis.process.env["ProgramFiles(x86)"] ??
					"C:\\Program Files (x86)",
				"Microsoft",
				"Edge",
				"Application",
				"msedge.exe",
			),
		];
	}
	if (globalThis.process.platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		];
	}
	const names = [
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
	];
	return (globalThis.process.env.PATH ?? "")
		.split(delimiter)
		.flatMap((directory) => names.map((name) => join(directory, name)));
}

function validateBaseUrl(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		(url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
	) {
		throw new Error("OPENCUT_HEADLESS_EDITOR_URL must be a localhost HTTP URL");
	}
	return url;
}

async function isFile(path: string): Promise<boolean> {
	const info = await stat(path).catch(() => null);
	return info?.isFile() ?? false;
}

function readTimeout(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
		throw new Error(
			"OPENCUT_HEADLESS_CONNECTION_TIMEOUT_MS must be between 1000 and 300000",
		);
	}
	return parsed;
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
	child.kill();
	await Promise.race([exited, delay(5_000)]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await Promise.race([exited, delay(1_000)]);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
