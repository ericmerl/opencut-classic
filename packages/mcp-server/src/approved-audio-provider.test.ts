import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CommandApprovedAudioProvider,
	type ApprovedAudioProviderRequest,
} from "./approved-audio-provider";
import {
	commandAudioCleanerFromEnvironment,
	type AudioCleanerJob,
} from "./audio-cleaner";
import { removeTestDirectory } from "./test-filesystem";

describe("approved audio provider protocol", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-approved-audio-"));
	});

	afterEach(async () => {
		delete process.env.OPENCUT_APPROVED_AUDIO_PROVIDER_COMMAND;
		delete process.env.OPENCUT_APPROVED_AUDIO_PROVIDER_ARGS;
		await removeTestDirectory(directory);
	});

	test("publishes MetricGAN A/B evidence only for exact 16 kHz mono alignment", async () => {
		const source = join(directory, "source.wav");
		const output = join(directory, "output");
		await Bun.write(source, pcm16Wave(16_000, 1, 320));
		const provider = await fixtureProvider(
			directory,
			`await Bun.write(job.outputDirectory + "/cleaned.wav", await Bun.file(job.source.path).arrayBuffer());
reply({task:"audio-cleanup", model:${JSON.stringify(METRICGAN_MODEL)}, runtime:${JSON.stringify(METRICGAN_RUNTIME)}, device:{kind:"cpu",runtime:"torch",canonical:true}, artifacts:{original:{path:job.source.path,role:"before",sampleRate:16000,channels:1,sampleCount:320},cleaned:{path:"cleaned.wav",role:"after",sampleRate:16000,channels:1,sampleCount:320}}});`,
		);

		const result = await provider.run(
			await request(source, output, "audio-cleanup"),
			10_000,
		);

		expect(result).toMatchObject({
			task: "audio-cleanup",
			model: METRICGAN_MODEL,
			runtime: METRICGAN_RUNTIME,
			device: { kind: "cpu", canonical: true },
			artifacts: {
				original: { path: source, role: "before", sampleCount: 320 },
				cleaned: {
					path: join(output, "cleaned.wav"),
					role: "after",
					sampleCount: 320,
				},
			},
		});
	});

	test("publishes UMX-HQ vocals and deterministic residual with exact source alignment", async () => {
		const source = join(directory, "source.wav");
		const output = join(directory, "output");
		await Bun.write(source, pcm16Wave(44_100, 2, 441));
		const provider = await fixtureProvider(
			directory,
			`const bytes = await Bun.file(job.source.path).arrayBuffer();
await Bun.write(job.outputDirectory + "/vocals.wav", bytes);
await Bun.write(job.outputDirectory + "/accompaniment.wav", bytes);
reply({task:"stem-separation", model:${JSON.stringify(OPEN_UNMIX_MODEL)}, runtime:${JSON.stringify(OPEN_UNMIX_RUNTIME)}, device:{kind:"cpu",runtime:"torch",canonical:true}, residualPolicy:"sample-wise-source-minus-vocals-f32-v1", artifacts:{vocals:{path:"vocals.wav",role:"vocals",sampleRate:44100,channels:2,sampleCount:441},accompaniment:{path:"accompaniment.wav",role:"accompaniment-residual",sampleRate:44100,channels:2,sampleCount:441}}});`,
		);

		const result = await provider.run(
			await request(source, output, "stem-separation"),
			10_000,
		);

		expect(result).toMatchObject({
			task: "stem-separation",
			model: OPEN_UNMIX_MODEL,
			residualPolicy: "sample-wise-source-minus-vocals-f32-v1",
			artifacts: {
				vocals: { path: join(output, "vocals.wav"), sampleCount: 441 },
				accompaniment: {
					path: join(output, "accompaniment.wav"),
					role: "accompaniment-residual",
					sampleCount: 441,
				},
			},
		});
	});

	test("publishes canonical one-thread Silero ranges in exact source samples", async () => {
		const source = join(directory, "source.wav");
		const output = join(directory, "output");
		await Bun.write(source, pcm16Wave(16_000, 1, 1600));
		const provider = await fixtureProvider(
			directory,
			`reply({task:"voice-activity-detection", model:${JSON.stringify(SILERO_MODEL)}, runtime:{id:"onnxruntime",version:"1.23.2"}, device:{kind:"cpu",runtime:"onnxruntime",canonical:true,executionProvider:"CPUExecutionProvider",intraOpThreads:1,interOpThreads:1}, sampleRate:16000, sampleCount:1600, ranges:[{startSample:160,endSampleExclusive:800,confidence:0.75}]});`,
		);

		const result = await provider.run(
			await request(source, output, "voice-activity-detection"),
			10_000,
		);

		expect(result).toMatchObject({
			task: "voice-activity-detection",
			model: SILERO_MODEL,
			device: {
				executionProvider: "CPUExecutionProvider",
				intraOpThreads: 1,
				interOpThreads: 1,
				canonical: true,
			},
			ranges: [{ startSample: 160, endSampleExclusive: 800, confidence: 0.75 }],
		});
	});

	test("fails closed on MetricGAN inputs outside its approved 16 kHz speech domain", async () => {
		const source = join(directory, "source.wav");
		await Bun.write(source, pcm16Wave(48_000, 2, 480));
		const provider = await fixtureProvider(
			directory,
			`throw new Error("must not execute");`,
		);

		await expect(
			provider.run(
				await request(source, join(directory, "output"), "audio-cleanup"),
				10_000,
			),
		).rejects.toThrow(
			"MetricGAN+ VoiceBank requires 16 kHz mono PCM WAV speech",
		);
	});

	test("rejects a provider that reports an unapproved model revision", async () => {
		const source = join(directory, "source.wav");
		const output = join(directory, "output");
		await Bun.write(source, pcm16Wave(16_000, 1, 320));
		const provider = await fixtureProvider(
			directory,
			`await Bun.write(job.outputDirectory + "/cleaned.wav", await Bun.file(job.source.path).arrayBuffer());
reply({task:"audio-cleanup", model:{...${JSON.stringify(METRICGAN_MODEL)},revision:"latest"}, runtime:${JSON.stringify(METRICGAN_RUNTIME)}, device:{kind:"cpu",runtime:"torch",canonical:true}, artifacts:{original:{path:job.source.path,role:"before",sampleRate:16000,channels:1,sampleCount:320},cleaned:{path:"cleaned.wav",role:"after",sampleRate:16000,channels:1,sampleCount:320}}});`,
		);

		await expect(
			provider.run(await request(source, output, "audio-cleanup"), 10_000),
		).rejects.toThrow("approved model identity");
	});

	test("rejects source bytes replaced after the request was created", async () => {
		const source = join(directory, "source.wav");
		const output = join(directory, "output");
		await Bun.write(source, pcm16Wave(16_000, 1, 320));
		const input = await request(source, output, "audio-cleanup");
		await Bun.write(source, pcm16Wave(16_000, 1, 321));
		const provider = await fixtureProvider(
			directory,
			`throw new Error("must not execute");`,
		);

		await expect(provider.run(input, 10_000)).rejects.toThrow(
			"source SHA-256 does not match",
		);
	});

	test("routes the production cleanup factory through the approved protocol", async () => {
		const source = join(directory, "source.wav");
		const output = join(directory, "output");
		await Bun.write(source, pcm16Wave(16_000, 1, 320));
		const script = join(directory, "approved-cleaner.ts");
		await writeFile(
			script,
			`const job = await Bun.stdin.json();
await Bun.write(job.outputDirectory + "/cleaned.wav", await Bun.file(job.source.path).arrayBuffer());
console.log(JSON.stringify({protocol:"opencut.approved-audio-provider.v1",status:"completed",task:"audio-cleanup",model:${JSON.stringify(METRICGAN_MODEL)},runtime:${JSON.stringify(METRICGAN_RUNTIME)},device:{kind:"cpu",runtime:"torch",canonical:true},artifacts:{original:{path:job.source.path,role:"before",sampleRate:16000,channels:1,sampleCount:320},cleaned:{path:"cleaned.wav",role:"after",sampleRate:16000,channels:1,sampleCount:320}},warnings:[]}));`,
		);
		process.env.OPENCUT_APPROVED_AUDIO_PROVIDER_COMMAND = process.execPath;
		process.env.OPENCUT_APPROVED_AUDIO_PROVIDER_ARGS = JSON.stringify([script]);
		const cleaner = commandAudioCleanerFromEnvironment();

		const result = await cleaner.clean(
			await legacyCleanupJob(source, output),
			10_000,
		);

		expect(result).toEqual({
			artifactPath: join(output, "cleaned.wav"),
			modelId: METRICGAN_MODEL.id,
			modelVersion: METRICGAN_MODEL.revision,
			warnings: [],
		});
	});

	test("rejects an installed runtime whose package version masks a different source revision", async () => {
		const sitePackages = join(directory, "site-packages");
		const metadata = join(sitePackages, "speechbrain-1.1.1.dist-info");
		await mkdir(metadata, { recursive: true });
		await writeFile(
			join(metadata, "METADATA"),
			"Metadata-Version: 2.1\nName: speechbrain\nVersion: 1.1.1\n",
		);
		await writeFile(
			join(metadata, "direct_url.json"),
			JSON.stringify({
				url: "https://github.com/speechbrain/speechbrain.git",
				vcs_info: { vcs: "git", commit_id: "0".repeat(40) },
			}),
		);
		const providerScript = join(
			import.meta.dir,
			"../providers/approved-audio/provider.py",
		);
		const python = [
			"import importlib.util",
			`spec=importlib.util.spec_from_file_location('provider', ${JSON.stringify(providerScript)})`,
			"module=importlib.util.module_from_spec(spec)",
			"spec.loader.exec_module(module)",
			"module.require_git_runtime('speechbrain','1.1.1','89ead74d163463d30c62329a09cfdb4c54f5abc1','SpeechBrain')",
		].join(";");
		const result = Bun.spawnSync(["python", "-c", python], {
			env: { ...process.env, PYTHONPATH: sitePackages },
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("runtime source revision is");
	});
});

const METRICGAN_MODEL = {
	id: "speechbrain/metricgan-plus-voicebank",
	revision: "a196ce26b3bdace6fa1d819017584bdbcce462a8",
	artifactSha256:
		"147bfb866bac8264603546e035bf283370e716ed2f4b7412d308d2bcee88304f",
};
const METRICGAN_RUNTIME = {
	id: "speechbrain/speechbrain",
	version: "1.1.1",
	revision: "89ead74d163463d30c62329a09cfdb4c54f5abc1",
};
const OPEN_UNMIX_MODEL = {
	id: "sigsep/open-unmix-umxhq-vocals",
	revision: "1.0.1",
	artifactSha256:
		"b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
};
const OPEN_UNMIX_RUNTIME = {
	id: "sigsep/open-unmix-pytorch",
	version: "1.3.0",
	revision: "814f144e34b2d1ed517eb605ce928dcb838abbed",
};
const SILERO_MODEL = {
	id: "silero-vad",
	revision: "7e30209a3e901f9842f81b225f3e93d8199902b1",
	artifactSha256:
		"1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
};

async function fixtureProvider(directory: string, body: string) {
	const script = join(directory, `provider-${crypto.randomUUID()}.ts`);
	await writeFile(
		script,
		`const job = await Bun.stdin.json();
await Bun.write(job.outputDirectory + "/.keep", "ready");
const reply = value => console.log(JSON.stringify({protocol:"opencut.approved-audio-provider.v1",status:"completed",...value}));
${body}`,
	);
	return new CommandApprovedAudioProvider({
		command: process.execPath,
		args: [script],
	});
}

async function request(
	path: string,
	outputDirectory: string,
	task: ApprovedAudioProviderRequest["task"],
): Promise<ApprovedAudioProviderRequest> {
	const contentSha256 = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(path).arrayBuffer())
		.digest("hex");
	return {
		protocol: "opencut.approved-audio-provider.v1",
		operationId: `operation-${task}`,
		task,
		source: { path, contentSha256 },
		outputDirectory,
		devicePolicy: { kind: "cpu", canonical: true },
		options:
			task === "voice-activity-detection"
				? { threshold: 0.5, minimumSpeechSamples: 160, paddingSamples: 0 }
				: {},
	};
}

function pcm16Wave(
	sampleRate: number,
	channels: number,
	sampleCount: number,
): Uint8Array {
	const dataBytes = sampleCount * channels * 2;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);
	for (const [offset, value] of [
		[0, "RIFF"],
		[8, "WAVE"],
		[12, "fmt "],
		[36, "data"],
	] as const) {
		for (let index = 0; index < value.length; index++)
			bytes[offset + index] = value.charCodeAt(index);
	}
	view.setUint32(4, 36 + dataBytes, true);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	view.setUint32(40, dataBytes, true);
	return bytes;
}

async function legacyCleanupJob(
	source: string,
	outputDirectory: string,
): Promise<AudioCleanerJob> {
	const contentHash = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(source).arrayBuffer())
		.digest("hex");
	return {
		protocolVersion: 1,
		operationId: "legacy-cleanup-operation",
		timebase: { ticksPerSecond: 120_000 },
		source: {
			path: source,
			name: "source.wav",
			mimeType: "audio/wav",
			contentHash,
			sourceFingerprint: "fixture",
			durationSeconds: 0.02,
		},
		clip: {
			startTime: 0,
			duration: 2_400,
			trimStart: 0,
			trimEnd: 0,
			retimeRate: 1,
			maintainPitch: true,
		},
		cleanup: {
			noiseReduction: 0.5,
			deReverb: 0,
			deEss: 0,
			highPassHz: 80,
			normalize: false,
		},
		outputDirectory,
		options: {},
	};
}
