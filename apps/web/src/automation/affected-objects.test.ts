import { describe, expect, test } from "bun:test";
import { diffAutomationSnapshots } from "./affected-objects";
import type { AutomationProjectSnapshot } from "./types";
import type { MediaTime } from "@/wasm";

describe("authoritative automation affected-object diffs", () => {
	test("reports created tracks, imported media, inserted elements, and relationships", () => {
		const before = snapshot();
		const after = snapshot({
			tracks: [
				{ trackId: "track-1", name: "Video", type: "video", role: "main" },
			],
			mediaAssets: [
				{ assetId: "media-1", name: "clip.mp4", type: "video", size: 42 },
			],
			elements: [element("element-1", 0, { groupId: "group-1" })],
		});
		expect(diffAutomationSnapshots(before, after)).toEqual(
			expect.arrayContaining([
				{ objectType: "track", objectId: "track-1", action: "created" },
				{ objectType: "media", objectId: "media-1", action: "imported" },
				{ objectType: "element", objectId: "element-1", action: "created" },
				{
					objectType: "relationship",
					objectId: "group:group-1",
					action: "created",
				},
			]),
		);
	});

	test("reports ripple movement and relationship membership changes from final state", () => {
		const before = snapshot({
			elements: [
				element("element-1", 0, { linkId: "link-1" }),
				element("element-2", 10, { linkId: "link-1" }),
			],
		});
		const after = snapshot({
			elements: [
				element("element-1", 0, { linkId: "link-1" }),
				element("element-2", 12),
			],
		});
		expect(diffAutomationSnapshots(before, after)).toEqual(
			expect.arrayContaining([
				{ objectType: "element", objectId: "element-2", action: "updated" },
				{
					objectType: "relationship",
					objectId: "link:link-1",
					action: "updated",
				},
			]),
		);
	});

	test("returns no effects for unchanged snapshots", () => {
		const before = snapshot();
		expect(diffAutomationSnapshots(before, structuredClone(before))).toEqual(
			[],
		);
	});
});

function snapshot(
	overrides: Partial<AutomationProjectSnapshot> = {},
): AutomationProjectSnapshot {
	return {
		projectId: "project-1",
		projectName: "Project",
		projectVersion: 1,
		sceneId: "scene-1",
		sceneName: "Scene",
		revision: 1,
		contentIdentity: {
			status: "hashed",
			hash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 1,
				digest: "a".repeat(64),
			},
		},
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		tracks: [],
		transitions: [],
		mediaAssets: [],
		scenes: [],
		bookmarks: [],
		elements: [],
		...overrides,
	};
}

function element(
	elementId: string,
	startTime: number,
	relationship: { groupId?: string; linkId?: string } = {},
) {
	return {
		trackId: "track-1",
		elementId,
		type: "video",
		name: elementId,
		startTime: startTime as MediaTime,
		duration: 5 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		sourceDuration: 5 as MediaTime,
		params: {},
		...relationship,
	};
}
