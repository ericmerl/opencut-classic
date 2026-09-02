/// <reference types="bun" />
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { describe, expect, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { MediaTime } from "@/wasm";
import {
	PROJECT_CONTENT_HASH_ALGORITHM,
	PROJECT_CONTENT_NEGATIVE_ZERO_POLICY,
	PROJECT_CONTENT_PROJECTION,
	PROJECT_CONTENT_PROJECTION_VERSION,
	canonicalSerialize,
	hashProjectContent,
	serializeProjectContent,
	type ProjectContentInput,
	type ProjectContentMediaAsset,
	type ProjectContentMediaSource,
} from "./project-content-hash";

type MutableInput = {
	project: TProject;
	mediaAssets: ProjectContentMediaAsset[];
};
type FixtureVideo = {
	startTime: number;
	groupId: string;
	linkId: string;
	params: Record<string, number>;
	transitionIn: { duration: number };
	effects: Array<{ enabled: boolean }>;
	animations: { opacity: { keys: Array<{ value: number }> } };
	masks: Array<{ params: { feather: number } }>;
	matte: { modelVersion: string };
	audioReplacement: { enabled: boolean };
	isSourceAudioEnabled: boolean;
};

describe("canonical project content", () => {
	test("is independent of object key insertion and media enumeration order", async () => {
		expect(canonicalSerialize({ z: 1, a: { y: 2, x: 3 } })).toBe(
			canonicalSerialize({ a: { x: 3, y: 2 }, z: 1 }),
		);
		const left = fixture();
		const right = fixture();
		video(left).params = { "reframe.cropX": 0.1, opacity: 0.9 };
		video(right).params = { opacity: 0.9, "reframe.cropX": 0.1 };
		right.mediaAssets.reverse();
		expect(serializeProjectContent(left)).toBe(serializeProjectContent(right));
		expect(await hashProjectContent(left)).toEqual(
			await hashProjectContent(right),
		);
	});

	test("reports an explicit versioned SHA-256 identity deterministically", async () => {
		const first = await hashProjectContent(fixture());
		const repeated = await Promise.all(
			Array.from({ length: 5 }, () => hashProjectContent(fixture())),
		);
		expect(
			repeated.every(
				(result) => canonicalSerialize(result) === canonicalSerialize(first),
			),
		).toBe(true);
		expect(first).toMatchObject({
			status: "hashed",
			hash: {
				algorithm: PROJECT_CONTENT_HASH_ALGORITHM,
				projection: PROJECT_CONTENT_PROJECTION,
				projectionVersion: PROJECT_CONTENT_PROJECTION_VERSION,
			},
		});
		expect(requireDigest(first)).toMatch(/^[a-f0-9]{64}$/);
	});

	test("uses ordinal case-sensitive ordering for non-ASCII keys and media IDs", () => {
		expect(canonicalSerialize({ ä: 4, a: 2, Á: 3, Z: 1 })).toBe(
			'{"Z":1,"a":2,"Á":3,"ä":4}',
		);
		const input = fixture();
		input.mediaAssets = ["ä", "a", "Á", "Z"].map((id) => ({
			id,
			name: id,
			type: "image",
			source: verifiedLocalSource("a"),
		}));
		const parsed = JSON.parse(serializeProjectContent(input)) as {
			mediaAssets: Array<{ id: string }>;
		};
		expect(parsed.mediaAssets.map((asset) => asset.id)).toEqual([
			"Z",
			"a",
			"Á",
			"ä",
		]);
	});

	test("rejects ambiguous arrays, undefined, and non-JSON numbers", () => {
		const sparse = Array(2);
		sparse[1] = "present";
		expect(() => canonicalSerialize(sparse)).toThrow("sparse array slot");
		expect(() => canonicalSerialize([undefined])).toThrow(
			"undefined at array index",
		);
		expect(() => canonicalSerialize({ missing: undefined })).toThrow(
			"undefined at object key",
		);
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() => canonicalSerialize(value)).toThrow("non-finite number");
		}
	});

	test("enforces SHA-256 syntax and normalizes uppercase digests", async () => {
		const unsupported = fixture();
		unsupported.mediaAssets[0]!.source.contentHash!.algorithm = "SHA-1";
		expect(() => serializeProjectContent(unsupported)).toThrow(
			"Unsupported content hash algorithm",
		);
		await expect(hashProjectContent(unsupported)).rejects.toThrow(
			"Unsupported content hash algorithm",
		);

		for (const malformed of ["abc", "g".repeat(64), "a".repeat(63)]) {
			const input = fixture();
			input.mediaAssets[0]!.source.contentHash!.digest = malformed;
			expect(() => serializeProjectContent(input)).toThrow(
				"Invalid SHA-256 digest",
			);
			await expect(hashProjectContent(input)).rejects.toThrow(
				"Invalid SHA-256 digest",
			);
		}

		const uppercase = fixture();
		uppercase.mediaAssets[0]!.source.contentHash!.digest = "A".repeat(64);
		expect(serializeProjectContent(uppercase)).toBe(
			serializeProjectContent(fixture()),
		);
		expect(await hashProjectContent(uppercase)).toEqual(
			await hashProjectContent(fixture()),
		);
	});

	test("rejects own undefined fields throughout projected project state", async () => {
		const mutations: Array<(input: MutableInput) => void> = [
			(input) =>
				Object.assign(input.project.settings, { canvasSizeMode: undefined }),
			(input) => Object.assign(video(input).params, { nested: undefined }),
			(input) =>
				Object.assign(video(input).animations.opacity, { metadata: undefined }),
		];
		for (const mutate of mutations) {
			const serialized = fixture();
			mutate(serialized);
			expect(() => serializeProjectContent(serialized)).toThrow(
				"Project content contains undefined at object key",
			);
			const hashed = fixture();
			mutate(hashed);
			await expect(hashProjectContent(hashed)).rejects.toThrow(
				"Project content contains undefined at object key",
			);
		}
	});

	test("intentionally normalizes negative zero", () => {
		expect(PROJECT_CONTENT_NEGATIVE_ZERO_POLICY).toBe("normalize-to-zero");
		expect(canonicalSerialize(-0)).toBe("0");
		expect(canonicalSerialize(-0)).toBe(canonicalSerialize(0));
	});

	test("rejects duplicate media IDs", async () => {
		const input = fixture();
		input.mediaAssets.push({ ...input.mediaAssets[0]!, name: "duplicate" });
		expect(() => serializeProjectContent(input)).toThrow(
			"Duplicate project media asset ID: media-video",
		);
		await expect(hashProjectContent(input)).rejects.toThrow(
			"Duplicate project media asset ID: media-video",
		);
	});

	test("returns structured blockers for missing local and provider byte identity", async () => {
		const local = fixture();
		local.mediaAssets[0]!.source = { kind: "local" };
		expect(await hashProjectContent(local)).toEqual({
			status: "blocked",
			blockers: [
				{
					code: "missing-media-content-hash",
					assetId: "media-video",
					missingFields: ["source.contentHash"],
				},
			],
		});

		const provider = fixture();
		provider.mediaAssets[0]!.source = {
			kind: "provider",
			sourceUrl: "https://media.example/video",
		};
		expect(await hashProjectContent(provider)).toMatchObject({
			status: "blocked",
			blockers: [
				{
					code: "incomplete-provider-media-identity",
					assetId: "media-video",
					missingFields: [
						"source.provider",
						"source.providerVersion",
						"source.contentHash",
					],
				},
			],
		});
	});

	test("blocks unverified URL media and accepts explicit provider provenance", async () => {
		const input = fixture();
		addLibraryAudio({ input, sourceUrl: "https://media.example/music" });
		expect(await hashProjectContent(input)).toMatchObject({
			status: "blocked",
			blockers: [{ code: "unverified-url-media" }],
		});
		input.mediaAssets.push({
			id: "library-music",
			name: "Library music",
			type: "audio",
			source: {
				kind: "provider",
				sourceUrl: "https://media.example/music",
				provider: "music-library",
				providerVersion: "catalog-2026-09",
				contentHash: {
					algorithm: "SHA-256",
					digest: "d".repeat(64),
				},
			},
		});
		expect(await hashProjectContent(input)).toMatchObject({ status: "hashed" });
	});

	test("changes for every required durable category", async () => {
		const baseline = await digest(fixture());
		const mutations: Array<[string, (input: MutableInput) => void]> = [
			["project name", (input) => (input.project.metadata.name = "Renamed")],
			["settings", (input) => (input.project.settings.canvasSize.width = 720)],
			["active scene", (input) => (input.project.currentSceneId = "scene-b")],
			["main scene", (input) => (input.project.scenes[0]!.isMain = false)],
			["scene order", (input) => input.project.scenes.reverse()],
			["other scene", (input) => (input.project.scenes[1]!.name = "Outro")],
			[
				"bookmark",
				(input) => (input.project.scenes[0]!.bookmarks[0]!.note = "CTA"),
			],
			[
				"track order",
				(input) => input.project.scenes[0]!.tracks.overlay.reverse(),
			],
			[
				"track state",
				(input) => (input.project.scenes[0]!.tracks.main.muted = true),
			],
			["transition", (input) => (video(input).transitionIn.duration = 45)],
			["element", (input) => (video(input).startTime = 12)],
			["group", (input) => (video(input).groupId = "group-b")],
			["link", (input) => (video(input).linkId = "link-b")],
			["effect", (input) => (video(input).effects[0]!.enabled = false)],
			[
				"keyframe",
				(input) => (video(input).animations.opacity.keys[0]!.value = 0.25),
			],
			["mask", (input) => (video(input).masks[0]!.params.feather = 8)],
			["matte", (input) => (video(input).matte.modelVersion = "2")],
			["audio", (input) => (video(input).audioReplacement.enabled = false)],
			["source audio", (input) => (video(input).isSourceAudioEnabled = false)],
			["reframe", (input) => (video(input).params["reframe.focalX"] = 0.8)],
			[
				"graphic identity",
				(input) => (graphic(input).definitionId = "ellipse"),
			],
			[
				"sticker identity",
				(input) => (sticker(input).stickerId = "shape:star"),
			],
			[
				"visual effect identity",
				(input) => (effectElement(input).effectType = "blur"),
			],
			[
				"nested compound",
				(input) => (compoundText(input).params.text = "Changed"),
			],
			[
				"media fingerprint",
				(input) => (input.mediaAssets[0]!.sourceFingerprint = "source-b"),
			],
			[
				"media content hash",
				(input) =>
					(input.mediaAssets[0]!.source.contentHash!.digest = "b".repeat(64)),
			],
		];

		for (const [category, mutate] of mutations) {
			const changed = fixture();
			mutate(changed);
			expect(await digest(changed), category).not.toBe(baseline);
		}
	});

	test("includes media-bin-only state", async () => {
		const changed = fixture();
		changed.mediaAssets.push({
			id: "unused-media",
			name: "unused.png",
			type: "image",
			file: { size: 456 },
			sourceFingerprint: "unused-source",
			source: {
				kind: "local",
				contentHash: { algorithm: "SHA-256", digest: "c".repeat(64) },
			},
			role: "timeline",
		});
		expect(await digest(changed)).not.toBe(await digest(fixture()));
	});

	test("excludes timestamps, UI state, thumbnails, and runtime objects", async () => {
		const changed = fixture();
		changed.project.metadata.id = "another-project";
		changed.project.metadata.createdAt = new Date("2040-01-01T00:00:00Z");
		changed.project.metadata.updatedAt = new Date("2040-01-02T00:00:00Z");
		changed.project.metadata.thumbnail = "changed";
		changed.project.metadata.duration = 999_999 as MediaTime;
		changed.project.version = 999;
		changed.project.timelineViewState = {
			zoomLevel: 4,
			scrollLeft: 500,
			playheadTime: 20 as MediaTime,
		};
		changed.project.scenes[0]!.createdAt = new Date("2040-01-03T00:00:00Z");
		changed.project.scenes[0]!.updatedAt = new Date("2040-01-04T00:00:00Z");
		Object.assign(changed.mediaAssets[0]!, {
			url: "blob:changed",
			thumbnailUrl: "blob:changed-thumbnail",
			lastModified: 999,
			ephemeral: true,
			file: { size: 123, runtimeDecoder: { state: "changed" } },
		});
		expect(await hashProjectContent(changed)).toEqual(
			await hashProjectContent(fixture()),
		);
	});
});

function fixture(): MutableInput {
	return {
		project: {
			metadata: {
				id: "project-a",
				name: "Canonical project",
				thumbnail: "ignored",
				duration: 240,
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			},
			currentSceneId: "scene-a",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1080, height: 1920 },
				background: { type: "color", color: "#000000" },
			},
			version: 31,
			timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
			scenes: [
				{
					id: "scene-a",
					name: "Main",
					isMain: true,
					bookmarks: [{ time: 10, duration: 20, note: "Hook", color: "red" }],
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-02T00:00:00Z"),
					tracks: sceneTracks(),
				},
				{
					id: "scene-b",
					name: "Second",
					isMain: false,
					bookmarks: [],
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-02T00:00:00Z"),
					tracks: emptyTracks("second"),
				},
			],
		} as unknown as TProject,
		mediaAssets: [
			{
				id: "media-video",
				name: "source.mp4",
				type: "video",
				file: { size: 123 },
				width: 1920,
				height: 1080,
				duration: 2,
				fps: 30,
				hasAudio: true,
				sourceFingerprint: "source-a",
				source: verifiedLocalSource("a"),
				role: "timeline",
			},
			{
				id: "media-matte",
				name: "matte.webm",
				type: "video",
				file: { size: 321 },
				sourceFingerprint: "matte-source",
				source: verifiedLocalSource("b"),
				role: "matte",
			},
		],
	};
}

function sceneTracks() {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [videoElement()],
		},
		overlay: [
			{
				id: "graphics",
				name: "Graphics",
				type: "graphic",
				hidden: false,
				elements: [graphicElement(), stickerElement()],
			},
			{
				id: "effects",
				name: "Effects",
				type: "effect",
				hidden: false,
				elements: [effectTrackElement()],
			},
			{
				id: "compound-track",
				name: "Compound",
				type: "video",
				muted: false,
				hidden: false,
				elements: [compoundElement()],
			},
		],
		audio: [],
	};
}

function emptyTracks(prefix: string) {
	return {
		main: {
			id: `${prefix}-main`,
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		overlay: [],
		audio: [],
	};
}

function baseElement({
	id,
	name,
	type,
}: {
	id: string;
	name: string;
	type: string;
}) {
	return {
		id,
		name,
		type,
		groupId: "group-a",
		linkId: "link-a",
		startTime: 0,
		duration: 120,
		trimStart: 0,
		trimEnd: 0,
		sourceDuration: 120,
		params: {},
	};
}

function videoElement() {
	return {
		...baseElement({ id: "video", name: "Video", type: "video" }),
		mediaId: "media-video",
		isSourceAudioEnabled: true,
		hidden: false,
		retime: { rate: 1, maintainPitch: true },
		params: { "reframe.focalX": 0.5, opacity: 1 },
		animations: {
			opacity: {
				keys: [
					{
						id: "key-1",
						time: 0,
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
		transitionIn: {
			id: "transition-1",
			type: "crossfade",
			duration: 30,
			fromElementId: "previous-video",
		},
		effects: [
			{
				id: "fx-1",
				type: "color-grade",
				enabled: true,
				params: { contrast: 12 },
			},
		],
		masks: [
			{
				id: "mask-1",
				type: "ellipse",
				params: {
					feather: 2,
					inverted: false,
					strokeColor: "#ffffff",
					strokeWidth: 0,
					strokeAlign: "center",
					centerX: 0.5,
					centerY: 0.5,
					width: 0.5,
					height: 0.5,
					rotation: 0,
					scale: 1,
				},
			},
		],
		matte: {
			assetId: "media-matte",
			sourceMediaId: "media-video",
			sourceFingerprint: "source-a",
			artifactHash: "matte-content",
			artifactFingerprint: "matte-source",
			channel: "red",
			modelId: "model",
			modelVersion: "1",
			enabled: true,
		},
		audioReplacement: {
			assetId: "audio-clean",
			sourceMediaId: "media-video",
			sourceFingerprint: "source-a",
			artifactHash: "audio-content",
			artifactFingerprint: "audio-source",
			modelId: "cleaner",
			modelVersion: "1",
			enabled: true,
		},
	};
}

function graphicElement() {
	return {
		...baseElement({ id: "graphic", name: "Graphic", type: "graphic" }),
		definitionId: "rectangle",
		hidden: false,
		effects: [],
		masks: [],
	};
}

function stickerElement() {
	return {
		...baseElement({ id: "sticker", name: "Sticker", type: "sticker" }),
		stickerId: "shape:circle",
		intrinsicWidth: 100,
		intrinsicHeight: 100,
		hidden: false,
		effects: [],
	};
}

function effectTrackElement() {
	return {
		...baseElement({ id: "effect", name: "Effect", type: "effect" }),
		effectType: "color-grade",
	};
}

function compoundElement() {
	return {
		...baseElement({ id: "compound", name: "Compound", type: "compound" }),
		hidden: false,
		tracks: {
			...emptyTracks("nested"),
			overlay: [
				{
					id: "nested-text",
					name: "Nested text",
					type: "text",
					hidden: false,
					elements: [
						{
							...baseElement({
								id: "nested-text-element",
								name: "Nested",
								type: "text",
							}),
							hidden: false,
							params: { text: "Nested" },
							effects: [],
						},
					],
				},
			],
		},
	};
}

function video(input: ProjectContentInput): FixtureVideo {
	return input.project.scenes[0]!.tracks.main
		.elements[0] as unknown as FixtureVideo;
}

function graphic(input: ProjectContentInput): { definitionId: string } {
	return input.project.scenes[0]!.tracks.overlay[0]!.elements[0] as unknown as {
		definitionId: string;
	};
}

function sticker(input: ProjectContentInput): { stickerId: string } {
	return input.project.scenes[0]!.tracks.overlay[0]!.elements[1] as unknown as {
		stickerId: string;
	};
}

function effectElement(input: ProjectContentInput): { effectType: string } {
	return input.project.scenes[0]!.tracks.overlay[1]!.elements[0] as unknown as {
		effectType: string;
	};
}

function compoundText(input: ProjectContentInput): {
	params: { text: string };
} {
	const compound = input.project.scenes[0]!.tracks.overlay[2]!
		.elements[0] as unknown as {
		tracks: {
			overlay: Array<{ elements: Array<{ params: { text: string } }> }>;
		};
	};
	return compound.tracks.overlay[0]!.elements[0]!;
}

function requireDigest(
	result: Awaited<ReturnType<typeof hashProjectContent>>,
): string {
	if (result.status !== "hashed") {
		throw new Error("expected the fixture to have complete content identity");
	}
	return result.hash.digest;
}

async function digest(input: ProjectContentInput): Promise<string> {
	return requireDigest(await hashProjectContent(input));
}

function verifiedLocalSource(seed: string): ProjectContentMediaSource {
	return {
		kind: "local",
		contentHash: { algorithm: "SHA-256", digest: seed.repeat(64) },
	};
}

function addLibraryAudio({
	input,
	sourceUrl,
}: {
	input: MutableInput;
	sourceUrl: string;
}): void {
	input.project.scenes[0]!.tracks.audio.push({
		id: "library-audio",
		name: "Library audio",
		type: "audio",
		muted: false,
		elements: [
			{
				...baseElement({
					id: "library-element",
					name: "Library",
					type: "audio",
				}),
				sourceType: "library",
				sourceUrl,
			},
		],
	} as unknown as TProject["scenes"][number]["tracks"]["audio"][number]);
}
