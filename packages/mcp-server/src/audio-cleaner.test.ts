import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandAudioCleaner, type AudioCleanerJob } from "./audio-cleaner";

describe("CommandAudioCleaner", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-cleaner-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("runs the JSON provider protocol and validates the artifact", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`const job = await Bun.stdin.json();
await Bun.write(job.outputDirectory + "/cleaned.wav", new Uint8Array([1,2,3]));
console.log(JSON.stringify({protocolVersion:1,status:"completed",artifact:{path:"cleaned.wav"},model:{id:"fixture",version:"1"},warnings:["draft"]}));`,
		);
		const cleaner = new CommandAudioCleaner({
			command: process.execPath,
			args: [script],
		});

		await expect(cleaner.clean(job(directory), 10_000)).resolves.toEqual({
			artifactPath: join(directory, "cleaned.wav"),
			modelId: "fixture",
			modelVersion: "1",
			warnings: ["draft"],
		});
	});

	test("rejects artifacts outside the isolated output directory", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`console.log(JSON.stringify({protocolVersion:1,status:"completed",artifact:{path:"../escape.wav"},model:{id:"fixture",version:"1"}}));`,
		);
		const cleaner = new CommandAudioCleaner({
			command: process.execPath,
			args: [script],
		});

		await expect(cleaner.clean(job(directory), 10_000)).rejects.toThrow(
			"inside the supplied output directory",
		);
	});
});

function job(outputDirectory: string): AudioCleanerJob {
	return {
		protocolVersion: 1,
		operationId: "operation-1",
		timebase: { ticksPerSecond: 120_000 },
		source: {
			path: join(outputDirectory, "source.wav"),
			name: "source.wav",
			mimeType: "audio/wav",
			contentHash: "hash",
			sourceFingerprint: "fingerprint",
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
