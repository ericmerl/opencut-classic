import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";

/** Renames an asset's display name without touching its bytes or identity. */
export class RenameMediaAssetCommand extends Command {
	private savedAssets: MediaAsset[] | null = null;
	private renamedAsset: MediaAsset | null = null;
	private previousAsset: MediaAsset | null = null;

	constructor({
		projectId,
		assetId,
		name,
	}: {
		projectId: string;
		assetId: string;
		name: string;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
		this.name = name;
	}

	private projectId: string;
	private assetId: string;
	private name: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();
		const name = this.name.trim();
		if (!name) throw new Error("asset name is required");
		const asset = assets.find((candidate) => candidate.id === this.assetId);
		if (!asset) throw new Error(`media asset not found: ${this.assetId}`);
		this.savedAssets = [...assets];
		this.previousAsset = asset;
		this.renamedAsset = { ...asset, name };
		editor.media.setAssets({
			assets: assets.map((candidate) =>
				candidate.id === this.assetId ? this.renamedAsset! : candidate,
			),
		});
		return undefined;
	}

	async preparePersistence(): Promise<void> {
		if (!this.renamedAsset) return;
		await storageService.saveMediaAsset({
			projectId: this.projectId,
			mediaAsset: this.renamedAsset,
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
		}
	}
}
