import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import type {
	SourceTranscriber,
	SourceTranscriptionResult,
} from "./transcript-service";

const DEFAULT_MODEL_ID = "nvidia/parakeet-tdt-0.6b-v2";

const workflowArtifactSchema = z
	.object({
		model: z.literal(DEFAULT_MODEL_ID),
		workflowVersion: z.string().trim().min(1),
		decision: z.string().trim().min(1),
		usedFallback: z.boolean(),
		reviewReasons: z.array(z.string()).default([]),
		text: z.string(),
		words: z
			.array(
				z
					.object({
						word: z.string().trim().min(1),
						start: z.number().finite().nonnegative(),
						end: z.number().finite().nonnegative(),
						probability: z.number().min(0).max(1).nullish(),
						confidence: z.number().min(0).max(1).nullish(),
						speaker: z.string().trim().min(1).nullish(),
					})
					.passthrough(),
			)
			.max(1_000_000),
		gpu: z.string().trim().min(1),
		torch: z.string().trim().min(1),
	})
	.passthrough();

export interface ParakeetTranscriberConfig {
	command: string;
	args: string[];
	modelId: typeof DEFAULT_MODEL_ID;
	modelRevision: string;
	modelArtifactPath: string;
	modelArtifactSha256: string;
	modelCacheDirectory: string;
	workflowScriptPath: string;
	extraEnvironment?: Record<string, string>;
}

export interface ParakeetReadiness {
	ready: boolean;
	reason: string | null;
	modelId: string;
	modelRevision: string | null;
	modelCacheDirectory: string | null;
	modelArtifactPath: string | null;
	workflowScriptPath: string | null;
}

export class ParakeetTranscriber implements SourceTranscriber {
	constructor(private config: ParakeetTranscriberConfig) {}

	async transcribe(input: {
		operationId: string;
		sourcePath: string;
		sourceName: string;
		sourceContentHash: string;
		language: "en";
		terms: string[];
		outputDirectory: string;
		timeoutMs: number;
	}): Promise<SourceTranscriptionResult> {
		await verifyConfiguredModel(this.config);
		await mkdir(input.outputDirectory, { recursive: true });
		const artifactPath = join(input.outputDirectory, "transcript.json");
		const process = Bun.spawn(
			[
				this.config.command,
				...this.config.args,
				input.sourcePath,
				"--output-dir",
				input.outputDirectory,
				"--force",
				"--no-fallback",
				...input.terms.flatMap((term) => ["--term", term]),
			],
			{
				cwd: input.outputDirectory,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...globalThis.process.env,
					...this.config.extraEnvironment,
					HF_HOME: this.config.modelCacheDirectory,
					HF_HUB_OFFLINE: "1",
					TRANSFORMERS_OFFLINE: "1",
				},
			},
		);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			process.kill();
		}, input.timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		clearTimeout(timer);
		if (timedOut) throw new Error("Parakeet transcription timed out");
		if (exitCode !== 0) {
			throw new Error(
				`Parakeet transcription exited with code ${exitCode}: ${lastDiagnostic(stderr || stdout)}`,
			);
		}
		let artifact: z.infer<typeof workflowArtifactSchema>;
		try {
			artifact = workflowArtifactSchema.parse(
				JSON.parse(await readFile(artifactPath, "utf8")),
			);
		} catch (error) {
			throw new Error(
				`Parakeet workflow artifact is invalid: ${error instanceof Error ? error.message : "invalid JSON"}`,
			);
		}
		if (artifact.usedFallback) {
			throw new Error(
				"Parakeet workflow unexpectedly used a fallback recognizer",
			);
		}
		const scriptHash = await hashFile(this.config.workflowScriptPath);
		const modelInfo = await stat(this.config.modelArtifactPath);
		return {
			language: input.language,
			text: artifact.text,
			words: artifact.words.map((word) => ({
				text: word.word,
				startSeconds: word.start,
				endSeconds: word.end,
				confidence: word.confidence ?? word.probability ?? null,
				speaker: word.speaker ?? null,
			})),
			provider: {
				providerId: "nvidia-parakeet-local",
				providerVersion: scriptHash,
				workflowVersion: artifact.workflowVersion,
				modelId: this.config.modelId,
				modelRevision: this.config.modelRevision,
				modelArtifact: {
					path: resolve(this.config.modelArtifactPath),
					bytes: modelInfo.size,
					sha256: this.config.modelArtifactSha256,
				},
				device: "cuda",
				deviceName: artifact.gpu,
				runtime: {
					torch: artifact.torch,
					offlineModelCache: true,
					sourceContentHash: input.sourceContentHash,
				},
				decision: artifact.decision,
				usedFallback: false,
				reviewReasons: artifact.reviewReasons,
				warnings:
					artifact.reviewReasons.length > 0
						? ["Parakeet candidate disagreement requires review"]
						: [],
			},
			artifactPath,
		};
	}
}

export async function parakeetTranscriberFromEnvironment(): Promise<ParakeetTranscriber> {
	const config = await readParakeetConfig();
	return new ParakeetTranscriber(config);
}

export async function readParakeetReadiness(): Promise<ParakeetReadiness> {
	try {
		const config = await readParakeetConfig();
		for (const path of [
			config.command,
			config.workflowScriptPath,
			config.modelArtifactPath,
		]) {
			if (!(await stat(path).catch(() => null))) {
				throw new Error(`configured path does not exist: ${path}`);
			}
		}
		return {
			ready: true,
			reason: null,
			modelId: config.modelId,
			modelRevision: config.modelRevision,
			modelCacheDirectory: config.modelCacheDirectory,
			modelArtifactPath: config.modelArtifactPath,
			workflowScriptPath: config.workflowScriptPath,
		};
	} catch (error) {
		return {
			ready: false,
			reason:
				error instanceof Error
					? error.message
					: "Parakeet configuration is unavailable",
			modelId: DEFAULT_MODEL_ID,
			modelRevision:
				globalThis.process.env.OPENCUT_PARAKEET_MODEL_REVISION ?? null,
			modelCacheDirectory:
				globalThis.process.env.OPENCUT_PARAKEET_MODEL_CACHE ?? null,
			modelArtifactPath:
				globalThis.process.env.OPENCUT_PARAKEET_MODEL_ARTIFACT ?? null,
			workflowScriptPath:
				globalThis.process.env.OPENCUT_PARAKEET_WORKFLOW_SCRIPT ?? null,
		};
	}
}

async function readParakeetConfig(): Promise<ParakeetTranscriberConfig> {
	const command =
		globalThis.process.env.OPENCUT_PARAKEET_PYTHON ??
		globalThis.process.env.PARAKEET_PYTHON;
	if (!command) {
		throw new Error(
			"OPENCUT_PARAKEET_PYTHON must name the proven CUDA/NeMo Python executable",
		);
	}
	const workflowScriptPath =
		globalThis.process.env.OPENCUT_PARAKEET_WORKFLOW_SCRIPT ??
		join(
			homedir(),
			".codex",
			"skills",
			"transcribe-media",
			"scripts",
			"transcribe_media.py",
		);
	const modelCacheDirectory =
		globalThis.process.env.OPENCUT_PARAKEET_MODEL_CACHE;
	if (!modelCacheDirectory) {
		throw new Error(
			"OPENCUT_PARAKEET_MODEL_CACHE is required so transcription never resolves a floating model",
		);
	}
	const modelRevision =
		globalThis.process.env.OPENCUT_PARAKEET_MODEL_REVISION ??
		(await discoverSingleRevision(modelCacheDirectory));
	const modelArtifactPath =
		globalThis.process.env.OPENCUT_PARAKEET_MODEL_ARTIFACT ??
		(await discoverModelArtifact(modelCacheDirectory, modelRevision));
	const modelArtifactSha256 =
		globalThis.process.env.OPENCUT_PARAKEET_MODEL_SHA256;
	if (!modelArtifactSha256 || !/^[a-f0-9]{64}$/.test(modelArtifactSha256)) {
		throw new Error(
			"OPENCUT_PARAKEET_MODEL_SHA256 must pin the cached .nemo bytes",
		);
	}
	return {
		command: resolve(command),
		args: [resolve(workflowScriptPath)],
		modelId: DEFAULT_MODEL_ID,
		modelRevision,
		modelArtifactPath: resolve(modelArtifactPath),
		modelArtifactSha256,
		modelCacheDirectory: resolve(modelCacheDirectory),
		workflowScriptPath: resolve(workflowScriptPath),
	};
}

async function discoverSingleRevision(cacheDirectory: string): Promise<string> {
	const directory = join(
		resolve(cacheDirectory),
		"hub",
		"models--nvidia--parakeet-tdt-0.6b-v2",
		"snapshots",
	);
	const entries = (
		await readdir(directory, { withFileTypes: true }).catch(() => [])
	).filter((entry) => entry.isDirectory());
	if (entries.length !== 1) {
		throw new Error(
			"OPENCUT_PARAKEET_MODEL_REVISION is required unless the model cache contains exactly one revision",
		);
	}
	return entries[0]!.name;
}

async function discoverModelArtifact(
	cacheDirectory: string,
	revision: string,
): Promise<string> {
	const directory = join(
		resolve(cacheDirectory),
		"hub",
		"models--nvidia--parakeet-tdt-0.6b-v2",
		"snapshots",
		revision,
	);
	const entries = (
		await readdir(directory, { withFileTypes: true }).catch(() => [])
	).filter((entry) => entry.isFile() || entry.isSymbolicLink());
	const models = entries.filter((entry) => entry.name.endsWith(".nemo"));
	if (models.length !== 1) {
		throw new Error(
			"OPENCUT_PARAKEET_MODEL_ARTIFACT is required unless the pinned snapshot contains exactly one .nemo file",
		);
	}
	return join(directory, models[0]!.name);
}

async function verifyConfiguredModel(
	config: ParakeetTranscriberConfig,
): Promise<void> {
	const info = await stat(config.modelArtifactPath).catch(() => null);
	if (!info?.isFile() || info.size === 0) {
		throw new Error("pinned Parakeet model artifact is missing");
	}
	if (
		(await hashFile(config.modelArtifactPath)) !== config.modelArtifactSha256
	) {
		throw new Error("pinned Parakeet model artifact hash mismatch");
	}
}

function lastDiagnostic(value: string): string {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1)?.slice(0, 2_000) ?? "no diagnostic output";
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export function parakeetModelId(): string {
	return DEFAULT_MODEL_ID;
}
