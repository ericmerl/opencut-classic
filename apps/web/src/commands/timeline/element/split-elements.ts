import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { isRetimableElement } from "@/timeline";
import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";
import { cloneCompoundTracks } from "./duplicate-elements";
import type { ObjectIdAllocation } from "opencut-wasm";
import * as OpenCutWasm from "opencut-wasm";
import { ResolvedObjectIds } from "@/automation/resolved-object-ids";

export class SplitElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private rightSideElements: { trackId: string; elementId: string }[] = [];
	private readonly elements: { trackId: string; elementId: string }[];
	private readonly splitTime: MediaTime;
	private readonly retainSide: "both" | "left" | "right";
	private readonly rightElementIds: Map<string, string>;
	private readonly resolvedIds: ResolvedObjectIds;

	constructor({
		elements,
		splitTime,
		retainSide = "both",
		rightElementIds,
		resolvedAllocations,
	}: {
		elements: { trackId: string; elementId: string }[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
		rightElementIds?: string[];
		resolvedAllocations?: ObjectIdAllocation[];
	}) {
		super();
		this.elements = elements;
		this.splitTime = splitTime;
		this.retainSide = retainSide;
		if (rightElementIds && rightElementIds.length !== elements.length) {
			throw new Error("right-side IDs must match split elements");
		}
		this.rightElementIds = new Map(
			elements.map((element, index) => [
				`${element.trackId}\0${element.elementId}`,
				rightElementIds?.[index] ?? generateUUID(),
			]),
		);
		this.resolvedIds = new ResolvedObjectIds(resolvedAllocations);
	}

	getRightSideElements(): { trackId: string; elementId: string }[] {
		return this.rightSideElements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		this.rightSideElements = [];

		const splitTrack = <
			TTrack extends { id: string; elements: TimelineElement[] },
		>(
			track: TTrack,
		): TTrack => {
			const elementsToSplit = this.elements.filter(
				(target) => target.trackId === track.id,
			);

			if (elementsToSplit.length === 0) {
				return track;
			}

			const replacedSourceIds = new Map<string, string>();
			const removedTransitionSourceIds = new Set<string>();
			const elements = track.elements.flatMap((element) => {
				const shouldSplit = elementsToSplit.some(
					(target) => target.elementId === element.id,
				);

				if (!shouldSplit) {
					return [element];
				}

				const effectiveStart = element.startTime;
				const effectiveEnd = element.startTime + element.duration;

				if (
					this.splitTime <= effectiveStart ||
					this.splitTime >= effectiveEnd
				) {
					return [element];
				}

				const relativeTime = subMediaTime({
					a: this.splitTime,
					b: element.startTime,
				});
				const leftVisibleDuration = relativeTime;
				const rightVisibleDuration = subMediaTime({
					a: element.duration,
					b: relativeTime,
				});
				const retimeRef = isRetimableElement(element)
					? element.retime
					: undefined;
				// Snap the source-side split point exactly once and derive the right
				// half from it. Independently rounding both spans (left and total)
				// would let a 1-tick rounding error desynchronise them, breaking the
				// invariant `leftSourceSpan + rightSourceSpan == totalSourceSpan`.
				// See the same discipline in `compute-resize.ts` (snap-once comment).
				const leftSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: leftVisibleDuration,
						retime: retimeRef,
					}),
				});
				const totalSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: element.duration,
						retime: retimeRef,
					}),
				});
				const rightSourceSpan = subMediaTime({
					a: totalSourceSpan,
					b: leftSourceSpan,
				});
				const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
					animations: element.animations,
					splitTime: relativeTime,
					shouldIncludeSplitBoundary: true,
					resolveLeftBoundaryId: (propertyPath) =>
						this.resolvedIds.take({
							role: "split-left-boundary-keyframe",
							sourceId: propertyPath,
							fallback: generateUUID,
						}),
					resolveRightBoundaryId: (propertyPath) =>
						this.resolvedIds.take({
							role: "split-right-boundary-keyframe",
							sourceId: propertyPath,
							fallback: generateUUID,
						}),
				});
				let splitResult: TimelineElement[];

				const leftTrimEnd = addMediaTime({
					a: element.trimEnd,
					b: rightSourceSpan,
				});
				const rightTrimStart = addMediaTime({
					a: element.trimStart,
					b: leftSourceSpan,
				});
				const rightElementId = this.requireRightElementId({
					trackId: track.id,
					elementId: element.id,
				});
				const transitionResolution = OpenCutWasm.resolveSplitTransition({
					retainSide: this.retainSide,
					sourceElementId: element.id,
					rightElementId,
				});
				const transitionInFor = (resultElementId: string) => ({
					transitionIn:
						transitionResolution.incomingTargetElementId === resultElementId &&
						"transitionIn" in element
							? element.transitionIn
							: undefined,
				});
				if (transitionResolution.outgoingSourceElementId === null) {
					removedTransitionSourceIds.add(element.id);
				} else {
					replacedSourceIds.set(
						element.id,
						transitionResolution.outgoingSourceElementId,
					);
				}

				if (this.retainSide === "left") {
					splitResult = [
						{
							...element,
							...transitionInFor(element.id),
							duration: leftVisibleDuration,
							trimEnd: leftTrimEnd,
							name: `${element.name} (left)`,
							animations: leftAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
					];
				} else if (this.retainSide === "right") {
					this.rightSideElements.push({
						trackId: track.id,
						elementId: rightElementId,
					});
					const rightOwned = cloneSplitRightOwnedIdentities({
						element,
						resolvedIds: this.resolvedIds,
					});
					splitResult = [
						{
							...rightOwned,
							...transitionInFor(rightElementId),
							id: rightElementId,
							startTime: this.splitTime,
							duration: rightVisibleDuration,
							trimStart: rightTrimStart,
							name: `${element.name} (right)`,
							animations: rightAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
					];
				} else {
					this.rightSideElements.push({
						trackId: track.id,
						elementId: rightElementId,
					});
					const rightOwned = cloneSplitRightOwnedIdentities({
						element,
						resolvedIds: this.resolvedIds,
					});
					splitResult = [
						{
							...element,
							...transitionInFor(element.id),
							duration: leftVisibleDuration,
							trimEnd: leftTrimEnd,
							name: `${element.name} (left)`,
							animations: leftAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
						{
							...rightOwned,
							...transitionInFor(rightElementId),
							id: rightElementId,
							startTime: this.splitTime,
							duration: rightVisibleDuration,
							trimStart: rightTrimStart,
							name: `${element.name} (right)`,
							animations: rightAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
					];
				}

				return splitResult;
			});

			const remappedElements = elements.map((element) => {
				if (!("transitionIn" in element) || !element.transitionIn) {
					return element;
				}
				if (
					removedTransitionSourceIds.has(element.transitionIn.fromElementId)
				) {
					return { ...element, transitionIn: undefined };
				}
				const remappedFromId = replacedSourceIds.get(
					element.transitionIn.fromElementId,
				);
				return remappedFromId
					? {
							...element,
							transitionIn: {
								...element.transitionIn,
								fromElementId: remappedFromId,
							},
						}
					: element;
			});

			return { ...track, elements: remappedElements } as TTrack;
		};

		const updatedTracks: SceneTracks = {
			overlay: this.savedState.overlay.map((track) => splitTrack(track)),
			main: splitTrack(this.savedState.main),
			audio: this.savedState.audio.map((track) => splitTrack(track)),
		};
		this.resolvedIds.assertExhausted();

		editor.timeline.updateTracks(updatedTracks);

		if (this.rightSideElements.length > 0) {
			return createElementSelectionResult(this.rightSideElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	private requireRightElementId({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): string {
		const id = this.rightElementIds.get(`${trackId}\0${elementId}`);
		if (!id) throw new Error("missing resolved right-side element ID");
		return id;
	}
}

function cloneSplitRightOwnedIdentities({
	element,
	resolvedIds,
}: {
	element: TimelineElement;
	resolvedIds: ResolvedObjectIds;
}): TimelineElement {
	let right: TimelineElement = {
		...element,
		groupId: element.groupId
			? resolvedIds.take({
					role: "split-group",
					sourceId: element.groupId,
					fallback: generateUUID,
				})
			: undefined,
		linkId: element.linkId
			? resolvedIds.take({
					role: "split-link",
					sourceId: element.linkId,
					fallback: generateUUID,
				})
			: undefined,
	};
	if ("effects" in right && right.effects) {
		right = {
			...right,
			effects: right.effects.map((effect) => ({
				...effect,
				id: resolvedIds.take({
					role: "split-effect",
					sourceId: effect.id,
					fallback: generateUUID,
				}),
			})),
		};
	}
	if ("masks" in right && right.masks) {
		right = {
			...right,
			masks: right.masks.map((mask) => ({
				...mask,
				id: resolvedIds.take({
					role: "split-mask",
					sourceId: mask.id,
					fallback: generateUUID,
				}),
			})),
		};
	}
	return right.type === "compound"
		? {
				...right,
				tracks: cloneCompoundTracks({
					tracks: right.tracks,
					resolvedIds,
					prefix: "split",
				}),
			}
		: right;
}
