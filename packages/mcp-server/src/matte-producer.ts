import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";

const producerResponseSchema = z.object({
	protocolVersion: z.literal(1),
	status: z.literal("completed"),
	artifact: z.object({
		path: z.string().min(1),
		channel: z.enum(["alpha", "red"]),
	}),
	model: z.object({
		id: z.string().trim().min(1),
		version: z.string().trim().min(1),
	}),
	warnings: z.array(z.string()).default([]),
});

export interface MatteProducerJob {
	protocolVersion: 1;
	operationId: string;
	source: {
		path: string;
		name: string;
		mimeType: string;
		contentHash: string;
		sourceFingerprint: string | null;
		width: number;
		height: number;
		duration: number;
		fps: number | null;
	};
	outputDirectory: string;
	requestedModel?: { id?: string; version?: string };
	options: Record<string, string | number | boolean | null>;
}

export interface MatteProducerResult {
	artifactPath: string;
	channel: "alpha" | "red";
	modelId: string;
	modelVersion: string;
	warnings: string[];
}

export class CommandMatteProducer {
	constructor(
		private config: {
			command: string;
			args?: string[];
		},
	) {}

	async produce(
		job: MatteProducerJob,
		timeoutMs: number,
	): Promise<MatteProducerResult> {
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
		if (timedOut) throw new Error("Matte producer timed out");
		if (exitCode !== 0) {
			throw new Error(
				`Matte producer exited with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error("Matte producer did not return valid JSON on stdout");
		}
		const response = producerResponseSchema.parse(parsed);
		const artifactPath = resolveArtifactPath({
			outputDirectory: job.outputDirectory,
			artifactPath: response.artifact.path,
		});
		const info = await stat(artifactPath).catch(() => null);
		if (!info?.isFile() || info.size === 0) {
			throw new Error("Matte producer did not create a non-empty artifact");
		}
		return {
			artifactPath,
			channel: response.artifact.channel,
			modelId: response.model.id,
			modelVersion: response.model.version,
			warnings: response.warnings,
		};
	}
}

export function commandMatteProducerFromEnvironment(): CommandMatteProducer {
	const command = globalThis.process.env.OPENCUT_MATTE_PRODUCER_COMMAND;
	if (!command) {
		throw new Error(
			"OPENCUT_MATTE_PRODUCER_COMMAND is required for opencut_generate_matte",
		);
	}
	const rawArgs = globalThis.process.env.OPENCUT_MATTE_PRODUCER_ARGS;
	let args: string[] = [];
	if (rawArgs) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArgs);
		} catch {
			throw new Error("OPENCUT_MATTE_PRODUCER_ARGS must be a JSON array");
		}
		if (
			!Array.isArray(parsed) ||
			!parsed.every((value) => typeof value === "string")
		) {
			throw new Error("OPENCUT_MATTE_PRODUCER_ARGS must contain only strings");
		}
		args = parsed;
	}
	return new CommandMatteProducer({ command, args });
}

export async function hashSourceFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
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
			"Matte artifact must be inside the supplied output directory",
		);
	}
	return candidate;
}
