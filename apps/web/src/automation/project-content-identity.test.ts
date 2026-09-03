import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { buildEditorProjectContentInput } from "./project-content-identity";
import {
	hashProjectContent,
	serializeProjectContent,
} from "./project-content-hash";

describe("editor project content identity mapping", () => {
	test("matches Rust bytes and digest for a JS adapter-built v2 projection", async () => {
		const project = buildProject();
		project.metadata.id = "js-project";
		project.metadata.name = "JS Adapter Golden";
		project.scenes[0]!.id = "scene-js";
		project.currentSceneId = "scene-js";
		const asset = buildMediaAsset("a".repeat(64));
		asset.id = "asset-js";
		const input = buildEditorProjectContentInput({
			project,
			mediaAssets: [asset],
		});
		const fixture = (
			await Bun.file(
				join(
					import.meta.dir,
					"../../../../rust/crates/canonical-json/tests/fixtures/js-adapter-project-v2.json",
				),
			).text()
		).replace(/\r?\n$/, "");
		expect(serializeProjectContent(input)).toBe(fixture);
		expect(await hashProjectContent(input)).toMatchObject({
			status: "hashed",
			hash: {
				projectionVersion: 2,
				digest:
					"62a26c353c0751924733f40f476425a0bf9a3722c42975a32bebbd7a8d966554",
			},
		});
	});

	test("maps durable local byte identity into a production hash", async () => {
		const input = buildEditorProjectContentInput({
			project: buildProject(),
			mediaAssets: [buildMediaAsset("a".repeat(64))],
		});
		const result = await hashProjectContent(input);
		expect(result.status).toBe("hashed");
		expect(input.mediaAssets[0]?.source).toEqual({
			kind: "local",
			contentHash: { algorithm: "SHA-256", digest: "a".repeat(64) },
		});
	});

	test("truthfully blocks a legacy local asset without byte identity", async () => {
		const asset = buildMediaAsset("a".repeat(64));
		delete asset.sourceIdentity;
		const result = await hashProjectContent(
			buildEditorProjectContentInput({
				project: buildProject(),
				mediaAssets: [asset],
			}),
		);
		expect(result).toEqual({
			status: "blocked",
			blockers: [
				{
					code: "missing-media-content-hash",
					assetId: "asset-1",
					missingFields: ["source.contentHash"],
				},
			],
		});
	});
});

function buildMediaAsset(digest: string): MediaAsset {
	return {
		id: "asset-1",
		name: "clip.bin",
		type: "video",
		file: new File([new Uint8Array([1, 2, 3])], "clip.bin"),
		sourceIdentity: {
			kind: "local",
			contentHash: { algorithm: "SHA-256", digest },
		},
	};
}

function buildProject(): TProject {
	return {
		metadata: {
			id: "project-1",
			name: "Project",
			duration: 0,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		scenes: [
			{
				id: "scene-1",
				name: "Main",
				isMain: true,
				bookmarks: [],
				tracks: {
					main: {
						id: "main",
						name: "Main",
						type: "video",
						elements: [],
					},
					overlay: [],
					audio: [],
				},
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
		],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	} as unknown as TProject;
}
