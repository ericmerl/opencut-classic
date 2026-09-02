import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandMatteProducer, type MatteProducerJob } from "./matte-producer";

describe("CommandMatteProducer", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-producer-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("runs the JSON provider protocol and validates the artifact", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`const job = await Bun.stdin.json();
await Bun.write(job.outputDirectory + "/matte.webm", new Uint8Array([1,2,3]));
console.log(JSON.stringify({protocolVersion:1,status:"completed",artifact:{path:"matte.webm",channel:"red"},model:{id:"fixture",version:"1"},warnings:["draft"]}));`,
		);
		const producer = new CommandMatteProducer({
			command: process.execPath,
			args: [script],
		});

		await expect(producer.produce(job(directory), 10_000)).resolves.toEqual({
			artifactPath: join(directory, "matte.webm"),
			channel: "red",
			modelId: "fixture",
			modelVersion: "1",
			warnings: ["draft"],
		});
	});

	test("rejects artifacts outside the isolated output directory", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`console.log(JSON.stringify({protocolVersion:1,status:"completed",artifact:{path:"../escape.webm",channel:"red"},model:{id:"fixture",version:"1"}}));`,
		);
		const producer = new CommandMatteProducer({
			command: process.execPath,
			args: [script],
		});

		await expect(producer.produce(job(directory), 10_000)).rejects.toThrow(
			"inside the supplied output directory",
		);
	});
});

function job(outputDirectory: string): MatteProducerJob {
	return {
		protocolVersion: 1,
		operationId: "operation-1",
		source: {
			path: join(outputDirectory, "source.mp4"),
			name: "source.mp4",
			mimeType: "video/mp4",
			contentHash: "hash",
			sourceFingerprint: "fingerprint",
			width: 1080,
			height: 1920,
			duration: 2,
			fps: 30,
		},
		outputDirectory,
		options: {},
	};
}
