import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type {
	CompoundElement,
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import {
	applyPlacement,
	buildEmptyTrack,
	resolveTrackPlacement,
} from "@/timeline/placement";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { generateUUID } from "@/utils/id";
import { mediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type { AutomationEditOperation } from "./types";
import { ResolvedObjectIds } from "./resolved-object-ids";

type CreateCompoundOperation = Extract<
	AutomationEditOperation,
	{ kind: "create_compound" }
>;
type BreakApartCompoundOperation = Extract<
	AutomationEditOperation,
	{ kind: "break_apart_compound" }
>;
type CompoundOperation = CreateCompoundOperation | BreakApartCompoundOperation;

interface ElementEntry extends ElementRef {
	element: TimelineElement;
}

export function buildCompoundCommand({
	tracks,
	operation,
}: {
	tracks: SceneTracks;
	operation: CompoundOperation;
}): Command {
	validateCompoundOperation({ tracks, operation });
	return new CompoundControlCommand(operation);
}

export function validateCompoundOperation({
	tracks,
	operation,
}: {
	tracks: SceneTracks;
	operation: CompoundOperation;
}): void {
	if (operation.kind === "create_compound") {
		if (!operation.compoundId.trim()) {
			throw new Error("compoundId is required");
		}
		if (operation.elements.length < 2) {
			throw new Error("a compound clip requires at least two elements");
		}
		const entries = requireDistinctEntries({
			tracks,
			refs: operation.elements,
		});
		if (containsElementId({ tracks, elementId: operation.compoundId })) {
			throw new Error(`element ID already exists: ${operation.compoundId}`);
		}
		if (operation.targetTrackId) {
			const target = findTrackInSceneTracks({
				tracks,
				trackId: operation.targetTrackId,
			});
			if (!target) {
				throw new Error(`track not found: ${operation.targetTrackId}`);
			}
			if (target.type !== "video") {
				throw new Error("compound clips require a video track");
			}
		}
		const span = elementSpan(entries);
		if (span.duration <= 0) {
			throw new Error("compound clip duration must be positive");
		}
		return;
	}

	const entry = findTopLevelEntry({
		tracks,
		ref: { trackId: operation.trackId, elementId: operation.elementId },
	});
	if (!entry) {
		throw new Error(
			`element not found: ${operation.trackId}/${operation.elementId}`,
		);
	}
	if (entry.element.type !== "compound") {
		throw new Error("break apart requires a compound clip");
	}
	validateBreakApartTiming(entry.element);
}

class CompoundControlCommand extends Command {
	private before: SceneTracks | null = null;

	constructor(private operation: CompoundOperation) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.before = editor.scenes.getActiveScene().tracks;
		const result =
			this.operation.kind === "create_compound"
				? createCompound({ tracks: this.before, operation: this.operation })
				: breakApartCompound({
						tracks: this.before,
						operation: this.operation,
					});
		editor.timeline.updateTracks(result.tracks);
		return createElementSelectionResult(result.selection);
	}

	undo(): void {
		if (this.before) {
			EditorCore.getInstance().timeline.updateTracks(this.before);
		}
	}
}

function createCompound({
	tracks,
	operation,
}: {
	tracks: SceneTracks;
	operation: CreateCompoundOperation;
}): { tracks: SceneTracks; selection: ElementRef[] } {
	validateCompoundOperation({ tracks, operation });
	const entries = requireDistinctEntries({ tracks, refs: operation.elements });
	const resolvedIds = new ResolvedObjectIds(operation.resolvedAllocations);
	const span = elementSpan(entries);
	const selectedKeys = new Set(entries.map(entryKey));
	const selectsMain = entries.some((entry) => entry.trackId === tracks.main.id);
	const nestedTracks = buildNestedTracks({
		tracks,
		selectedKeys,
		timeOrigin: span.startTime,
		emptyMainTrackId: selectsMain
			? undefined
			: takeDeclaredId({
					resolvedIds,
					role: "compound-empty-main-track",
					sourceId: "",
					declared: operation.emptyMainTrackId,
				}),
	});
	const compound: CompoundElement = {
		id: operation.compoundId,
		name: operation.name?.trim() || "Compound clip",
		type: "compound",
		tracks: nestedTracks,
		startTime: span.startTime,
		duration: span.duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: span.duration,
		params: {},
		hidden: false,
	};
	const withoutSelected = mapTracks({
		tracks,
		update: (track) => ({
			...track,
			elements: track.elements.filter(
				(element) =>
					!selectedKeys.has(entryKey({ trackId: track.id, element })),
			),
		}),
	});
	const placementResult = resolveTrackPlacement({
		tracks: withoutSelected,
		elementType: "compound",
		timeSpans: [{ startTime: span.startTime, duration: span.duration }],
		strategy: operation.targetTrackId
			? { type: "explicit", trackId: operation.targetTrackId }
			: { type: "alwaysNew", position: "highest" },
	});
	if (!placementResult) {
		throw new Error("no compatible track is available for the compound clip");
	}
	const applied = applyPlacement({
		tracks: withoutSelected,
		placementResult,
		elements: [compound],
		newTrackId: operation.targetTrackId
			? undefined
			: takeDeclaredId({
					resolvedIds,
					role: "compound-auto-track",
					sourceId: "",
					declared: operation.autoTrackId,
				}),
	});
	if (!applied) throw new Error("compound clip placement failed");
	resolvedIds.assertExhausted();
	return {
		tracks: applied.updatedTracks,
		selection: [
			{ trackId: applied.targetTrackId, elementId: operation.compoundId },
		],
	};
}

function breakApartCompound({
	tracks,
	operation,
}: {
	tracks: SceneTracks;
	operation: BreakApartCompoundOperation;
}): { tracks: SceneTracks; selection: ElementRef[] } {
	validateCompoundOperation({ tracks, operation });
	const entry = findTopLevelEntry({
		tracks,
		ref: { trackId: operation.trackId, elementId: operation.elementId },
	});
	if (!entry || entry.element.type !== "compound") {
		throw new Error("compound clip not found");
	}
	const compound = entry.element;
	const nestedElements: TimelineElement[] = [];
	for (const track of orderedTracks(compound.tracks)) {
		nestedElements.push(...(track.elements as TimelineElement[]));
	}
	if (
		operation.restoredElementIds &&
		operation.restoredElementIds.length !== nestedElements.length
	) {
		throw new Error("restored element IDs must cover compound members");
	}
	const resolvedIds = new ResolvedObjectIds(operation.resolvedAllocations);
	const restoredIds = new Map(
		nestedElements.map((element, index) => [
			element.id,
			takeDeclaredIdRequired({
				resolvedIds,
				role: "break-apart-element",
				sourceId: element.id,
				declared: operation.restoredElementIds?.[index],
				legacyFallback: () => element.id,
			}),
		]),
	);
	let restored = mapTracks({
		tracks,
		update: (track) => ({
			...track,
			elements: track.elements.filter((element) => element.id !== compound.id),
		}),
	});
	const selection: ElementRef[] = [];
	for (const nestedTrack of orderedTracks(compound.tracks)) {
		if (nestedTrack.elements.length === 0) continue;
		const translatedTrack = translateTrack({
			track: nestedTrack,
			timeOffset: mediaTime({
				ticks: compound.startTime - compound.trimStart,
			}),
			remapElementIds: restoredIds,
		});
		const elements: TimelineElement[] = [...translatedTrack.elements];
		const existing = findTrackInSceneTracks({
			tracks: restored,
			trackId: nestedTrack.id,
		});
		if (existing) {
			if (existing.type !== nestedTrack.type) {
				throw new Error(
					`track type changed while compound was nested: ${nestedTrack.id}`,
				);
			}
			restored = appendTrackElements({
				tracks: restored,
				source: translatedTrack,
			});
		} else {
			restored = restoreMissingTrack({
				tracks: restored,
				track: translatedTrack,
			});
		}
		selection.push(
			...elements.map((element) => ({
				trackId: nestedTrack.id,
				elementId: element.id,
			})),
		);
	}
	resolvedIds.assertExhausted();
	return { tracks: restored, selection };
}

function buildNestedTracks({
	tracks,
	selectedKeys,
	timeOrigin,
	emptyMainTrackId,
}: {
	tracks: SceneTracks;
	selectedKeys: Set<string>;
	timeOrigin: MediaTime;
	emptyMainTrackId?: string;
}): SceneTracks {
	const selectTrack = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
		({
			...track,
			elements: track.elements
				.filter((element) =>
					selectedKeys.has(entryKey({ trackId: track.id, element })),
				)
				.map((element) => ({
					...element,
					startTime: mediaTime({ ticks: element.startTime - timeOrigin }),
				})),
		}) as TTrack;
	const selectedMain = selectTrack(tracks.main);
	return {
		main:
			selectedMain.elements.length > 0
				? selectedMain
				: buildEmptyTrack({
						id: emptyMainTrackId ?? generateUUID(),
						type: "video",
					}),
		overlay: tracks.overlay
			.map(selectTrack)
			.filter((track) => track.elements.length > 0),
		audio: tracks.audio
			.map(selectTrack)
			.filter((track) => track.elements.length > 0),
	};
}

function restoreMissingTrack({
	tracks,
	track,
}: {
	tracks: SceneTracks;
	track: TimelineTrack;
}): SceneTracks {
	if (track.type === "audio") {
		return { ...tracks, audio: [...tracks.audio, track] };
	}
	const overlayTrack =
		track.type === "video" && track.id === tracks.main.id
			? ({ ...track, id: generateUUID() } as VideoTrack)
			: track;
	return { ...tracks, overlay: [...tracks.overlay, overlayTrack] };
}

function translateTrack<TTrack extends TimelineTrack>({
	track,
	timeOffset,
	remapElementIds,
}: {
	track: TTrack;
	timeOffset: MediaTime;
	remapElementIds: ReadonlyMap<string, string>;
}): TTrack {
	const translateStart = (startTime: MediaTime) =>
		mediaTime({ ticks: timeOffset + startTime });
	const translateElement = (element: TimelineElement): TimelineElement => ({
		...element,
		id: remapElementIds.get(element.id) ?? element.id,
		startTime: translateStart(element.startTime),
		...(element.transitionIn
			? {
					transitionIn: {
						...element.transitionIn,
						fromElementId:
							remapElementIds.get(element.transitionIn.fromElementId) ??
							element.transitionIn.fromElementId,
					},
				}
			: {}),
	});
	switch (track.type) {
		case "video":
			return {
				...track,
				elements: track.elements.map((element) => translateElement(element)),
			} as TTrack;
		case "text":
			return {
				...track,
				elements: track.elements.map((element) => translateElement(element)),
			} as TTrack;
		case "audio":
			return {
				...track,
				elements: track.elements.map((element) => translateElement(element)),
			} as TTrack;
		case "graphic":
			return {
				...track,
				elements: track.elements.map((element) => translateElement(element)),
			} as TTrack;
		case "effect":
			return {
				...track,
				elements: track.elements.map((element) => translateElement(element)),
			} as TTrack;
	}
}

function takeDeclaredId({
	resolvedIds,
	role,
	sourceId,
	declared,
	legacyFallback = generateUUID,
}: {
	resolvedIds: ResolvedObjectIds;
	role: "compound-auto-track" | "compound-empty-main-track" | "break-apart-element";
	sourceId: string;
	declared: string | undefined;
	legacyFallback?: () => string;
}): string | undefined {
	if (!resolvedIds.strict && declared === undefined) return undefined;
	const resolved = resolvedIds.take({
		role,
		sourceId,
		fallback: () => declared ?? legacyFallback(),
	});
	if (declared !== undefined && declared !== resolved) {
		throw new Error(`declared ${role} ID does not match native allocation`);
	}
	return resolved;
}

function takeDeclaredIdRequired(
	options: Parameters<typeof takeDeclaredId>[0],
): string {
	const resolved = options.resolvedIds.take({
		role: options.role,
		sourceId: options.sourceId,
		fallback: () =>
			options.declared ?? options.legacyFallback?.() ?? generateUUID(),
	});
	if (options.declared !== undefined && options.declared !== resolved) {
		throw new Error(`declared ${options.role} ID does not match native allocation`);
	}
	if (resolved === undefined) {
		throw new Error(`missing declared ${options.role} ID`);
	}
	return resolved;
}

function appendTrackElements({
	tracks,
	source,
}: {
	tracks: SceneTracks;
	source: TimelineTrack;
}): SceneTracks {
	if (source.type === "audio") {
		return {
			...tracks,
			audio: tracks.audio.map((track) =>
				track.id === source.id
					? { ...track, elements: [...track.elements, ...source.elements] }
					: track,
			),
		};
	}
	if (source.type === "video" && tracks.main.id === source.id) {
		return {
			...tracks,
			main: {
				...tracks.main,
				elements: [...tracks.main.elements, ...source.elements],
			},
		};
	}
	switch (source.type) {
		case "video":
			return {
				...tracks,
				overlay: tracks.overlay.map((track) =>
					track.id === source.id && track.type === "video"
						? { ...track, elements: [...track.elements, ...source.elements] }
						: track,
				),
			};
		case "text":
			return {
				...tracks,
				overlay: tracks.overlay.map((track) =>
					track.id === source.id && track.type === "text"
						? { ...track, elements: [...track.elements, ...source.elements] }
						: track,
				),
			};
		case "graphic":
			return {
				...tracks,
				overlay: tracks.overlay.map((track) =>
					track.id === source.id && track.type === "graphic"
						? { ...track, elements: [...track.elements, ...source.elements] }
						: track,
				),
			};
		case "effect":
			return {
				...tracks,
				overlay: tracks.overlay.map((track) =>
					track.id === source.id && track.type === "effect"
						? { ...track, elements: [...track.elements, ...source.elements] }
						: track,
				),
			};
	}
}

function validateBreakApartTiming(compound: CompoundElement): void {
	for (const track of orderedTracks(compound.tracks)) {
		for (const element of track.elements) {
			if (compound.startTime - compound.trimStart + element.startTime < 0) {
				throw new Error("breaking apart would place an element before zero");
			}
		}
	}
}

function elementSpan(entries: ElementEntry[]): {
	startTime: MediaTime;
	duration: MediaTime;
} {
	const startTime = Math.min(
		...entries.map(({ element }) => element.startTime),
	);
	const endTime = Math.max(
		...entries.map(({ element }) => element.startTime + element.duration),
	);
	return {
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: endTime - startTime }),
	};
}

function requireDistinctEntries({
	tracks,
	refs,
}: {
	tracks: SceneTracks;
	refs: ElementRef[];
}): ElementEntry[] {
	const keys = refs.map((ref) => `${ref.trackId}\u0000${ref.elementId}`);
	if (new Set(keys).size !== keys.length) {
		throw new Error("duplicate element references are not allowed");
	}
	return refs.map((ref) => {
		const entry = findTopLevelEntry({ tracks, ref });
		if (!entry) {
			throw new Error(`element not found: ${ref.trackId}/${ref.elementId}`);
		}
		return entry;
	});
}

function findTopLevelEntry({
	tracks,
	ref,
}: {
	tracks: SceneTracks;
	ref: ElementRef;
}): ElementEntry | null {
	const track = findTrackInSceneTracks({ tracks, trackId: ref.trackId });
	const element = track?.elements.find(
		(candidate) => candidate.id === ref.elementId,
	);
	return element ? { ...ref, element } : null;
}

function containsElementId({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): boolean {
	for (const track of orderedTracks(tracks)) {
		for (const element of track.elements) {
			if (element.id === elementId) return true;
			if (
				element.type === "compound" &&
				containsElementId({ tracks: element.tracks, elementId })
			) {
				return true;
			}
		}
	}
	return false;
}

function orderedTracks(tracks: SceneTracks): TimelineTrack[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

function mapTracks({
	tracks,
	update,
}: {
	tracks: SceneTracks;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SceneTracks {
	return {
		main: update(tracks.main),
		overlay: tracks.overlay.map(update),
		audio: tracks.audio.map(update),
	};
}

function entryKey({
	trackId,
	element,
}: {
	trackId: string;
	element: TimelineElement;
}): string {
	return `${trackId}\u0000${element.id}`;
}
