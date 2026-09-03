import type { TProject } from "@/project/types";
import type {
	ClipAudioReplacementAttachment,
	ClipMatteAttachment,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import {
	canonicalSerialize as serializeCanonicalJson,
	findCanonicalJsonDomainBlockers,
} from "@opencut/canonical-json";

export const PROJECT_CONTENT_PROJECTION = "opencut-project-content" as const;
export const PROJECT_CONTENT_PROJECTION_VERSION = 2 as const;
export const PROJECT_CONTENT_HASH_ALGORITHM = "SHA-256" as const;
export const PROJECT_CONTENT_NEGATIVE_ZERO_POLICY =
	"normalize-to-zero" as const;

export interface ImmutableContentHash {
	algorithm: string;
	digest: string;
}

export type ProjectContentMediaSource =
	| {
			kind: "local";
			contentHash?: ImmutableContentHash;
	  }
	| {
			kind: "provider";
			sourceUrl: string;
			provider?: string;
			providerVersion?: string;
			contentHash?: ImmutableContentHash;
	  };

export interface ProjectContentMediaAsset {
	id: string;
	name: string;
	type: "image" | "video" | "audio";
	size?: number;
	file?: { size: number };
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	sourceFingerprint?: string;
	source: ProjectContentMediaSource;
	role?: "timeline" | "matte" | "audio-replacement";
}

export interface ProjectContentHash {
	algorithm: typeof PROJECT_CONTENT_HASH_ALGORITHM;
	projection: typeof PROJECT_CONTENT_PROJECTION;
	projectionVersion: ProjectContentProjectionVersion;
	digest: string;
}

export type ProjectContentProjectionVersion = 1 | 2;

export interface ProjectContentProjectionOptions {
	projectionVersion?: ProjectContentProjectionVersion;
}

export interface ProjectContentInput {
	project: TProject;
	mediaAssets: readonly ProjectContentMediaAsset[];
}

export type ProjectContentHashBlocker =
	| {
			code: "missing-media-content-hash";
			assetId: string;
			missingFields: ["source.contentHash"];
	  }
	| {
			code: "incomplete-provider-media-identity";
			assetId: string;
			sourceUrl: string;
			missingFields: string[];
	  }
	| {
			code: "unverified-url-media";
			sourceUrl: string;
			missingFields: ["mediaAssets.providerIdentity"];
	  }
	| {
			code: "unsafe-integer";
			path: string;
			value: string;
	  }
	| {
			code: "invalid-unicode";
			path: string;
	  };

export type ProjectContentHashResult =
	| { status: "hashed"; hash: ProjectContentHash }
	| { status: "blocked"; blockers: ProjectContentHashBlocker[] };

export function buildCanonicalProjectState(
	{ project, mediaAssets }: ProjectContentInput,
	options: ProjectContentProjectionOptions = {},
): Record<string, unknown> {
	const projectionVersion =
		options.projectionVersion ?? PROJECT_CONTENT_PROJECTION_VERSION;
	if (projectionVersion !== 1 && projectionVersion !== 2) {
		throw new Error(
			`Unsupported project content projection version: ${String(projectionVersion)}`,
		);
	}
	assertUniqueMediaIds(mediaAssets);
	assertCanonicalMediaHashes(mediaAssets);
	return {
		projection: PROJECT_CONTENT_PROJECTION,
		projectionVersion,
		project: {
			...(projectionVersion === 2 ? { id: project.metadata.id } : {}),
			name: project.metadata.name,
			activeSceneId: project.currentSceneId,
			mainSceneId: project.scenes.find((scene) => scene.isMain)?.id ?? null,
			settings: toCanonicalValue(project.settings),
			scenes: project.scenes.map((scene, order) => ({
				order,
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				bookmarks: scene.bookmarks.map((bookmark, bookmarkOrder) => ({
					order: bookmarkOrder,
					time: bookmark.time,
					duration: bookmark.duration ?? null,
					note: bookmark.note ?? null,
					color: bookmark.color ?? null,
				})),
				tracks: projectTracks(scene.tracks),
			})),
		},
		mediaAssets: [...mediaAssets]
			.sort((left, right) => compareOrdinal({ left: left.id, right: right.id }))
			.map(projectMediaIdentity),
	};
}

export function serializeProjectContent(
	input: ProjectContentInput,
	options: ProjectContentProjectionOptions = {},
): string {
	return canonicalSerialize(buildCanonicalProjectState(input, options));
}

export async function hashProjectContent(
	input: ProjectContentInput,
	options: ProjectContentProjectionOptions = {},
): Promise<ProjectContentHashResult> {
	assertCanonicalMediaHashes(input.mediaAssets);
	const projection = buildCanonicalProjectState(input, options);
	const blockers = [
		...findContentIdentityBlockers(input),
		...findCanonicalDomainBlockers(projection),
	];
	if (blockers.length > 0) return { status: "blocked", blockers };
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable");
	const bytes = new TextEncoder().encode(canonicalSerialize(projection));
	const digest = await subtle.digest(PROJECT_CONTENT_HASH_ALGORITHM, bytes);
	const projectionVersion =
		options.projectionVersion ?? PROJECT_CONTENT_PROJECTION_VERSION;
	return {
		status: "hashed",
		hash: {
			algorithm: PROJECT_CONTENT_HASH_ALGORITHM,
			projection: PROJECT_CONTENT_PROJECTION,
			projectionVersion,
			digest: bytesToHex(new Uint8Array(digest)),
		},
	};
}

export function canonicalSerialize(value: unknown): string {
	const blocker = findCanonicalDomainBlockers(value)[0];
	if (blocker) throw new ProjectContentCanonicalizationError(blocker);
	try {
		return serializeCanonicalJson(value);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Canonical JSON ")) {
			throw new Error(
				error.message.replace("Canonical JSON ", "Project content "),
			);
		}
		throw error;
	}
}

export class ProjectContentCanonicalizationError extends Error {
	constructor(
		readonly blocker: Extract<ProjectContentHashBlocker, { path: string }>,
	) {
		super(
			blocker.code === "unsafe-integer"
				? `Project content contains an unsafe integer at ${blocker.path}`
				: `Project content contains invalid Unicode at ${blocker.path}`,
		);
		this.name = "ProjectContentCanonicalizationError";
	}
}

type CanonicalDomainBlocker = Extract<
	ProjectContentHashBlocker,
	{ path: string }
>;

function findCanonicalDomainBlockers(value: unknown): CanonicalDomainBlocker[] {
	return findCanonicalJsonDomainBlockers(value);
}

function projectTracks(tracks: SceneTracks): Array<Record<string, unknown>> {
	return [
		projectTrack({ track: tracks.main, role: "main", order: 0 }),
		...tracks.overlay.map((track, order) =>
			projectTrack({ track, role: "overlay", order }),
		),
		...tracks.audio.map((track, order) =>
			projectTrack({ track, role: "audio", order }),
		),
	];
}

function projectTrack({
	track,
	role,
	order,
}: {
	track: TimelineTrack;
	role: "main" | "overlay" | "audio";
	order: number;
}): Record<string, unknown> {
	return {
		role,
		order,
		id: track.id,
		name: track.name,
		type: track.type,
		muted: "muted" in track ? track.muted : null,
		hidden: "hidden" in track ? track.hidden : null,
		transitions: track.elements.flatMap((element, transitionOrder) =>
			element.transitionIn
				? [
						{
							order: transitionOrder,
							id: element.transitionIn.id,
							fromElementId: element.transitionIn.fromElementId,
							toElementId: element.id,
							type: element.transitionIn.type,
							duration: element.transitionIn.duration,
						},
					]
				: [],
		),
		elements: track.elements.map((element, elementOrder) =>
			projectElement({ element, order: elementOrder }),
		),
	};
}

function projectElement({
	element,
	order,
}: {
	element: TimelineElement;
	order: number;
}): Record<string, unknown> {
	const common: Record<string, unknown> = {
		order,
		id: element.id,
		name: element.name,
		type: element.type,
		groupId: element.groupId ?? null,
		linkId: element.linkId ?? null,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		sourceDuration: element.sourceDuration ?? null,
		params: toCanonicalValue(element.params),
		animations: toCanonicalValue(element.animations ?? {}),
	};

	switch (element.type) {
		case "audio":
			return {
				...common,
				sourceType: element.sourceType,
				mediaId: element.sourceType === "upload" ? element.mediaId : null,
				sourceUrl: element.sourceType === "library" ? element.sourceUrl : null,
				retime: toCanonicalValue(element.retime ?? null),
				audioReplacement: projectAudioReplacement(element.audioReplacement),
			};
		case "video":
			return {
				...common,
				mediaId: element.mediaId,
				hidden: element.hidden ?? null,
				isSourceAudioEnabled: element.isSourceAudioEnabled ?? null,
				retime: toCanonicalValue(element.retime ?? null),
				effects: projectEffects(element.effects),
				masks: projectMasks(element.masks),
				matte: projectMatte(element.matte),
				audioReplacement: projectAudioReplacement(element.audioReplacement),
			};
		case "image":
			return {
				...common,
				mediaId: element.mediaId,
				hidden: element.hidden ?? null,
				effects: projectEffects(element.effects),
				masks: projectMasks(element.masks),
			};
		case "text":
			return {
				...common,
				hidden: element.hidden ?? null,
				effects: projectEffects(element.effects),
			};
		case "sticker":
			return {
				...common,
				stickerId: element.stickerId,
				intrinsicWidth: element.intrinsicWidth ?? null,
				intrinsicHeight: element.intrinsicHeight ?? null,
				hidden: element.hidden ?? null,
				effects: projectEffects(element.effects),
			};
		case "graphic":
			return {
				...common,
				definitionId: element.definitionId,
				hidden: element.hidden ?? null,
				effects: projectEffects(element.effects),
				masks: projectMasks(element.masks),
			};
		case "effect":
			return { ...common, effectType: element.effectType };
		case "compound":
			return {
				...common,
				hidden: element.hidden ?? null,
				tracks: projectTracks(element.tracks),
			};
	}
}

function projectEffects(
	effects: Extract<TimelineElement, { type: "video" }>["effects"],
): Array<Record<string, unknown>> {
	return (effects ?? []).map((effect, order) => ({
		order,
		id: effect.id,
		type: effect.type,
		enabled: effect.enabled,
		params: toCanonicalValue(effect.params),
	}));
}

function projectMasks(
	masks: Extract<TimelineElement, { type: "video" }>["masks"],
): Array<Record<string, unknown>> {
	return (masks ?? []).map((mask, order) => ({
		order,
		id: mask.id,
		type: mask.type,
		params: toCanonicalValue(mask.params),
	}));
}

function projectMatte(
	matte: ClipMatteAttachment | undefined,
): Record<string, unknown> | null {
	return matte ? projectAttachment(matte) : null;
}

function projectAudioReplacement(
	replacement: ClipAudioReplacementAttachment | undefined,
): Record<string, unknown> | null {
	return replacement ? projectAttachment(replacement) : null;
}

function projectAttachment(
	attachment: ClipMatteAttachment | ClipAudioReplacementAttachment,
): Record<string, unknown> {
	return {
		assetId: attachment.assetId,
		sourceMediaId: attachment.sourceMediaId,
		sourceFingerprint: attachment.sourceFingerprint,
		artifactHash: attachment.artifactHash,
		artifactFingerprint: attachment.artifactFingerprint,
		modelId: attachment.modelId,
		modelVersion: attachment.modelVersion,
		enabled: attachment.enabled,
		...("channel" in attachment ? { channel: attachment.channel } : {}),
	};
}

function projectMediaIdentity(
	asset: ProjectContentMediaAsset,
): Record<string, unknown> {
	return {
		id: asset.id,
		name: asset.name,
		type: asset.type,
		size: asset.file?.size ?? asset.size ?? null,
		width: asset.width ?? null,
		height: asset.height ?? null,
		duration: asset.duration ?? null,
		fps: asset.fps ?? null,
		hasAudio: asset.hasAudio ?? null,
		sourceFingerprint: asset.sourceFingerprint ?? null,
		source:
			asset.source.kind === "local"
				? {
						kind: asset.source.kind,
						contentHash: projectImmutableHash(asset.source.contentHash),
					}
				: {
						kind: asset.source.kind,
						sourceUrl: asset.source.sourceUrl,
						provider: asset.source.provider ?? null,
						providerVersion: asset.source.providerVersion ?? null,
						contentHash: projectImmutableHash(asset.source.contentHash),
					},
		role: asset.role ?? null,
	};
}

function projectImmutableHash(
	hash: ImmutableContentHash | undefined,
): Record<string, string> | null {
	return hash
		? { algorithm: hash.algorithm, digest: hash.digest.toLowerCase() }
		: null;
}

function findContentIdentityBlockers({
	project,
	mediaAssets,
}: ProjectContentInput): ProjectContentHashBlocker[] {
	assertUniqueMediaIds(mediaAssets);
	const blockers: ProjectContentHashBlocker[] = [];
	const orderedAssets = [...mediaAssets].sort((left, right) =>
		compareOrdinal({ left: left.id, right: right.id }),
	);
	for (const asset of orderedAssets) {
		if (asset.source.kind === "local") {
			if (!isCompleteContentHash(asset.source.contentHash)) {
				blockers.push({
					code: "missing-media-content-hash",
					assetId: asset.id,
					missingFields: ["source.contentHash"],
				});
			}
			continue;
		}
		const missingFields = providerIdentityMissingFields(asset.source);
		if (missingFields.length > 0) {
			blockers.push({
				code: "incomplete-provider-media-identity",
				assetId: asset.id,
				sourceUrl: asset.source.sourceUrl,
				missingFields,
			});
		}
	}

	const providerUrls = new Set(
		mediaAssets.flatMap((asset) =>
			asset.source.kind === "provider" ? [asset.source.sourceUrl] : [],
		),
	);
	for (const sourceUrl of [...referencedLibraryUrls(project)].sort(
		(left, right) => compareOrdinal({ left, right }),
	)) {
		if (!providerUrls.has(sourceUrl)) {
			blockers.push({
				code: "unverified-url-media",
				sourceUrl,
				missingFields: ["mediaAssets.providerIdentity"],
			});
		}
	}
	return blockers;
}

function providerIdentityMissingFields(
	source: Extract<ProjectContentMediaSource, { kind: "provider" }>,
): string[] {
	const missing: string[] = [];
	if (!source.sourceUrl.trim()) missing.push("source.sourceUrl");
	if (!source.provider?.trim()) missing.push("source.provider");
	if (!source.providerVersion?.trim()) missing.push("source.providerVersion");
	if (!isCompleteContentHash(source.contentHash)) {
		missing.push("source.contentHash");
	}
	return missing;
}

function isCompleteContentHash(
	hash: ImmutableContentHash | undefined,
): hash is ImmutableContentHash {
	return hash !== undefined;
}

function assertCanonicalMediaHashes(
	mediaAssets: readonly ProjectContentMediaAsset[],
): void {
	for (const asset of mediaAssets) {
		const hash = asset.source.contentHash;
		if (!hash) continue;
		if (hash.algorithm !== PROJECT_CONTENT_HASH_ALGORITHM) {
			throw new Error(
				`Unsupported content hash algorithm for media asset ${asset.id}: ${hash.algorithm}`,
			);
		}
		if (!/^[a-fA-F0-9]{64}$/.test(hash.digest)) {
			throw new Error(
				`Invalid SHA-256 digest for media asset ${asset.id}: expected 64 hexadecimal characters`,
			);
		}
	}
}

function referencedLibraryUrls(project: TProject): Set<string> {
	const urls = new Set<string>();
	for (const scene of project.scenes) {
		collectLibraryUrls({ tracks: scene.tracks, urls });
	}
	return urls;
}

function collectLibraryUrls({
	tracks,
	urls,
}: {
	tracks: SceneTracks;
	urls: Set<string>;
}): void {
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			if (element.type === "audio" && element.sourceType === "library") {
				urls.add(element.sourceUrl);
			}
			if (element.type === "compound") {
				collectLibraryUrls({ tracks: element.tracks, urls });
			}
		}
	}
}

function assertUniqueMediaIds(
	mediaAssets: readonly ProjectContentMediaAsset[],
): void {
	const seen = new Set<string>();
	for (const asset of mediaAssets) {
		if (seen.has(asset.id)) {
			throw new Error(`Duplicate project media asset ID: ${asset.id}`);
		}
		seen.add(asset.id);
	}
}

function toCanonicalValue(value: unknown): unknown {
	if (
		value === null ||
		["string", "boolean", "number"].includes(typeof value)
	) {
		return value;
	}
	if (Array.isArray(value)) {
		assertDenseDefinedArray(value);
		return value.map(toCanonicalValue);
	}
	if (!isPlainObject(value)) {
		throw new Error(
			"Project content contains a non-serializable runtime value",
		);
	}
	const entries = Object.entries(value);
	for (const [key, entry] of entries) {
		if (entry === undefined) {
			throw new Error(
				`Project content contains undefined at object key ${key}`,
			);
		}
	}
	return Object.fromEntries(
		entries.map(([key, entry]) => [key, toCanonicalValue(entry)]),
	);
}

function assertDenseDefinedArray(value: unknown[]): void {
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) {
			throw new Error(
				`Project content contains a sparse array slot at ${index}`,
			);
		}
		if (value[index] === undefined) {
			throw new Error(
				`Project content contains undefined at array index ${index}`,
			);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function compareOrdinal({
	left,
	right,
}: {
	left: string;
	right: string;
}): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
