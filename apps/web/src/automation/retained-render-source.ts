import type {
	CanonicalAttachment,
	CanonicalElement,
	CanonicalEffect,
	CanonicalMask,
	CanonicalTrack,
	ProjectSnapshot,
} from "opencut-wasm";
import type { ChannelData, ElementAnimations } from "@/animation/types";
import type { Effect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import type { TProjectSettings } from "@/project/types";
import {
	ComparisonSourceUnavailableError,
	type LoadProjectSnapshotInput,
	type RetainedProjectSnapshot,
	verifyRetainedProjectMedia,
} from "@/services/storage/project-snapshot-storage";
import { storageService } from "@/services/storage/service";
import type { PersistedMediaReadback } from "@/services/storage/types";
import {
	CLIP_TRANSITION_TYPES,
	type ClipAudioReplacementAttachment,
	type ClipMatteAttachment,
	type ClipTransition,
	type AudioElement,
	type CompoundElement,
	type EffectElement,
	type GraphicElement,
	type ImageElement,
	type OverlayTrack,
	type RetimeConfig,
	type SceneTracks,
	type StickerElement,
	type TextElement,
	type TimelineElement,
	type TimelineTrack,
	type VideoElement,
} from "@/timeline";
import { mediaTime } from "@/wasm";
import type { ProjectContentHash } from "./project-content-hash";
import {
	parsePersistedSaveProjectResult,
	type PersistedAutomationSaveResult,
} from "./save-project-receipt";

export interface RetainedRenderSourceBinding {
	projectId: string;
	sceneId: string;
	revision: number;
	contentHash: ProjectContentHash;
	writeVersion: number;
	saveReceiptOperationId: string;
	saveReceiptId: string;
}

export interface RetainedRenderSource {
	binding: RetainedRenderSourceBinding;
	snapshot: ProjectSnapshot;
	scene: { id: string; name: string; tracks: SceneTracks };
	settings: TProjectSettings;
	mediaAssets: PersistedMediaReadback[];
	saveReceipt: PersistedAutomationSaveResult;
	retention: Pick<
		RetainedProjectSnapshot,
		"firstVerifiedAt" | "lastVerifiedAt" | "expiresAt"
	>;
}

export interface RetainedRenderSourceDependencies {
	loadProjectSnapshot(
		input: LoadProjectSnapshotInput,
	): Promise<RetainedProjectSnapshot>;
	loadSaveReceipt(operationId: string): Promise<unknown>;
}

const defaultDependencies: RetainedRenderSourceDependencies = {
	loadProjectSnapshot: (input) => storageService.loadProjectSnapshot(input),
	loadSaveReceipt: async (operationId) => {
		const envelope = await storageService.loadSaveReceipt({
			operationId,
			parseResult: parsePersistedSaveProjectResult,
		});
		return envelope?.result ?? null;
	},
};

export async function resolveRetainedRenderSource({
	binding,
	dependencies = defaultDependencies,
}: {
	binding: RetainedRenderSourceBinding;
	dependencies?: RetainedRenderSourceDependencies;
}): Promise<RetainedRenderSource> {
	let retained: RetainedProjectSnapshot;
	try {
		retained = await dependencies.loadProjectSnapshot({
			projectId: binding.projectId,
			contentHash: binding.contentHash,
		});
	} catch (error) {
		if (error instanceof ComparisonSourceUnavailableError) throw error;
		throw unavailable({ binding, reason: "corrupt" });
	}
	if (
		retained.projectId !== binding.projectId ||
		retained.contentHash.algorithm !== binding.contentHash.algorithm ||
		retained.contentHash.projection !== binding.contentHash.projection ||
		retained.contentHash.projectionVersion !==
			binding.contentHash.projectionVersion ||
		retained.contentHash.digest !== binding.contentHash.digest ||
		retained.snapshot.projection !== binding.contentHash.projection ||
		retained.snapshot.projectionVersion !==
			binding.contentHash.projectionVersion ||
		(retained.snapshot.projectionVersion >= 2 &&
			retained.snapshot.project.id !== binding.projectId)
	) {
		throw unavailable({ binding, reason: "identity-mismatch" });
	}

	let saveReceipt: PersistedAutomationSaveResult;
	try {
		const value = await dependencies.loadSaveReceipt(
			binding.saveReceiptOperationId,
		);
		if (value === null || value === undefined) {
			throw unavailable({ binding, reason: "missing" });
		}
		saveReceipt = parsePersistedSaveProjectResult(value);
	} catch (error) {
		if (error instanceof ComparisonSourceUnavailableError) throw error;
		throw unavailable({ binding, reason: "corrupt" });
	}

	if (!receiptMatchesBinding({ receipt: saveReceipt, binding })) {
		throw unavailable({ binding, reason: "identity-mismatch" });
	}

	try {
		const scene = singleScene({
			snapshot: retained.snapshot,
			sceneId: binding.sceneId,
		});
		const providerAudioMediaIds = providerAudioMediaIdsByUrl(retained.snapshot);
		const mediaAssets = await verifyRetainedProjectMedia({
			snapshot: retained.snapshot,
			mediaAssets: retained.mediaAssets,
		});
		return {
			binding: { ...binding, contentHash: { ...binding.contentHash } },
			snapshot: retained.snapshot,
			scene: {
				id: scene.id,
				name: scene.name,
				tracks: decodeSceneTracks({
					value: scene.tracks,
					providerAudioMediaIds,
				}),
			},
			settings: decodeProjectSettings(retained.snapshot.project.settings),
			mediaAssets,
			saveReceipt,
			retention: {
				firstVerifiedAt: retained.firstVerifiedAt,
				lastVerifiedAt: retained.lastVerifiedAt,
				expiresAt: retained.expiresAt,
			},
		};
	} catch (error) {
		if (error instanceof ComparisonSourceUnavailableError) throw error;
		throw unavailable({ binding, reason: "corrupt" });
	}
}

function receiptMatchesBinding({
	receipt,
	binding,
}: {
	receipt: PersistedAutomationSaveResult;
	binding: RetainedRenderSourceBinding;
}): boolean {
	return (
		receipt.status === "saved" &&
		receipt.receiptId === binding.saveReceiptId &&
		receipt.operationId === binding.saveReceiptOperationId &&
		receipt.projectId === binding.projectId &&
		receipt.sceneId === binding.sceneId &&
		receipt.revision === binding.revision &&
		receipt.contentHash === binding.contentHash.digest &&
		receipt.readbackContentHash === binding.contentHash.digest &&
		receipt.contentHashProjectionVersion ===
			binding.contentHash.projectionVersion &&
		receipt.writeVersion === binding.writeVersion &&
		receipt.reloadVerified === true
	);
}

function providerAudioMediaIdsByUrl(
	snapshot: ProjectSnapshot,
): ReadonlyMap<string, string> {
	const resolved = new Map<string, { id: string; digest: string }>();
	for (const asset of snapshot.mediaAssets) {
		if (asset.type !== "audio" || asset.source.kind !== "provider") continue;
		const digest = asset.source.contentHash?.digest;
		if (!digest) {
			throw new Error("retained provider audio has no immutable content hash");
		}
		const prior = resolved.get(asset.source.sourceUrl);
		if (prior && prior.digest !== digest) {
			throw new Error(
				"retained provider audio URL is bound to multiple byte identities",
			);
		}
		if (!prior || asset.id < prior.id) {
			resolved.set(asset.source.sourceUrl, { id: asset.id, digest });
		}
	}
	return new Map(
		[...resolved.entries()].map(([sourceUrl, value]) => [sourceUrl, value.id]),
	);
}

function singleScene({
	snapshot,
	sceneId,
}: {
	snapshot: ProjectSnapshot;
	sceneId: string;
}) {
	const scenes = snapshot.project.scenes.filter(
		(scene) => scene.id === sceneId,
	);
	if (scenes.length !== 1)
		throw new Error("retained scene identity is invalid");
	return scenes[0]!;
}

function decodeProjectSettings(
	value: Record<string, unknown>,
): TProjectSettings {
	const fps = recordField({ value, field: "fps" });
	const canvasSize = recordField({ value, field: "canvasSize" });
	const background = recordField({ value, field: "background" });
	if (
		!positiveInteger(fps.numerator) ||
		!positiveInteger(fps.denominator) ||
		!positiveInteger(canvasSize.width) ||
		!positiveInteger(canvasSize.height)
	) {
		throw new Error("retained project render settings are invalid");
	}
	if (
		(background.type !== "color" || typeof background.color !== "string") &&
		(background.type !== "blur" ||
			typeof background.blurIntensity !== "number" ||
			!Number.isFinite(background.blurIntensity))
	) {
		throw new Error("retained project background is invalid");
	}
	const optional = decodeOptionalProjectSettings(value);
	return {
		fps: { numerator: fps.numerator, denominator: fps.denominator },
		canvasSize: { width: canvasSize.width, height: canvasSize.height },
		background: decodeBackground(background),
		...optional,
	};
}

function decodeBackground(
	value: Record<string, unknown>,
): TProjectSettings["background"] {
	if (value.type === "color" && typeof value.color === "string") {
		return { type: value.type, color: value.color };
	}
	if (
		value.type === "blur" &&
		typeof value.blurIntensity === "number" &&
		Number.isFinite(value.blurIntensity)
	) {
		return { type: value.type, blurIntensity: value.blurIntensity };
	}
	throw new Error("retained project background is invalid");
}

function decodeOptionalProjectSettings(
	value: Record<string, unknown>,
): Pick<
	TProjectSettings,
	"canvasSizeMode" | "lastCustomCanvasSize" | "originalCanvasSize"
> {
	if (
		value.canvasSizeMode !== undefined &&
		value.canvasSizeMode !== "preset" &&
		value.canvasSizeMode !== "custom"
	) {
		throw new Error("retained canvas size mode is invalid");
	}
	return {
		...(value.canvasSizeMode === undefined
			? {}
			: { canvasSizeMode: value.canvasSizeMode }),
		...decodeOptionalCanvasSize({ value, field: "lastCustomCanvasSize" }),
		...decodeOptionalCanvasSize({ value, field: "originalCanvasSize" }),
	};
}

function decodeOptionalCanvasSize({
	value,
	field,
}: {
	value: Record<string, unknown>;
	field: "lastCustomCanvasSize" | "originalCanvasSize";
}): Partial<TProjectSettings> {
	const candidate = value[field];
	if (candidate === undefined) return {};
	if (candidate === null) return { [field]: null };
	if (
		!isRecord(candidate) ||
		!positiveInteger(candidate.width) ||
		!positiveInteger(candidate.height)
	) {
		throw new Error(`retained ${field} is invalid`);
	}
	return { [field]: { width: candidate.width, height: candidate.height } };
}

function decodeSceneTracks({
	value,
	providerAudioMediaIds,
}: {
	value: CanonicalTrack[];
	providerAudioMediaIds: ReadonlyMap<string, string>;
}): SceneTracks {
	const main = value.filter((track) => track.role === "main");
	const overlay = value.filter((track) => track.role === "overlay");
	const audio = value.filter((track) => track.role === "audio");
	if (
		main.length !== 1 ||
		main[0]!.type !== "video" ||
		value.length !== main.length + overlay.length + audio.length ||
		value.some((track, index) =>
			index === 0
				? track.role !== "main"
				: roleRank(value[index - 1]!.role) > roleRank(track.role),
		)
	) {
		throw new Error("retained scene track roles are invalid");
	}
	assertOrdered({ values: main, name: "main track" });
	assertOrdered({ values: overlay, name: "overlay track" });
	assertOrdered({ values: audio, name: "audio track" });
	const decodedMain = decodeTrack({
		track: main[0]!,
		providerAudioMediaIds,
	});
	if (decodedMain.type !== "video") {
		throw new Error("retained main track type is invalid");
	}
	const decodedOverlay = overlay.map((track) =>
		decodeTrack({ track, providerAudioMediaIds }),
	);
	if (!decodedOverlay.every(isOverlayTrack)) {
		throw new Error("retained overlay track type is invalid");
	}
	const decodedAudio = audio.map((track) =>
		decodeTrack({ track, providerAudioMediaIds }),
	);
	if (!decodedAudio.every((track) => track.type === "audio")) {
		throw new Error("retained audio track type is invalid");
	}
	return {
		main: decodedMain,
		overlay: decodedOverlay,
		audio: decodedAudio,
	};
}

function isOverlayTrack(track: TimelineTrack): track is OverlayTrack {
	return (
		track.type === "video" ||
		track.type === "text" ||
		track.type === "graphic" ||
		track.type === "effect"
	);
}

function roleRank(role: string): number {
	if (role === "main") return 0;
	if (role === "overlay") return 1;
	if (role === "audio") return 2;
	return Number.MAX_SAFE_INTEGER;
}

function decodeTrack({
	track,
	providerAudioMediaIds,
}: {
	track: CanonicalTrack;
	providerAudioMediaIds: ReadonlyMap<string, string>;
}): TimelineTrack {
	assertOrdered({ values: track.elements, name: "element" });
	assertOrdered({ values: track.transitions, name: "transition" });
	const transitions = new Map<string, ClipTransition>();
	for (const transition of track.transitions) {
		if (
			transitions.has(transition.toElementId) ||
			!isTransitionType(transition.type)
		) {
			throw new Error("retained transition is invalid");
		}
		transitions.set(transition.toElementId, {
			id: transition.id,
			type: transition.type,
			duration: mediaTime({ ticks: transition.duration }),
			fromElementId: transition.fromElementId,
		});
	}
	const elements = track.elements.map((element) => {
		const transitionIn = transitions.get(element.id);
		if (transitionIn) transitions.delete(element.id);
		return decodeElement({ element, transitionIn, providerAudioMediaIds });
	});
	if (transitions.size > 0) {
		throw new Error("retained transition target is missing");
	}
	const common = { id: track.id, name: track.name, type: track.type, elements };
	switch (track.type) {
		case "video": {
			const trackElements = elements.filter(isVideoTrackElement);
			if (trackElements.length !== elements.length) {
				throw new Error("retained video track element type is invalid");
			}
			return {
				...common,
				type: track.type,
				muted: requiredBoolean(track.muted),
				hidden: requiredBoolean(track.hidden),
				elements: trackElements,
			};
		}
		case "text": {
			const trackElements = elements.filter(isTextElement);
			if (trackElements.length !== elements.length) {
				throw new Error("retained text track element type is invalid");
			}
			return {
				...common,
				type: track.type,
				hidden: requiredBoolean(track.hidden),
				elements: trackElements,
			};
		}
		case "graphic": {
			const trackElements = elements.filter(isGraphicTrackElement);
			if (trackElements.length !== elements.length) {
				throw new Error("retained graphic track element type is invalid");
			}
			return {
				...common,
				type: track.type,
				hidden: requiredBoolean(track.hidden),
				elements: trackElements,
			};
		}
		case "effect": {
			const trackElements = elements.filter(isEffectElement);
			if (trackElements.length !== elements.length) {
				throw new Error("retained effect track element type is invalid");
			}
			return {
				...common,
				type: track.type,
				hidden: requiredBoolean(track.hidden),
				elements: trackElements,
			};
		}
		case "audio": {
			const trackElements = elements.filter(isAudioElement);
			if (trackElements.length !== elements.length) {
				throw new Error("retained audio track element type is invalid");
			}
			return {
				...common,
				type: track.type,
				muted: requiredBoolean(track.muted),
				elements: trackElements,
			};
		}
		default:
			throw new Error("retained track type is invalid");
	}
}

function isTransitionType(value: string): value is ClipTransition["type"] {
	return CLIP_TRANSITION_TYPES.some((type) => type === value);
}

function isVideoTrackElement(
	element: TimelineElement,
): element is VideoElement | ImageElement | CompoundElement {
	return (
		element.type === "video" ||
		element.type === "image" ||
		element.type === "compound"
	);
}

function isTextElement(element: TimelineElement): element is TextElement {
	return element.type === "text";
}

function isGraphicTrackElement(
	element: TimelineElement,
): element is StickerElement | GraphicElement {
	return element.type === "sticker" || element.type === "graphic";
}

function isEffectElement(element: TimelineElement): element is EffectElement {
	return element.type === "effect";
}

function isAudioElement(element: TimelineElement): element is AudioElement {
	return element.type === "audio";
}

function decodeElement({
	element,
	transitionIn,
	providerAudioMediaIds,
}: {
	element: CanonicalElement;
	transitionIn?: ClipTransition;
	providerAudioMediaIds: ReadonlyMap<string, string>;
}): TimelineElement {
	const common = {
		id: element.id,
		name: element.name,
		startTime: mediaTime({ ticks: element.startTime }),
		duration: mediaTime({ ticks: element.duration }),
		trimStart: mediaTime({ ticks: element.trimStart }),
		trimEnd: mediaTime({ ticks: element.trimEnd }),
		params: scalarRecord({ value: element.params, name: "element params" }),
		animations: decodeAnimations(element.animations),
		...(element.groupId === null ? {} : { groupId: element.groupId }),
		...(element.linkId === null ? {} : { linkId: element.linkId }),
		...(element.sourceDuration === null
			? {}
			: { sourceDuration: mediaTime({ ticks: element.sourceDuration }) }),
		...(transitionIn ? { transitionIn } : {}),
	};
	switch (element.type) {
		case "video":
			return {
				...common,
				type: element.type,
				mediaId: element.mediaId,
				...(element.hidden === null ? {} : { hidden: element.hidden }),
				...(element.isSourceAudioEnabled === null
					? {}
					: { isSourceAudioEnabled: element.isSourceAudioEnabled }),
				...(decodeRetime(element.retime)
					? { retime: decodeRetime(element.retime)! }
					: {}),
				effects: decodeEffects(element.effects),
				masks: decodeMasks(element.masks),
				...(element.matte ? { matte: decodeMatte(element.matte) } : {}),
				...(element.audioReplacement
					? {
							audioReplacement: decodeAudioReplacement(
								element.audioReplacement,
							),
						}
					: {}),
			};
		case "image":
			return {
				...common,
				type: element.type,
				mediaId: element.mediaId,
				...(element.hidden === null ? {} : { hidden: element.hidden }),
				effects: decodeEffects(element.effects),
				masks: decodeMasks(element.masks),
			};
		case "text":
			return {
				...common,
				type: element.type,
				...(element.hidden === null ? {} : { hidden: element.hidden }),
				effects: decodeEffects(element.effects),
			};
		case "sticker":
			return {
				...common,
				type: element.type,
				stickerId: element.stickerId,
				...(element.intrinsicWidth === null
					? {}
					: { intrinsicWidth: element.intrinsicWidth }),
				...(element.intrinsicHeight === null
					? {}
					: { intrinsicHeight: element.intrinsicHeight }),
				...(element.hidden === null ? {} : { hidden: element.hidden }),
				effects: decodeEffects(element.effects),
			};
		case "graphic":
			return {
				...common,
				type: element.type,
				definitionId: element.definitionId,
				...(element.hidden === null ? {} : { hidden: element.hidden }),
				effects: decodeEffects(element.effects),
				masks: decodeMasks(element.masks),
			};
		case "effect":
			return { ...common, type: element.type, effectType: element.effectType };
		case "audio": {
			const retime = decodeRetime(element.retime);
			const audioReplacement = element.audioReplacement
				? decodeAudioReplacement(element.audioReplacement)
				: undefined;
			if (element.sourceType === "upload" && element.mediaId) {
				return {
					...common,
					type: element.type,
					sourceType: element.sourceType,
					mediaId: element.mediaId,
					...(retime ? { retime } : {}),
					...(audioReplacement ? { audioReplacement } : {}),
				};
			}
			if (element.sourceType === "library" && element.sourceUrl) {
				const mediaId = providerAudioMediaIds.get(element.sourceUrl);
				if (!mediaId) {
					throw new Error(
						"retained library audio has no unique immutable provider asset",
					);
				}
				return {
					...common,
					type: element.type,
					sourceType: "upload",
					mediaId,
					...(retime ? { retime } : {}),
					...(audioReplacement ? { audioReplacement } : {}),
				};
			}
			throw new Error("retained audio source is invalid");
		}
		case "compound":
			return {
				...common,
				type: element.type,
				tracks: decodeSceneTracks({
					value: element.tracks,
					providerAudioMediaIds,
				}),
				...(element.hidden === null ? {} : { hidden: element.hidden }),
			};
	}
}

function decodeEffects(values: CanonicalEffect[]): Effect[] {
	assertOrdered({ values, name: "effect" });
	return values.map((effect) => ({
		id: effect.id,
		type: effect.type,
		enabled: effect.enabled,
		params: scalarRecord({ value: effect.params, name: "effect params" }),
	}));
}

function decodeMasks(values: CanonicalMask[]): Mask[] {
	assertOrdered({ values, name: "mask" });
	return values.map((mask) => {
		const decoded: unknown = {
			id: mask.id,
			type: mask.type,
			params: objectValue({ value: mask.params, name: "mask params" }),
		};
		if (!isMask(decoded)) throw new Error("retained mask is invalid");
		return decoded;
	});
}

function decodeMatte(value: CanonicalAttachment): ClipMatteAttachment {
	if (value.channel !== "alpha" && value.channel !== "red") {
		throw new Error("retained matte channel is invalid");
	}
	return { ...decodeAttachment(value), channel: value.channel };
}

function decodeAudioReplacement(
	value: CanonicalAttachment,
): ClipAudioReplacementAttachment {
	return decodeAttachment(value);
}

function decodeAttachment(value: CanonicalAttachment) {
	return {
		assetId: value.assetId,
		sourceMediaId: value.sourceMediaId,
		sourceFingerprint: value.sourceFingerprint,
		artifactHash: value.artifactHash,
		artifactFingerprint: value.artifactFingerprint,
		modelId: value.modelId,
		modelVersion: value.modelVersion,
		enabled: value.enabled,
	};
}

function decodeRetime(value: unknown): RetimeConfig | undefined {
	if (value === null) return undefined;
	if (!isRecord(value) || typeof value.rate !== "number" || value.rate <= 0) {
		throw new Error("retained retime configuration is invalid");
	}
	if (
		value.maintainPitch !== undefined &&
		value.maintainPitch !== null &&
		typeof value.maintainPitch !== "boolean"
	) {
		throw new Error("retained retime pitch policy is invalid");
	}
	return {
		rate: value.rate,
		...(typeof value.maintainPitch === "boolean"
			? { maintainPitch: value.maintainPitch }
			: {}),
	};
}

function scalarRecord({
	value,
	name,
}: {
	value: unknown;
	name: string;
}): ParamValues {
	if (!isParamValues(value)) {
		throw new Error(`retained ${name} is invalid`);
	}
	return value;
}

function isParamValues(value: unknown): value is ParamValues {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(item) =>
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean",
		)
	);
}

function decodeAnimations(value: unknown): ElementAnimations {
	if (!isElementAnimations(value)) {
		throw new Error("retained element animations are invalid");
	}
	return value;
}

function isElementAnimations(value: unknown): value is ElementAnimations {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(channel) => channel === undefined || isChannelData(channel),
		)
	);
}

function isChannelData(value: unknown): value is ChannelData {
	if (!isRecord(value)) return false;
	if (Array.isArray(value.keys)) {
		return value.keys.every(
			(key) =>
				isRecord(key) &&
				typeof key.id === "string" &&
				typeof key.time === "number" &&
				(typeof key.value === "string" ||
					typeof key.value === "number" ||
					typeof key.value === "boolean"),
		);
	}
	return Object.values(value).every(
		(channel) => channel === undefined || isChannelData(channel),
	);
}

function isMask(value: unknown): value is Mask {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!isRecord(value.params)
	) {
		return false;
	}
	return [
		"split",
		"cinematic-bars",
		"rectangle",
		"ellipse",
		"heart",
		"diamond",
		"star",
		"text",
		"freeform",
	].some((type) => type === value.type);
}

function objectValue({
	value,
	name,
}: {
	value: unknown;
	name: string;
}): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`retained ${name} is invalid`);
	return value;
}

function recordField({
	value,
	field,
}: {
	value: Record<string, unknown>;
	field: string;
}) {
	return objectValue({
		value: value[field],
		name: `project setting ${field}`,
	});
}

function assertOrdered({
	values,
	name,
}: {
	values: Array<{ order: number }>;
	name: string;
}): void {
	if (values.some((value, index) => value.order !== index)) {
		throw new Error(`retained ${name} order is invalid`);
	}
}

function requiredBoolean(value: boolean | null): boolean {
	if (typeof value !== "boolean") {
		throw new Error("retained track state is invalid");
	}
	return value;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable({
	binding,
	reason,
}: {
	binding: RetainedRenderSourceBinding;
	reason: "missing" | "identity-mismatch" | "corrupt";
}): ComparisonSourceUnavailableError {
	return new ComparisonSourceUnavailableError({
		contentHash: binding.contentHash.digest,
		reason,
	});
}
