import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/element-utils";
import type { SceneTracks } from "@/timeline";
import { UpdateElementsCommand } from "@/commands/timeline";

export class RemoveMediaAssetCommand extends Command {
	private savedAssets: MediaAsset[] | null = null;
	private savedTracks: SceneTracks | null = null;
	private removedAssets: MediaAsset[] = [];

	constructor({ projectId, assetId }: { projectId: string; assetId: string }) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
	}

	private projectId: string;
	private assetId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();

		this.savedAssets = [...assets];
		this.savedTracks = editor.scenes.getActiveScene().tracks;

		const primaryAsset =
			assets.find((media) => media.id === this.assetId) ?? null;

		if (!primaryAsset) {
			console.error("Media asset not found:", this.assetId);
			return;
		}

		const elementsToRemove: Array<{ trackId: string; elementId: string }> = [];
		const tracks = [
			...this.savedTracks.overlay,
			this.savedTracks.main,
			...this.savedTracks.audio,
		];

		for (const track of tracks) {
			for (const element of track.elements) {
				if (hasMediaId(element) && element.mediaId === this.assetId) {
					elementsToRemove.push({ trackId: track.id, elementId: element.id });
				}
			}
		}
		const removedElementKeys = new Set(
			elementsToRemove.map(
				(element) => `${element.trackId}\0${element.elementId}`,
			),
		);
		const assetIdsToRemove = new Set([this.assetId]);
		for (const track of tracks) {
			for (const element of track.elements) {
				if (
					element.type !== "video" ||
					!element.matte ||
					!removedElementKeys.has(`${track.id}\0${element.id}`)
				) {
					continue;
				}
				const hasSurvivingReference = tracks.some((candidateTrack) =>
					candidateTrack.elements.some(
						(candidate) =>
							candidate.type === "video" &&
							candidate.matte?.assetId === element.matte?.assetId &&
							!removedElementKeys.has(`${candidateTrack.id}\0${candidate.id}`),
					),
				);
				if (!hasSurvivingReference) assetIdsToRemove.add(element.matte.assetId);
			}
		}

		this.removedAssets = assets.filter((asset) =>
			assetIdsToRemove.has(asset.id),
		);
		for (const asset of this.removedAssets) {
			if (asset.url) URL.revokeObjectURL(asset.url);
			if (asset.thumbnailUrl) URL.revokeObjectURL(asset.thumbnailUrl);
			videoCache.clearVideo({ mediaId: asset.id });
			waveformCache.clearSource({
				sourceKey: buildWaveformSourceKey({ kind: "media", id: asset.id }),
			});
		}
		editor.media.setAssets({
			assets: assets.filter((media) => !assetIdsToRemove.has(media.id)),
		});

		if (elementsToRemove.length > 0) {
			editor.timeline.deleteElements({ elements: elementsToRemove });
		}
		const matteDetachUpdates = tracks.flatMap((track) =>
			track.elements.flatMap((element) =>
				element.type === "video" &&
				element.matte?.assetId === this.assetId &&
				!removedElementKeys.has(`${track.id}\0${element.id}`)
					? [
							{
								trackId: track.id,
								elementId: element.id,
								patch: { matte: undefined },
							},
						]
					: [],
			),
		);
		if (matteDetachUpdates.length > 0) {
			new UpdateElementsCommand({ updates: matteDetachUpdates }).execute();
		}

		for (const assetId of assetIdsToRemove) {
			storageService
				.deleteMediaAsset({ projectId: this.projectId, id: assetId })
				.catch((error) => {
					console.error("Failed to delete media item:", error);
				});
		}
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		if (this.savedAssets && this.removedAssets.length > 0) {
			const restoredById = new Map(
				this.removedAssets.map((asset) => [
					asset.id,
					{ ...asset, url: URL.createObjectURL(asset.file) },
				]),
			);

			editor.media.setAssets({
				assets: this.savedAssets.map(
					(asset) => restoredById.get(asset.id) ?? asset,
				),
			});

			for (const restoredAsset of restoredById.values()) {
				storageService
					.saveMediaAsset({
						projectId: this.projectId,
						mediaAsset: restoredAsset,
					})
					.catch((error) => {
						console.error("Failed to restore media item on undo:", error);
					});
			}
		}

		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
	}
}
