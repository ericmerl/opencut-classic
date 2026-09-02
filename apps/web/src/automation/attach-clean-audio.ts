import { BatchCommand, type Command } from "@/commands";
import {
	AddMediaAssetCommand,
	RemoveMediaAssetCommand,
} from "@/commands/media";
import { UpdateElementsCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import type { AutomationAttachCleanAudioRequest } from "./types";
import {
	buildAudioReplacementAttachment,
	countAudioReplacementReferences,
	findAudioCapableElement,
	validateAudioReplacementAsset,
} from "./audio-replacement-control";

export interface PreparedCleanAudioAttachment {
	command: Command;
	addMedia: AddMediaAssetCommand;
}

export async function prepareCleanAudioAttachment({
	editor,
	request,
}: {
	editor: EditorCore;
	request: AutomationAttachCleanAudioRequest;
}): Promise<PreparedCleanAudioAttachment> {
	const tracks = editor.scenes.getActiveScene().tracks;
	const element = findAudioCapableElement({
		tracks,
		trackId: request.trackId,
		elementId: request.elementId,
	});
	if (!("mediaId" in element)) {
		throw new Error("library audio cannot use a cleaned source attachment");
	}
	if (element.type === "video" && element.isSourceAudioEnabled === false) {
		throw new Error(
			"video source audio is separated; attach cleaned audio to its separated audio element",
		);
	}
	const source = editor.media
		.getAssets()
		.find((asset) => asset.id === element.mediaId);
	if (!source || (source.type !== "audio" && source.type !== "video")) {
		throw new Error(`source media asset not found: ${element.mediaId}`);
	}

	const response = await fetch(request.url);
	if (!response.ok) {
		throw new Error(
			`cleaned audio transfer failed with HTTP ${response.status}`,
		);
	}
	const blob = await response.blob();
	const file = new File([blob], request.name, { type: request.mimeType });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed)
		throw new Error("OpenCut could not process the cleaned audio");
	const replacementAsset = {
		...processed,
		role: "audio-replacement" as const,
		sourceFingerprint: request.artifactFingerprint,
	};
	validateAudioReplacementAsset({ source, replacement: replacementAsset });

	const addMedia = new AddMediaAssetCommand({
		projectId: request.projectId,
		asset: replacementAsset,
		ratchetProjectFps: false,
	});
	const update = new UpdateElementsCommand({
		updates: [
			{
				trackId: request.trackId,
				elementId: element.id,
				patch: {
					audioReplacement: buildAudioReplacementAttachment({
						assetId: addMedia.getAssetId(),
						source,
						artifactHash: request.artifactHash,
						artifactFingerprint: request.artifactFingerprint,
						modelId: request.modelId,
						modelVersion: request.modelVersion,
					}),
				},
			},
		],
	});
	const commands: Command[] = [addMedia, update];
	if (
		element.audioReplacement &&
		countAudioReplacementReferences({
			tracks,
			assetId: element.audioReplacement.assetId,
		}) === 1
	) {
		commands.push(
			new RemoveMediaAssetCommand({
				projectId: request.projectId,
				assetId: element.audioReplacement.assetId,
			}),
		);
	}
	return { command: new BatchCommand(commands), addMedia };
}
