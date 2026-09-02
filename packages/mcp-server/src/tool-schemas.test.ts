import { describe, expect, test } from "bun:test";
import {
	attachMatteInputSchema,
	generateMatteInputSchema,
	createProjectInputSchema,
	editPlanInputSchema,
	exportSubtitlesInputSchema,
	importMediaInputSchema,
	importSubtitlesInputSchema,
	openProjectInputSchema,
	timelineQueryInputSchema,
	trackSubjectInputSchema,
	transcribeTimelineInputSchema,
} from "./tool-schemas";

describe("OpenCut subject-tracking MCP contract", () => {
	test("defaults to smoothed focal-point tracking", () => {
		const result = trackSubjectInputSchema.safeParse({
			projectId: "project-1",
			operationId: "track-1",
			expectedRevision: 3,
			trackId: "main",
			elementId: "video-1",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toMatchObject({
				trackingMode: "focal-point",
				sampleIntervalTicks: 12_000,
				maxSamples: 2_000,
				minConfidence: 0.25,
				smoothing: 0.75,
				padding: 0.25,
			});
		}
	});

	test("accepts a prompt, initial box, crop tracking, and provider options", () => {
		expect(
			trackSubjectInputSchema.safeParse({
				projectId: "project-1",
				operationId: "track-2",
				expectedRevision: 3,
				trackId: "main",
				elementId: "video-1",
				trackingMode: "crop",
				subjectPrompt: "presenter",
				initialBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.8 },
				options: { detector: "person", redetect: true },
			}).success,
		).toBe(true);
	});
});

describe("OpenCut subtitle MCP contract", () => {
	test("defaults timeline transcription to the balanced local model", () => {
		const result = transcribeTimelineInputSchema.safeParse({
			projectId: "project-1",
			operationId: "transcription-1",
			expectedRevision: 3,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toMatchObject({
				language: "auto",
				modelId: "whisper-small",
				wordsPerCaption: 3,
				minCaptionDuration: 0.8,
			});
		}
	});

	test("accepts subtitle import, correction, and export requests", () => {
		expect(
			importSubtitlesInputSchema.safeParse({
				projectId: "project-1",
				operationId: "subtitle-import-1",
				expectedRevision: 3,
				path: "C:\\media\\captions.vtt",
				style: { fontSize: 6, color: "#ffffff" },
			}).success,
		).toBe(true);
		expect(
			editPlanInputSchema.safeParse({
				projectId: "project-1",
				operationId: "caption-correction-1",
				expectedRevision: 4,
				description: "Correct caption text and timing",
				operations: [
					{
						kind: "update_caption",
						trackId: "captions",
						elementId: "caption-1",
						text: "Corrected caption",
						startTime: 120000,
						duration: 240000,
					},
				],
			}).success,
		).toBe(true);
		expect(
			exportSubtitlesInputSchema.safeParse({
				projectId: "project-1",
				operationId: "subtitle-export-1",
				expectedRevision: 5,
				outputPath: "C:\\media\\corrected.srt",
				format: "srt",
				trackIds: ["captions"],
			}).success,
		).toBe(true);
	});

	test("rejects an empty caption correction", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "caption-correction-2",
			expectedRevision: 4,
			description: "Empty correction",
			operations: [
				{
					kind: "update_caption",
					trackId: "captions",
					elementId: "caption-1",
				},
			],
		});
		expect(result.success).toBe(false);
	});
});

describe("OpenCut matte MCP contract", () => {
	test("accepts a precomputed red-channel video matte", () => {
		const result = attachMatteInputSchema.safeParse({
			projectId: "project-1",
			operationId: "matte-1",
			expectedRevision: 4,
			trackId: "main",
			elementId: "clip-1",
			path: "C:\\media\\clip-matte.webm",
			channel: "red",
			modelId: "background-matting-v2",
			modelVersion: "2.1",
		});
		expect(result.success).toBe(true);
	});

	test("accepts a provider-driven matte generation request", () => {
		const result = generateMatteInputSchema.safeParse({
			projectId: "project-1",
			operationId: "generate-matte-1",
			expectedRevision: 4,
			trackId: "main",
			elementId: "clip-1",
			modelId: "person-segmenter",
			options: { quality: "draft", refineEdges: true },
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.timeoutSeconds).toBe(1800);
			expect(result.data.options).toEqual({
				quality: "draft",
				refineEdges: true,
			});
		}
	});

	test("accepts matte state changes and detachment", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "matte-controls-1",
			expectedRevision: 5,
			description: "Disable and remove the clip matte",
			operations: [
				{
					kind: "set_matte_state",
					trackId: "main",
					elementId: "clip-1",
					enabled: false,
				},
				{
					kind: "remove_matte",
					trackId: "main",
					elementId: "clip-1",
				},
			],
		});
		expect(result.success).toBe(true);
	});
});

describe("OpenCut timeline-query MCP contract", () => {
	test("accepts bounded track and element filters", () => {
		const result = timelineQueryInputSchema.safeParse({
			projectId: "project-1",
			expectedRevision: 4,
			startTime: 120000,
			endTime: 360000,
			trackIds: ["main"],
			elementTypes: ["video", "image"],
		});

		expect(result.success).toBe(true);
	});

	test("rejects a reversed range", () => {
		const result = timelineQueryInputSchema.safeParse({
			projectId: "project-1",
			expectedRevision: 4,
			startTime: 360000,
			endTime: 120000,
		});

		expect(result.success).toBe(false);
	});
});

describe("OpenCut edit-plan MCP contract", () => {
	test("accepts crop, cover focal point, and picture-in-picture layouts", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "reframe-1",
			expectedRevision: 2,
			description: "Crop the speaker and place the reaction overlay",
			operations: [
				{
					kind: "set_reframe",
					trackId: "main",
					elementId: "speaker",
					mode: "fill",
					crop: { x: 0.1, y: 0, width: 0.8, height: 1 },
					focalPoint: { x: 0.65, y: 0.4 },
				},
				{
					kind: "set_reframe",
					trackId: "overlay",
					elementId: "reaction",
					layout: "pip-bottom-right",
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("rejects invalid and ambiguous reframe rectangles", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "reframe-invalid-1",
			expectedRevision: 2,
			description: "Invalid reframe",
			operations: [
				{
					kind: "set_reframe",
					trackId: "main",
					elementId: "speaker",
					targetRect: { x: 0.8, y: 0, width: 0.4, height: 1 },
					layout: "split-left",
				},
			],
		});

		expect(result.success).toBe(false);
	});

	test("accepts constant retiming with optional pitch preservation", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "retime-1",
			expectedRevision: 3,
			description: "Speed up the presenter clip",
			operations: [
				{
					kind: "set_retime",
					trackId: "main-track",
					elementId: "video-1",
					rate: 1.25,
					maintainPitch: true,
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("accepts deterministic audio gain, mute, and fades", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "audio-control-1",
			expectedRevision: 2,
			description: "Set dialogue level and fades",
			operations: [
				{
					kind: "set_audio",
					trackId: "track-1",
					elementId: "element-1",
					volumeDb: -6,
					muted: false,
					fade: { inDuration: 12000, outDuration: 24000 },
				},
			],
		});

		expect(result.success).toBe(true);
		if (result.success) {
			const [operation] = result.data.operations;
			expect(operation?.kind).toBe("set_audio");
			if (operation?.kind === "set_audio") {
				expect(operation.fade?.floorDb).toBe(-60);
			}
		}
	});

	test("rejects an empty audio-control operation", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "audio-control-empty-1",
			expectedRevision: 2,
			description: "No audio changes",
			operations: [
				{
					kind: "set_audio",
					trackId: "track-1",
					elementId: "element-1",
				},
			],
		});

		expect(result.success).toBe(false);
	});

	test("accepts a uniform mix-gain adjustment", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "mix-gain-1",
			expectedRevision: 2,
			description: "Raise the complete mix",
			operations: [{ kind: "adjust_mix_gain", gainDb: 3.5 }],
		});

		expect(result.success).toBe(true);
	});

	test("accepts effect creation, updates, ordering, and removal", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "effects-1",
			expectedRevision: 2,
			description: "Build and order the clip effect stack",
			operations: [
				{
					kind: "upsert_effect",
					trackId: "track-1",
					elementId: "clip-1",
					effectId: "blur-1",
					effectType: "blur",
					params: { intensity: 30 },
					enabled: true,
				},
				{
					kind: "reorder_effects",
					trackId: "track-1",
					elementId: "clip-1",
					effectIds: ["blur-1"],
				},
				{
					kind: "remove_effect",
					trackId: "track-1",
					elementId: "clip-1",
					effectId: "blur-1",
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("accepts create, retime, and remove keyframe operation shapes", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "keyframes-1",
			expectedRevision: 2,
			description: "Animate and revise clip opacity",
			operations: [
				{
					kind: "upsert_keyframe",
					trackId: "track-1",
					elementId: "element-1",
					propertyPath: "opacity",
					time: 0,
					value: 0,
					interpolation: "linear",
					keyframeId: "opacity-start",
				},
				{
					kind: "retime_keyframe",
					trackId: "track-1",
					elementId: "element-1",
					propertyPath: "opacity",
					keyframeId: "opacity-start",
					time: 12000,
				},
				{
					kind: "remove_keyframe",
					trackId: "track-1",
					elementId: "element-1",
					propertyPath: "opacity",
					keyframeId: "opacity-start",
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("rejects malformed keyframe fields", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "keyframes-invalid-1",
			expectedRevision: 2,
			description: "Invalid keyframe",
			operations: [
				{
					kind: "upsert_keyframe",
					trackId: "track-1",
					elementId: "element-1",
					propertyPath: "   ",
					time: -1,
					value: 0,
				},
			],
		});

		expect(result.success).toBe(false);
	});

	test("accepts transition creation, updates, and removal", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "transitions-1",
			expectedRevision: 2,
			description: "Create and remove a crossfade",
			operations: [
				{
					kind: "upsert_transition",
					trackId: "track-1",
					transitionId: "transition-1",
					fromElementId: "clip-1",
					toElementId: "clip-2",
					transitionType: "crossfade",
					duration: 60000,
				},
				{
					kind: "remove_transition",
					trackId: "track-1",
					transitionId: "transition-1",
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("rejects unsupported transition types and non-positive durations", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "transitions-invalid-1",
			expectedRevision: 2,
			description: "Invalid transition",
			operations: [
				{
					kind: "upsert_transition",
					trackId: "track-1",
					transitionId: "transition-1",
					fromElementId: "clip-1",
					toElementId: "clip-2",
					transitionType: "cube-spin",
					duration: 0,
				},
			],
		});

		expect(result.success).toBe(false);
	});

	test("rejects retiming outside OpenCut's supported range", () => {
		const tooSlow = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "retime-too-slow",
			expectedRevision: 3,
			description: "Invalid slowdown",
			operations: [
				{
					kind: "set_retime",
					trackId: "main-track",
					elementId: "video-1",
					rate: 0.001,
				},
			],
		});
		const tooFast = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "retime-too-fast",
			expectedRevision: 3,
			description: "Invalid speedup",
			operations: [
				{
					kind: "set_retime",
					trackId: "main-track",
					elementId: "video-1",
					rate: 5.01,
				},
			],
		});

		expect(tooSlow.success).toBe(false);
		expect(tooFast.success).toBe(false);
	});

	test("accepts creating and populating a typed timeline track", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "add-track-1",
			expectedRevision: 3,
			description: "Create a B-roll layer",
			operations: [
				{ kind: "add_track", trackType: "video", trackId: "b-roll-track" },
				{
					kind: "move",
					trackId: "main-track",
					targetTrackId: "b-roll-track",
					elementId: "clip-1",
					startTime: 0,
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("rejects a new track that would remain empty", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "add-empty-track-1",
			expectedRevision: 3,
			description: "Create an empty layer",
			operations: [
				{ kind: "add_track", trackType: "video", trackId: "empty-track" },
			],
		});

		expect(result.success).toBe(false);
	});

	test("accepts cross-track moves and source-edge trims", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "timeline-surgery-1",
			expectedRevision: 4,
			description: "Move and trim a B-roll clip",
			operations: [
				{
					kind: "move",
					trackId: "source-track",
					targetTrackId: "b-roll-track",
					elementId: "clip-1",
					startTime: 240000,
				},
				{
					kind: "trim",
					trackId: "b-roll-track",
					elementId: "clip-1",
					trimStart: 210000,
					trimEnd: 60000,
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("accepts importing media onto an explicit track", () => {
		const result = importMediaInputSchema.safeParse({
			projectId: "project-1",
			operationId: "import-b-roll-1",
			expectedRevision: 4,
			path: "C:\\media\\b-roll.mp4",
			startTime: 0,
			trackId: "b-roll-track",
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.adoptMediaSettings).toBe(false);
		}
	});

	test("can explicitly adopt canvas and frame rate from first media", () => {
		const result = importMediaInputSchema.safeParse({
			projectId: "project-1",
			operationId: "import-first-media-1",
			expectedRevision: 0,
			path: "C:\\media\\first-video.mp4",
			startTime: 0,
			adoptMediaSettings: true,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.adoptMediaSettings).toBe(true);
		}
	});

	test("accepts setting the project canvas, frame rate, and background", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "vertical-project-settings-1",
			expectedRevision: 4,
			description: "Configure a vertical short",
			operations: [
				{
					kind: "set_project_settings",
					canvasSize: { width: 1080, height: 1920 },
					fps: { numerator: 30, denominator: 1 },
					background: { type: "color", color: "#000000" },
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("rejects an empty project-settings operation", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "empty-project-settings-1",
			expectedRevision: 4,
			description: "Make no changes",
			operations: [{ kind: "set_project_settings" }],
		});

		expect(result.success).toBe(false);
	});

	test("accepts a timed caption batch with shared styling", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "captions-1",
			expectedRevision: 5,
			description: "Add presenter captions",
			operations: [
				{
					kind: "insert_captions",
					captions: [
						{ text: "This is the hook", startTime: 0, duration: 72_000 },
					],
					style: {
						fontFamily: "Arial",
						fontSize: 7,
						color: "#ffffff",
						fontWeight: "bold",
						background: { enabled: true, color: "#000000" },
						placement: { verticalAlign: "bottom", marginVerticalRatio: 0.08 },
					},
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("accepts deterministic track visibility and mute state", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "track-state-1",
			expectedRevision: 6,
			description: "Mute the source layer",
			operations: [
				{
					kind: "set_track_state",
					trackId: "source-track",
					muted: true,
					hidden: false,
				},
			],
		});

		expect(result.success).toBe(true);
	});

	test("rejects a track-state operation without a requested state", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "track-state-empty-1",
			expectedRevision: 6,
			description: "Make no track change",
			operations: [{ kind: "set_track_state", trackId: "source-track" }],
		});

		expect(result.success).toBe(false);
	});
});

describe("OpenCut project-lifecycle MCP contract", () => {
	test("accepts idempotent create and open requests", () => {
		const createResult = createProjectInputSchema.safeParse({
			operationId: "create-project-1",
			name: "September product short",
		});
		const openResult = openProjectInputSchema.safeParse({
			operationId: "open-project-1",
			projectId: "project-1",
		});

		expect(createResult.success).toBe(true);
		expect(openResult.success).toBe(true);
	});

	test("rejects a blank project name", () => {
		const result = createProjectInputSchema.safeParse({
			operationId: "create-project-blank-1",
			name: "   ",
		});

		expect(result.success).toBe(false);
	});
});
