import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

	test("accepts the v2 SAM result only when its immutable model and mask evidence match the request", async () => {
		const outputDirectory = join(directory, "outputs");
		await mkdir(outputDirectory);
		await writeFile(join(outputDirectory, "subject-1.ocmask"), "mask-bytes");
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`const job = await Bun.stdin.json();
console.log(JSON.stringify({protocolVersion:2,status:"completed",coordinateSpace:"normalized-source",coverage:{startTicks:0,endTicks:1200000},subjects:[{subjectId:"subject-1",label:"presenter",samples:[{sampleId:"subject-1:0",sourceTimeTicks:0,box:{x:0.1,y:0.2,width:0.3,height:0.4},confidence:0.93,occlusion:"visible"},{sampleId:"subject-1:1",sourceTimeTicks:1200000,box:{x:0.2,y:0.2,width:0.3,height:0.4},confidence:0.81,occlusion:"partial"}],corrections:[{correctionId:"correction-1",sourceTimeTicks:600000,box:{x:0.15,y:0.2,width:0.3,height:0.4},note:"owner correction"}]}],artifacts:[{artifactId:"subject-1-mask",kind:"binary-mask-sequence",path:"subject-1.ocmask",contentSha256:"c57609a26891dfac9284889316b78f3e624db17f3f18f22855cd9f34281fba11",bytes:10}],model:{id:"facebook/sam2.1-hiera-small",revision:"ee5bba1d82bb8749febdf90f45e84b687142ba03",artifact:"model.safetensors",sha256:"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",codeRevision:"2b90b9f5ceec907a1c18123530e92e794ad901a4",license:"Apache-2.0"},runtime:{device:"cpu",framework:"facebookresearch/sam2",deterministic:true},warnings:[job.operationId]}));`,
		);
		const tracker = new CommandSubjectTracker({
			command: process.execPath,
			args: [script],
		});
		const request = {
			...job(directory),
			protocolVersion: 2 as const,
			outputDirectory,
			coverage: { startTicks: 0, endTicks: 1_200_000 },
			requestedModel: {
				id: "facebook/sam2.1-hiera-small",
				revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
				artifactSha256:
					"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
				codeRevision: "2b90b9f5ceec907a1c18123530e92e794ad901a4",
			},
		};

		const result = await tracker.track(request, 10_000);

		expect(result).toMatchObject({
			modelId: "facebook/sam2.1-hiera-small",
			modelVersion: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
			device: "cpu",
			samples: [
				{ sourceTime: 0, occlusion: "visible" },
				{ sourceTime: 1_200_000, occlusion: "partial" },
			],
			subjects: [
				{
					subjectId: "subject-1",
					corrections: [{ correctionId: "correction-1" }],
				},
			],
			artifacts: [{ artifactId: "subject-1-mask", bytes: 10 }],
		});
	});

	test("rejects a v2 tracker that silently advances the approved model revision", async () => {
		const script = join(directory, "provider.ts");
		await writeFile(
			script,
			`console.log(JSON.stringify({protocolVersion:2,status:"completed",coordinateSpace:"normalized-source",coverage:{startTicks:0,endTicks:1200000},subjects:[{subjectId:"subject-1",samples:[{sampleId:"first",sourceTimeTicks:0,box:{x:0,y:0,width:1,height:1},confidence:1,occlusion:"visible"},{sampleId:"last",sourceTimeTicks:1200000,box:{x:0,y:0,width:1,height:1},confidence:1,occlusion:"visible"}],corrections:[]}],artifacts:[],model:{id:"facebook/sam2.1-hiera-small",revision:"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",artifact:"model.safetensors",sha256:"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",codeRevision:"2b90b9f5ceec907a1c18123530e92e794ad901a4",license:"Apache-2.0"},runtime:{device:"cpu",framework:"facebookresearch/sam2",deterministic:true},warnings:[]}));`,
		);
		const tracker = new CommandSubjectTracker({
			command: process.execPath,
			args: [script],
		});
		const request = {
			...job(directory),
			protocolVersion: 2 as const,
			outputDirectory: directory,
			coverage: { startTicks: 0, endTicks: 1_200_000 },
			requestedModel: {
				id: "facebook/sam2.1-hiera-small",
				revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
				artifactSha256:
					"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
				codeRevision: "2b90b9f5ceec907a1c18123530e92e794ad901a4",
			},
		};

		await expect(tracker.track(request, 10_000)).rejects.toThrow(
			"model revision",
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
