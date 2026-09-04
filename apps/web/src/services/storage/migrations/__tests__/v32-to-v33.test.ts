import { describe, expect, test } from "bun:test";
import { transformProjectV32ToV33 } from "../transformers/v32-to-v33";

describe("V32 to V33 Migration", () => {
	test("declares optional keying and track-matte persistence without rewriting data", () => {
		const project = {
			id: "project-v32-compositing",
			version: 32,
			legacyExtension: { keep: true },
			scenes: [
				{
					id: "scene-1",
					tracks: {
						overlay: [
							{
								id: "foreground",
								trackMatte: {
									sourceTrackId: "matte",
									mode: "luma",
									inverted: false,
									enabled: true,
								},
								elements: [
									{
										id: "clip-1",
										type: "video",
										key: {
											type: "chroma",
											keyColor: "#00ff00",
											similarity: 0.2,
											softness: 0.1,
											spillSuppression: 0.8,
											enabled: true,
										},
									},
								],
							},
						],
					},
				},
			],
		};

		const result = transformProjectV32ToV33({ project });

		expect(result.skipped).toBe(false);
		expect(result.project).toEqual({ ...project, version: 33 });
	});

	test("fails closed for missing identity and skips non-v32 records", () => {
		expect(
			transformProjectV32ToV33({ project: { version: 32 } }),
		).toMatchObject({ skipped: true, reason: "no project id" });
		expect(
			transformProjectV32ToV33({ project: { id: "p", version: 31 } }),
		).toMatchObject({ skipped: true, reason: "not v32" });
		expect(
			transformProjectV32ToV33({ project: { id: "p", version: 33 } }),
		).toMatchObject({ skipped: true, reason: "already v33" });
	});
});
