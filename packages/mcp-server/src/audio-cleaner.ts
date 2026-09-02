import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
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

export class CommandAudioCleaner {
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
): CommandAudioCleaner {
	const command = globalThis.process.env.OPENCUT_AUDIO_CLEANER_COMMAND;
	if (!command) {
		throw new Error(
			"OPENCUT_AUDIO_CLEANER_COMMAND is required for opencut_clean_audio",
		);
	}
	const rawArgs = globalThis.process.env.OPENCUT_AUDIO_CLEANER_ARGS;
	let args: string[] = [];
	if (rawArgs) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArgs);
		} catch {
			throw new Error("OPENCUT_AUDIO_CLEANER_ARGS must be a JSON array");
		}
		if (
			!Array.isArray(parsed) ||
			!parsed.every((value) => typeof value === "string")
		) {
			throw new Error("OPENCUT_AUDIO_CLEANER_ARGS must contain only strings");
		}
		args = parsed;
	}
	return new CommandAudioCleaner({
		command,
		args,
		...(resultReceiptDirectory
			? { supervisorDirectory: resultReceiptDirectory }
			: {}),
	});
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
