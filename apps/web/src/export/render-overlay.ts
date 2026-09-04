import type { TCanvasSize } from "@/project/types";
import {
	measureCaptionLocalLayout,
	placeCaptionGeometry,
	type CaptionGeometry,
	type Rect,
} from "@/text/caption-layout";
import type { TextCanvasContext } from "@/text/layout";
import {
	buildTextBackgroundFromElement,
	buildTextLayoutParamsFromElement,
} from "@/text/measure-element";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import {
	requireFrameSchedule,
	resolveFrameTime,
} from "@/services/renderer/frame-schedule";
import type { ExportFormat, ExportQuality } from ".";

export interface ExportSafeZone {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ExportElementLayoutOverlay {
	positionX?: number;
	positionY?: number;
	scaleX?: number;
	scaleY?: number;
	rotate?: number;
	targetSafeZoneId?: string;
}

export interface ExportElementReframeOverlay {
	mode?: "contain" | "cover" | "stretch";
	crop?: { x: number; y: number; width: number; height: number };
	focalPoint?: { x: number; y: number };
	targetRect?: { x: number; y: number; width: number; height: number };
}

export type ExportSubjectSafeFocalPolicy =
	| { kind: "preserve" }
	| { kind: "fixed"; focalPoint: { x: number; y: number } }
	| { kind: "safe-zone-center"; safeZoneId: string };

export interface ExportElementOverlay {
	elementId: string;
	layout?: ExportElementLayoutOverlay;
	reframe?: ExportElementReframeOverlay;
	subjectSafeFocalPolicy?: ExportSubjectSafeFocalPolicy;
}

export interface ExportCaptionStyleOverlay {
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: "normal" | "bold";
	fontStyle?: "normal" | "italic";
	color?: string;
	textAlign?: "left" | "center" | "right";
	backgroundEnabled?: boolean;
	backgroundColor?: string;
	backgroundPerLine?: boolean;
	highlightEnabled?: boolean;
	highlightColor?: string;
}

export interface ExportCaptionOverlay {
	mode: "preserve" | "on" | "off";
	trackIds?: string[];
	elementIds?: string[];
	style?: ExportCaptionStyleOverlay;
	position?: { x: number; y: number };
	positionSafeZoneId?: string;
}

export type ExportCoverFrameSelector =
	| { kind: "frame-index"; frameIndex: number }
	| {
			kind: "media-time";
			ticks: number;
			rounding: "exact" | "floor" | "nearest" | "ceil";
	  };

export interface ExportRenderOverlay {
	version: 1;
	canvasSize?: TCanvasSize;
	safeZones?: ExportSafeZone[];
	tracks?: { include?: string[]; exclude?: string[] };
	elements?: ExportElementOverlay[];
	captions?: ExportCaptionOverlay;
	coverFrame?: ExportCoverFrameSelector;
}

export interface ResolvedExportRenderSpecification {
	version: 1;
	canvasSize: TCanvasSize;
	safeZones: ExportSafeZone[];
	tracks: {
		includedTrackIds: string[];
		excludedTrackIds: string[];
	};
	elements: Array<{
		elementId: string;
		layout: ExportElementLayoutOverlay | null;
		reframe: ExportElementReframeOverlay | null;
		subjectSafeFocalPolicy: ExportSubjectSafeFocalPolicy;
	}>;
	captions: {
		mode: "preserve" | "on" | "off";
		trackIds: string[];
		elementIds: string[];
		style: ExportCaptionStyleOverlay | null;
		position: { x: number; y: number } | null;
		positionSafeZoneId: string | null;
		geometry: ExportCaptionGeometryEvidence[];
	};
	coverFrame: {
		requested: ExportCoverFrameSelector;
		frameIndex: number;
		resolvedTicks: number;
	} | null;
	output: {
		format: ExportFormat;
		videoCodec: "avc" | "vp9";
		quality: ExportQuality;
		fps: { numerator: number; denominator: number };
		includeAudio: boolean;
	};
	frameSchedule: {
		durationTicks: number;
		ticksPerFrame: number;
		frameCount: number;
		firstFrameTicks: 0;
		lastFrameTicks: number | null;
	};
}

export interface ExportCaptionGeometryEvidence {
	elementId: string;
	startTicks: number;
	endTicks: number;
	safeZoneId: string | null;
	geometry: CaptionGeometry;
}

export function resolveExportRenderOverlay({
	tracks,
	sourceCanvasSize,
	sourceFps,
	format,
	videoCodec,
	quality,
	includeAudio,
	overlay,
}: {
	tracks: SceneTracks;
	sourceCanvasSize: TCanvasSize;
	sourceFps: { numerator: number; denominator: number };
	format: ExportFormat;
	videoCodec: "avc" | "vp9";
	quality: ExportQuality;
	includeAudio: boolean;
	overlay?: ExportRenderOverlay;
}): { tracks: SceneTracks; specification: ResolvedExportRenderSpecification } {
	if (
		(format === "mp4" && videoCodec !== "avc") ||
		(format === "webm" && videoCodec !== "vp9")
	) {
		throw new Error(`video codec ${videoCodec} is not supported for ${format}`);
	}
	const canvasSize = overlay?.canvasSize ?? sourceCanvasSize;
	assertCanvasSize(canvasSize);
	const safeZones = (overlay?.safeZones ?? []).map((zone) => {
		assertNormalizedRect(zone, `safe zone ${zone.id}`);
		if (!zone.id.trim()) throw new Error("safe zone IDs must not be empty");
		return { ...zone };
	});
	const safeZoneMap = uniqueMap(safeZones, (zone) => zone.id, "safe zone");
	const sourceTracks = allTracks(tracks);
	const trackMap = uniqueMap(sourceTracks, (track) => track.id, "track");
	const requestedInclude = new Set(overlay?.tracks?.include ?? trackMap.keys());
	const requestedExclude = new Set(overlay?.tracks?.exclude ?? []);
	for (const id of [...requestedInclude, ...requestedExclude]) {
		if (!trackMap.has(id))
			throw new Error(`export overlay track not found: ${id}`);
	}
	const captionTrackIds = resolveCaptionTracks({
		overlay,
		sourceTracks,
		trackMap,
	});
	if (overlay?.captions?.mode === "on") {
		for (const id of captionTrackIds) requestedInclude.add(id);
	}
	if (
		overlay?.captions?.mode === "off" &&
		!overlay.captions.elementIds?.length
	) {
		for (const id of captionTrackIds) requestedExclude.add(id);
	}
	const includedTrackIds = sourceTracks
		.map((track) => track.id)
		.filter((id) => requestedInclude.has(id) && !requestedExclude.has(id));
	const included = new Set(includedTrackIds);

	let resolvedTracks = cloneTracks(tracks);
	const elementMap = collectElements(resolvedTracks);
	const resolvedElementOverlays = (overlay?.elements ?? []).map((entry) => {
		const element = elementMap.get(entry.elementId);
		if (!element)
			throw new Error(`export overlay element not found: ${entry.elementId}`);
		applyElementOverlay({ element, entry, safeZoneMap });
		return {
			elementId: entry.elementId,
			layout: entry.layout ? { ...entry.layout } : null,
			reframe: entry.reframe ? cloneReframe(entry.reframe) : null,
			subjectSafeFocalPolicy:
				entry.subjectSafeFocalPolicy ?? ({ kind: "preserve" } as const),
		};
	});

	const captionElementIds = applyCaptionOverlay({
		tracks: resolvedTracks,
		captionTrackIds,
		caption: overlay?.captions,
		safeZoneMap,
		canvasSize,
	});
	resolvedTracks = selectTracks(resolvedTracks, included);

	const fps = sourceFps;
	const durationTicks = calculateOverlayDuration(resolvedTracks);
	if (durationTicks <= 0)
		throw new Error("export overlay produced an empty scene");
	const { ticksPerFrame } = requireFrameSchedule(fps);
	const frameCount = Math.floor(durationTicks / ticksPerFrame);
	if (frameCount <= 0)
		throw new Error("export overlay produced no complete frames");
	const coverFrame = overlay?.coverFrame
		? resolveCoverFrame({ selector: overlay.coverFrame, fps, durationTicks })
		: null;

	return {
		tracks: resolvedTracks,
		specification: {
			version: 1,
			canvasSize: { ...canvasSize },
			safeZones,
			tracks: {
				includedTrackIds,
				excludedTrackIds: sourceTracks
					.map((track) => track.id)
					.filter((id) => !included.has(id)),
			},
			elements: resolvedElementOverlays,
			captions: {
				mode: overlay?.captions?.mode ?? "preserve",
				trackIds: captionTrackIds,
				elementIds: captionElementIds,
				style: overlay?.captions?.style ? { ...overlay.captions.style } : null,
				position: overlay?.captions?.position
					? { ...overlay.captions.position }
					: null,
				positionSafeZoneId: overlay?.captions?.positionSafeZoneId ?? null,
				geometry: [],
			},
			coverFrame,
			output: { format, videoCodec, quality, fps: { ...fps }, includeAudio },
			frameSchedule: {
				durationTicks,
				ticksPerFrame,
				frameCount,
				firstFrameTicks: 0,
				lastFrameTicks:
					frameCount > 0 ? (frameCount - 1) * ticksPerFrame : null,
			},
		},
	};
}

/** Materialize renderer-native caption rectangles for the resolved variant. */
export function materializeExportCaptionGeometry({
	tracks,
	specification,
	context,
}: {
	tracks: SceneTracks;
	specification: ResolvedExportRenderSpecification;
	context: TextCanvasContext;
}): ExportCaptionGeometryEvidence[] {
	if (specification.captions.mode === "off") return [];
	const selected = new Set(specification.captions.elementIds);
	const safeZone = resolveCaptionSafeZone(specification);
	const elements = collectElements(tracks);
	return [...selected].sort().map((elementId) => {
		const element = elements.get(elementId);
		if (!element || element.type !== "text") {
			throw new Error(`resolved caption element not found: ${elementId}`);
		}
		const local = measureCaptionLocalLayout({
			text: buildTextLayoutParamsFromElement({ element }),
			background: buildTextBackgroundFromElement({ element }),
			canvasHeight: specification.canvasSize.height,
			ctx: context,
		});
		const geometry = placeCaptionGeometry({
			local,
			canvasSize: specification.canvasSize,
			position: {
				x: finiteParam(element.params["transform.positionX"]),
				y: finiteParam(element.params["transform.positionY"]),
			},
			safeZone: safeZone.rect,
		});
		return {
			elementId,
			startTicks: element.startTime,
			endTicks: element.startTime + element.duration,
			safeZoneId: safeZone.id,
			geometry,
		};
	});
}

function resolveCaptionSafeZone(
	specification: ResolvedExportRenderSpecification,
): { id: string | null; rect: Rect } {
	const id = specification.captions.positionSafeZoneId;
	const zone = id
		? specification.safeZones.find((candidate) => candidate.id === id)
		: null;
	if (id && !zone)
		throw new Error(`resolved caption safe zone not found: ${id}`);
	return zone
		? {
				id: zone.id,
				rect: {
					left: zone.x * specification.canvasSize.width,
					top: zone.y * specification.canvasSize.height,
					width: zone.width * specification.canvasSize.width,
					height: zone.height * specification.canvasSize.height,
				},
			}
		: {
				id: null,
				rect: {
					left: 0,
					top: 0,
					width: specification.canvasSize.width,
					height: specification.canvasSize.height,
				},
			};
}

function finiteParam(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function resolveCaptionTracks({
	overlay,
	sourceTracks,
	trackMap,
}: {
	overlay?: ExportRenderOverlay;
	sourceTracks: TimelineTrack[];
	trackMap: Map<string, TimelineTrack>;
}): string[] {
	const requested = overlay?.captions?.trackIds;
	if (!requested) {
		return sourceTracks
			.filter((track) => track.type === "text")
			.map((track) => track.id);
	}
	for (const id of requested) {
		const track = trackMap.get(id);
		if (!track) throw new Error(`caption overlay track not found: ${id}`);
		if (track.type !== "text")
			throw new Error(`caption overlay track is not text: ${id}`);
	}
	return [...new Set(requested)];
}

function applyCaptionOverlay({
	tracks,
	captionTrackIds,
	caption,
	safeZoneMap,
	canvasSize,
}: {
	tracks: SceneTracks;
	captionTrackIds: string[];
	caption?: ExportCaptionOverlay;
	safeZoneMap: Map<string, ExportSafeZone>;
	canvasSize: TCanvasSize;
}): string[] {
	const selectedIds = caption?.elementIds ? new Set(caption.elementIds) : null;
	const matched = new Set<string>();
	const targetTrackIds = new Set(captionTrackIds);
	let position = caption?.position ? { ...caption.position } : null;
	if (caption?.positionSafeZoneId) {
		const zone = requireSafeZone(safeZoneMap, caption.positionSafeZoneId);
		position = {
			x: (zone.x + zone.width / 2 - 0.5) * canvasSize.width,
			y: (zone.y + zone.height / 2 - 0.5) * canvasSize.height,
		};
	}
	for (const track of allTracks(tracks)) {
		if (track.type !== "text" || !targetTrackIds.has(track.id)) continue;
		if (caption?.mode === "on") track.hidden = false;
		const retained = [] as typeof track.elements;
		for (const element of track.elements) {
			const selected = !selectedIds || selectedIds.has(element.id);
			if (selected) {
				matched.add(element.id);
				if (caption?.style) applyCaptionStyle(element, caption.style);
				if (position) {
					element.params["transform.positionX"] = position.x;
					element.params["transform.positionY"] = position.y;
				}
				if (caption?.mode === "off" && selectedIds) continue;
			}
			retained.push(element);
		}
		if (caption?.mode === "off" && selectedIds) track.elements = retained;
	}
	if (selectedIds) {
		for (const id of selectedIds) {
			if (!matched.has(id))
				throw new Error(`caption overlay element not found: ${id}`);
		}
	}
	return [...matched].sort();
}

function applyCaptionStyle(
	element: Extract<TimelineElement, { type: "text" }>,
	style: ExportCaptionStyleOverlay,
): void {
	const values: Array<[string, unknown]> = [
		["fontFamily", style.fontFamily],
		["fontSize", style.fontSize],
		["fontWeight", style.fontWeight],
		["fontStyle", style.fontStyle],
		["color", style.color],
		["textAlign", style.textAlign],
		["background.enabled", style.backgroundEnabled],
		["background.color", style.backgroundColor],
		["background.perLine", style.backgroundPerLine],
		["highlight.enabled", style.highlightEnabled],
		["highlight.color", style.highlightColor],
	];
	for (const [key, value] of values) {
		if (value !== undefined) element.params[key] = value as never;
	}
}

function applyElementOverlay({
	element,
	entry,
	safeZoneMap,
}: {
	element: TimelineElement;
	entry: ExportElementOverlay;
	safeZoneMap: Map<string, ExportSafeZone>;
}): void {
	const layout = entry.layout;
	if (layout) {
		for (const [key, value] of [
			["transform.positionX", layout.positionX],
			["transform.positionY", layout.positionY],
			["transform.scaleX", layout.scaleX],
			["transform.scaleY", layout.scaleY],
			["transform.rotate", layout.rotate],
		] as const) {
			if (value !== undefined) element.params[key] = value;
		}
		if (layout.targetSafeZoneId) {
			const zone = requireSafeZone(safeZoneMap, layout.targetSafeZoneId);
			writeRect(element, "reframe.target", zone);
		}
	}
	const reframe = entry.reframe;
	if (reframe?.mode) element.params["reframe.mode"] = reframe.mode;
	if (reframe?.crop) writeRect(element, "reframe.crop", reframe.crop);
	if (reframe?.focalPoint)
		writePoint(element, "reframe.focal", reframe.focalPoint);
	if (reframe?.targetRect)
		writeRect(element, "reframe.target", reframe.targetRect);
	const policy = entry.subjectSafeFocalPolicy;
	if (policy?.kind === "fixed")
		writePoint(element, "reframe.focal", policy.focalPoint);
	if (policy?.kind === "safe-zone-center") {
		const zone = requireSafeZone(safeZoneMap, policy.safeZoneId);
		writePoint(element, "reframe.focal", {
			x: zone.x + zone.width / 2,
			y: zone.y + zone.height / 2,
		});
	}
}

function writeRect(
	element: TimelineElement,
	prefix: "reframe.crop" | "reframe.target",
	rect: { x: number; y: number; width: number; height: number },
): void {
	assertNormalizedRect(rect, prefix);
	element.params[`${prefix}X`] = rect.x;
	element.params[`${prefix}Y`] = rect.y;
	element.params[`${prefix}Width`] = rect.width;
	element.params[`${prefix}Height`] = rect.height;
}

function writePoint(
	element: TimelineElement,
	prefix: "reframe.focal",
	point: { x: number; y: number },
): void {
	assertUnit(point.x, `${prefix}X`);
	assertUnit(point.y, `${prefix}Y`);
	element.params[`${prefix}X`] = point.x;
	element.params[`${prefix}Y`] = point.y;
}

function selectTracks(tracks: SceneTracks, included: Set<string>): SceneTracks {
	return {
		main: included.has(tracks.main.id)
			? tracks.main
			: { ...tracks.main, hidden: true },
		overlay: tracks.overlay.filter((track) => included.has(track.id)),
		audio: tracks.audio.filter((track) => included.has(track.id)),
	};
}

function cloneTracks(tracks: SceneTracks): SceneTracks {
	const cloneElement = (element: TimelineElement): TimelineElement =>
		element.type === "compound"
			? {
					...element,
					params: { ...element.params },
					tracks: cloneTracks(element.tracks),
				}
			: { ...element, params: { ...element.params } };
	const cloneTrack = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map(cloneElement),
		}) as T;
	return {
		main: cloneTrack(tracks.main),
		overlay: tracks.overlay.map(cloneTrack),
		audio: tracks.audio.map(cloneTrack),
	};
}

function collectElements(tracks: SceneTracks): Map<string, TimelineElement> {
	const map = new Map<string, TimelineElement>();
	for (const track of allTracks(tracks)) {
		for (const element of track.elements) {
			if (map.has(element.id))
				throw new Error(`duplicate element ID: ${element.id}`);
			map.set(element.id, element);
			if (element.type === "compound") {
				for (const [id, child] of collectElements(element.tracks)) {
					if (map.has(id)) throw new Error(`duplicate element ID: ${id}`);
					map.set(id, child);
				}
			}
		}
	}
	return map;
}

function allTracks(tracks: SceneTracks): TimelineTrack[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

function calculateOverlayDuration(tracks: SceneTracks): number {
	let duration = 0;
	for (const track of allTracks(tracks)) {
		for (const element of track.elements) {
			duration = Math.max(duration, element.startTime + element.duration);
		}
	}
	return duration;
}

function resolveCoverFrame({
	selector,
	fps,
	durationTicks,
}: {
	selector: ExportCoverFrameSelector;
	fps: { numerator: number; denominator: number };
	durationTicks: number;
}) {
	const resolved = resolveFrameTime({ time: selector, fps });
	if (resolved.status === "error") throw new Error(resolved.reason);
	if (resolved.resolvedTicks >= durationTicks)
		throw new Error("cover frame is outside the rendered scene duration");
	return {
		requested: { ...selector },
		frameIndex: resolved.frameIndex,
		resolvedTicks: resolved.resolvedTicks,
	};
}

function requireSafeZone(
	zones: Map<string, ExportSafeZone>,
	id: string,
): ExportSafeZone {
	const zone = zones.get(id);
	if (!zone) throw new Error(`export overlay safe zone not found: ${id}`);
	return zone;
}

function uniqueMap<T>(
	values: Iterable<T>,
	key: (value: T) => string,
	label: string,
): Map<string, T> {
	const map = new Map<string, T>();
	for (const value of values) {
		const id = key(value);
		if (map.has(id)) throw new Error(`duplicate ${label} ID: ${id}`);
		map.set(id, value);
	}
	return map;
}

function assertCanvasSize(size: TCanvasSize): void {
	if (
		!Number.isSafeInteger(size.width) ||
		size.width <= 0 ||
		!Number.isSafeInteger(size.height) ||
		size.height <= 0
	)
		throw new Error("export canvas dimensions must be positive safe integers");
}

function assertNormalizedRect(
	rect: { x: number; y: number; width: number; height: number },
	label: string,
): void {
	assertUnit(rect.x, `${label}.x`);
	assertUnit(rect.y, `${label}.y`);
	if (!(rect.width > 0) || rect.x + rect.width > 1)
		throw new Error(`${label}.width must fit inside normalized bounds`);
	if (!(rect.height > 0) || rect.y + rect.height > 1)
		throw new Error(`${label}.height must fit inside normalized bounds`);
}

function assertUnit(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1)
		throw new Error(`${label} must be between 0 and 1`);
}

function cloneReframe(
	value: ExportElementReframeOverlay,
): ExportElementReframeOverlay {
	return {
		...value,
		...(value.crop ? { crop: { ...value.crop } } : {}),
		...(value.focalPoint ? { focalPoint: { ...value.focalPoint } } : {}),
		...(value.targetRect ? { targetRect: { ...value.targetRect } } : {}),
	};
}
