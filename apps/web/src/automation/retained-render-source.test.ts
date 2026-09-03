/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { PersistedMediaReadback } from "@/services/storage/types";
import type { SceneTracks } from "@/timeline";
import { mediaTime } from "@/wasm";
import type { ProjectSnapshot } from "opencut-wasm";
import {
	buildCanonicalProjectState,
	canonicalSerialize,
	type ProjectContentHash,
} from "./project-content-hash";
import {
	resolveRetainedRenderSource,
	type RetainedRenderSourceBinding,
} from "./retained-render-source";

describe("retained render source resolution", () => {
	test("uses the exact retained state and media when the live third state and relinked asset differ", async () => {
		const oldBytes = new TextEncoder().encode("original media bytes");
		const oldMediaDigest = await sha256Bytes(oldBytes);
		const oldFile = new File([oldBytes], "original.mp4", {
			type: "video/mp4",
			lastModified: 100,
		});
		const media = persistedMedia({ file: oldFile, digest: oldMediaDigest });
		const snapshot = buildSnapshot(media);
		const binding = await sourceBinding(snapshot);
		const replacementFile = new File(["replacement bytes"], "replacement.mp4");
		let liveReads = 0;
		let currentMediaReads = 0;

		const dependencies = {
			loadProjectSnapshot: async (lookup: {
				projectId: string;
				contentHash: ProjectContentHash;
			}) => {
				expect(lookup).toEqual({
					projectId: binding.projectId,
					contentHash: binding.contentHash,
				});
				return retainedSnapshot({
					snapshot,
					contentHash: binding.contentHash,
					media,
				});
			},
			loadSaveReceipt: async () => saveReceipt(binding),
			// These model the now-active third state and the asset ID being relinked.
			loadProjectFresh: async () => {
				liveReads += 1;
				return { name: "third state" };
			},
			loadMediaAsset: async () => {
				currentMediaReads += 1;
				return { ...media, file: replacementFile };
			},
		};
		const source = await resolveRetainedRenderSource({ binding, dependencies });

		expect(liveReads).toBe(0);
		expect(currentMediaReads).toBe(0);
		expect(source.binding).toEqual(binding);
		expect(source.settings).toEqual({
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#101010" },
		});
		expect(source.scene).toMatchObject({ id: "scene-1", name: "Main" });
		expect(source.scene.tracks).toEqual(expectedTracks());
		expect(
			new Uint8Array(await source.mediaAssets[0]!.file.arrayBuffer()),
		).toEqual(oldBytes);
	});

	test("rewrites retained library audio to its exact content-addressed provider bytes", async () => {
		const bytes = new TextEncoder().encode("retained provider audio bytes");
		const digest = await sha256Bytes(bytes);
		const media = persistedProviderAudio({
			file: new File([bytes], "provider.mp3", { type: "audio/mpeg" }),
			digest,
		});
		const sourceUrl = media.sourceIdentity.sourceUrl;
		const retainedProject = project();
		retainedProject.scenes[0]!.tracks.audio = [
			{
				id: "audio-track",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "library-audio",
						name: "Library audio",
						type: "audio",
						sourceType: "library",
						sourceUrl,
						startTime: mediaTime({ ticks: 0 }),
						duration: mediaTime({ ticks: 6_000 }),
						trimStart: mediaTime({ ticks: 0 }),
						trimEnd: mediaTime({ ticks: 0 }),
						sourceDuration: mediaTime({ ticks: 6_000 }),
						params: { volume: 1 },
						animations: {},
					},
				],
			},
		];
		const snapshot = buildCanonicalProjectState({
			project: retainedProject,
			mediaAssets: [
				{
					...media,
					file: media.file,
					source: media.sourceIdentity,
				},
			],
		});
		const binding = await sourceBinding(snapshot);
		const source = await resolveRetainedRenderSource({
			binding,
			dependencies: {
				loadProjectSnapshot: async () =>
					retainedSnapshot({
						snapshot,
						contentHash: binding.contentHash,
						media,
					}),
				loadSaveReceipt: async () => saveReceipt(binding),
			},
		});

		expect(source.scene.tracks.audio[0]!.elements[0]).toMatchObject({
			sourceType: "upload",
			mediaId: media.id,
		});
		expect(source.scene.tracks.audio[0]!.elements[0]).not.toHaveProperty(
			"sourceUrl",
		);
	});

	test("rejects an independently invalid save receipt as COMPARISON_SOURCE_UNAVAILABLE", async () => {
		const bytes = new TextEncoder().encode("source");
		const mediaDigest = await sha256Bytes(bytes);
		const media = persistedMedia({
			file: new File([bytes], "source.mp4"),
			digest: mediaDigest,
		});
		const snapshot = buildSnapshot(media);
		const binding = await sourceBinding(snapshot);

		await expect(
			resolveRetainedRenderSource({
				binding,
				dependencies: {
					loadProjectSnapshot: async () =>
						retainedSnapshot({
							snapshot,
							contentHash: binding.contentHash,
							media,
						}),
					loadSaveReceipt: async () => ({
						...saveReceipt(binding),
						writeVersion: binding.writeVersion + 1,
					}),
				},
			}),
		).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
			reason: "identity-mismatch",
			contentHash: binding.contentHash.digest,
		});
	});

	test("normalizes corrupt canonical renderer input to COMPARISON_SOURCE_UNAVAILABLE", async () => {
		const bytes = new TextEncoder().encode("source");
		const mediaDigest = await sha256Bytes(bytes);
		const media = persistedMedia({
			file: new File([bytes], "source.mp4"),
			digest: mediaDigest,
		});
		const snapshot = buildSnapshot(media);
		const binding = await sourceBinding(snapshot);
		const corrupt = structuredClone(snapshot);
		corrupt.project.settings = { fps: "thirty" };

		await expect(
			resolveRetainedRenderSource({
				binding,
				dependencies: {
					loadProjectSnapshot: async () =>
						retainedSnapshot({
							snapshot: corrupt,
							contentHash: binding.contentHash,
							media,
						}),
					loadSaveReceipt: async () => saveReceipt(binding),
				},
			}),
		).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
			reason: "corrupt",
		});
	});

	test("independently rejects retained media whose bytes no longer match the snapshot", async () => {
		const original = new TextEncoder().encode("source");
		const mediaDigest = await sha256Bytes(original);
		const media = persistedMedia({
			file: new File([original], "source.mp4"),
			digest: mediaDigest,
		});
		const snapshot = buildSnapshot(media);
		const binding = await sourceBinding(snapshot);
		const corrupted = {
			...media,
			file: new File(["corrupted"], "source.mp4"),
		};

		await expect(
			resolveRetainedRenderSource({
				binding,
				dependencies: {
					loadProjectSnapshot: async () =>
						retainedSnapshot({
							snapshot,
							contentHash: binding.contentHash,
							media: corrupted,
						}),
					loadSaveReceipt: async () => saveReceipt(binding),
				},
			}),
		).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
			reason: "corrupt",
		});
	});

	test("rejects a snapshot-store response bound to a different immutable hash", async () => {
		const bytes = new TextEncoder().encode("source");
		const mediaDigest = await sha256Bytes(bytes);
		const media = persistedMedia({
			file: new File([bytes], "source.mp4"),
			digest: mediaDigest,
		});
		const snapshot = buildSnapshot(media);
		const binding = await sourceBinding(snapshot);
		const wrongHash = { ...binding.contentHash, digest: "f".repeat(64) };

		await expect(
			resolveRetainedRenderSource({
				binding,
				dependencies: {
					loadProjectSnapshot: async () =>
						retainedSnapshot({ snapshot, contentHash: wrongHash, media }),
					loadSaveReceipt: async () => saveReceipt(binding),
				},
			}),
		).rejects.toMatchObject({
			code: "COMPARISON_SOURCE_UNAVAILABLE",
			reason: "identity-mismatch",
		});
	});
});

function buildSnapshot(media: PersistedMediaReadback): ProjectSnapshot {
	return buildCanonicalProjectState({
		project: project(),
		mediaAssets: [
			{
				id: media.id,
				name: media.name,
				type: media.type,
				file: media.file,
				width: media.width,
				height: media.height,
				duration: media.duration,
				fps: media.fps,
				hasAudio: media.hasAudio,
				sourceFingerprint: media.sourceFingerprint,
				role: media.role,
				source: media.sourceIdentity,
			},
		],
	});
}

function project(): TProject {
	return {
		metadata: {
			id: "project-1",
			name: "Before",
			duration: mediaTime({ ticks: 6_000 }),
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		scenes: [
			{
				id: "scene-1",
				name: "Main",
				isMain: true,
				bookmarks: [],
				createdAt: new Date(0),
				updatedAt: new Date(0),
				tracks: expectedTracks(),
			},
		],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#101010" },
		},
		version: 4,
	};
}

function expectedTracks(): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video" as const,
			muted: false,
			hidden: false,
			elements: [
				{
					id: "video-1",
					name: "First",
					type: "video" as const,
					mediaId: "media-1",
					startTime: mediaTime({ ticks: 0 }),
					duration: mediaTime({ ticks: 3_000 }),
					trimStart: mediaTime({ ticks: 0 }),
					trimEnd: mediaTime({ ticks: 0 }),
					sourceDuration: mediaTime({ ticks: 6_000 }),
					params: { opacity: 1 },
					animations: {},
					effects: [],
					masks: [],
				},
				{
					id: "video-2",
					name: "Second",
					type: "video" as const,
					mediaId: "media-1",
					startTime: mediaTime({ ticks: 3_000 }),
					duration: mediaTime({ ticks: 3_000 }),
					trimStart: mediaTime({ ticks: 0 }),
					trimEnd: mediaTime({ ticks: 0 }),
					sourceDuration: mediaTime({ ticks: 6_000 }),
					params: { opacity: 0.75 },
					animations: {},
					effects: [],
					masks: [],
					transitionIn: {
						id: "transition-1",
						type: "crossfade" as const,
						duration: mediaTime({ ticks: 300 }),
						fromElementId: "video-1",
					},
				},
			],
		},
		overlay: [
			{
				id: "captions",
				name: "Captions",
				type: "text" as const,
				hidden: false,
				elements: [
					{
						id: "text-1",
						name: "Caption",
						type: "text" as const,
						startTime: mediaTime({ ticks: 1_000 }),
						duration: mediaTime({ ticks: 2_000 }),
						trimStart: mediaTime({ ticks: 0 }),
						trimEnd: mediaTime({ ticks: 0 }),
						params: { content: "Before" },
						animations: {},
						effects: [],
					},
				],
			},
		],
		audio: [],
	};
}

function persistedMedia({
	file,
	digest,
}: {
	file: File;
	digest: string;
}): PersistedMediaReadback {
	return {
		id: "media-1",
		name: "source.mp4",
		type: "video",
		size: file.size,
		lastModified: file.lastModified,
		width: 1920,
		height: 1080,
		duration: 6_000,
		fps: 30,
		hasAudio: true,
		sourceFingerprint: "source-fingerprint",
		role: "timeline",
		sourceIdentity: {
			kind: "local",
			contentHash: { algorithm: "SHA-256", digest },
		},
		file,
	};
}

function persistedProviderAudio({
	file,
	digest,
}: {
	file: File;
	digest: string;
}): PersistedMediaReadback & {
	sourceIdentity: Extract<
		PersistedMediaReadback["sourceIdentity"],
		{ kind: "provider" }
	>;
} {
	return {
		id: "provider-audio-1",
		name: file.name,
		type: "audio",
		size: file.size,
		lastModified: file.lastModified,
		duration: 6_000,
		sourceFingerprint: "provider-audio-fingerprint",
		role: "timeline",
		sourceIdentity: {
			kind: "provider",
			sourceUrl: "https://provider.example/audio.mp3",
			provider: "test-provider",
			providerVersion: "1",
			contentHash: { algorithm: "SHA-256", digest },
		},
		file,
	};
}

async function sourceBinding(
	snapshot: ProjectSnapshot,
): Promise<RetainedRenderSourceBinding> {
	return {
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 12,
		contentHash: {
			algorithm: "SHA-256",
			projection: "opencut-project-content",
			projectionVersion: 3,
			digest: await sha256(canonicalSerialize(snapshot)),
		},
		writeVersion: 7,
		saveReceiptOperationId: "save-before",
		saveReceiptId: "save:project-1:7:before",
	};
}

function saveReceipt(binding: RetainedRenderSourceBinding) {
	return {
		status: "saved" as const,
		receiptId: binding.saveReceiptId,
		operationId: binding.saveReceiptOperationId,
		projectId: binding.projectId,
		sceneId: binding.sceneId,
		revision: binding.revision,
		contentHash: binding.contentHash.digest,
		contentHashProjectionVersion: binding.contentHash.projectionVersion,
		persistedAt: "2026-09-03T12:00:00.000Z",
		completedAt: "2026-09-03T12:00:01.000Z",
		storageSchemaVersion: 1,
		writeVersion: binding.writeVersion,
		reloadVerified: true as const,
		readbackContentHash: binding.contentHash.digest,
	};
}

function retainedSnapshot({
	snapshot,
	contentHash,
	media,
}: {
	snapshot: ProjectSnapshot;
	contentHash: ProjectContentHash;
	media: PersistedMediaReadback;
}) {
	return {
		contentHash,
		projectId: "project-1",
		snapshot,
		mediaAssets: [media],
		firstVerifiedAt: "2026-09-03T12:00:00.000Z",
		lastVerifiedAt: "2026-09-03T12:00:00.000Z",
		expiresAt: "2026-12-02T12:00:00.000Z",
		latestVerification: {
			writeVersion: 7,
			receiptId: "some-later-receipt-for-the-same-hash",
			operationId: "some-later-save",
			verifiedAt: "2026-09-03T12:00:00.000Z",
		},
	};
}

async function sha256(value: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
	const bytes = Uint8Array.from(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
