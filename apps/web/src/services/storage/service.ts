import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import {
	type StorageCapacityCheckResult,
	StorageQuotaExceededError,
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "./quota";
import {
	PROJECT_STORAGE_ENVELOPE_VERSION,
	SAVE_RECEIPT_ENVELOPE_VERSION,
	SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
	type FreshProjectReadback,
	type MediaAssetData,
	type PersistedMediaReadback,
	type PersistedProjectWriteRecord,
	type PersistedSaveReceipt,
	type PersistedSaveReceiptEnvelope,
	type StorageConfig,
	type SerializedProject,
	type SerializedProjectEnvelope,
	type SerializedScene,
	type StoredProjectRecord,
} from "./types";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/sounds/types";
import {
	migrations,
	runStorageMigrations,
} from "@/services/storage/migrations";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";
import { resolvePersistedMediaIdentity } from "@/media/content-identity";
import { parseSaveReceiptEnvelope } from "./save-receipt-storage";

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<StoredProjectRecord>;
	private savedSoundsAdapter: IndexedDBAdapter<SavedSoundsData>;
	private saveReceiptsAdapter: IndexedDBAdapter<unknown>;
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;
	private projectWriteTails = new Map<string, Promise<void>>();

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			savedSoundsDb: "video-editor-saved-sounds",
			version: 1,
		};

		this.projectsAdapter = this.createProjectsAdapter();

		this.savedSoundsAdapter = new IndexedDBAdapter<SavedSoundsData>({
			dbName: this.config.savedSoundsDb,
			storeName: "saved-sounds",
			version: this.config.version,
		});
		this.saveReceiptsAdapter = new IndexedDBAdapter<unknown>({
			dbName: "opencut-save-receipts",
			storeName: "receipts",
			version: 1,
		});
	}

	private createProjectsAdapter(): IndexedDBAdapter<StoredProjectRecord> {
		return new IndexedDBAdapter<StoredProjectRecord>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});
	}

	private async ensureMigrations(): Promise<void> {
		if (this.migrationsPromise) {
			await this.migrationsPromise;
			return;
		}

		this.migrationsPromise = runStorageMigrations({ migrations }).then(
			() => undefined,
		);
		await this.migrationsPromise;
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		const quotaStatus = await readStorageQuotaStatus();
		return evaluateStorageCapacity({
			requiredBytes: size,
			quotaStatus,
		});
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		};
	}

	async saveProject({
		project,
	}: {
		project: TProject;
	}): Promise<PersistedProjectWriteRecord> {
		return this.enqueueProjectWrite({
			projectId: project.metadata.id,
			write: () => this.writeProjectSnapshot(project),
		});
	}

	private async writeProjectSnapshot(
		project: TProject,
	): Promise<PersistedProjectWriteRecord> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));

		const serializedProject: SerializedProject = {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: serializedScenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			version: project.version,
			timelineViewState: project.timelineViewState,
		};

		const snapshotAt = new Date().toISOString();
		const priorEnvelope = asProjectEnvelope(
			await this.projectsAdapter.get(project.metadata.id),
		);
		const writeVersion = (priorEnvelope?.writeVersion ?? 0) + 1;
		const completedAt = new Date().toISOString();
		const envelope: SerializedProjectEnvelope = {
			id: project.metadata.id,
			envelopeVersion: PROJECT_STORAGE_ENVELOPE_VERSION,
			storageSchemaVersion: this.config.version,
			writeVersion,
			snapshotAt,
			completedAt,
			project: serializedProject,
		};
		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: envelope,
		});
		return {
			projectId: project.metadata.id,
			storageSchemaVersion: this.config.version,
			writeVersion,
			snapshotAt,
			completedAt,
		};
	}

	private async enqueueProjectWrite<T>({
		projectId,
		write,
	}: {
		projectId: string;
		write: () => Promise<T>;
	}): Promise<T> {
		const prior = this.projectWriteTails.get(projectId) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.projectWriteTails.set(projectId, tail);
		await prior.catch(() => undefined);
		try {
			return await write();
		} finally {
			release();
			if (this.projectWriteTails.get(projectId) === tail) {
				this.projectWriteTails.delete(projectId);
			}
		}
	}

	async saveSaveReceipt<T>(receipt: PersistedSaveReceipt<T>): Promise<void> {
		await this.saveReceiptsAdapter.set({
			key: receipt.operationId,
			value: {
				...receipt,
				id: receipt.operationId,
				envelopeVersion: SAVE_RECEIPT_ENVELOPE_VERSION,
				storageSchemaVersion: SAVE_RECEIPT_STORAGE_SCHEMA_VERSION,
			} satisfies PersistedSaveReceiptEnvelope<T>,
		});
	}

	async loadSaveReceipt<T extends { operationId: string }>({
		operationId,
		parseResult,
	}: {
		operationId: string;
		parseResult: (value: unknown) => T;
	}): Promise<PersistedSaveReceiptEnvelope<T> | null> {
		const value = await this.saveReceiptsAdapter.get(operationId);
		if (value === null) return null;
		return parseSaveReceiptEnvelope({ value, operationId, parseResult });
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureMigrations();
		const serializedProject = unwrapStoredProject(
			await this.projectsAdapter.get(id),
		);

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const scenes =
			serializedProject.scenes?.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				tracks: scene.tracks,
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})) ?? [];

		const project: TProject = {
			metadata: {
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({ scenes }),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			},
			scenes,
			currentSceneId: serializedProject.currentSceneId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: serializedProject.timelineViewState,
		};

		return { project };
	}

	async loadProjectFresh({
		id,
	}: {
		id: string;
	}): Promise<FreshProjectReadback | null> {
		await this.ensureMigrations();
		const stored = await this.createProjectsAdapter().get(id);
		const envelope = asProjectEnvelope(stored);
		const serialized = unwrapStoredProject(stored);
		if (!serialized) return null;
		if (!envelope?.completedAt) {
			throw new Error(
				"Persisted project is missing a completed write envelope",
			);
		}
		const project = deserializeProject(serialized);
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId: id });
		const mediaAssets: PersistedMediaReadback[] = [];
		for (const mediaId of await mediaMetadataAdapter.list()) {
			const [metadata, file] = await Promise.all([
				mediaMetadataAdapter.get(mediaId),
				mediaAssetsAdapter.get(mediaId),
			]);
			if (!metadata || !file) continue;
			const resolved = await resolvePersistedMediaIdentity({
				file,
				storedIdentity: metadata.sourceIdentity,
			});
			if (resolved.backfilled) {
				await mediaMetadataAdapter.set({
					key: metadata.id,
					value: { ...metadata, sourceIdentity: resolved.identity },
				});
			}
			mediaAssets.push({
				...metadata,
				file,
				sourceIdentity: resolved.identity,
			});
		}
		return {
			project,
			mediaAssets,
			persistence: {
				projectId: id,
				storageSchemaVersion: envelope.storageSchemaVersion,
				writeVersion: envelope.writeVersion,
				snapshotAt: envelope.snapshotAt,
				completedAt: envelope.completedAt,
			},
		};
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const serializedProjects = (await this.projectsAdapter.getAll()).flatMap(
			(record) => {
				const project = unwrapStoredProject(record);
				return project ? [project] : [];
			},
		);

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({
							scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const metadata: MediaAssetData = {
			id: mediaAsset.id,
			name: mediaAsset.name,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			fps: mediaAsset.fps,
			hasAudio: mediaAsset.hasAudio,
			thumbnailUrl: mediaAsset.thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
			sourceFingerprint: mediaAsset.sourceFingerprint,
			role: mediaAsset.role,
			sourceIdentity: mediaAsset.sourceIdentity,
		};

		try {
			await mediaAssetsAdapter.set({
				key: mediaAsset.id,
				value: mediaAsset.file,
			});
			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: metadata,
			});
		} catch (error) {
			try {
				await mediaAssetsAdapter.remove(mediaAsset.id);
			} catch {
				// Ignore cleanup failures so the original storage error is preserved.
			}

			if (this.isQuotaExceededError({ error })) {
				throw new StorageQuotaExceededError({
					requiredBytes: mediaAsset.file.size,
				});
			}

			throw error;
		}
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const [file, metadata] = await Promise.all([
			mediaAssetsAdapter.get(id),
			mediaMetadataAdapter.get(id),
		]);

		if (!file || !metadata) return null;

		let url: string;
		if (metadata.type === "image" && (!file.type || file.type === "")) {
			try {
				const text = await file.text();
				if (text.trim().startsWith("<svg")) {
					const svgBlob = new Blob([text], { type: "image/svg+xml" });
					url = URL.createObjectURL(svgBlob);
				} else {
					url = URL.createObjectURL(file);
				}
			} catch {
				url = URL.createObjectURL(file);
			}
		} else {
			url = URL.createObjectURL(file);
		}

		const resolvedIdentity = await resolvePersistedMediaIdentity({
			file,
			storedIdentity: metadata.sourceIdentity,
		});
		if (resolvedIdentity.backfilled) {
			await mediaMetadataAdapter.set({
				key: metadata.id,
				value: { ...metadata, sourceIdentity: resolvedIdentity.identity },
			});
		}

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			sourceFingerprint: metadata.sourceFingerprint,
			role: metadata.role,
			sourceIdentity: resolvedIdentity.identity,
		};
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: MediaAsset[] = [];

		for (const id of mediaIds) {
			const item = await this.loadMediaAsset({ projectId, id });
			if (item) {
				mediaItems.push(item);
			}
		}

		return mediaItems;
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaAssetsAdapter.remove(id),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			mediaAssetsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isOPFSSupported();
	}
}

export const storageService = new StorageService();
export { StorageService };

function asProjectEnvelope(
	value: StoredProjectRecord | null,
): SerializedProjectEnvelope | null {
	if (
		value &&
		"envelopeVersion" in value &&
		value.envelopeVersion === PROJECT_STORAGE_ENVELOPE_VERSION &&
		"project" in value
	) {
		return value as SerializedProjectEnvelope;
	}
	return null;
}

function unwrapStoredProject(
	value: StoredProjectRecord | null,
): SerializedProject | null {
	if (!value) return null;
	const envelope = asProjectEnvelope(value);
	return envelope ? envelope.project : (value as SerializedProject);
}

function deserializeProject(serializedProject: SerializedProject): TProject {
	const scenes =
		serializedProject.scenes?.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: scene.tracks,
			bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})) ?? [];
	return {
		metadata: {
			id: serializedProject.metadata.id,
			name: serializedProject.metadata.name,
			thumbnail: serializedProject.metadata.thumbnail,
			duration: roundMediaTime({
				time:
					serializedProject.metadata.duration ??
					getProjectDurationFromScenes({ scenes }),
			}),
			createdAt: new Date(serializedProject.metadata.createdAt),
			updatedAt: new Date(serializedProject.metadata.updatedAt),
		},
		scenes,
		currentSceneId: serializedProject.currentSceneId || "",
		settings: serializedProject.settings,
		version: serializedProject.version,
		timelineViewState: serializedProject.timelineViewState,
	};
}
