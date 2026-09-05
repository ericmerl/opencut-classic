import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { semanticProviderInput } from "./provider-semantic-input";
import {
	DurableProviderSupervisor,
	providerSupervisorFingerprint,
} from "./provider-supervisor";

export const APPROVED_SAM21_MODEL = {
	id: "facebook/sam2.1-hiera-small",
	revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
	artifact: "model.safetensors",
	artifactSha256:
		"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
	codeRevision: "2b90b9f5ceec907a1c18123530e92e794ad901a4",
	license: "Apache-2.0",
} as const;

const normalizedBoxSchema = z
	.object({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().min(0.001).max(1),
		height: z.number().min(0.001).max(1),
	})
	.refine((box) => box.x + box.width <= 1, {
		message: "tracking box x + width must be at most 1",
	})
	.refine((box) => box.y + box.height <= 1, {
		message: "tracking box y + height must be at most 1",
	});

const trackerResponseV1Schema = z.object({
	protocolVersion: z.literal(1),
	status: z.literal("completed"),
	coordinateSpace: z.literal("normalized-source"),
	samples: z
		.array(
			z.object({
				sourceTime: z.number().int().nonnegative(),
				box: normalizedBoxSchema,
				confidence: z.number().min(0).max(1).optional(),
			}),
		)
		.min(1)
		.max(10_000),
	model: z.object({
		id: z.string().trim().min(1),
		version: z.string().trim().min(1),
	}),
	warnings: z.array(z.string()).default([]),
});

const trackingSampleV2Schema = z.object({
	sampleId: z.string().trim().min(1),
	sourceTimeTicks: z.number().int().nonnegative(),
	box: normalizedBoxSchema,
	confidence: z.number().min(0).max(1),
	occlusion: z.enum(["visible", "partial", "occluded", "unknown"]),
});

const trackerResponseV2Schema = z.object({
	protocolVersion: z.literal(2),
	status: z.literal("completed"),
	coordinateSpace: z.literal("normalized-source"),
	coverage: z.object({
		startTicks: z.number().int().nonnegative(),
		endTicks: z.number().int().positive(),
	}),
	subjects: z
		.array(
			z.object({
				subjectId: z.string().trim().min(1),
				label: z.string().trim().min(1).optional(),
				samples: z.array(trackingSampleV2Schema).min(2).max(10_000),
				corrections: z
					.array(
						z.object({
							correctionId: z.string().trim().min(1),
							sourceTimeTicks: z.number().int().nonnegative(),
							box: normalizedBoxSchema,
							note: z.string().trim().min(1),
						}),
					)
					.default([]),
			}),
		)
		.min(1)
		.max(1_024),
	artifacts: z
		.array(
			z.object({
				artifactId: z.string().trim().min(1),
				kind: z.literal("binary-mask-sequence"),
				path: z.string().trim().min(1),
				contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
				bytes: z.number().int().positive(),
			}),
		)
		.max(1_024),
	model: z.object({
		id: z.string().trim().min(1),
		revision: z.string().regex(/^[a-f0-9]{40}$/),
		artifact: z.literal("model.safetensors"),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
		license: z.literal("Apache-2.0"),
	}),
	runtime: z.object({
		device: z.enum(["cpu", "cuda"]),
		framework: z.literal("facebookresearch/sam2"),
		deterministic: z.literal(true),
	}),
	warnings: z.array(z.string()).default([]),
});

export interface NormalizedTrackingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SubjectTrackingSample {
	sourceTime: number;
	box: NormalizedTrackingBox;
	confidence?: number;
	occlusion?: "visible" | "partial" | "occluded" | "unknown";
	sampleId?: string;
}

export interface SubjectTrackerJob {
	protocolVersion: 1 | 2;
	operationId: string;
	timebase: { ticksPerSecond: 120_000 };
	source: {
		path: string;
		name: string;
		mimeType: string;
		contentHash: string;
		sourceFingerprint: string | null;
		width: number;
		height: number;
		durationTicks: number;
		fps: number | null;
	};
	clip: {
		trimStart: number;
		trimEnd: number;
		duration: number;
		retimeRate: number;
	};
	sampling: {
		intervalTicks: number;
		maxSamples: number;
	};
	subject?: {
		prompt?: string;
		initialBox?: NormalizedTrackingBox;
		corrections?: Array<{
			correctionId: string;
			sourceTimeTicks: number;
			box: NormalizedTrackingBox;
			note: string;
		}>;
	};
	requestedModel?: {
		id?: string;
		version?: string;
		revision?: string;
		artifactSha256?: string;
		codeRevision?: string;
	};
	coverage?: { startTicks: number; endTicks: number };
	outputDirectory?: string;
	options: Record<string, string | number | boolean | null>;
}

export interface SubjectTrackerResult {
	samples: SubjectTrackingSample[];
	modelId: string;
	modelVersion: string;
	warnings: string[];
	device?: "cpu" | "cuda";
	subjects?: Array<{
		subjectId: string;
		label?: string;
		samples: Array<{
			sampleId: string;
			sourceTimeTicks: number;
			box: NormalizedTrackingBox;
			confidence: number;
			occlusion: "visible" | "partial" | "occluded" | "unknown";
		}>;
		corrections: Array<{
			correctionId: string;
			sourceTimeTicks: number;
			box: NormalizedTrackingBox;
			note: string;
		}>;
	}>;
	artifacts?: Array<{
		artifactId: string;
		kind: "binary-mask-sequence";
		path: string;
		contentSha256: string;
		bytes: number;
	}>;
	modelArtifactSha256?: string;
	codeRevision?: string;
}

export class CommandSubjectTracker {
	constructor(
		private config: {
			command: string;
			args?: string[];
			supervisorDirectory?: string;
		},
	) {}

	async track(
		job: SubjectTrackerJob,
		timeoutMs: number,
	): Promise<SubjectTrackerResult> {
		if (this.config.supervisorDirectory)
			return this.runSupervised(job, timeoutMs);
		return this.run(job, timeoutMs);
	}

	private async runSupervised(
		job: SubjectTrackerJob,
		timeoutMs: number,
	): Promise<SubjectTrackerResult> {
		const supervisor = new DurableProviderSupervisor({
			directory: this.config.supervisorDirectory!,
		});
		try {
			await supervisor.submit({
				provider: "subject-tracker-command",
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
				"subject-tracker-command",
				job.operationId,
				timeoutMs + 5_000,
			);
			if (terminal.state !== "succeeded") {
				throw new Error(
					providerTerminalError(terminal.state, terminal.diagnostics),
				);
			}
			return trackerResultSchema.parse(terminal.result);
		} finally {
			supervisor.close();
		}
	}

	private async run(
		job: SubjectTrackerJob,
		timeoutMs: number,
	): Promise<SubjectTrackerResult> {
		const process = Bun.spawn(
			[this.config.command, ...(this.config.args ?? [])],
			{
				cwd: dirname(job.source.path),
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
		if (timedOut) throw new Error("Subject tracker timed out");
		if (exitCode !== 0) {
			throw new Error(
				`Subject tracker exited with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error("Subject tracker did not return valid JSON on stdout");
		}
		return parseTrackerResponse(job, parsed);
	}
}

export function commandSubjectTrackerFromEnvironment(
	resultReceiptDirectory?: string,
): CommandSubjectTracker {
	const command = globalThis.process.env.OPENCUT_SUBJECT_TRACKER_COMMAND;
	if (!command) {
		throw new Error(
			"OPENCUT_SUBJECT_TRACKER_COMMAND is required for opencut_track_subject",
		);
	}
	const rawArgs = globalThis.process.env.OPENCUT_SUBJECT_TRACKER_ARGS;
	let args: string[] = [];
	if (rawArgs) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArgs);
		} catch {
			throw new Error("OPENCUT_SUBJECT_TRACKER_ARGS must be a JSON array");
		}
		if (
			!Array.isArray(parsed) ||
			!parsed.every((value) => typeof value === "string")
		) {
			throw new Error("OPENCUT_SUBJECT_TRACKER_ARGS must contain only strings");
		}
		args = parsed;
	}
	return new CommandSubjectTracker({
		command,
		args,
		...(resultReceiptDirectory
			? { supervisorDirectory: resultReceiptDirectory }
			: {}),
	});
}

const trackerResultSchema = z.object({
	samples: z.array(
		z.object({
			sourceTime: z.number().int().nonnegative(),
			box: normalizedBoxSchema,
			confidence: z.number().min(0).max(1).optional(),
		}),
	),
	modelId: z.string().min(1),
	modelVersion: z.string().min(1),
	warnings: z.array(z.string()),
	device: z.enum(["cpu", "cuda"]).optional(),
	subjects: trackerResponseV2Schema.shape.subjects.optional(),
	artifacts: trackerResponseV2Schema.shape.artifacts.optional(),
	modelArtifactSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	codeRevision: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.optional(),
});

async function parseTrackerResponse(
	job: SubjectTrackerJob,
	parsed: unknown,
): Promise<SubjectTrackerResult> {
	if (isRecord(parsed) && parsed.protocolVersion === 2) {
		const response = trackerResponseV2Schema.parse(parsed);
		if (job.protocolVersion !== 2) {
			throw new Error("Subject tracker returned protocol v2 for a v1 request");
		}
		const requestedCoverage = job.coverage ?? {
			startTicks: 0,
			endTicks: job.source.durationTicks,
		};
		if (
			response.coverage.startTicks !== requestedCoverage.startTicks ||
			response.coverage.endTicks !== requestedCoverage.endTicks
		) {
			throw new Error("Subject tracker coverage does not match the request");
		}
		validateApprovedModel(job, response.model);
		for (const subject of response.subjects) {
			validateSamples({
				samples: subject.samples.map((sample) => ({
					sourceTime: sample.sourceTimeTicks,
					box: sample.box,
					confidence: sample.confidence,
				})),
				sourceDuration: requestedCoverage.endTicks,
				maxSamples: job.sampling.maxSamples,
			});
			if (
				subject.samples[0]?.sourceTimeTicks !== requestedCoverage.startTicks ||
				subject.samples.at(-1)?.sourceTimeTicks !== requestedCoverage.endTicks
			) {
				throw new Error(
					"Subject tracker must include first and last coverage samples",
				);
			}
		}
		if (!job.outputDirectory && response.artifacts.length > 0) {
			throw new Error(
				"Subject tracker returned artifacts without an output directory",
			);
		}
		const artifacts = await Promise.all(
			response.artifacts.map(async (artifact) => {
				const path = resolveContainedPath(job.outputDirectory!, artifact.path);
				const info = await stat(path).catch(() => null);
				if (!info?.isFile() || info.size !== artifact.bytes) {
					throw new Error("Subject tracker mask artifact size does not match");
				}
				if ((await hashFile(path)) !== artifact.contentSha256) {
					throw new Error("Subject tracker mask artifact hash does not match");
				}
				return { ...artifact, path };
			}),
		);
		const primary = response.subjects[0]!;
		return {
			samples: primary.samples.map((sample) => ({
				sourceTime: sample.sourceTimeTicks,
				box: sample.box,
				confidence: sample.confidence,
				occlusion: sample.occlusion,
				sampleId: sample.sampleId,
			})),
			modelId: response.model.id,
			modelVersion: response.model.revision,
			modelArtifactSha256: response.model.sha256,
			codeRevision: response.model.codeRevision,
			device: response.runtime.device,
			subjects: response.subjects,
			artifacts,
			warnings: response.warnings,
		};
	}

	const response = trackerResponseV1Schema.parse(parsed);
	if (job.protocolVersion === 2) {
		throw new Error(
			"Subject tracker protocol downgrade from v2 to v1 is forbidden",
		);
	}
	validateSamples({
		samples: response.samples,
		sourceDuration: job.source.durationTicks,
		maxSamples: job.sampling.maxSamples,
	});
	return {
		samples: response.samples,
		modelId: response.model.id,
		modelVersion: response.model.version,
		warnings: response.warnings,
	};
}

function validateApprovedModel(
	job: SubjectTrackerJob,
	model: z.infer<typeof trackerResponseV2Schema>["model"],
): void {
	const requested = job.requestedModel;
	if (requested?.id && model.id !== requested.id) {
		throw new Error("Subject tracker model ID does not match the request");
	}
	const revision = requested?.revision ?? requested?.version;
	if (revision && model.revision !== revision) {
		throw new Error(
			"Subject tracker model revision does not match the request",
		);
	}
	if (requested?.artifactSha256 && model.sha256 !== requested.artifactSha256) {
		throw new Error("Subject tracker model hash does not match the request");
	}
	if (
		requested?.codeRevision &&
		model.codeRevision !== requested.codeRevision
	) {
		throw new Error("Subject tracker code revision does not match the request");
	}
}

function resolveContainedPath(
	rootDirectory: string,
	artifactPath: string,
): string {
	const root = resolve(rootDirectory);
	const path = resolve(root, artifactPath);
	const child = relative(root, path);
	if (child.startsWith("..") || isAbsolute(child)) {
		throw new Error("Subject tracker artifact escapes its output directory");
	}
	return path;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerTerminalError(
	state: string,
	diagnostics: string | null,
): string {
	return state === "unknown"
		? `Subject tracker outcome is durably unknown and will not be rerun: ${diagnostics ?? "supervisor stopped before publication"}`
		: `Subject tracker failed: ${diagnostics ?? state}`;
}

function validateSamples({
	samples,
	sourceDuration,
	maxSamples,
}: {
	samples: SubjectTrackingSample[];
	sourceDuration: number;
	maxSamples: number;
}): void {
	if (samples.length > maxSamples) {
		throw new Error("Subject tracker exceeded the requested sample limit");
	}
	let previousTime = -1;
	for (const sample of samples) {
		if (sample.sourceTime <= previousTime) {
			throw new Error(
				"Subject tracker samples must have increasing sourceTime",
			);
		}
		if (sample.sourceTime > sourceDuration) {
			throw new Error("Subject tracker sample exceeds the source duration");
		}
		previousTime = sample.sourceTime;
	}
}
