import type { MediaType } from "@/media/types";
import type { MediaSourceIdentity } from "@/media/content-identity";
import type {
	TProject,
	TProjectMetadata,
	TTimelineViewState,
} from "@/project/types";
import type { TScene } from "@/timeline";

export interface StorageAdapter<T> {
	get(key: string): Promise<T | null>;
	set(args: { key: string; value: T }): Promise<void>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

export interface MediaAssetData {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
	sourceFingerprint?: string;
	role?: "timeline" | "matte" | "audio-replacement";
	sourceIdentity?: MediaSourceIdentity;
}

export type SerializedScene = Omit<TScene, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProjectMetadata = Omit<
	TProjectMetadata,
	"createdAt" | "updatedAt"
> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProject = Omit<TProject, "metadata" | "scenes"> & {
	metadata: SerializedProjectMetadata;
	scenes: SerializedScene[];
	timelineViewState?: TTimelineViewState;
};

export const PROJECT_STORAGE_ENVELOPE_VERSION = 1 as const;

export interface SerializedProjectEnvelope {
	id: string;
	envelopeVersion: typeof PROJECT_STORAGE_ENVELOPE_VERSION;
	storageSchemaVersion: number;
	writeVersion: number;
	snapshotAt: string;
	completedAt: string | null;
	project: SerializedProject;
}

export type StoredProjectRecord = SerializedProject | SerializedProjectEnvelope;

export interface PersistedProjectWriteRecord {
	projectId: string;
	storageSchemaVersion: number;
	writeVersion: number;
	snapshotAt: string;
	completedAt: string;
}

export interface PersistedMediaReadback extends MediaAssetData {
	file: File;
	sourceIdentity: MediaSourceIdentity;
}

export interface FreshProjectReadback {
	project: TProject;
	mediaAssets: PersistedMediaReadback[];
	persistence: PersistedProjectWriteRecord;
}

export const SAVE_RECEIPT_ENVELOPE_VERSION = 1 as const;
export const SAVE_RECEIPT_STORAGE_SCHEMA_VERSION = 1 as const;

export interface PersistedSaveReceipt<T> {
	operationId: string;
	fingerprint: string;
	result: T;
	recordedAt: string;
}

export interface PersistedSaveReceiptEnvelope<
	T,
> extends PersistedSaveReceipt<T> {
	id: string;
	envelopeVersion: typeof SAVE_RECEIPT_ENVELOPE_VERSION;
	storageSchemaVersion: typeof SAVE_RECEIPT_STORAGE_SCHEMA_VERSION;
}

export const OPERATION_RECEIPT_ENVELOPE_VERSION = 3 as const;
export const OPERATION_RECEIPT_STORAGE_SCHEMA_VERSION = 3 as const;

export interface OperationReceiptBinding {
	version: 1;
	outerOperationId: string;
	outerToolName: string;
	outerRequestFingerprint: string;
	role: "direct-terminal" | "composite-step";
	stepId: string;
	browserMethod: string;
	browserRequestFingerprint: string;
}

export interface OperationReceiptAfterState {
	projectId: string;
	sceneId: string;
	sessionRevisionAfter: number;
	revisionAfter: number;
	durableWriteVersion: number;
	contentHashAfter: string;
}

export interface PersistedOperationReceipt {
	id: string;
	envelopeVersion: typeof OPERATION_RECEIPT_ENVELOPE_VERSION;
	storageSchemaVersion: typeof OPERATION_RECEIPT_STORAGE_SCHEMA_VERSION;
	operationId: string;
	binding: OperationReceiptBinding;
	afterState: OperationReceiptAfterState;
	result: unknown;
	recordedAt: string;
}

export interface StorageConfig {
	projectsDb: string;
	mediaDb: string;
	savedSoundsDb: string;
	version: number;
}

// TypeScript type augmentation to add async iterator methods to FileSystemDirectoryHandle
// These methods are part of the File System Access API spec but may not be in all type definitions
declare global {
	interface FileSystemDirectoryHandle {
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}
