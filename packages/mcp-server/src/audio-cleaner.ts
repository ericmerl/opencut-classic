import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import {
	APPROVED_AUDIO_PROVIDER_PROTOCOL,
	CommandApprovedAudioProvider,
} from "./approved-audio-provider";
import { semanticProviderInput } from "./provider-semantic-input";
import {
	DurableProviderSupervisor,
	providerSupervisorFingerprint,
} from "./provider-supervisor";

const cleanerResponseSchema = z.object({
	protocolVersion: z.literal(1),
	status: z.literal("completed"),
	artifact: z.object({ path: z.string().min(1) }),
	model: z.object({
		id: z.string().trim().min(1),
		version: z.string().trim().min(1),
	}),
	warnings: z.array(z.string()).default([]),
});

export interface AudioCleanerJob {
	protocolVersion: 1;
	operationId: string;
	timebase: { ticksPerSecond: 120_000 };
	source: {
		path: string;
		name: string;
		mimeType: string;
		contentHash: string;
		sourceFingerprint: string | null;
		durationSeconds: number;
	};
	clip: {
		startTime: number;
		duration: number;
		trimStart: number;
		trimEnd: number;
		retimeRate: number;
		maintainPitch: boolean;
	};
	cleanup: {
		noiseReduction: number;
		deReverb: number;
		deEss: number;
		highPassHz: number;
		normalize: boolean;
	};
	outputDirectory: string;
	requestedModel?: { id?: string; version?: string };
	options: Record<string, string | number | boolean | null>;
}

export interface AudioCleanerResult {
	artifactPath: string;
	modelId: string;
	modelVersion: string;
	warnings: string[];
}

export interface AudioCleanerProtocol {
	clean(job: AudioCleanerJob, timeoutMs: number): Promise<AudioCleanerResult>;
}

export class CommandAudioCleaner implements AudioCleanerProtocol {
	constructor(
		private config: {
			command: string;
			args?: string[];
			supervisorDirectory?: string;
		},
	) {}

	async clean(
		job: AudioCleanerJob,
		timeoutMs: number,
	): Promise<AudioCleanerResult> {
		if (this.config.supervisorDirectory) return this.runSupervised(job, timeoutMs);
		return this.run(job, timeoutMs);
	}

	private async runSupervised(
		job: AudioCleanerJob,
		timeoutMs: number,
	): Promise<AudioCleanerResult> {
		const supervisor = new DurableProviderSupervisor({
			directory: this.config.supervisorDirectory!,
		});
		try {
			await supervisor.submit({
				provider: "audio-cleaner-command",
				operationId: job.operationId,
				semanticFingerprint: providerSupervisorFingerprint(
					semanticProviderInput(job),
				),
				command: this.config.command,
				args: this.config.args ?? [],
				request: job,
				timeoutMs,
			});
			const terminal = await supervisor.waitForTerminal(
				"audio-cleaner-command",
				job.operationId,
				timeoutMs + 5_000,
			);
			if (terminal.state !== "succeeded") {
				throw new Error(providerTerminalError(terminal.state, terminal.diagnostics));
			}
			return cleanerResultSchema.parse(terminal.result);
		} finally {
			supervisor.close();
		}
	}

	private async run(
		job: AudioCleanerJob,
		timeoutMs: number,
	): Promise<AudioCleanerResult> {
		const process = Bun.spawn(
			[this.config.command, ...(this.config.args ?? [])],
			{
				cwd: job.outputDirectory,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...globalThis.process.env },
			},
		);
		process.stdin.write(JSON.stringify(job));
		process.stdin.end();

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			process.kill();
		}, timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		clearTimeout(timer);
		if (timedOut) throw new Error("Audio cleaner timed out");
		if (exitCode !== 0) {
			throw new Error(
				`Audio cleaner exited with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error("Audio cleaner did not return valid JSON on stdout");
		}
		const response = cleanerResponseSchema.parse(parsed);
		const artifactPath = resolveArtifactPath({
			outputDirectory: job.outputDirectory,
			artifactPath: response.artifact.path,
		});
		const info = await stat(artifactPath).catch(() => null);
		if (!info?.isFile() || info.size === 0) {
			throw new Error("Audio cleaner did not create a non-empty artifact");
		}
		return {
			artifactPath,
			modelId: response.model.id,
			modelVersion: response.model.version,
			warnings: response.warnings,
		};
	}
}

export function commandAudioCleanerFromEnvironment(
	resultReceiptDirectory?: string,
): AudioCleanerProtocol {
	const approvedCommand =
		globalThis.process.env.OPENCUT_APPROVED_AUDIO_PROVIDER_COMMAND;
	if (approvedCommand) {
		const provider = new CommandApprovedAudioProvider({
			command: approvedCommand,
			args: parseCommandArgs(
				globalThis.process.env.OPENCUT_APPROVED_AUDIO_PROVIDER_ARGS,
				"OPENCUT_APPROVED_AUDIO_PROVIDER_ARGS",
			),
		});
		return {
			async clean(job, timeoutMs) {
				const result = await provider.run(
					{
						protocol: APPROVED_AUDIO_PROVIDER_PROTOCOL,
						operationId: job.operationId,
						task: "audio-cleanup",
						source: {
							path: job.source.path,
							contentSha256: job.source.contentHash,
						},
						outputDirectory: job.outputDirectory,
						devicePolicy: { kind: "cpu", canonical: true },
						options: {
							...job.options,
							noiseReduction: job.cleanup.noiseReduction,
							deReverb: job.cleanup.deReverb,
							deEss: job.cleanup.deEss,
							highPassHz: job.cleanup.highPassHz,
							normalize: job.cleanup.normalize,
						},
					},
					timeoutMs,
				);
				if (result.task !== "audio-cleanup") {
					throw new Error("approved audio provider returned the wrong task");
				}
				return {
					artifactPath: result.artifacts.cleaned.path,
					modelId: result.model.id,
					modelVersion: result.model.revision,
					warnings: result.warnings,
				};
			},
		};
	}
	const command = globalThis.process.env.OPENCUT_AUDIO_CLEANER_COMMAND;
	if (!command) {
		throw new Error(
			"OPENCUT_AUDIO_CLEANER_COMMAND is required for opencut_clean_audio",
		);
	}
	const args = parseCommandArgs(
		globalThis.process.env.OPENCUT_AUDIO_CLEANER_ARGS,
		"OPENCUT_AUDIO_CLEANER_ARGS",
	);
	return new CommandAudioCleaner({
		command,
		args,
		...(resultReceiptDirectory
			? { supervisorDirectory: resultReceiptDirectory }
			: {}),
	});
}

function parseCommandArgs(raw: string | undefined, name: string): string[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${name} must be a JSON array`);
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every((value) => typeof value === "string")
	) {
		throw new Error(`${name} must contain only strings`);
	}
	return parsed;
}

const cleanerResultSchema = z.object({
	artifactPath: z.string().min(1),
	modelId: z.string().min(1),
	modelVersion: z.string().min(1),
	warnings: z.array(z.string()),
});

function providerTerminalError(state: string, diagnostics: string | null): string {
	return state === "unknown"
		? `Audio cleaner outcome is durably unknown and will not be rerun: ${diagnostics ?? "supervisor stopped before publication"}`
		: `Audio cleaner failed: ${diagnostics ?? state}`;
}

function resolveArtifactPath({
	outputDirectory,
	artifactPath,
}: {
	outputDirectory: string;
	artifactPath: string;
}): string {
	const root = resolve(outputDirectory);
	const candidate = resolve(root, artifactPath);
	const child = relative(root, candidate);
	if (child === "" || child.startsWith("..") || isAbsolute(child)) {
		throw new Error(
			"Cleaned audio artifact must be inside the supplied output directory",
		);
	}
	return candidate;
}
