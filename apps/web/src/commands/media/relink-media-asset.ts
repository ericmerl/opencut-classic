import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import * as opencutWasm from "opencut-wasm";

export interface MediaRelinkDifference {
	field: "type" | "width" | "height" | "duration" | "fps" | "hasAudio" | "size";
	before: unknown;
	after: unknown;
}

/**
 * Compares a replacement asset against the asset it would replace. The type
 * must match; every other difference is reported so the caller can decide
 * whether the consequences (cropped frames, shortened clips, silent audio)
 * are acceptable before committing.
 */
export function compareMediaAssets({
	current,
	replacement,
}: {
	current: MediaAsset;
	replacement: Omit<MediaAsset, "id">;
}): { compatible: boolean; differences: MediaRelinkDifference[] } {
	const result = opencutWasm.evaluateMediaRelinkCompatibility({
		current: mediaRelinkDescriptor(current),
		replacement: mediaRelinkDescriptor(replacement),
	});
	return {
		compatible: result.compatible,
		differences: result.differences.map((difference) => ({
			field: difference.field as MediaRelinkDifference["field"],
			before: difference.before ?? null,
			after: difference.after ?? null,
		})),
	};
}

export function mediaRelinkDescriptor(asset: Omit<MediaAsset, "id">) {
	return {
		type: asset.type,
		width: asset.width,
		height: asset.height,
		duration: asset.duration,
		fps: asset.fps,
		hasAudio: asset.hasAudio,
		size: asset.file.size,
	};
}

/**
 * Replaces the bytes and source identity behind an existing asset id. Every
 * timeline, matte, and audio-replacement reference keeps pointing at the same
 * asset id, so the project's structure is unchanged while its content identity
 * moves to the replacement's hash.
 */
export class RelinkMediaAssetCommand extends Command {
	private savedAssets: MediaAsset[] | null = null;
	private previousAsset: MediaAsset | null = null;
	private relinkedAsset: MediaAsset | null = null;
	private differences: MediaRelinkDifference[] = [];

	constructor({
		projectId,
		assetId,
		replacement,
		allowIncompatible = false,
	}: {
		projectId: string;
		assetId: string;
		replacement: Omit<MediaAsset, "id">;
		allowIncompatible?: boolean;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
		this.replacement = replacement;
		this.allowIncompatible = allowIncompatible;
	}

	private projectId: string;
	private assetId: string;
	private replacement: Omit<MediaAsset, "id">;
	private allowIncompatible: boolean;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();
		const current = assets.find((candidate) => candidate.id === this.assetId);
		if (!current) throw new Error(`media asset not found: ${this.assetId}`);
		const comparison = compareMediaAssets({
			current,
			replacement: this.replacement,
		});
		if (!comparison.compatible && !this.allowIncompatible) {
			throw new Error(
				`replacement is a ${this.replacement.type} asset but ${this.assetId} is ${current.type}`,
			);
		}
		this.differences = comparison.differences;
		this.savedAssets = [...assets];
		this.previousAsset = current;
		this.relinkedAsset = {
			...this.replacement,
			id: this.assetId,
			role: current.role,
			url: this.replacement.url ?? URL.createObjectURL(this.replacement.file),
		};
		editor.media.setAssets({
			assets: assets.map((candidate) =>
				candidate.id === this.assetId ? this.relinkedAsset! : candidate,
			),
		});
		videoCache.clearVideo({ mediaId: this.assetId });
		waveformCache.clearSource({
			sourceKey: buildWaveformSourceKey({ kind: "media", id: this.assetId }),
		});
		return undefined;
	}

	async preparePersistence(): Promise<void> {
		if (!this.relinkedAsset) return;
		await storageService.saveMediaAsset({
			projectId: this.projectId,
			mediaAsset: this.relinkedAsset,
		});
	}

	async rollbackPersistence(): Promise<void> {
		if (!this.previousAsset) return;
		await storageService.saveMediaAsset({
			projectId: this.projectId,
			mediaAsset: this.previousAsset,
		});
	}

	undo(): void {
		if (this.savedAssets) {
			EditorCore.getInstance().media.setAssets({ assets: this.savedAssets });
			videoCache.clearVideo({ mediaId: this.assetId });
			waveformCache.clearSource({
				sourceKey: buildWaveformSourceKey({ kind: "media", id: this.assetId }),
			});
		}
	}

	getDifferences(): MediaRelinkDifference[] {
		return this.differences;
	}
}
