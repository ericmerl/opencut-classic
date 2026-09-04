import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/element-utils";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline";
import { UpdateElementsCommand } from "@/commands/timeline";
import { countProjectAssetReferences } from "@/automation/project-media-references";

/**
 * - `legacy` (default, used by the editor UI): remove the asset, delete its
 *   elements in the active scene, and cascade to mattes and audio
 *   replacements that lose their last reference.
 * - `unused-only`: refuse to remove an asset that is still referenced by any
 *   scene, compound, matte, or audio replacement.
 * - `cascade`: remove the asset and every element, matte, and audio
 *   replacement that references it in every scene and compound.
 */
export type RemoveMediaAssetPolicy = "legacy" | "unused-only" | "cascade";

export class RemoveMediaAssetCommand extends Command {
	private savedAssets: MediaAsset[] | null = null;
	private savedTracks: SceneTracks | null = null;
	private savedScenes: TScene[] | null = null;
	private removedAssets: MediaAsset[] = [];

	constructor({
		projectId,
		assetId,
		deferPersistence = false,
		policy = "legacy",
	}: {
		projectId: string;
		assetId: string;
		deferPersistence?: boolean;
		policy?: RemoveMediaAssetPolicy;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
		this.deferPersistence = deferPersistence;
		this.policy = policy;
	}

	private projectId: string;
	private assetId: string;
	private readonly deferPersistence: boolean;
	private readonly policy: RemoveMediaAssetPolicy;
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
			if (this.policy === "legacy") {
				console.error("Media asset not found:", this.assetId);
				return;
			}
			throw new Error(`media asset not found: ${this.assetId}`);
		}

		if (this.policy === "unused-only" || this.policy === "cascade") {
			const references = countProjectAssetReferences({
				projectScenes: editor.scenes.getScenes(),
				assetId: this.assetId,
			});
			if (this.policy === "unused-only" && references > 0) {
				throw new Error(
					`media asset ${this.assetId} is still referenced ${references} time(s); pass the cascade policy to remove its usages`,
				);
			}
			if (this.policy === "cascade" && references > 0) {
				this.removeEverywhere(editor, assets);
				return;
			}
			this.removedAssets = [primaryAsset];
			editor.media.setAssets({
				assets: assets.filter((media) => media.id !== this.assetId),
			});
			this.schedulePersistence();
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

		this.schedulePersistence();
	}

	/**
	 * Cascade across every scene: elements bound to the asset are deleted,
	 * mattes and audio replacements pointing at it are detached, and compound
	 * elements are cleaned recursively.
	 */
	private removeEverywhere(editor: EditorCore, assets: MediaAsset[]): void {
		const scenes = editor.scenes.getScenes();
		this.savedScenes = [...scenes];
		const assetId = this.assetId;
		const now = new Date();
		const cleaned = scenes.map((scene) => ({
			...scene,
			updatedAt: now,
			tracks: stripAssetFromTracks(scene.tracks, assetId),
		}));
		this.removedAssets = assets.filter((asset) => asset.id === assetId);
		editor.media.setAssets({
			assets: assets.filter((media) => media.id !== assetId),
		});
		editor.scenes.setScenes({ scenes: cleaned });
		this.schedulePersistence();
	}

	private schedulePersistence(): void {
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
		this.persistenceQueue = this.persistenceQueue
			.catch(() => undefined)
			.then(async () => {
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

		if (this.savedScenes) {
			editor.scenes.setScenes({ scenes: this.savedScenes });
		} else if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
		void this.rollbackPersistence().catch((error) => {
			console.error("Failed to restore media item on undo:", error);
		});
	}
}

function stripAssetFromTracks(
	tracks: SceneTracks,
	assetId: string,
): SceneTracks {
	const strip = <T extends { elements: TimelineElement[] }>(track: T): T => ({
		...track,
		elements: track.elements
			.filter(
				(element) => !(hasMediaId(element) && element.mediaId === assetId),
			)
			.map((element) => stripAssetFromElement(element, assetId)),
	});
	return {
		main: strip(tracks.main),
		overlay: tracks.overlay.map(strip) as SceneTracks["overlay"],
		audio: tracks.audio.map(strip) as SceneTracks["audio"],
	};
}

function stripAssetFromElement(
	element: TimelineElement,
	assetId: string,
): TimelineElement {
	if (element.type === "compound") {
		return {
			...element,
			tracks: stripAssetFromTracks(element.tracks, assetId),
		};
	}
	if (element.type === "video") {
		const { matte, audioReplacement, ...rest } = element;
		return {
			...rest,
			...(matte && matte.assetId !== assetId ? { matte } : {}),
			...(audioReplacement && audioReplacement.assetId !== assetId
				? { audioReplacement }
				: {}),
		};
	}
	if (
		element.type === "audio" &&
		element.audioReplacement?.assetId === assetId
	) {
		const { audioReplacement: _detached, ...rest } = element;
		return rest as TimelineElement;
	}
	return element;
}
