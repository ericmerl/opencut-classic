import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commandAudioCleanerFromEnvironment,
	type AudioCleanerJob,
} from "./audio-cleaner";
import {
	commandMatteProducerFromEnvironment,
	type MatteProducerJob,
} from "./matte-producer";
import {
	commandSubjectTrackerFromEnvironment,
	type SubjectTrackerJob,
} from "./subject-tracker";

const originalEnvironment = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnvironment)) delete process.env[key];
	}
	Object.assign(process.env, originalEnvironment);
});

describe("default provider factories use the durable detached supervisor", () => {
	test(
		"exactly replays audio, matte, and full tracker results without a second provider invocation",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "opencut-provider-factories-"));
			try {
				const audio = await fixture(root, "audio-cleaner-command");
				process.env.OPENCUT_AUDIO_CLEANER_COMMAND = process.execPath;
				process.env.OPENCUT_AUDIO_CLEANER_ARGS = JSON.stringify(audio.args);
				const cleaner = commandAudioCleanerFromEnvironment(audio.supervisorDirectory);
				const audioJob = buildAudioJob(audio.outputDirectory);
				const firstAudio = await cleaner.clean(audioJob, 10_000);
				expect(await cleaner.clean(audioJob, 10_000)).toEqual(firstAudio);
				const relocatedAudio = {
					...audioJob,
					outputDirectory: join(audio.outputDirectory, "relocated-output"),
					source: {
						...audioJob.source,
						path: join(audio.outputDirectory, "relocated-source.wav"),
					},
				};
				expect(await cleaner.clean(relocatedAudio, 10_000)).toEqual(firstAudio);
				await expect(
					cleaner.clean(
						{ ...audioJob, options: { path: "semantic/model-a" } },
						10_000,
					),
				).rejects.toThrow("reused with different semantic input");
				await expect(
					cleaner.clean(
						{ ...audioJob, options: { url: "https://models.example/a" } },
						10_000,
					),
				).rejects.toThrow("reused with different semantic input");
				expect(await invocationCount(audio.counterPath)).toBe(1);

				const matte = await fixture(root, "matte-producer-command");
				process.env.OPENCUT_MATTE_PRODUCER_COMMAND = process.execPath;
				process.env.OPENCUT_MATTE_PRODUCER_ARGS = JSON.stringify(matte.args);
				const producer = commandMatteProducerFromEnvironment(
					matte.supervisorDirectory,
				);
				const matteJob = buildMatteJob(matte.outputDirectory);
				const firstMatte = await producer.produce(matteJob, 10_000);
				expect(await producer.produce(matteJob, 10_000)).toEqual(firstMatte);
				expect(await invocationCount(matte.counterPath)).toBe(1);

				const tracker = await fixture(root, "subject-tracker-command");
				process.env.OPENCUT_SUBJECT_TRACKER_COMMAND = process.execPath;
				process.env.OPENCUT_SUBJECT_TRACKER_ARGS = JSON.stringify(tracker.args);
				const subjectTracker = commandSubjectTrackerFromEnvironment(
					tracker.supervisorDirectory,
				);
				const trackerJob = buildTrackerJob(tracker.outputDirectory);
				const firstTracking = await subjectTracker.track(trackerJob, 10_000);
				expect(await subjectTracker.track(trackerJob, 10_000)).toEqual(
					firstTracking,
				);
				expect(firstTracking.samples).toHaveLength(3);
				expect(await invocationCount(tracker.counterPath)).toBe(1);
			} finally {
				await rm(root, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 50,
				});
			}
		},
		30_000,
	);
});

async function fixture(
	root: string,
	provider:
		| "audio-cleaner-command"
		| "matte-producer-command"
		| "subject-tracker-command",
) {
	const directory = join(root, provider);
	const outputDirectory = join(directory, "output");
	const supervisorDirectory = join(directory, "supervisor");
	const counterPath = join(directory, "counter.txt");
	const startedPath = join(directory, "started.txt");
	const donePath = join(directory, "done.txt");
	await mkdir(outputDirectory, { recursive: true });
	return {
		outputDirectory,
		supervisorDirectory,
		counterPath,
		args: [
			join(import.meta.dir, "provider-supervisor-fixture-provider.ts"),
			provider,
			counterPath,
			startedPath,
			donePath,
			"0",
		],
	};
}

async function invocationCount(path: string): Promise<number> {
	const text = await readFile(path, "utf8");
	return text.trim().split(/\r?\n/).filter(Boolean).length;
}

function buildAudioJob(outputDirectory: string): AudioCleanerJob {
	return {
		protocolVersion: 1,
		operationId: "factory-audio-1",
		timebase: { ticksPerSecond: 120_000 },
		source: {
			path: join(outputDirectory, "source.wav"),
			name: "source.wav",
			mimeType: "audio/wav",
			contentHash: "a".repeat(64),
			sourceFingerprint: null,
			durationSeconds: 2,
		},
		clip: {
			startTime: 0,
			duration: 240_000,
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

function buildMatteJob(outputDirectory: string): MatteProducerJob {
	return {
		protocolVersion: 1,
		operationId: "factory-matte-1",
		source: {
			path: join(outputDirectory, "source.mp4"),
			name: "source.mp4",
			mimeType: "video/mp4",
			contentHash: "b".repeat(64),
			sourceFingerprint: null,
			width: 1080,
			height: 1920,
			duration: 240_000,
			fps: 30,
		},
		outputDirectory,
		options: {},
	};
}

function buildTrackerJob(directory: string): SubjectTrackerJob {
	return {
		protocolVersion: 1,
		operationId: "factory-tracker-1",
		timebase: { ticksPerSecond: 120_000 },
		source: {
			path: join(directory, "source.mp4"),
			name: "source.mp4",
			mimeType: "video/mp4",
			contentHash: "c".repeat(64),
			sourceFingerprint: null,
			width: 1080,
			height: 1920,
			durationTicks: 240_000,
			fps: 30,
		},
		clip: { trimStart: 0, trimEnd: 0, duration: 240_000, retimeRate: 1 },
		sampling: { intervalTicks: 12_000, maxSamples: 100 },
		options: {},
	};
}
