import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";

export const APPROVED_AUDIO_PROVIDER_PROTOCOL =
	"opencut.approved-audio-provider.v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const modelSchema = z.object({
	id: z.string().min(1),
	revision: z.string().min(1),
	artifactSha256: sha256Schema,
});
const runtimeSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
	revision: z.string().min(1).optional(),
});
const cpuDeviceSchema = z.object({
	kind: z.literal("cpu"),
	runtime: z.string().min(1),
	canonical: z.literal(true),
	executionProvider: z.string().min(1).optional(),
	intraOpThreads: z.number().int().positive().optional(),
	interOpThreads: z.number().int().positive().optional(),
});
const audioArtifactSchema = z.object({
	path: z.string().min(1),
	role: z.string().min(1),
	sampleRate: z.number().int().positive(),
	channels: z.number().int().positive(),
	sampleCount: z.number().int().nonnegative(),
});

const cleanupResponseSchema = z.object({
	protocol: z.literal(APPROVED_AUDIO_PROVIDER_PROTOCOL),
	status: z.literal("completed"),
	task: z.literal("audio-cleanup"),
	model: modelSchema,
	runtime: runtimeSchema,
	device: cpuDeviceSchema,
	artifacts: z.object({
		original: audioArtifactSchema.extend({ role: z.literal("before") }),
		cleaned: audioArtifactSchema.extend({ role: z.literal("after") }),
	}),
	warnings: z.array(z.string()).default([]),
});
const stemResponseSchema = z.object({
	protocol: z.literal(APPROVED_AUDIO_PROVIDER_PROTOCOL),
	status: z.literal("completed"),
	task: z.literal("stem-separation"),
	model: modelSchema,
	runtime: runtimeSchema,
	device: cpuDeviceSchema,
	residualPolicy: z.literal("sample-wise-source-minus-vocals-f32-v1"),
	artifacts: z.object({
		vocals: audioArtifactSchema.extend({ role: z.literal("vocals") }),
		accompaniment: audioArtifactSchema.extend({
			role: z.literal("accompaniment-residual"),
		}),
	}),
	warnings: z.array(z.string()).default([]),
});
const vadResponseSchema = z.object({
	protocol: z.literal(APPROVED_AUDIO_PROVIDER_PROTOCOL),
	status: z.literal("completed"),
	task: z.literal("voice-activity-detection"),
	model: modelSchema,
	runtime: runtimeSchema,
	device: cpuDeviceSchema.extend({
		executionProvider: z.literal("CPUExecutionProvider"),
		intraOpThreads: z.literal(1),
		interOpThreads: z.literal(1),
	}),
	sampleRate: z.literal(16_000),
	sampleCount: z.number().int().nonnegative(),
	ranges: z.array(
		z.object({
			startSample: z.number().int().nonnegative(),
			endSampleExclusive: z.number().int().positive(),
			confidence: z.number().min(0).max(1),
		}),
	),
	warnings: z.array(z.string()).default([]),
});
const responseSchema = z.discriminatedUnion("task", [
	cleanupResponseSchema,
	stemResponseSchema,
	vadResponseSchema,
]);

export interface ApprovedAudioProviderRequest {
	protocol: typeof APPROVED_AUDIO_PROVIDER_PROTOCOL;
	operationId: string;
	task: "audio-cleanup" | "stem-separation" | "voice-activity-detection";
	source: { path: string; contentSha256: string };
	outputDirectory: string;
	devicePolicy: { kind: "cpu"; canonical: true };
	options: Record<string, string | number | boolean | null>;
}

export type ApprovedAudioProviderResult =
	| (z.infer<typeof cleanupResponseSchema> & {
			artifacts: {
				original: PublishedAudioArtifact;
				cleaned: PublishedAudioArtifact;
			};
	  })
	| (z.infer<typeof stemResponseSchema> & {
			artifacts: {
				vocals: PublishedAudioArtifact;
				accompaniment: PublishedAudioArtifact;
			};
	  })
	| z.infer<typeof vadResponseSchema>;

export interface PublishedAudioArtifact<Role extends string = string> {
	path: string;
	role: Role;
	sampleRate: number;
	channels: number;
	sampleCount: number;
	contentSha256: string;
	bytes: number;
}

const APPROVED = {
	"audio-cleanup": {
		model: {
			id: "speechbrain/metricgan-plus-voicebank",
			revision: "a196ce26b3bdace6fa1d819017584bdbcce462a8",
			artifactSha256:
				"147bfb866bac8264603546e035bf283370e716ed2f4b7412d308d2bcee88304f",
		},
		runtime: {
			id: "speechbrain/speechbrain",
			version: "1.1.1",
			revision: "89ead74d163463d30c62329a09cfdb4c54f5abc1",
		},
	},
	"stem-separation": {
		model: {
			id: "sigsep/open-unmix-umxhq-vocals",
			revision: "1.0.1",
			artifactSha256:
				"b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
		},
		runtime: {
			id: "sigsep/open-unmix-pytorch",
			version: "1.3.0",
			revision: "814f144e34b2d1ed517eb605ce928dcb838abbed",
		},
	},
	"voice-activity-detection": {
		model: {
			id: "silero-vad",
			revision: "7e30209a3e901f9842f81b225f3e93d8199902b1",
			artifactSha256:
				"1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
		},
	},
} as const;

export class CommandApprovedAudioProvider {
	constructor(private readonly config: { command: string; args?: string[] }) {}

	async run(
		request: ApprovedAudioProviderRequest,
		timeoutMs: number,
	): Promise<ApprovedAudioProviderResult> {
		validateRequest(request, timeoutMs);
		const sourceWave = await inspectWave(request.source.path);
		validateSourceDomain(request.task, sourceWave);
		await mkdir(request.outputDirectory, { recursive: true });
		const child = Bun.spawn(
			[this.config.command, ...(this.config.args ?? [])],
			{
				cwd: request.outputDirectory,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			},
		);
		child.stdin.write(JSON.stringify(request));
		child.stdin.end();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		clearTimeout(timer);
		if (timedOut) throw new Error("approved audio provider timed out");
		if (exitCode !== 0) {
			throw new Error(
				`approved audio provider exited with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`,
			);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(stdout);
		} catch {
			throw new Error("approved audio provider returned invalid JSON");
		}
		const response = responseSchema.parse(raw);
		if (response.task !== request.task) {
			throw new Error("approved audio provider returned the wrong task");
		}
		validateApprovedIdentity(response);

		if (response.task === "voice-activity-detection") {
			validateVad(response, sourceWave.sampleCount);
			return response;
		}
		if (response.task === "audio-cleanup") {
			if (resolve(response.artifacts.original.path) !== resolve(request.source.path)) {
				throw new Error("cleanup A/B original must identify the exact source file");
			}
			const original = await publishSourceArtifact(
				response.artifacts.original,
				request.source.path,
				sourceWave,
			);
			const cleaned = await publishOutputArtifact(
				response.artifacts.cleaned,
				request.outputDirectory,
				sourceWave,
			);
			return { ...response, artifacts: { original, cleaned } };
		}

		const vocals = await publishOutputArtifact(
			response.artifacts.vocals,
			request.outputDirectory,
			sourceWave,
		);
		const accompaniment = await publishOutputArtifact(
			response.artifacts.accompaniment,
			request.outputDirectory,
			sourceWave,
		);
		return { ...response, artifacts: { vocals, accompaniment } };
	}
}

function validateRequest(request: ApprovedAudioProviderRequest, timeoutMs: number) {
	if (request.protocol !== APPROVED_AUDIO_PROVIDER_PROTOCOL) {
		throw new Error("unsupported approved audio provider protocol");
	}
	if (!request.operationId.trim() || !sha256Schema.safeParse(request.source.contentSha256).success) {
		throw new Error("operation ID and lowercase source SHA-256 are required");
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("provider timeout must be a positive safe integer");
	}
}

function validateSourceDomain(task: ApprovedAudioProviderRequest["task"], wave: WaveIdentity) {
	if (wave.format !== 1 || wave.bitsPerSample !== 16) {
		throw new Error("approved audio providers require 16-bit PCM WAV input");
	}
	if (task === "stem-separation") {
		if (wave.sampleRate !== 44_100 || wave.channels !== 2) {
			throw new Error("Open-Unmix UMX-HQ requires 44.1 kHz stereo PCM WAV audio");
		}
		return;
	}
	if (wave.sampleRate !== 16_000 || wave.channels !== 1) {
		throw new Error(
			task === "audio-cleanup"
				? "MetricGAN+ VoiceBank requires 16 kHz mono PCM WAV speech; resampling or non-speech inference is outside the approved provider policy"
				: "Silero VAD canonical inference requires 16 kHz mono PCM WAV audio",
		);
	}
}

function validateApprovedIdentity(response: z.infer<typeof responseSchema>) {
	const expected = APPROVED[response.task];
	if (JSON.stringify(response.model) !== JSON.stringify(expected.model)) {
		throw new Error(`${response.task} provider did not report the exact approved model identity`);
	}
	if ("runtime" in expected && JSON.stringify(response.runtime) !== JSON.stringify(expected.runtime)) {
		throw new Error(`${response.task} provider did not report the exact approved runtime identity`);
	}
}

function validateVad(response: z.infer<typeof vadResponseSchema>, sourceSamples: number) {
	if (response.sampleCount !== sourceSamples) {
		throw new Error("VAD result sample count does not match the exact source duration");
	}
	let previousEnd = 0;
	for (const range of response.ranges) {
		if (
			range.startSample < previousEnd ||
			range.endSampleExclusive <= range.startSample ||
			range.endSampleExclusive > sourceSamples
		) {
			throw new Error("VAD ranges must be ordered, non-overlapping exact source-sample ranges");
		}
		previousEnd = range.endSampleExclusive;
	}
}

async function publishSourceArtifact<Role extends string>(
	artifact: z.infer<typeof audioArtifactSchema> & { role: Role },
	path: string,
	expected: WaveIdentity,
): Promise<PublishedAudioArtifact<Role>> {
	validateDeclaredWave(artifact, expected);
	const info = await stat(path);
	return { ...artifact, path: resolve(path), contentSha256: await hashFile(path), bytes: info.size };
}

async function publishOutputArtifact<Role extends string>(
	artifact: z.infer<typeof audioArtifactSchema> & { role: Role },
	outputDirectory: string,
	expected: WaveIdentity,
): Promise<PublishedAudioArtifact<Role>> {
	const path = resolveContainedPath(outputDirectory, artifact.path);
	const actual = await inspectWave(path);
	validateDeclaredWave(artifact, actual);
	if (
		actual.sampleRate !== expected.sampleRate ||
		actual.channels !== expected.channels ||
		actual.sampleCount !== expected.sampleCount
	) {
		throw new Error("provider audio output is not exactly sample-aligned with the source");
	}
	const info = await stat(path);
	return { ...artifact, path, contentSha256: await hashFile(path), bytes: info.size };
}

function validateDeclaredWave(
	artifact: z.infer<typeof audioArtifactSchema>,
	actual: WaveIdentity,
) {
	if (
		artifact.sampleRate !== actual.sampleRate ||
		artifact.channels !== actual.channels ||
		artifact.sampleCount !== actual.sampleCount
	) {
		throw new Error("provider audio declaration does not match the published WAV bytes");
	}
}

interface WaveIdentity {
	format: number;
	channels: number;
	sampleRate: number;
	bitsPerSample: number;
	sampleCount: number;
}

async function inspectWave(path: string): Promise<WaveIdentity> {
	const bytes = await readFile(path);
	if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("approved audio provider input/output must be a valid RIFF/WAVE file");
	}
	let cursor = 12;
	let format: Omit<WaveIdentity, "sampleCount"> | null = null;
	let dataBytes: number | null = null;
	while (cursor + 8 <= bytes.length) {
		const id = bytes.toString("ascii", cursor, cursor + 4);
		const size = bytes.readUInt32LE(cursor + 4);
		const start = cursor + 8;
		if (start + size > bytes.length) throw new Error("WAV chunk exceeds file bounds");
		if (id === "fmt " && size >= 16) {
			format = {
				format: bytes.readUInt16LE(start),
				channels: bytes.readUInt16LE(start + 2),
				sampleRate: bytes.readUInt32LE(start + 4),
				bitsPerSample: bytes.readUInt16LE(start + 14),
			};
		}
		if (id === "data") dataBytes = size;
		cursor = start + size + (size % 2);
	}
	if (!format || dataBytes === null || format.channels <= 0 || format.bitsPerSample <= 0) {
		throw new Error("WAV is missing a valid fmt or data chunk");
	}
	const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
	if (!Number.isInteger(bytesPerFrame) || dataBytes % bytesPerFrame !== 0) {
		throw new Error("WAV data is not sample-frame aligned");
	}
	return { ...format, sampleCount: dataBytes / bytesPerFrame };
}

function resolveContainedPath(rootPath: string, childPath: string): string {
	const root = resolve(rootPath);
	const candidate = resolve(root, childPath);
	const child = relative(root, candidate);
	if (child === "" || child.startsWith("..") || isAbsolute(child)) {
		throw new Error("provider output artifact escapes its output directory");
	}
	return candidate;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
