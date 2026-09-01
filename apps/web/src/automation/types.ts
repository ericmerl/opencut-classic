import type { MediaTime } from "@/wasm";
import type { ExportFormat, ExportQuality } from "@/export";
import type { TBackground, TCanvasSize } from "@/project/types";
import type { SubtitleStyleOverrides } from "@/subtitles/types";
import type { ClipTransitionType, RetimeConfig, TrackType } from "@/timeline";
import type { FrameRate } from "opencut-wasm";
import type {
	AnimationInterpolation,
	ElementKeyframe,
} from "@/animation/types";

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
	effects?: AutomationEffectSnapshot[];
}

export interface AutomationEffectSnapshot {
	effectId: string;
	effectType: string;
	enabled: boolean;
	params: Record<string, string | number | boolean>;
}

export interface AutomationEffectCatalogEntry {
	effectType: string;
	name: string;
	keywords: string[];
	params: Array<{
		key: string;
		label: string;
		type: string;
		default: string | number | boolean;
		keyframable: boolean;
		min?: number;
		max?: number;
		step?: number;
		options?: Array<{ value: string; label: string }>;
	}>;
}

export interface AutomationTrackSnapshot {
	trackId: string;
	name: string;
	type: string;
	role: "main" | "overlay" | "audio";
	muted?: boolean;
	hidden?: boolean;
}

export interface AutomationTransitionSnapshot {
	transitionId: string;
	trackId: string;
	fromElementId: string;
	toElementId: string;
	type: ClipTransitionType;
	duration: MediaTime;
	valid: boolean;
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
	transitions: AutomationTransitionSnapshot[];
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

export interface AutomationAudioAnalysisRequest {
	projectId: string;
	expectedRevision: number;
}

export interface AutomationAudioAnalysis {
	integratedLufs: number | null;
	samplePeakDbfs: number | null;
	estimatedTruePeakDbtp: number | null;
	durationSeconds: number;
	channels: number;
	sampleRate: number;
	analyzedBlocks: number;
	minimumGainDb: number;
	maximumGainDb: number;
	affectedElementCount: number;
}

export type AutomationAudioAnalysisResult =
	| {
			status: "analyzed";
			projectId: string;
			revision: number;
			analysis: AutomationAudioAnalysis;
	  }
	| {
			status: "conflict";
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; reason: string };

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
			kind: "adjust_mix_gain";
			gainDb: number;
	  }
	| {
			kind: "upsert_effect";
			trackId: string;
			elementId: string;
			effectId: string;
			effectType: string;
			params?: Record<string, string | number | boolean>;
			enabled?: boolean;
	  }
	| {
			kind: "remove_effect";
			trackId: string;
			elementId: string;
			effectId: string;
	  }
	| {
			kind: "reorder_effects";
			trackId: string;
			elementId: string;
			effectIds: string[];
	  }
	| {
			kind: "upsert_keyframe";
			trackId: string;
			elementId: string;
			propertyPath: string;
			time: MediaTime;
			value: string | number | boolean;
			interpolation?: AnimationInterpolation;
			keyframeId?: string;
	  }
	| {
			kind: "remove_keyframe";
			trackId: string;
			elementId: string;
			propertyPath: string;
			keyframeId: string;
	  }
	| {
			kind: "retime_keyframe";
			trackId: string;
			elementId: string;
			propertyPath: string;
			keyframeId: string;
			time: MediaTime;
	  }
	| {
			kind: "upsert_transition";
			trackId: string;
			transitionId: string;
			fromElementId: string;
			toElementId: string;
			transitionType: ClipTransitionType;
			duration: MediaTime;
	  }
	| {
			kind: "remove_transition";
			trackId: string;
			transitionId: string;
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
