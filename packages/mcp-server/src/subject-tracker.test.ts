import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CommandSubjectTracker,
	type SubjectTrackerJob,
} from "./subject-tracker";

describe("CommandSubjectTracker", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-tracker-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("runs the JSON tracker protocol and validates normalized samples", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`const job = await Bun.stdin.json();
console.log(JSON.stringify({protocolVersion:1,status:"completed",coordinateSpace:"normalized-source",samples:[{sourceTime:0,box:{x:0.1,y:0.2,width:0.3,height:0.4},confidence:0.9},{sourceTime:120000,box:{x:0.2,y:0.2,width:0.3,height:0.4},confidence:0.8}],model:{id:"fixture",version:"1"},warnings:[job.operationId]}));`,
		);
		const tracker = new CommandSubjectTracker({
			command: process.execPath,
			args: [script],
		});

		await expect(tracker.track(job(directory), 10_000)).resolves.toEqual({
			samples: [
				{
					sourceTime: 0,
					box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
					confidence: 0.9,
				},
				{
					sourceTime: 120_000,
					box: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
					confidence: 0.8,
				},
			],
			modelId: "fixture",
			modelVersion: "1",
			warnings: ["operation-1"],
		});
	});

	test("rejects samples that are not strictly increasing", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`console.log(JSON.stringify({protocolVersion:1,status:"completed",coordinateSpace:"normalized-source",samples:[{sourceTime:120000,box:{x:0,y:0,width:1,height:1}},{sourceTime:0,box:{x:0,y:0,width:1,height:1}}],model:{id:"fixture",version:"1"}}));`,
		);
		const tracker = new CommandSubjectTracker({
			command: process.execPath,
			args: [script],
		});

		await expect(tracker.track(job(directory), 10_000)).rejects.toThrow(
			"increasing sourceTime",
		);
	});
});

function job(directory: string): SubjectTrackerJob {
	return {
		protocolVersion: 1,
		operationId: "operation-1",
		timebase: { ticksPerSecond: 120_000 },
		source: {
			path: join(directory, "source.mp4"),
			name: "source.mp4",
			mimeType: "video/mp4",
			contentHash: "hash",
			sourceFingerprint: "fingerprint",
			width: 1080,
			height: 1920,
			durationTicks: 1_200_000,
			fps: 30,
		},
		clip: {
			trimStart: 0,
			trimEnd: 0,
			duration: 1_200_000,
			retimeRate: 1,
		},
		sampling: { intervalTicks: 12_000, maxSamples: 100 },
		options: {},
	};
}
