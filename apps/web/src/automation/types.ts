import type { MediaTime } from "@/wasm";
import type { ExportFormat, ExportQuality } from "@/export";
import type { TBackground, TCanvasSize } from "@/project/types";
import type { SubtitleStyleOverrides } from "@/subtitles/types";
import type { RetimeConfig, TrackType } from "@/timeline";
import type { FrameRate } from "opencut-wasm";
import type { ElementKeyframe } from "@/animation/types";

export interface AutomationElementSnapshot {
	trackId: string;
	elementId: string;
	type: string;
	name: string;
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration: MediaTime;
	params: Record<string, string | number | boolean>;
	mediaId?: string;
	sourceType?: "upload" | "library";
	sourceUrl?: string;
	hidden?: boolean;
	retime?: RetimeConfig;
	keyframes?: ElementKeyframe[];
}

export interface AutomationTrackSnapshot {
	trackId: string;
	name: string;
	type: string;
	role: "main" | "overlay" | "audio";
	muted?: boolean;
	hidden?: boolean;
}

export interface AutomationMediaAssetSnapshot {
	assetId: string;
	name: string;
	type: "image" | "video" | "audio";
	size: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
}

export interface AutomationProjectSnapshot {
	projectId: string;
	projectName: string;
	projectVersion: number;
	sceneId: string;
	sceneName: string;
	revision: number;
	settings: {
		fps: FrameRate;
		canvasSize: TCanvasSize;
		background: TBackground;
	};
	tracks: AutomationTrackSnapshot[];
	mediaAssets: AutomationMediaAssetSnapshot[];
	elements: AutomationElementSnapshot[];
}

export interface AutomationProjectSummary {
	projectId: string;
	name: string;
	duration: MediaTime;
	createdAt: string;
	updatedAt: string;
	isActive: boolean;
}

export interface AutomationProjectListResult {
	activeProjectId: string | null;
	projects: AutomationProjectSummary[];
}

export interface AutomationCreateProjectRequest {
	operationId: string;
	name: string;
}

export interface AutomationOpenProjectRequest {
	operationId: string;
	projectId: string;
}

export interface AutomationProjectActivatedResult {
	operationId: string;
	projectId: string;
	editorPath: string;
	revision: number;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationCreateProjectResult =
	| (AutomationProjectActivatedResult & { status: "created" | "replayed" })
	| { status: "rejected"; operationId: string; reason: string };

export type AutomationOpenProjectResult =
	| (AutomationProjectActivatedResult & { status: "opened" | "replayed" })
	| { status: "rejected"; operationId: string; reason: string };

export type AutomationEditOperation =
	| {
			kind: "insert_text";
			content: string;
			startTime: MediaTime;
			duration: MediaTime;
	  }
	| {
			kind: "add_track";
			trackType: TrackType;
			trackId: string;
	  }
	| {
			kind: "set_track_state";
			trackId: string;
			muted?: boolean;
			hidden?: boolean;
	  }
	| {
			kind: "set_project_settings";
			fps?: FrameRate;
			canvasSize?: TCanvasSize;
			background?: TBackground;
	  }
	| {
			kind: "insert_captions";
			captions: Array<{
				text: string;
				startTime: MediaTime;
				duration: MediaTime;
			}>;
			style?: SubtitleStyleOverrides;
	  }
	| {
			kind: "delete";
			trackId: string;
			elementId: string;
	  }
	| {
			kind: "move";
			trackId: string;
			targetTrackId?: string;
			elementId: string;
			startTime: MediaTime;
	  }
	| {
			kind: "set_params";
			trackId: string;
			elementId: string;
			params: Record<string, string | number | boolean>;
	  }
	| {
			kind: "set_audio";
			trackId: string;
			elementId: string;
			volumeDb?: number;
			muted?: boolean;
			fade?: {
				inDuration: MediaTime;
				outDuration: MediaTime;
				floorDb: number;
			};
	  }
	| {
			kind: "set_retime";
			trackId: string;
			elementId: string;
			rate: number;
			maintainPitch?: boolean;
	  }
	| {
			kind: "trim";
			trackId: string;
			elementId: string;
			startTime?: MediaTime;
			duration?: MediaTime;
			trimStart: MediaTime;
			trimEnd: MediaTime;
	  }
	| {
			kind: "split";
			trackId: string;
			elementId: string;
			splitTime: MediaTime;
			retainSide?: "both" | "left" | "right";
	  };

export interface AutomationEditPlan {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	description: string;
	operations: AutomationEditOperation[];
}

export interface AutomationAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationMutationResult =
	| AutomationAppliedResult
	| {
			status: "replayed";
			operationId: string;
			revision: number;
			snapshot: AutomationProjectSnapshot;
	  }
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

export type AutomationUndoResult =
	| {
			status: "undone";
			revision: number;
			snapshot: AutomationProjectSnapshot;
	  }
	| {
			status: "conflict";
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "nothing-to-undo"; revision: number };

export interface AutomationImportRequest {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	url: string;
	name: string;
	mimeType: string;
	sourceFingerprint: string;
	startTime: MediaTime;
	trackId?: string;
	adoptMediaSettings: boolean;
}

export interface AutomationImportAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	assetId: string;
	elementId: string;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationImportResult =
	| AutomationImportAppliedResult
	| (Omit<AutomationImportAppliedResult, "status"> & { status: "replayed" })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

export interface AutomationExportRequest {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	url: string;
	outputPath: string;
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio: boolean;
}

export interface AutomationExportCompletedResult {
	status: "exported";
	operationId: string;
	revision: number;
	outputPath: string;
	bytesWritten: number;
}

export type AutomationExportResult =
	| AutomationExportCompletedResult
	| (Omit<AutomationExportCompletedResult, "status"> & { status: "replayed" })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };
