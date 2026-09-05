import { describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import {
	buildTrackingEditOperations,
	type SubjectTrackingBridge,
	type TrackSubjectInput,
	SubjectTrackingService,
} from "./track-subject";

describe("SubjectTrackingService", () => {
	test("transfers, tracks, maps retimed source samples, applies keyframes, and replays", async () => {
		let sourcePath = "";
		let trackerCalls = 0;
		const providerStates: string[] = [];
		const appliedPlans: Record<string, unknown>[] = [];
		const methods: string[] = [];
		const bridge: SubjectTrackingBridge = {
			sourceTickets: {
				async create(path) {
					sourcePath = path;
					return { url: "http://127.0.0.1/source/fixture", outputPath: path };
				},
			},
			async request(method, params) {
				methods.push(method);
				if (method === "read_project") return snapshot();
				if (method === "transfer_source_media") {
					await writeFile(sourcePath, new Uint8Array([4, 5, 6]));
					return {
						status: "transferred",
						revision: 2,
						mediaId: "media-1",
						name: "source.mp4",
						mimeType: "video/mp4",
						bytesTransferred: 3,
						sourceFingerprint: "source-fingerprint",
					};
				}
				if (method === "apply_edit_plan") {
					appliedPlans.push(params as Record<string, unknown>);
					return { status: "applied", revision: 3 };
				}
				throw new Error(`unexpected method: ${method}`);
			},
		};
		const service = new SubjectTrackingService(bridge, () => ({
			async track(job) {
				trackerCalls += 1;
				expect((await stat(job.source.path)).size).toBe(3);
				expect(job.clip).toMatchObject({
					trimStart: 120_000,
					duration: 240_000,
					retimeRate: 2,
				});
				return {
					samples: [
						{
							sourceTime: 120_000,
							box: { x: 0.1, y: 0.2, width: 0.2, height: 0.4 },
							confidence: 0.95,
						},
						{
							sourceTime: 360_000,
							box: { x: 0.5, y: 0.2, width: 0.2, height: 0.4 },
							confidence: 0.9,
						},
					],
					modelId: "fixture",
					modelVersion: "1",
					warnings: [],
				};
			},
		}));

		const first = await service.track(input(), async (event) => {
			providerStates.push(event.state);
		});
		const replay = await service.track(input());

		expect(first).toMatchObject({
			status: "tracked-and-reframed",
			projectId: "project-1",
			sceneId: "scene-1",
			bridgeProtocolVersion: 2,
			keyframeCount: 6,
			sampleCount: 3,
			tracker: { modelId: "fixture", modelVersion: "1" },
		});
		expect(replay.status).toBe("replayed");
		expect(trackerCalls).toBe(1);
		expect(providerStates).toEqual(["prepared", "committed", "verified"]);
		expect(methods).toEqual([
			"read_project",
			"transfer_source_media",
			"apply_edit_plan",
		]);
		const operations = appliedPlans[0].operations as Array<
			Record<string, unknown>
		>;
		expect(operations[0]).toMatchObject({
			kind: "set_reframe",
			mode: "cover",
		});
		expect(
			operations
				.filter((operation) => operation.propertyPath === "reframe.focalX")
				.map((operation) => operation.time),
		).toEqual([0, 120_000, 240_000]);
	});

	test("preserves provider provenance and affinity on a no-sample rejection", async () => {
		let sourcePath = "";
		const bridge: SubjectTrackingBridge = {
			sourceTickets: {
				async create(path) {
					sourcePath = path;
					return { url: "http://127.0.0.1/source/fixture", outputPath: path };
				},
			},
			async request(method) {
				if (method === "read_project") return snapshot();
				if (method === "transfer_source_media") {
					await writeFile(sourcePath, new Uint8Array([4, 5, 6]));
					return {
						status: "transferred",
						mediaId: "media-1",
						name: "source.mp4",
						mimeType: "video/mp4",
						bytesTransferred: 3,
						sourceFingerprint: "source-fingerprint",
					};
				}
				throw new Error(`unexpected method: ${method}`);
			},
		};
		const service = new SubjectTrackingService(bridge, () => ({
			async track() {
				return {
					samples: [],
					modelId: "fixture-tracker",
					modelVersion: "2",
					warnings: ["no confident samples"],
				};
			},
		}));

		const result = await service.track(input());

		expect(result).toMatchObject({
			status: "rejected",
			projectId: "project-1",
			sceneId: "scene-1",
			bridgeProtocolVersion: 2,
			connectionIdentity: connectionIdentity,
			requestConnectionIdentity: connectionIdentity,
			source: { mediaId: "media-1", bytesTransferred: 3 },
			tracker: {
				modelId: "fixture-tracker",
				modelVersion: "2",
				warnings: ["no confident samples"],
			},
		});
	});

	test("applies retained tracker samples without rerunning the tracker", async () => {
		let trackerCalls = 0;
		const methods: string[] = [];
		const states: string[] = [];
		const service = new SubjectTrackingService(
			{
				sourceTickets: { create: async () => ({ url: "", outputPath: "" }) },
				request: async (method) => {
					methods.push(method);
					if (method === "read_project") return snapshot();
					if (method === "apply_edit_plan") {
						return { status: "applied", revision: 3 };
					}
					throw new Error(`unexpected method: ${method}`);
				},
			},
			() => ({
				track: async () => {
					trackerCalls += 1;
					throw new Error("tracker must not rerun");
				},
			}),
		);
		const result = await service.applyRecovered(
			input(),
			{
				modelId: "fixture",
				modelVersion: "1",
				samples: [
					{
						sourceTime: 120_000,
						box: { x: 0.1, y: 0.2, width: 0.2, height: 0.4 },
						confidence: 0.95,
					},
					{
						sourceTime: 360_000,
						box: { x: 0.5, y: 0.2, width: 0.2, height: 0.4 },
						confidence: 0.9,
					},
				],
			},
			async (event) => {
				states.push(event.state);
			},
		);
		expect(result).toMatchObject({
			status: "tracked-and-reframed",
			recoveredProviderSamples: true,
		});
		expect(trackerCalls).toBe(0);
		expect(methods).toEqual(["read_project", "apply_edit_plan"]);
		expect(states).toEqual(["verified"]);
	});

	test("builds padded crop channels and filters low-confidence samples", () => {
		const operations = buildTrackingEditOperations({
			input: { ...input(), trackingMode: "crop", padding: 0.5 },
			clip: { duration: 120_000, trimStart: 0, retimeRate: 1 },
			samples: [
				{
					sourceTime: 0,
					box: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
					confidence: 0.9,
				},
				{
					sourceTime: 60_000,
					box: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 },
					confidence: 0.1,
				},
			],
		});

		expect(operations).toHaveLength(9);
		expect(operations[1]).toMatchObject({
			propertyPath: "reframe.cropX",
			time: 0,
		});
		if (operations[1].kind !== "upsert_keyframe") {
			throw new Error("expected a crop keyframe");
		}
		expect(operations[1].value).toBeCloseTo(0.3);
		expect(operations[3]).toMatchObject({
			propertyPath: "reframe.cropWidth",
			value: 0.4,
		});
		expect(operations[5]).toMatchObject({ time: 120_000 });
	});

	test("maps tracker samples through ramp, reverse, and hold source time", () => {
		const operations = buildTrackingEditOperations({
			input: {
				...input(),
				sampleIntervalTicks: 30_000,
				smoothing: 0,
			},
			clip: {
				duration: 120_000,
				trimStart: 0,
				retimeRate: 1,
				timeMap: {
					schemaVersion: "opencut.time-map.v1",
					frameInterpolation: { requested: "nearest", fallback: "nearest" },
					audioPolicy: { maintainPitch: false, hold: "mute" },
					segments: [
						{
							kind: "speed",
							timelineStart: 0,
							timelineEnd: 60_000,
							sourceStart: 0,
							startRate: 1,
							endRate: 1,
							direction: "forward",
						},
						{
							kind: "hold",
							timelineStart: 60_000,
							timelineEnd: 90_000,
							sourceTime: 60_000,
							frameIdentity: "source-frame:60000",
						},
						{
							kind: "speed",
							timelineStart: 90_000,
							timelineEnd: 120_000,
							sourceStart: 60_000,
							startRate: 1,
							endRate: 1,
							direction: "reverse",
						},
					],
				},
			},
			samples: [
				{
					sourceTime: 0,
					box: { x: 0.1, y: 0.2, width: 0.2, height: 0.4 },
				},
				{
					sourceTime: 60_000,
					box: { x: 0.7, y: 0.2, width: 0.2, height: 0.4 },
				},
			],
		});
		expect(
			operations.flatMap((operation) =>
				operation.kind === "upsert_keyframe" &&
				operation.propertyPath === "reframe.focalX"
					? [[operation.time, operation.value]]
					: [],
			),
		).toEqual([
			[0, 0.2],
			[30_000, 0.5],
			[60_000, 0.8],
			[90_000, 0.8],
			[120_000, 0.5],
		]);
	});

	test("clamps a boundary subject center to the reframe keyframe range", () => {
		const operations = buildTrackingEditOperations({
			input: input(),
			clip: { duration: 120_000, trimStart: 0, retimeRate: 1 },
			samples: [
				{
					sourceTime: 0,
					box: { x: 0.999, y: 0.999, width: 0.001, height: 0.001 },
				},
			],
		});

		expect(operations[1]).toMatchObject({
			propertyPath: "reframe.focalX",
			value: 0.999,
		});
		expect(operations[2]).toMatchObject({
			propertyPath: "reframe.focalY",
			value: 0.999,
		});
	});
});

function input(): TrackSubjectInput {
	return {
		projectId: "project-1",
		operationId: "track-1",
		expectedRevision: 2,
		trackId: "main",
		elementId: "clip-1",
		trackingMode: "focal-point",
		sampleIntervalTicks: 12_000,
		maxSamples: 2_000,
		minConfidence: 0.25,
		smoothing: 0,
		padding: 0.25,
		options: {},
		timeoutSeconds: 30,
	};
}

function snapshot(): Record<string, unknown> {
	return {
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 2,
		bridgeProtocolVersion: 2,
		connectionIdentity,
		requestConnectionIdentity: connectionIdentity,
		elements: [
			{
				trackId: "main",
				elementId: "clip-1",
				type: "video",
				mediaId: "media-1",
				duration: 240_000,
				trimStart: 120_000,
				trimEnd: 120_000,
				retime: { rate: 2 },
			},
		],
		mediaAssets: [
			{
				assetId: "media-1",
				name: "source.mp4",
				width: 1080,
				height: 1920,
				duration: 10,
				fps: 30,
			},
		],
	};
}

const connectionIdentity = {
	serverInstanceId: "server-1",
	editorInstanceId: "editor-1",
	editorSessionId: "session-1",
	connectionGeneration: 1,
};
