import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, statfs } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { CURRENT_BRIDGE_PROTOCOL_VERSION } from "./editor-bridge";
import { stableSerialize } from "./matte-generation-data";
import { OPERATION_LEDGER_SCHEMA_VERSION } from "./operation-ledger-schema";
import { CURRENT_PROJECT_CONTENT_PROJECTION_VERSION } from "./project-content-version";
import { EDIT_PLAN_OPERATION_VARIANTS } from "./tool-schemas";
import { readPreviewRangeLimits } from "./range-preview-config";

export const CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Caption presets whose faces ship with the editor as audited bundled bytes
 * (apps/web/src/fonts/bundled-fonts.ts); the web runtime reports readiness
 * for the same list.
 */
export const NAMED_FONT_PRESETS = [
	{
		id: "tiktok-sans-caption",
		descriptors: [
			'normal 400 16px "TikTok Sans"',
			'normal 700 16px "TikTok Sans"',
		],
	},
	{
		id: "montserrat-caption",
		descriptors: [
			'normal 400 16px "Montserrat"',
			'normal 700 16px "Montserrat"',
			'italic 700 16px "Montserrat"',
		],
	},
] as const;

export const REGISTERED_TOOL_NAMES = [
	"opencut_analyze_audio",
	"opencut_analyze_speech",
	"opencut_apply_edit_plan",
	"opencut_attach_clean_audio",
	"opencut_attach_matte",
	"opencut_cancel_comparison",
	"opencut_cancel_export_batch",
	"opencut_cancel_export_job",
	"opencut_cancel_job",
	"opencut_cancel_preview_range",
	"opencut_capabilities",
	"opencut_clean_audio",
	"opencut_clone_scene",
	"opencut_compare_project_states",
	"opencut_connection_status",
	"opencut_correct_transcript",
	"opencut_create_delivery_package",
	"opencut_create_editorial_decision",
	"opencut_create_project",
	"opencut_create_scene",
	"opencut_delete_project",
	"opencut_delete_scene",
	"opencut_diff_editorial_decision",
	"opencut_duplicate_project",
	"opencut_evaluate_export_qc",
	"opencut_export_editorial_decision_json",
	"opencut_export_project",
	"opencut_export_subtitles",
	"opencut_generate_matte",
	"opencut_get_comparison",
	"opencut_get_edit_plan_preflight",
	"opencut_get_editorial_decision",
	"opencut_get_export_batch",
	"opencut_get_export_job",
	"opencut_get_export_qc",
	"opencut_get_export_receipt",
	"opencut_get_job",
	"opencut_get_operation",
	"opencut_get_preview_frame",
	"opencut_get_preview_range",
	"opencut_get_project",
	"opencut_get_save_receipt",
	"opencut_get_speech_analysis",
	"opencut_get_transcript",
	"opencut_import_editorial_decision_json",
	"opencut_import_media",
	"opencut_import_media_asset",
	"opencut_import_subtitles",
	"opencut_list_comparisons",
	"opencut_list_edit_plan_preflights",
	"opencut_list_editorial_decisions",
	"opencut_list_effects",
	"opencut_list_export_batches",
	"opencut_list_export_jobs",
	"opencut_list_jobs",
	"opencut_list_media_usages",
	"opencut_list_operation_history",
	"opencut_list_preview_frames",
	"opencut_list_preview_ranges",
	"opencut_list_projects",
	"opencut_list_scenes",
	"opencut_list_transcripts",
	"opencut_list_visual_assets",
	"opencut_normalize_audio",
	"opencut_open_project",
	"opencut_preflight_edit_plan",
	"opencut_preflight_lifecycle_mutation",
	"opencut_preflight_media_relink",
	"opencut_query_timeline",
	"opencut_queue_export",
	"opencut_queue_export_batch",
	"opencut_reapply_editorial_decision",
	"opencut_record_export_inspection",
	"opencut_relink_media_asset",
	"opencut_remove_media_asset",
	"opencut_rename_media_asset",
	"opencut_rename_project",
	"opencut_rename_scene",
	"opencut_render_preview_frame",
	"opencut_render_preview_range",
	"opencut_reorder_scenes",
	"opencut_resolve_job",
	"opencut_retry_job",
	"opencut_run_export_jobs",
	"opencut_save_project",
	"opencut_search_stickers",
	"opencut_search_transcript",
	"opencut_set_main_scene",
	"opencut_start_editor_worker",
	"opencut_stop_editor_worker",
	"opencut_switch_scene",
	"opencut_sync_audio",
	"opencut_track_subject",
	"opencut_transcribe_source",
	"opencut_transcribe_timeline",
	"opencut_undo",
	"opencut_verify_delivery_package",
] as const;

import { EXPORT_CANCELLATION_POLICY } from "./export-jobs";
import {
	JOB_HEARTBEAT_INTERVAL_MS,
	JOB_HEARTBEAT_STALE_MS,
	JOB_LEASE_MS,
	JOB_SCHEMA_VERSION,
} from "./job-store";
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

export interface CapabilityQueueState {
	jobs: {
		total: number;
		queued: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
		cancelling?: number;
		blocked?: number;
		recoveryRequired?: number;
	};
	batches: number;
	/** Queue depth of the single-instance job queue across every job type. */
	depth?: number;
	/** The job currently holding the compositor lease, if any. */
	running?: {
		jobId: string;
		jobType: string;
		state: string;
		phase: string;
		completed: number;
		total: number | null;
		heartbeatAt: string | null;
		cancellationRequestedAt: string | null;
	} | null;
	recoveryRequired?: string[];
	byType?: Record<string, { queued: number; active: number }>;
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
	parakeetReadiness?: () => Promise<{
		ready: boolean;
		reason: string | null;
		modelId: string;
		modelRevision: string | null;
		modelCacheDirectory: string | null;
		modelArtifactPath: string | null;
		workflowScriptPath: string | null;
	}>;
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
		const [
			build,
			editorRuntime,
			mediaTools,
			providers,
			parakeet,
			queues,
			disk,
			wasm,
		] = await Promise.all([
			this.readBuildIdentity(),
			this.readEditorRuntime(bridgeStatus),
			this.readMediaTools(),
			this.readProviderReadiness(),
			this.options.parakeetReadiness?.() ?? Promise.resolve(null),
			this.options.queueState(),
			readDiskCapacity(this.options.stateDirectory),
			this.readWasmArtifact(),
		]);
		const capturedAt = this.now().toISOString();
		const previewRangeLimits = readPreviewRangeLimits(this.environment);
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
				previewRangeReceipt: 1,
				comparisonReceipt: 1,
				job: JOB_SCHEMA_VERSION,
				projectStorage: 31,
				transcript: 1,
				speechAnalysis: 1,
				editorialDecision: 1,
			},
			projections: {
				projectContent: CURRENT_PROJECT_CONTENT_PROJECTION_VERSION,
			},
			jobs: {
				status: "ready",
				schemaVersion: JOB_SCHEMA_VERSION,
				store: "sqlite-wal",
				types: [
					"export",
					"preview-range",
					"comparison",
					"transcription",
					"provider",
					"qc",
					"packaging",
				],
				states: [
					"queued",
					"starting",
					"running",
					"cancelling",
					"cancelled",
					"succeeded",
					"failed",
					"blocked",
					"recovery-required",
				],
				concurrency: "single-queue-per-instance",
				heartbeatIntervalMs: JOB_HEARTBEAT_INTERVAL_MS,
				heartbeatStaleAfterMs: JOB_HEARTBEAT_STALE_MS,
				leaseMs: JOB_LEASE_MS,
				resolutions: ["rerun-as-new-attempt", "mark-failed"],
				exportCancellation: EXPORT_CANCELLATION_POLICY,
			},
			previewRange: {
				status: "ready",
				mode: "inline",
				outputs: ["frame-sequence"],
				frameCodec: "image/png",
				audio: { supported: true, codec: "pcm-s16le", container: "audio/wav" },
				endpointPolicy: "start-inclusive-end-exclusive",
				limits: previewRangeLimits,
				cancellationObservationBound:
					"next-completed-frame-upload; during-audio: 100ms-poll-interval-plus-local-status-round-trip, terminal-after-extraction-cleanup",
			},
			comparison: {
				status: "ready",
				contractVersion: 1,
				sourceProjection: {
					name: "opencut-project-content",
					version: 2,
					supportedVersions: [1, 2],
				},
				outputs: ["side-by-side", "wipe", "pixel-diff"],
				normalization: {
					canvas: "none",
					color: "none",
					fonts: "exact",
					timing: "shared-schedule",
				},
				frameCodec: "image/png",
				audio: {
					supported: true,
					required: true,
					codec: "pcm-s16le",
					container: "audio/wav",
				},
				endpointPolicy: "start-inclusive-end-exclusive",
				limits: previewRangeLimits,
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
				sourceTranscription: parakeet
					? {
							status: parakeet.ready ? "ready" : "misconfigured",
							reason: parakeet.reason,
							provider: "nvidia-parakeet-local",
							fallback: "disabled",
							model: {
								status: parakeet.ready ? "ready" : "unavailable",
								id: parakeet.modelId,
								version: parakeet.modelRevision,
								artifactPath: parakeet.modelArtifactPath,
								cacheDirectory: parakeet.modelCacheDirectory,
							},
							workflowScriptPath: parakeet.workflowScriptPath,
						}
					: {
							status: "unknown",
							reason: "Parakeet readiness probe is unavailable.",
						},
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
