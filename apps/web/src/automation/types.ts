import type { MediaTime } from "@/wasm";
import type { ExportFormat, ExportQuality } from "@/export";
import type { TBackground, TCanvasSize } from "@/project/types";
import type { SubtitleStyleOverrides } from "@/subtitles/types";
import type {
	TranscriptionLanguage,
	TranscriptionModelId,
} from "@/transcription/types";
import type {
	ClipAudioReplacementAttachment,
	ClipMatteAttachment,
	ClipTransitionType,
	RetimeConfig,
	TrackType,
} from "@/timeline";
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
	matte?: AutomationMatteSnapshot;
	audioReplacement?: AutomationAudioReplacementSnapshot;
	reframe?: AutomationReframeSnapshot;
	sourceAudioSeparated?: boolean;
	graphicDefinitionId?: string;
	stickerId?: string;
	stickerIntrinsicWidth?: number;
	stickerIntrinsicHeight?: number;
	effectType?: string;
	masks?: AutomationMaskSnapshot[];
}

export interface AutomationFreeformPathPoint {
	id: string;
	x: number;
	y: number;
	inX: number;
	inY: number;
	outX: number;
	outY: number;
}

export type AutomationMaskParamValue =
	| string
	| number
	| boolean
	| AutomationFreeformPathPoint[];

export interface AutomationMaskSnapshot {
	maskId: string;
	maskType: string;
	params: Record<string, AutomationMaskParamValue>;
}

export interface AutomationNormalizedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AutomationReframeSnapshot {
	mode: "contain" | "cover" | "stretch";
	crop: AutomationNormalizedRect;
	focalPoint: { x: number; y: number };
	targetRect: AutomationNormalizedRect;
}

export type AutomationReframeLayout =
	| "full-frame"
	| "split-left"
	| "split-right"
	| "split-top"
	| "split-bottom"
	| "pip-top-left"
	| "pip-top-right"
	| "pip-bottom-left"
	| "pip-bottom-right";

export interface AutomationMatteSnapshot extends ClipMatteAttachment {
	assetType: "image" | "video" | null;
	width: number | null;
	height: number | null;
	duration: number | null;
	fps: number | null;
	stale: boolean | null;
}

export interface AutomationAudioReplacementSnapshot extends ClipAudioReplacementAttachment {
	assetType: "audio" | null;
	duration: number | null;
	stale: boolean | null;
}

export interface AutomationEffectSnapshot {
	effectId: string;
	effectType: string;
	enabled: boolean;
	params: Record<string, string | number | boolean>;
}

export interface AutomationParamCatalogEntry {
	key: string;
	label: string;
	type: string;
	default: string | number | boolean;
	keyframable: boolean;
	min?: number;
	max?: number;
	step?: number;
	options?: Array<{ value: string; label: string }>;
}

export interface AutomationEffectCatalogEntry {
	effectType: string;
	name: string;
	keywords: string[];
	presets?: Array<{
		id: string;
		name: string;
		params: Record<string, string | number | boolean>;
	}>;
	params: AutomationParamCatalogEntry[];
}

export interface AutomationGraphicCatalogEntry {
	definitionId: string;
	name: string;
	keywords: string[];
	params: AutomationParamCatalogEntry[];
}

export interface AutomationMaskCatalogEntry {
	maskType: string;
	name: string;
	features: {
		hasPosition: boolean;
		hasRotation: boolean;
		sizeMode:
			| "none"
			| "uniform"
			| "width-height"
			| "height-only"
			| "width-only";
	};
	params: AutomationParamCatalogEntry[];
	supportsFreeformPath: boolean;
}

export interface AutomationVisualAssetCatalog {
	graphics: AutomationGraphicCatalogEntry[];
	masks: AutomationMaskCatalogEntry[];
	stickerCategories: Array<{ id: string; name: string }>;
}

export interface AutomationStickerSearchRequest {
	query: string;
	category: "all" | "flags" | "shapes";
	limit: number;
}

export interface AutomationStickerSearchResult {
	items: Array<{
		stickerId: string;
		provider: string;
		name: string;
		previewUrl: string;
		metadata: Record<string, unknown>;
	}>;
	total: number;
	hasMore: boolean;
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
	sourceFingerprint?: string;
	role?: "timeline" | "matte" | "audio-replacement";
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

export interface AutomationAudioSyncRequest {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	reference: { trackId: string; elementId: string };
	target: { trackId: string; elementId: string };
	maxOffsetTicks: MediaTime;
	analysisSampleRate: number;
	maxAnalysisDurationTicks: MediaTime;
	minCorrelation: number;
}

export interface AutomationAudioSyncAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	correlation: number;
	lagTicks: MediaTime;
	previousStartTime: MediaTime;
	startTime: MediaTime;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationAudioSyncResult =
	| AutomationAudioSyncAppliedResult
	| (Omit<AutomationAudioSyncAppliedResult, "status"> & {
			status: "replayed";
	  })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

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

export interface AutomationImportSubtitlesRequest {
	operationId: string;
	projectId: string;
	expectedRevision: number;
	fileName: string;
	input: string;
	contentHash: string;
	style?: SubtitleStyleOverrides;
}

export interface AutomationImportSubtitlesAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	trackId: string;
	elementIds: string[];
	importedCueCount: number;
	skippedCueCount: number;
	warnings: string[];
	snapshot: AutomationProjectSnapshot;
}

export type AutomationImportSubtitlesResult =
	| (Omit<AutomationImportSubtitlesAppliedResult, "status"> & {
			status: "applied" | "replayed";
	  })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

export interface AutomationExportSubtitlesRequest {
	projectId: string;
	expectedRevision: number;
	format: "srt" | "vtt";
	trackIds?: string[];
}

export type AutomationExportSubtitlesResult =
	| {
			status: "serialized";
			revision: number;
			format: "srt" | "vtt";
			trackIds: string[];
			cueCount: number;
			content: string;
	  }
	| {
			status: "conflict";
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; reason: string };

export interface AutomationTranscriptionRequest {
	operationId: string;
	projectId: string;
	expectedRevision: number;
	language: TranscriptionLanguage;
	modelId: TranscriptionModelId;
	wordsPerCaption: number;
	minCaptionDuration: number;
	style?: SubtitleStyleOverrides;
}

export interface AutomationTranscriptionAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	language: string;
	modelId: TranscriptionModelId;
	transcript: string;
	segmentCount: number;
	captionCount: number;
	trackId: string;
	elementIds: string[];
	snapshot: AutomationProjectSnapshot;
}

export type AutomationTranscriptionResult =
	| AutomationTranscriptionAppliedResult
	| (Omit<AutomationTranscriptionAppliedResult, "status"> & {
			status: "replayed";
	  })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

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
			kind: "insert_graphic";
			definitionId: string;
			name?: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			params?: Record<string, string | number | boolean>;
	  }
	| {
			kind: "insert_sticker";
			stickerId: string;
			name?: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			params?: Record<string, string | number | boolean>;
	  }
	| {
			kind: "insert_adjustment_layer";
			effectType: string;
			name?: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			params?: Record<string, string | number | boolean>;
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
			kind: "update_caption";
			trackId: string;
			elementId: string;
			text?: string;
			startTime?: MediaTime;
			duration?: MediaTime;
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
			kind: "set_reframe";
			trackId: string;
			elementId: string;
			mode?: "fit" | "fill" | "contain" | "cover" | "stretch";
			crop?: AutomationNormalizedRect;
			focalPoint?: { x: number; y: number };
			targetRect?: AutomationNormalizedRect;
			layout?: AutomationReframeLayout;
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
			kind: "separate_source_audio";
			trackId: string;
			elementId: string;
	  }
	| {
			kind: "duck_audio";
			trackId: string;
			elementId: string;
			regions: Array<{ startTime: MediaTime; duration: MediaTime }>;
			reductionDb: number;
			attackDuration: MediaTime;
			releaseDuration: MediaTime;
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
	  }
	| {
			kind: "set_matte_state";
			trackId: string;
			elementId: string;
			enabled: boolean;
	  }
	| {
			kind: "remove_matte";
			trackId: string;
			elementId: string;
	  }
	| {
			kind: "set_mask";
			trackId: string;
			elementId: string;
			maskId: string;
			maskType:
				| "split"
				| "cinematic-bars"
				| "rectangle"
				| "ellipse"
				| "heart"
				| "diamond"
				| "star"
				| "text"
				| "freeform";
			params?: Record<string, AutomationMaskParamValue>;
	  }
	| {
			kind: "remove_mask";
			trackId: string;
			elementId: string;
			maskId: string;
	  }
	| {
			kind: "set_audio_replacement_state";
			trackId: string;
			elementId: string;
			enabled: boolean;
	  }
	| {
			kind: "remove_audio_replacement";
			trackId: string;
			elementId: string;
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

export interface AutomationAttachMatteRequest {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	trackId: string;
	elementId: string;
	url: string;
	name: string;
	mimeType: string;
	artifactHash: string;
	artifactFingerprint: string;
	channel: "alpha" | "red";
	modelId: string;
	modelVersion: string;
}

export interface AutomationAttachMatteAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	assetId: string;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationAttachMatteResult =
	| AutomationAttachMatteAppliedResult
	| (Omit<AutomationAttachMatteAppliedResult, "status"> & {
			status: "replayed";
	  })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

export interface AutomationAttachCleanAudioRequest {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	trackId: string;
	elementId: string;
	url: string;
	name: string;
	mimeType: string;
	artifactHash: string;
	artifactFingerprint: string;
	modelId: string;
	modelVersion: string;
}

export interface AutomationAttachCleanAudioAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	assetId: string;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationAttachCleanAudioResult =
	| AutomationAttachCleanAudioAppliedResult
	| (Omit<AutomationAttachCleanAudioAppliedResult, "status"> & {
			status: "replayed";
	  })
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

export interface AutomationTransferSourceRequest {
	projectId: string;
	expectedRevision: number;
	trackId: string;
	elementId: string;
	url: string;
}

export type AutomationTransferSourceResult =
	| {
			status: "transferred";
			revision: number;
			mediaId: string;
			name: string;
			mimeType: string;
			bytesTransferred: number;
			sourceFingerprint: string | null;
	  }
	| {
			status: "conflict";
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; reason: string };

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
	sha256: string;
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
