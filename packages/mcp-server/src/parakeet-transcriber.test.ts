import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParakeetTranscriber } from "./parakeet-transcriber";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Parakeet transcription adapter", () => {
	test("runs the local workflow offline and pins model, script, device, and word evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-parakeet-"));
		directories.push(directory);
		const modelPath = join(directory, "parakeet.nemo");
		const sourcePath = join(directory, "source.wav");
		const scriptPath = join(directory, "fake-workflow.ts");
		const outputDirectory = join(directory, "output");
		await Bun.write(modelPath, "model-bytes");
		await Bun.write(sourcePath, "audio-bytes");
		await Bun.write(
			scriptPath,
			`import { mkdir } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-dir") + 1];
await mkdir(output, { recursive: true });
await Bun.write(output + "/transcript.json", JSON.stringify({
  model: "nvidia/parakeet-tdt-0.6b-v2",
  workflowVersion: "parakeet-raw-padded-v1",
  decision: "matching_parakeet",
  usedFallback: false,
  reviewReasons: [],
  text: "hello world",
  words: [{ word: "hello", start: 0.1, end: 0.4, confidence: 0.92 }],
  gpu: "test GPU",
  torch: "2.8.0"
}));
console.log(JSON.stringify({ outputDir: output }));`,
		);
		const transcriber = new ParakeetTranscriber({
			command: process.execPath,
			args: [scriptPath],
			modelId: "nvidia/parakeet-tdt-0.6b-v2",
			modelRevision: "revision-1",
			modelArtifactPath: modelPath,
			modelArtifactSha256: hash("model-bytes"),
			modelCacheDirectory: directory,
			workflowScriptPath: scriptPath,
			extraEnvironment: { OPENCUT_TEST_OFFLINE: "1" },
		});
		const result = await transcriber.transcribe({
			operationId: "transcribe-1",
			sourcePath,
			sourceName: "source.wav",
			sourceContentHash: hash("audio-bytes"),
			language: "en",
			terms: ["OpenCut"],
			outputDirectory,
			timeoutMs: 10_000,
		});
		expect(result.words).toEqual([
			{
				text: "hello",
				startSeconds: 0.1,
				endSeconds: 0.4,
				confidence: 0.92,
				speaker: null,
			},
		]);
		expect(result.provider).toMatchObject({
			providerId: "nvidia-parakeet-local",
			modelRevision: "revision-1",
			device: "cuda",
			deviceName: "test GPU",
			usedFallback: false,
		});
		expect(result.provider.modelArtifact.sha256).toBe(hash("model-bytes"));
	});

	test("fails before execution when the configured model bytes changed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-parakeet-tamper-"));
		directories.push(directory);
		const modelPath = join(directory, "parakeet.nemo");
		const scriptPath = join(directory, "workflow.py");
		await writeFile(modelPath, "changed-model");
		await writeFile(scriptPath, "unused");
		const transcriber = new ParakeetTranscriber({
			command: process.execPath,
			args: [scriptPath],
			modelId: "nvidia/parakeet-tdt-0.6b-v2",
			modelRevision: "revision-1",
			modelArtifactPath: modelPath,
			modelArtifactSha256: hash("expected-model"),
			modelCacheDirectory: directory,
			workflowScriptPath: scriptPath,
		});
		await expect(
			transcriber.transcribe({
				operationId: "transcribe-2",
				sourcePath: modelPath,
				sourceName: "source.wav",
				sourceContentHash: hash("source"),
				language: "en",
				terms: [],
				outputDirectory: join(directory, "output"),
				timeoutMs: 10_000,
			}),
		).rejects.toThrow("model artifact hash mismatch");
	});
});

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
