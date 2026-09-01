import { BatchCommand, type Command } from "@/commands";
import {
	AddMediaAssetCommand,
	RemoveMediaAssetCommand,
} from "@/commands/media";
import { UpdateElementsCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import type { AutomationAttachMatteRequest } from "./types";
import {
	buildMatteAttachment,
	countMatteReferences,
	findVideoElement,
	validateMatteAsset,
} from "./matte-control";

export interface PreparedMatteAttachment {
	command: Command;
	addMedia: AddMediaAssetCommand;
}

export async function prepareMatteAttachment({
	editor,
	request,
}: {
	editor: EditorCore;
	request: AutomationAttachMatteRequest;
}): Promise<PreparedMatteAttachment> {
	const tracks = editor.scenes.getActiveScene().tracks;
	const element = findVideoElement({
		tracks,
		trackId: request.trackId,
		elementId: request.elementId,
	});
	const source = editor.media
		.getAssets()
		.find((asset) => asset.id === element.mediaId);
	if (!source || source.type !== "video") {
		throw new Error(`source video asset not found: ${element.mediaId}`);
	}

	const response = await fetch(request.url);
	if (!response.ok) {
		throw new Error(`matte transfer failed with HTTP ${response.status}`);
	}
	const blob = await response.blob();
	const file = new File([blob], request.name, { type: request.mimeType });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed)
		throw new Error("OpenCut could not process the matte artifact");
	const matteAsset = {
		...processed,
		role: "matte" as const,
		sourceFingerprint: request.artifactFingerprint,
	};
	validateMatteAsset({ source, matte: matteAsset });

	const addMedia = new AddMediaAssetCommand({
		projectId: request.projectId,
		asset: matteAsset,
		ratchetProjectFps: false,
	});
	const update = new UpdateElementsCommand({
		updates: [
			{
				trackId: request.trackId,
				elementId: element.id,
				patch: {
					matte: buildMatteAttachment({
						assetId: addMedia.getAssetId(),
						source,
						artifactHash: request.artifactHash,
						artifactFingerprint: request.artifactFingerprint,
						channel: request.channel,
						modelId: request.modelId,
						modelVersion: request.modelVersion,
					}),
				},
			},
		],
	});
	const commands: Command[] = [addMedia, update];
	if (
		element.matte &&
		countMatteReferences({ tracks, assetId: element.matte.assetId }) === 1
	) {
		commands.push(
			new RemoveMediaAssetCommand({
				projectId: request.projectId,
				assetId: element.matte.assetId,
			}),
		);
	}
	return { command: new BatchCommand(commands), addMedia };
}
