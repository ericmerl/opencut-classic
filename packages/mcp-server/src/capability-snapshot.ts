import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, statfs } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { CURRENT_BRIDGE_PROTOCOL_VERSION } from "./editor-bridge";
import { stableSerialize } from "./matte-generation-data";
import { OPERATION_LEDGER_SCHEMA_VERSION } from "./operation-ledger-schema";
import { CURRENT_PROJECT_CONTENT_PROJECTION_VERSION } from "./project-content-version";
import { EDIT_PLAN_OPERATION_VARIANTS } from "./tool-schemas";

export const CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const NAMED_FONT_PRESETS = [
	{
		id: "default-caption",
		descriptors: [
			'normal 400 16px "Arial"',
			'normal 700 16px "Arial"',
			'italic 700 16px "Arial"',
		],
	},
] as const;

export const REGISTERED_TOOL_NAMES = [
	"opencut_analyze_audio",
	"opencut_apply_edit_plan",
	"opencut_attach_clean_audio",
	"opencut_attach_matte",
	"opencut_cancel_export_batch",
	"opencut_cancel_export_job",
	"opencut_capabilities",
	"opencut_clean_audio",
	"opencut_connection_status",
	"opencut_create_project",
	"opencut_export_project",
	"opencut_export_subtitles",
	"opencut_generate_matte",
	"opencut_get_export_batch",
	"opencut_get_export_job",
	"opencut_get_export_receipt",
	"opencut_get_operation",
	"opencut_get_preview_frame",
	"opencut_get_project",
	"opencut_get_save_receipt",
	"opencut_import_media",
	"opencut_import_subtitles",
	"opencut_list_effects",
	"opencut_list_export_batches",
	"opencut_list_export_jobs",
	"opencut_list_operation_history",
	"opencut_list_preview_frames",
	"opencut_list_projects",
	"opencut_list_visual_assets",
	"opencut_normalize_audio",
	"opencut_open_project",
	"opencut_query_timeline",
	"opencut_queue_export",
	"opencut_queue_export_batch",
	"opencut_record_export_inspection",
	"opencut_render_preview_frame",
	"opencut_run_export_jobs",
	"opencut_save_project",
	"opencut_search_stickers",
	"opencut_start_editor_worker",
	"opencut_stop_editor_worker",
	"opencut_sync_audio",
	"opencut_track_subject",
	"opencut_transcribe_timeline",
	"opencut_undo",
] as const;

export { EDIT_PLAN_OPERATION_VARIANTS } from "./tool-schemas";

export type ReadinessStatus =
	| "ready"
	| "degraded"
	| "unavailable"
	| "misconfigured"
	| "unknown";

interface CapabilityBridge {
	getStatus(): {
		connected: boolean;
		host: string;
		port: number;
		serverInstanceId: string;
		supportedProtocolVersions: readonly number[];
		negotiatedProtocolVersion: number | null;
		connectionIdentity: unknown;
	};
	request(
		method: string,
		params: unknown,
		timeoutMs?: number,
		expectedIdentity?: never,
	): Promise<unknown>;
}

interface CapabilityWorker {
	getStatus(): {
		enabled: boolean;
		running: boolean;
		connected: boolean;
		baseUrl: string | null;
		profileDirectory: string;
		browserPath: string | null;
		projectId: string | null;
		lastError: string | null;
		rendererClass: "software" | "hardware";
		pinnedCompositorBackend: "webgpu";
	};
}

interface CapabilityQueueState {
	jobs: {
		total: number;
		queued: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
	};
	batches: number;
}

export interface CapabilitySnapshotServiceOptions {
	bridge: CapabilityBridge;
	worker: CapabilityWorker;
	stateDirectory: string;
	queueState: () => Promise<CapabilityQueueState>;
	repositoryDirectory?: string;
	buildTimestamp?: string;
	environment?: Record<string, string | undefined>;
	now?: () => Date;
}

export class CapabilitySnapshotService {
	private readonly repositoryDirectory: string;
	private readonly buildTimestamp: string;
	private readonly environment: Record<string, string | undefined>;
	private readonly now: () => Date;

	constructor(private options: CapabilitySnapshotServiceOptions) {
		this.repositoryDirectory = resolve(
			options.repositoryDirectory ?? resolve(import.meta.dir, "../../.."),
		);
		this.environment = options.environment ?? globalThis.process.env;
		this.now = options.now ?? (() => new Date());
		this.buildTimestamp =
			options.buildTimestamp ??
			this.environment.OPENCUT_BUILD_TIMESTAMP ??
			this.now().toISOString();
	}

	async capture(): Promise<Record<string, unknown>> {
		const bridgeStatus = this.options.bridge.getStatus();
		const workerStatus = this.options.worker.getStatus();
		const [build, editorRuntime, mediaTools, providers, queues, disk, wasm] =
			await Promise.all([
				this.readBuildIdentity(),
				this.readEditorRuntime(bridgeStatus),
				this.readMediaTools(),
				this.readProviderReadiness(),
				this.options.queueState(),
				readDiskCapacity(this.options.stateDirectory),
				this.readWasmArtifact(),
			]);
		const capturedAt = this.now().toISOString();
		const editor = {
			status: bridgeStatus.connected ? "ready" : "unavailable",
			connected: bridgeStatus.connected,
			reason: bridgeStatus.connected
				? null
				: "OpenCut web editor is not running or connected.",
			negotiatedProtocolVersion: bridgeStatus.negotiatedProtocolVersion,
			connectionIdentity: bridgeStatus.connectionIdentity,
			runtime: editorRuntime,
		};
		const selectedBackend = readStringField(editorRuntime, "compositorBackend");
		const rendererRuntime = readRecordField(editorRuntime, "renderer");
		const reportedWasmPackageVersion = readStringField(
			editorRuntime,
			"wasmPackageVersion",
		);
		const wasmMatchesEditor =
			reportedWasmPackageVersion === null
				? null
				: reportedWasmPackageVersion === wasm.packageVersion;
		const pinnedBackend = workerStatus.pinnedCompositorBackend;
		const runtimeRendererStatus = readStringField(rendererRuntime, "status");
		const content = {
			schemaVersion: CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
			capturedAt,
			serverInstanceId: bridgeStatus.serverInstanceId,
			bridgeProtocolVersion: bridgeStatus.negotiatedProtocolVersion,
			connectionIdentity: bridgeStatus.connectionIdentity,
			build,
			schemas: {
				bridgeProtocol: CURRENT_BRIDGE_PROTOCOL_VERSION,
				operationLedger: OPERATION_LEDGER_SCHEMA_VERSION,
				exportJob: 1,
				exportReceipt: 1,
				previewReceipt: 2,
				projectStorage: 31,
			},
			projections: {
				projectContent: CURRENT_PROJECT_CONTENT_PROJECTION_VERSION,
			},
			instance: {
				serverInstanceId: bridgeStatus.serverInstanceId,
				bridge: {
					host: bridgeStatus.host,
					port: bridgeStatus.port,
					supportedProtocolVersions: [
						...bridgeStatus.supportedProtocolVersions,
					],
				},
				profileDirectory: workerStatus.profileDirectory,
				stateDirectory: resolve(this.options.stateDirectory),
			},
			tools: {
				registered: [...REGISTERED_TOOL_NAMES],
				editPlanOperationVariants: [...EDIT_PLAN_OPERATION_VARIANTS],
			},
			editor,
			renderer: {
				status:
					runtimeRendererStatus === "unavailable"
						? "unavailable"
						: selectedBackend === null
							? "unknown"
							: runtimeRendererStatus === "ready" &&
								  wasm.status === "ready" &&
								  wasmMatchesEditor !== false
								? "ready"
								: "degraded",
				reason: readStringField(rendererRuntime, "reason"),
				selectedBackend,
				pinnedBackend,
				isPinned: selectedBackend === pinnedBackend,
				rendererClass:
					readStringField(rendererRuntime, "rendererClass") ??
					(workerStatus.running ? workerStatus.rendererClass : "unknown"),
				adapterMatchesClass: readBooleanField(
					rendererRuntime,
					"adapterMatchesClass",
				),
				adapter: readRecordField(rendererRuntime, "adapter"),
				surfaceFormat: readStringField(rendererRuntime, "surfaceFormat"),
				reportedWasmPackageVersion,
				wasmMatchesEditor,
				browser: readStringField(editorRuntime, "browser"),
				wasm,
			},
			mediaTools,
			fonts: readRecordField(editorRuntime, "fonts") ?? {
				status: bridgeStatus.connected ? "unknown" : "unavailable",
				reason: bridgeStatus.connected
					? "The connected editor did not report font readiness."
					: "Font readiness requires a running web editor.",
				presets: NAMED_FONT_PRESETS.map((preset) => ({
					...preset,
					status: "unknown",
					missingDescriptors: [...preset.descriptors],
				})),
			},
			providers: {
				...providers,
				timelineTranscription: readRecordField(
					editorRuntime,
					"timelineTranscription",
				) ?? {
					status: bridgeStatus.connected ? "unknown" : "unavailable",
					reason: bridgeStatus.connected
						? "The connected editor did not report local transcription readiness."
						: "Local transcription readiness requires a running web editor.",
					model: { status: "unknown", id: null, version: null },
				},
			},
			queue: { ...queues, disk },
		};
		return { ...content, snapshotHash: hashCapabilitySnapshot(content) };
	}

	async snapshotHash(): Promise<string> {
		const snapshot = await this.capture();
		return String(snapshot.snapshotHash);
	}

	private async readBuildIdentity() {
		const packageMetadata = await readJsonRecord(
			resolve(import.meta.dir, "../package.json"),
		);
		const envCommit = this.environment.OPENCUT_BUILD_COMMIT?.trim();
		const gitCommit = envCommit
			? { ok: true as const, stdout: envCommit }
			: await runCommand(["git", "rev-parse", "HEAD"], {
					cwd: this.repositoryDirectory,
				});
		const gitStatus = await runCommand(
			["git", "status", "--porcelain", "--untracked-files=normal"],
			{ cwd: this.repositoryDirectory },
		);
		return {
			name: readStringField(packageMetadata, "name") ?? "opencut-classic",
			version: readStringField(packageMetadata, "version") ?? "unknown",
			gitCommit: gitCommit.ok ? gitCommit.stdout.trim() : "unknown",
			dirty: gitStatus.ok ? gitStatus.stdout.trim().length > 0 : false,
			buildTimestamp: this.buildTimestamp,
			identitySource: envCommit
				? "environment"
				: gitCommit.ok
					? "git"
					: "unavailable",
		};
	}

	private async readEditorRuntime(
		bridgeStatus: ReturnType<CapabilityBridge["getStatus"]>,
	) {
		if (!bridgeStatus.connected) return null;
		try {
			const value = await this.options.bridge.request(
				"read_runtime_capabilities",
				{},
				5_000,
			);
			return isRecord(value) ? value : null;
		} catch (error) {
			return {
				status: "degraded",
				reason:
					error instanceof Error
						? error.message
						: "Editor runtime capability probe failed.",
			};
		}
	}

	private async readMediaTools() {
		const ffmpeg =
			this.environment.OPENCUT_FFMPEG_PATH ??
			this.environment.FFMPEG_PATH ??
			"ffmpeg";
		const ffprobe =
			this.environment.OPENCUT_FFPROBE_PATH ??
			this.environment.FFPROBE_PATH ??
			"ffprobe";
		const [ffmpegResult, ffprobeResult] = await Promise.all([
			probeExecutable(ffmpeg, ["-version"]),
			probeExecutable(ffprobe, ["-version"]),
		]);
		return { ffmpeg: ffmpegResult, ffprobe: ffprobeResult };
	}

	private async readProviderReadiness() {
		const entries = [
			[
				"audioCleanup",
				"OPENCUT_AUDIO_CLEANER_COMMAND",
				"OPENCUT_AUDIO_CLEANER_ARGS",
			],
			[
				"matteGeneration",
				"OPENCUT_MATTE_PRODUCER_COMMAND",
				"OPENCUT_MATTE_PRODUCER_ARGS",
			],
			[
				"subjectTracking",
				"OPENCUT_SUBJECT_TRACKER_COMMAND",
				"OPENCUT_SUBJECT_TRACKER_ARGS",
			],
		] as const;
		const results = await Promise.all(
			entries.map(async ([name, commandKey, argsKey]) => {
				const command = this.environment[commandKey];
				if (!command) {
					return [
						name,
						{
							status: "unavailable",
							reason: `${commandKey} is not configured.`,
							command: null,
							version: null,
							model: { status: "unavailable", id: null, version: null },
						},
					] as const;
				}
				const args = parseArgs(this.environment[argsKey]);
				if (!args.ok) {
					return [
						name,
						{
							status: "misconfigured",
							reason: args.reason,
							command,
							version: null,
							model: { status: "unknown", id: null, version: null },
						},
					] as const;
				}
				const probe = await probeExecutable(command, [
					...args.value,
					"--version",
				]);
				return [
					name,
					{
						...probe,
						model: {
							status: probe.status === "ready" ? "unknown" : probe.status,
							id: null,
							version: null,
							reason:
								"The model is selected per request and no model probe performs inference.",
						},
					},
				] as const;
			}),
		);
		return Object.fromEntries(results);
	}

	private async readWasmArtifact() {
		const path = resolve(
			this.environment.OPENCUT_WASM_ARTIFACT_PATH ??
				resolve(
					import.meta.dir,
					"../../../node_modules/opencut-wasm/opencut_wasm_bg.wasm",
				),
		);
		const packageMetadata = await readJsonRecord(
			resolve(path, "../package.json"),
		);
		const info = await stat(path).catch(() => null);
		return info?.isFile()
			? {
					status: "ready",
					path,
					bytes: info.size,
					sha256: await hashFile(path),
					packageVersion:
						readStringField(packageMetadata, "version") ?? "unknown",
				}
			: {
					status: "unavailable",
					path,
					bytes: null,
					sha256: null,
					packageVersion:
						readStringField(packageMetadata, "version") ?? "unknown",
				};
	}
}

export function hashCapabilitySnapshot(value: unknown): string {
	return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

async function probeExecutable(command: string, versionArgs: string[]) {
	const resolvedCommand = await resolveExecutable(command);
	if (!resolvedCommand) {
		return {
			status: "misconfigured" as const,
			command,
			resolvedPath: null,
			version: null,
			reason: `Executable was not found: ${command}`,
		};
	}
	const result = await runCommand([resolvedCommand, ...versionArgs], {
		timeoutMs: 5_000,
	});
	const version = firstLine(result.stdout || result.stderr);
	return result.ok
		? {
				status: "ready" as const,
				command,
				resolvedPath: resolvedCommand,
				version,
				reason: null,
			}
		: {
				status: "misconfigured" as const,
				command,
				resolvedPath: resolvedCommand,
				version,
				reason: result.reason,
			};
}

async function resolveExecutable(command: string): Promise<string | null> {
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		const path = resolve(command);
		return (await stat(path).catch(() => null))?.isFile() ? path : null;
	}
	return Bun.which(command);
}

async function runCommand(
	command: string[],
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<
	| { ok: true; stdout: string; stderr: string }
	| { ok: false; stdout: string; stderr: string; reason: string }
> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(command, {
			cwd: options.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: "",
			reason:
				error instanceof Error ? error.message : "Command failed to start.",
		};
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, options.timeoutMs ?? 5_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		child.exited,
	]);
	clearTimeout(timer);
	if (timedOut) {
		return { ok: false, stdout, stderr, reason: "Version probe timed out." };
	}
	return exitCode === 0
		? { ok: true, stdout, stderr }
		: {
				ok: false,
				stdout,
				stderr,
				reason: `Version probe exited with code ${exitCode}.`,
			};
}

async function readDiskCapacity(directory: string) {
	const path = resolve(directory);
	await mkdir(path, { recursive: true });
	const value = await statfs(path).catch(() => null);
	return value
		? {
				status: "ready",
				path,
				freeBytes: value.bavail * value.bsize,
				totalBytes: value.blocks * value.bsize,
			}
		: {
				status: "unavailable",
				path,
				freeBytes: null,
				totalBytes: null,
			};
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function readJsonRecord(
	path: string,
): Promise<Record<string, unknown> | null> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function parseArgs(
	value: string | undefined,
): { ok: true; value: string[] } | { ok: false; reason: string } {
	if (!value) return { ok: true, value: [] };
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) &&
			parsed.every((item) => typeof item === "string")
			? { ok: true, value: parsed }
			: {
					ok: false,
					reason: "Provider arguments must be a JSON string array.",
				};
	} catch {
		return { ok: false, reason: "Provider arguments must be valid JSON." };
	}
}

function firstLine(value: string): string | null {
	return (
		value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? null
	);
}

function readStringField(
	value: Record<string, unknown> | null,
	key: string,
): string | null {
	return typeof value?.[key] === "string" ? value[key] : null;
}

function readRecordField(
	value: Record<string, unknown> | null,
	key: string,
): Record<string, unknown> | null {
	return isRecord(value?.[key]) ? value[key] : null;
}

function readBooleanField(
	value: Record<string, unknown> | null,
	key: string,
): boolean | null {
	return typeof value?.[key] === "boolean" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
