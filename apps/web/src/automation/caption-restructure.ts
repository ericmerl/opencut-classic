import type { Command } from "@/commands/base-command";
import { BatchCommand } from "@/commands";
import {
	DeleteElementsCommand,
	InsertElementCommand,
	UpdateElementsCommand,
} from "@/commands/timeline/element";
import type { TextElement, TimelineTrack } from "@/timeline";
import { mediaTime } from "@/wasm";
import type { AutomationEditOperation } from "./types";

type CaptionRestructureOperation = Extract<
	AutomationEditOperation,
	{
		kind:
			| "shift_captions"
			| "merge_captions"
			| "split_caption"
			| "restyle_captions";
	}
>;

/**
 * Native commands for the caption restructuring operations. Every decision
 * about which captions move, how text joins, where a split falls, and which
 * params a restyle sets was already made by the Rust evaluator; this only
 * replays that plan through undoable commands so the native after-state
 * equals the prediction.
 */
export function buildCaptionRestructureCommand({
	operation,
	tracks,
}: {
	operation: CaptionRestructureOperation;
	tracks: readonly TimelineTrack[];
}): Command {
	const track = tracks.find((candidate) => candidate.id === operation.trackId);
	if (!track) throw new Error(`unknown track: ${operation.trackId}`);
	switch (operation.kind) {
		case "shift_captions": {
			if (operation.delta === 0) throw new Error("delta cannot be zero");
			const targets = captionTargets({ track, elementIds: operation.elementIds });
			const updates = targets.map((element) => {
				const startTicks = element.startTime + operation.delta;
				if (startTicks < 0) throw new Error("delta moves a caption before zero");
				return {
					trackId: track.id,
					elementId: element.id,
					patch: { startTime: mediaTime({ ticks: startTicks }) },
				};
			});
			return new UpdateElementsCommand({ updates });
		}
		case "merge_captions": {
			if (operation.elementIds.length < 2) {
				throw new Error("merge needs at least two captions");
			}
			const targets = captionTargets({ track, elementIds: operation.elementIds });
			if (targets.length !== operation.elementIds.length) {
				throw new Error("merge captions must be distinct");
			}
			const ordered = [...targets].sort(
				(left, right) =>
					left.startTime - right.startTime || left.id.localeCompare(right.id),
			);
			const kept = ordered[0]!;
			const text = ordered
				.map((element) => captionText(element).trim())
				.join(operation.separator ?? " ");
			if (!text.trim()) throw new Error("merged caption text is empty");
			const start = Math.min(...ordered.map((element) => element.startTime));
			const end = Math.max(
				...ordered.map((element) => element.startTime + element.duration),
			);
			return new BatchCommand([
				new UpdateElementsCommand({
					updates: [
						{
							trackId: track.id,
							elementId: kept.id,
							patch: {
								startTime: mediaTime({ ticks: start }),
								duration: mediaTime({ ticks: end - start }),
								params: { ...kept.params, content: text },
							},
						},
					],
				}),
				new DeleteElementsCommand({
					elements: ordered
						.slice(1)
						.map((element) => ({ trackId: track.id, elementId: element.id })),
				}),
			]);
		}
		case "split_caption": {
			const [source] = captionTargets({
				track,
				elementIds: [operation.elementId],
			});
			if (!source) throw new Error(`unknown caption: ${operation.elementId}`);
			if (source.animations && Object.keys(source.animations).length > 0) {
				throw new Error("split_caption does not support animated captions");
			}
			const chars = Array.from(captionText(source));
			if (operation.splitIndex <= 0 || operation.splitIndex >= chars.length) {
				throw new Error("splitIndex must fall inside the caption text");
			}
			const left = chars.slice(0, operation.splitIndex).join("").trim();
			const right = chars.slice(operation.splitIndex).join("").trim();
			if (!left || !right) throw new Error("split leaves an empty caption");
			const leftLength = Array.from(left).length;
			const totalLength = leftLength + Array.from(right).length;
			const leftTicks = Math.floor((source.duration * leftLength) / totalLength);
			const rightTicks = source.duration - leftTicks;
			if (leftTicks <= 0 || rightTicks <= 0) {
				throw new Error("caption is too short to split");
			}
			const rightId =
				operation.resolvedAllocations?.[0]?.resolvedId ??
				operation.rightElementId;
			if (!rightId) throw new Error("split caption id was not resolved");
			return new BatchCommand([
				new UpdateElementsCommand({
					updates: [
						{
							trackId: track.id,
							elementId: source.id,
							patch: {
								duration: mediaTime({ ticks: leftTicks }),
								params: { ...source.params, content: left },
							},
						},
					],
				}),
				new InsertElementCommand({
					elementId: rightId,
					placement: { mode: "explicit", trackId: track.id },
					element: {
						type: "text",
						name: source.name,
						startTime: mediaTime({ ticks: source.startTime + leftTicks }),
						duration: mediaTime({ ticks: rightTicks }),
						trimStart: source.trimStart,
						trimEnd: source.trimEnd,
						params: { ...source.params, content: right },
					},
				}),
			]);
		}
		case "restyle_captions": {
			const params = operation.resolvedParams;
			if (!params || Object.keys(params).length === 0) {
				throw new Error("restyle params were not resolved");
			}
			const targets = captionTargets({ track, elementIds: operation.elementIds });
			return new UpdateElementsCommand({
				updates: targets.map((element) => ({
					trackId: track.id,
					elementId: element.id,
					patch: {
						params: { ...element.params, ...params },
					},
				})),
			});
		}
	}
}

/**
 * The captions an operation addresses on a track, matching the evaluator:
 * the listed ids, each of which must be a caption on the track, or every
 * caption on it in timeline order.
 */
function captionTargets({
	track,
	elementIds,
}: {
	track: TimelineTrack;
	elementIds: readonly string[] | undefined;
}): TextElement[] {
	const captions = track.elements.filter(
		(element): element is TextElement => element.type === "text",
	);
	if (elementIds) {
		const unique = [...new Set(elementIds)];
		return unique.map((id) => {
			const caption = captions.find((element) => element.id === id);
			if (!caption) throw new Error(`unknown caption: ${id}`);
			return caption;
		});
	}
	const ordered = [...captions].sort(
		(left, right) =>
			left.startTime - right.startTime || left.id.localeCompare(right.id),
	);
	if (ordered.length === 0) throw new Error("no captions to operate on");
	return ordered;
}

function captionText(element: TextElement): string {
	const content = element.params.content;
	return typeof content === "string" ? content : "";
}
