import { dirname } from "node:path";
import * as z from "zod/v4";
import { semanticProviderInput } from "./provider-semantic-input";
import {
	DurableProviderSupervisor,
	providerSupervisorFingerprint,
} from "./provider-supervisor";

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

const trackerResponseSchema = z.object({
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
}

export interface SubjectTrackerJob {
	protocolVersion: 1;
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
	};
	requestedModel?: { id?: string; version?: string };
	options: Record<string, string | number | boolean | null>;
}

export interface SubjectTrackerResult {
	samples: SubjectTrackingSample[];
	modelId: string;
	modelVersion: string;
	warnings: string[];
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
		if (this.config.supervisorDirectory) return this.runSupervised(job, timeoutMs);
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
				throw new Error(providerTerminalError(terminal.state, terminal.diagnostics));
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
		const response = trackerResponseSchema.parse(parsed);
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
});

function providerTerminalError(state: string, diagnostics: string | null): string {
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
