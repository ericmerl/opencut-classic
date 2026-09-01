import { describe, expect, test } from "bun:test";
import { editPlanInputSchema } from "./tool-schemas";

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
});
