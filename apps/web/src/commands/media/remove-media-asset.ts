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

	constructor({
		projectId,
		assetId,
		deferPersistence = false,
	}: {
		projectId: string;
		assetId: string;
		deferPersistence?: boolean;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
		this.deferPersistence = deferPersistence;
	}

	private projectId: string;
	private assetId: string;
	private readonly deferPersistence: boolean;
	private persistencePrepared = false;
	private readonly persistedRemovedIds = new Set<string>();
	private persistenceQueue = Promise.resolve();

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
				if (removedElementKeys.has(`${track.id}\0${element.id}`)) {
					if (element.type === "video" && element.matte) {
						const hasSurvivingReference = tracks.some((candidateTrack) =>
							candidateTrack.elements.some(
								(candidate) =>
									candidate.type === "video" &&
									candidate.matte?.assetId === element.matte?.assetId &&
									!removedElementKeys.has(
										`${candidateTrack.id}\0${candidate.id}`,
									),
							),
						);
						if (!hasSurvivingReference)
							assetIdsToRemove.add(element.matte.assetId);
					}
					if (
						(element.type === "audio" || element.type === "video") &&
						element.audioReplacement
					) {
						const hasSurvivingReference = tracks.some((candidateTrack) =>
							candidateTrack.elements.some(
								(candidate) =>
									(candidate.type === "audio" || candidate.type === "video") &&
									candidate.audioReplacement?.assetId ===
										element.audioReplacement?.assetId &&
									!removedElementKeys.has(
										`${candidateTrack.id}\0${candidate.id}`,
									),
							),
						);
						if (!hasSurvivingReference) {
							assetIdsToRemove.add(element.audioReplacement.assetId);
						}
					}
				}
			}
		}

		this.removedAssets = assets.filter((asset) =>
			assetIdsToRemove.has(asset.id),
		);
		editor.media.setAssets({
			assets: assets.filter((media) => !assetIdsToRemove.has(media.id)),
		});

		if (elementsToRemove.length > 0) {
			editor.timeline.deleteElements({ elements: elementsToRemove });
		}
		const attachmentDetachUpdates = tracks.flatMap((track) =>
			track.elements.flatMap((element) =>
				!removedElementKeys.has(`${track.id}\0${element.id}`)
					? [
							...(element.type === "video" &&
							element.matte?.assetId === this.assetId
								? [
										{
											trackId: track.id,
											elementId: element.id,
											patch: { matte: undefined },
										},
									]
								: []),
							...((element.type === "audio" || element.type === "video") &&
							element.audioReplacement?.assetId === this.assetId
								? [
										{
											trackId: track.id,
											elementId: element.id,
											patch: { audioReplacement: undefined },
										},
									]
								: []),
						]
					: [],
			),
		);
		if (attachmentDetachUpdates.length > 0) {
			new UpdateElementsCommand({ updates: attachmentDetachUpdates }).execute();
		}

		if (!this.deferPersistence || this.persistencePrepared) {
			void this.preparePersistence().catch((error) => {
				console.error("Failed to delete media item:", error);
			});
		}
	}

	preparePersistence(): Promise<void> {
		this.persistencePrepared = true;
		this.persistenceQueue = this.persistenceQueue.then(async () => {
			for (const asset of this.removedAssets) {
				if (this.persistedRemovedIds.has(asset.id)) continue;
				await storageService.deleteMediaAsset({
					projectId: this.projectId,
					id: asset.id,
				});
				this.persistedRemovedIds.add(asset.id);
				if (asset.url) URL.revokeObjectURL(asset.url);
				if (asset.thumbnailUrl) URL.revokeObjectURL(asset.thumbnailUrl);
				videoCache.clearVideo({ mediaId: asset.id });
				waveformCache.clearSource({
					sourceKey: buildWaveformSourceKey({ kind: "media", id: asset.id }),
				});
			}
		});
		return this.persistenceQueue;
	}

	rollbackPersistence(): Promise<void> {
		this.persistenceQueue = this.persistenceQueue.catch(() => undefined).then(async () => {
			for (const asset of this.removedAssets) {
				if (!this.persistedRemovedIds.has(asset.id)) continue;
				await storageService.saveMediaAsset({
					projectId: this.projectId,
					mediaAsset: asset,
				});
				this.persistedRemovedIds.delete(asset.id);
			}
		});
		return this.persistenceQueue;
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

		}

		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
		void this.rollbackPersistence().catch((error) => {
			console.error("Failed to restore media item on undo:", error);
		});
	}
}
