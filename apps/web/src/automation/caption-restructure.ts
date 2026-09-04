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
			| "restyle_captions"
			| "rechunk_captions"
			| "repair_caption_overlaps";
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
		case "rechunk_captions": {
			const chunks = operation.resolvedChunks;
			if (!chunks || chunks.length === 0) {
				throw new Error("caption chunks were not resolved");
			}
			const targets = captionTargets({
				track,
				elementIds: operation.elementIds,
				speaker: operation.speaker,
			});
			const sources = new Map(targets.map((element) => [element.id, element]));
			const chunkIds = new Set(chunks.map((chunk) => chunk.elementId));
			const commands: Command[] = [];
			// Captions the chunks did not reuse vanished into the chunks that
			// replaced them; remove them before the reused ones take new spans.
			const surplus = targets.filter((element) => !chunkIds.has(element.id));
			if (surplus.length > 0) {
				commands.push(
					new DeleteElementsCommand({
						elements: surplus.map((element) => ({
							trackId: track.id,
							elementId: element.id,
						})),
					}),
				);
			}
			const updates: ConstructorParameters<
				typeof UpdateElementsCommand
			>[0]["updates"] = [];
			const inserts: Command[] = [];
			for (const chunk of chunks) {
				const source = sources.get(chunk.sourceElementId);
				if (!source) {
					throw new Error(`unknown chunk source: ${chunk.sourceElementId}`);
				}
				const params = { ...source.params, content: chunk.text };
				if (sources.has(chunk.elementId)) {
					updates.push({
						trackId: track.id,
						elementId: chunk.elementId,
						patch: {
							name: source.name,
							startTime: mediaTime({ ticks: chunk.startTime }),
							duration: mediaTime({ ticks: chunk.duration }),
							params,
						},
					});
					continue;
				}
				inserts.push(
					new InsertElementCommand({
						elementId: chunk.elementId,
						placement: { mode: "explicit", trackId: track.id },
						element: {
							type: "text",
							name: source.name,
							startTime: mediaTime({ ticks: chunk.startTime }),
							duration: mediaTime({ ticks: chunk.duration }),
							trimStart: source.trimStart,
							trimEnd: source.trimEnd,
							params,
						},
					}),
				);
			}
			if (updates.length > 0) {
				commands.push(new UpdateElementsCommand({ updates }));
			}
			commands.push(...inserts);
			return new BatchCommand(commands);
		}
		case "repair_caption_overlaps": {
			const gap = operation.minGap ?? 0;
			if (gap < 0) throw new Error("minGap cannot be negative");
			const ordered = [
				...captionTargets({ track, elementIds: operation.elementIds }),
			].sort(
				(left, right) =>
					left.startTime - right.startTime || left.id.localeCompare(right.id),
			);
			const updates: ConstructorParameters<
				typeof UpdateElementsCommand
			>[0]["updates"] = [];
			for (let position = 0; position + 1 < ordered.length; position++) {
				const earlier = ordered[position]!;
				const later = ordered[position + 1]!;
				const limit = later.startTime - gap;
				if (earlier.startTime + earlier.duration <= limit) continue;
				// Shortening an animated caption would re-key its animations here,
				// which the evaluator refuses to predict.
				if (earlier.animations && Object.keys(earlier.animations).length > 0) {
					throw new Error(
						"repair_caption_overlaps does not support animated captions",
					);
				}
				const trimmed = limit - earlier.startTime;
				if (trimmed <= 0) {
					throw new Error("overlap repair leaves a caption without duration");
				}
				updates.push({
					trackId: track.id,
					elementId: earlier.id,
					patch: { duration: mediaTime({ ticks: trimmed }) },
				});
			}
			if (updates.length === 0) {
				throw new Error("no caption overlaps to repair");
			}
			return new UpdateElementsCommand({ updates });
		}
		case "restyle_captions": {
			const params = operation.resolvedParams;
			if (!params || Object.keys(params).length === 0) {
				throw new Error("restyle params were not resolved");
			}
			const targets = captionTargets({
				track,
				elementIds: operation.elementIds,
				speaker: operation.speaker,
			});
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
 * caption on it in timeline order, narrowed to one speaker when asked.
 */
function captionTargets({
	track,
	elementIds,
	speaker,
}: {
	track: TimelineTrack;
	elementIds: readonly string[] | undefined;
	speaker?: string | undefined;
}): TextElement[] {
	const captions = track.elements.filter(
		(element): element is TextElement => element.type === "text",
	);
	const listed = elementIds
		? [...new Set(elementIds)].map((id) => {
				const caption = captions.find((element) => element.id === id);
				if (!caption) throw new Error(`unknown caption: ${id}`);
				return caption;
			})
		: [...captions].sort(
				(left, right) =>
					left.startTime - right.startTime || left.id.localeCompare(right.id),
			);
	if (speaker !== undefined && speaker.trim() === "") {
		throw new Error("speaker cannot be empty");
	}
	const targets =
		speaker === undefined
			? listed
			: listed.filter((element) => captionSpeaker(element) === speaker);
	if (targets.length === 0) throw new Error("no captions to operate on");
	return targets;
}

function captionSpeaker(element: TextElement): string {
	const speaker = element.params["caption.speaker"];
	return typeof speaker === "string" ? speaker : "";
}

function captionText(element: TextElement): string {
	const content = element.params.content;
	return typeof content === "string" ? content : "";
}
