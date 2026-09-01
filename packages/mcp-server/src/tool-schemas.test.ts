import { describe, expect, test } from "bun:test";
import {
	createProjectInputSchema,
	editPlanInputSchema,
	importMediaInputSchema,
	openProjectInputSchema,
} from "./tool-schemas";

describe("OpenCut edit-plan MCP contract", () => {
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

	test("accepts creating a typed timeline track", () => {
		const result = editPlanInputSchema.safeParse({
			projectId: "project-1",
			operationId: "add-track-1",
			expectedRevision: 3,
			description: "Create a B-roll layer",
			operations: [{ kind: "add_track", trackType: "video" }],
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
