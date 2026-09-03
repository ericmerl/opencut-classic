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
import type {
	CapabilitySnapshot,
	EditPlanError,
	EditPlanEvaluation,
	ResolvedEditOperation,
	FrameRate,
	FrameRangeSchedule,
	ObjectIdAllocation,
} from "opencut-wasm";
import type {
	AnimationInterpolation,
	ElementKeyframe,
} from "@/animation/types";
import type {
	ProjectContentHashResult,
	ProjectContentProjectionVersion,
} from "./project-content-hash";
import type {
	OperationReceiptAfterState,
	OperationReceiptBinding,
} from "@/services/storage/types";
import type { RenderEnvironmentIdentity } from "@/services/renderer/render-environment";

export interface AutomationElementSnapshot {
	trackId: string;
	elementId: string;
	type: string;
	name: string;
	groupId?: string;
	linkId?: string;
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
	compound?: AutomationCompoundSnapshot;
}

export interface AutomationCompoundSnapshot {
	tracks: AutomationTrackSnapshot[];
	transitions: AutomationTransitionSnapshot[];
	elements: AutomationElementSnapshot[];
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

export type AutomationRelationshipScope = "element" | "group" | "link" | "all";

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
	sourceIdentity?: {
		kind: "local" | "provider";
		contentHash?: { algorithm: "SHA-256"; digest: string };
		provider?: string;
		providerVersion?: string;
		sourceUrl?: string;
	};
}

export interface AutomationProjectSnapshot {
	projectId: string;
	projectName: string;
	projectVersion: number;
	sceneId: string;
	sceneName: string;
	revision: number;
	contentIdentity: ProjectContentHashResult;
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

export interface AutomationReadProjectRequest {
	projectContentProjectionVersion?: ProjectContentProjectionVersion;
}

export interface AutomationContentIdentityBlockedResult {
	status: "content-identity-blocked";
	projectId: string;
	operationId?: string;
	reason: string;
	contentIdentity: Extract<ProjectContentHashResult, { status: "blocked" }>;
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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

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
			contentIdentity: ProjectContentHashResult;
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

export interface AutomationSaveProjectRequest {
	projectId: string;
	sceneId?: string;
	operationId: string;
	expectedRevision: number;
	expectedContentHash?: string;
	bridgeProtocolVersion?: 1 | 2;
}

export interface AutomationSaveReceipt {
	receiptId: string;
	operationId: string;
	projectId: string;
	sceneId: string;
	revision: number;
	contentHash: string;
	contentHashProjectionVersion: ProjectContentProjectionVersion;
	persistedAt: string;
	completedAt: string;
	storageSchemaVersion: number;
	writeVersion: number;
	reloadVerified: true;
	readbackContentHash: string;
}

export type AutomationSaveProjectResult =
	| ({ status: "saved" } & AutomationSaveReceipt)
	| ({ status: "replayed" } & AutomationSaveReceipt)
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
			expectedContentHash?: string;
			actualContentHash?: string | null;
	  }
	| { status: "rejected"; operationId: string; reason: string }
	| {
			status: "verification-failed";
			operationId: string;
			projectId: string;
			reason: string;
			expectedContentHash: string;
			readbackContentHash: string | null;
	  };

export interface AutomationGetSaveReceiptRequest {
	operationId: string;
}

export type AutomationGetSaveReceiptResult =
	| ({ status: "found" } & AutomationSaveReceipt)
	| { status: "not-found"; operationId: string };

export interface AutomationGetOperationReceiptRequest {
	operationId: string;
	binding: OperationReceiptBinding;
}

export type AutomationGetOperationReceiptResult =
	| {
			status: "found";
			operationId: string;
			binding: OperationReceiptBinding;
			afterState: OperationReceiptAfterState;
			result: unknown;
			recordedAt: string;
	  }
	| { status: "not-found" | "contract-mismatch"; operationId: string };

export interface AutomationVerifyOperationReceiptRequest {
	binding: OperationReceiptBinding;
	saveOperationId: string;
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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

export interface AutomationExportSubtitlesRequest {
	projectId: string;
	expectedRevision: number;
	format: "srt" | "vtt";
	trackIds?: string[];
}

export type AutomationExportSubtitlesResult =
	| {
			status: "serialized";
			projectId: string;
			sceneId: string;
			revision: number;
			contentIdentity: ProjectContentHashResult;
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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

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
			elementId?: string | undefined;
			content: string;
			startTime: MediaTime;
			duration: MediaTime;
			autoTrackId?: string | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "insert_graphic";
			elementId?: string | undefined;
			definitionId: string;
			name?: string | undefined;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string | undefined;
			params?: Record<string, string | number | boolean> | undefined;
			autoTrackId?: string | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "insert_sticker";
			elementId?: string | undefined;
			stickerId: string;
			name?: string | undefined;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string | undefined;
			params?: Record<string, string | number | boolean> | undefined;
			autoTrackId?: string | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "insert_adjustment_layer";
			elementId?: string | undefined;
			effectType: string;
			name?: string | undefined;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string | undefined;
			params?: Record<string, string | number | boolean> | undefined;
			autoTrackId?: string | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "add_track";
			trackType: TrackType;
			trackId: string;
	  }
	| {
			kind: "set_track_state";
			trackId: string;
			muted?: boolean | undefined;
			hidden?: boolean | undefined;
	  }
	| {
			kind: "set_project_settings";
			fps?: FrameRate | undefined;
			canvasSize?: TCanvasSize | undefined;
			background?: TBackground | undefined;
	  }
	| {
			kind: "insert_captions";
			trackId?: string | undefined;
			captions: Array<{
				elementId?: string | undefined;
				text: string;
				startTime: MediaTime;
				duration: MediaTime;
				/** Internal browser-resolved layout, pinned by the V2 preflight receipt. */
				resolvedName?: string | undefined;
				resolvedContent?: string | undefined;
				resolvedParams?: Record<string, string | number | boolean> | undefined;
				resolvedLayoutVersion?: string | undefined;
				resolvedLayoutEngine?: string | undefined;
			}>;
			style?: SubtitleStyleOverrides | undefined;
	  }
	| {
			kind: "update_caption";
			trackId: string;
			elementId: string;
			text?: string | undefined;
			startTime?: MediaTime | undefined;
			duration?: MediaTime | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "delete";
			trackId: string;
			elementId: string;
			ripple?: boolean | undefined;
			relationshipScope?: AutomationRelationshipScope | undefined;
	  }
	| {
			kind: "duplicate_elements";
			elements: Array<{ trackId: string; elementId: string }>;
			duplicateIds?: string[] | undefined;
			relationshipScope?: AutomationRelationshipScope | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "create_compound";
			compoundId: string;
			name?: string | undefined;
			elements: Array<{ trackId: string; elementId: string }>;
			relationshipScope?: AutomationRelationshipScope | undefined;
			targetTrackId?: string | undefined;
			autoTrackId?: string | undefined;
			emptyMainTrackId?: string | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "break_apart_compound";
			trackId: string;
			elementId: string;
			restoredElementIds?: string[] | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "set_group";
			groupId: string;
			elements: Array<{ trackId: string; elementId: string }>;
	  }
	| {
			kind: "clear_group";
			groupId: string;
	  }
	| {
			kind: "set_link";
			linkId: string;
			elements: Array<{ trackId: string; elementId: string }>;
	  }
	| {
			kind: "clear_link";
			linkId: string;
	  }
	| {
			kind: "move";
			trackId: string;
			targetTrackId?: string | undefined;
			elementId: string;
			startTime: MediaTime;
			relationshipScope?: AutomationRelationshipScope | undefined;
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
			mode?: "fit" | "fill" | "contain" | "cover" | "stretch" | undefined;
			crop?: AutomationNormalizedRect | undefined;
			focalPoint?: { x: number; y: number } | undefined;
			targetRect?: AutomationNormalizedRect | undefined;
			layout?: AutomationReframeLayout | undefined;
	  }
	| {
			kind: "set_audio";
			trackId: string;
			elementId: string;
			volumeDb?: number | undefined;
			muted?: boolean | undefined;
			fade?:
				| {
						inDuration: MediaTime;
						outDuration: MediaTime;
						floorDb: number;
				  }
				| undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "separate_source_audio";
			trackId: string;
			elementId: string;
			audioTrackId?: string | undefined;
			audioElementId?: string | undefined;
			linkId?: string | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "duck_audio";
			trackId: string;
			elementId: string;
			regions: Array<{ startTime: MediaTime; duration: MediaTime }>;
			reductionDb: number;
			attackDuration: MediaTime;
			releaseDuration: MediaTime;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
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
			params?: Record<string, string | number | boolean> | undefined;
			enabled?: boolean | undefined;
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
			interpolation?: AnimationInterpolation | undefined;
			keyframeId?: string | undefined;
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
			maintainPitch?: boolean | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "trim";
			trackId: string;
			elementId: string;
			startTime?: MediaTime | undefined;
			duration?: MediaTime | undefined;
			trimStart: MediaTime;
			trimEnd: MediaTime;
			ripple?: boolean | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
	  }
	| {
			kind: "split";
			trackId: string;
			elementId: string;
			splitTime: MediaTime;
			rightElementId?: string | undefined;
			retainSide?: "both" | "left" | "right" | undefined;
			ripple?: boolean | undefined;
			resolvedAllocations?: ObjectIdAllocation[] | undefined;
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
			params?: Record<string, AutomationMaskParamValue> | undefined;
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

export interface AutomationConnectionIdentityV2 {
	serverInstanceId: string;
	editorInstanceId: string;
	editorSessionId: string;
	connectionGeneration: number;
}

interface AutomationEditPlanBase<TOperation> {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	expectedProjectContentHash?: string;
	bridgeProtocolVersion?: 1 | 2;
	description: string;
	operations: TOperation[];
}

export type AutomationEditPlanV1 =
	AutomationEditPlanBase<AutomationEditOperation> & {
		contractVersion?: 1;
		bridgeProtocolVersion?: 1;
	};

export type AutomationEditPlanV2 =
	AutomationEditPlanBase<ResolvedEditOperation> & {
		contractVersion: 2;
		bridgeProtocolVersion: 2;
		expectedConnectionIdentity: AutomationConnectionIdentityV2;
		sceneId: string;
		expectedProjectContentHash: string;
		expectedWriteVersion: number;
		saveReceiptOperationId: string;
		expectedSaveReceiptId: string;
		preflight?: {
			preflightId: string;
			receiptId: string;
			evaluation: EditPlanEvaluation;
		};
	};

export type AutomationEditPlan = AutomationEditPlanV1 | AutomationEditPlanV2;

export interface AutomationEditPlanPreflightRequest {
	contractVersion: 2;
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: AutomationConnectionIdentityV2;
	preflightId: string;
	projectId: string;
	sceneId: string;
	expectedRevision: number;
	expectedProjectContentHash: string;
	expectedWriteVersion: number;
	saveReceiptOperationId: string;
	expectedSaveReceiptId: string;
	description: string;
	operations: AutomationEditOperation[];
	policy: {
		warningPolicy: "allow" | "reject-any";
		providerExecution: "forbidden";
		costPolicy: "require-exact" | "allow-bounded" | "allow-unavailable";
	};
	capabilitySnapshot: CapabilitySnapshot;
}

export type AutomationVerifyEditPlanPreflightSourceRequest = Pick<
	AutomationEditPlanPreflightRequest,
	| "bridgeProtocolVersion"
	| "expectedConnectionIdentity"
	| "projectId"
	| "sceneId"
	| "expectedRevision"
	| "expectedProjectContentHash"
	| "expectedWriteVersion"
	| "saveReceiptOperationId"
	| "expectedSaveReceiptId"
>;

export type AutomationVerifyEditPlanPreflightSourceResult =
	| { status: "verified"; observation: AutomationNoMutationObservation }
	| import("./edit-plan-preflight-source").PreflightSourceFailure;

export interface AutomationGetEditPlanPreflightReceiptRequest {
	preflightId: string;
	requestFingerprint: string;
}

export type AutomationGetEditPlanPreflightReceiptResult =
	| {
			status: "found";
			receipt: import("./edit-plan-preflight-receipt").PersistedEditPlanPreflightReceipt;
	  }
	| { status: "not-found" | "mismatched"; preflightId: string };

export interface AutomationNoMutationObservation {
	projectId: string;
	sceneId: string;
	sessionRevision: number;
	canonicalProjectHash: string;
	durableWriteVersion: number;
	saveReceiptId: string;
	saveOperationId: string;
	connectionIdentity: AutomationEditPlanPreflightRequest["expectedConnectionIdentity"] & {
		bridgeProtocolVersion: 2;
	};
	activeProjectId: string;
	activeSceneId: string;
	playheadTicks: MediaTime;
	isPlaying: boolean;
	selectionFingerprint: string;
	historyFingerprint: string;
	persistenceFingerprint: string;
}

export type AutomationEditPlanPreflightResult =
	| {
			status: "validated";
			preflightId: string;
			evaluation: EditPlanEvaluation;
			sourceObservation: AutomationNoMutationObservation;
			noMutationProof: {
				unchanged: true;
				before: AutomationNoMutationObservation;
				after: AutomationNoMutationObservation;
			};
	  }
	| {
			status: "conflict";
			preflightId: string;
			code: "SOURCE_STATE_CONFLICT" | "STATE_CHANGED_DURING_PREFLIGHT";
			reason: string;
	  }
	| {
			status: "rejected";
			preflightId: string;
			code:
				| "PERSISTED_SOURCE_UNAVAILABLE"
				| "PERSISTED_SOURCE_MISMATCH"
				| "SAVE_RECEIPT_MISMATCH"
				| "PREFLIGHT_ID_REUSED";
			reason: string;
	  }
	| {
			status: "rejected";
			preflightId: string;
			code: "NATIVE_EVALUATION_REJECTED";
			reason: string;
			error: EditPlanError;
	  };

export type AutomationResolvedEditOperation = ResolvedEditOperation;

export interface AutomationAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	snapshot: AutomationProjectSnapshot;
	affectedObjects: import("./affected-objects").AutomationAffectedObject[];
}

export type AutomationMutationResult =
	| AutomationAppliedResult
	| {
			status: "replayed";
			operationId: string;
			revision: number;
			snapshot: AutomationProjectSnapshot;
			affectedObjects: import("./affected-objects").AutomationAffectedObject[];
	  }
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| {
			status: "content-hash-conflict";
			code: "CONTENT_HASH_CONFLICT";
			operationId: string;
			projectId: string;
			expectedProjectContentHash: string;
			actualProjectContentHash: string;
	  }
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

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
	| {
			status: "nothing-to-undo";
			revision: number;
			contentIdentity: ProjectContentHashResult;
	  }
	| AutomationContentIdentityBlockedResult;

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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

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
			contentIdentity: ProjectContentHashResult;
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
	canvasSize?: TCanvasSize;
	expectedProjectContentHash?: string;
	bridgeProtocolVersion?: 1 | 2;
	capabilitySnapshotHash?: string;
	wasmSha256?: string;
}

export interface AutomationExportCompletedResult {
	status: "exported";
	operationId: string;
	projectId: string;
	sceneId: string;
	revision: number;
	outputPath: string;
	bytesWritten: number;
	sha256: string;
	contentIdentity: ProjectContentHashResult;
	saveReceiptId: string;
	savedContentHash: string;
	renderEnvironment: RenderEnvironmentIdentity & {
		capabilitySnapshotHash?: string;
		wasmSha256?: string;
	};
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
	| { status: "rejected"; operationId: string; reason: string }
	| AutomationContentIdentityBlockedResult;

export type AutomationPreviewTimeSelector =
	| { kind: "frame-index"; frameIndex: number }
	| {
			kind: "media-time";
			ticks: number;
			rounding: "exact" | "floor" | "nearest" | "ceil";
	  };

export interface AutomationRenderPreviewFrameRequest {
	contractVersion: 2;
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: {
		serverInstanceId: string;
		editorInstanceId: string;
		editorSessionId: string;
		connectionGeneration: number;
	};
	operationId: string;
	projectId: string;
	sceneId: string;
	expectedRevision: number;
	expectedProjectContentHash: string;
	expectedWriteVersion: number;
	saveReceiptOperationId: string;
	expectedSaveReceiptId: string;
	capabilitySnapshotHash?: string;
	wasmSha256?: string;
	time: AutomationPreviewTimeSelector;
	canvasSize: TCanvasSize;
	format: "png";
	url: string;
}

export interface AutomationRenderPreviewFrameCompletedResult {
	status: "rendered" | "replayed";
	contractVersion: 2;
	operationId: string;
	projectId: string;
	sceneId: string;
	revision: number;
	contentIdentity: ProjectContentHashResult;
	writeVersion: number;
	saveReceiptId: string;
	saveReceiptOperationId: string;
	saveReceipt: AutomationSaveReceipt;
	requestedTime: AutomationPreviewTimeSelector;
	requestedTicks: number;
	resolvedTicks: number;
	frameIndex: number;
	fps: FrameRate;
	ticksPerFrame: number;
	rounding: "exact" | "floor" | "nearest" | "ceil";
	width: number;
	height: number;
	mimeType: "image/png";
	bytesWritten: number;
	sha256: string;
	pixelRgbaSha256: string;
	colorSpace: "srgb";
	alphaMode: "straight";
	fontReadiness: {
		status: "ready";
		families: string[];
		descriptors: Array<{
			family: string;
			style: string;
			weight: string;
			stretch: string;
			css: string;
			identitySha256: string;
			matchedFaceIdentities: string[];
			matchedFaces: Array<{
				provenance: "font-face-set" | "system-local-font-face";
				family: string;
				style: string;
				weight: string;
				stretch: string;
				unicodeRange: string;
				featureSettings: string;
				display: string;
				identitySha256: string;
			}>;
		}>;
		descriptorsSha256: string;
	};
	sourceVerification: {
		revisionBefore: number;
		revisionAfter: number;
		contentHashBefore: string;
		contentHashAfter: string;
	};
	renderer: {
		provider: "opencut-web-renderer";
		pipeline: "editor-native-exact-frame";
		compositor: "opencut-wasm-webgl";
		browser: string;
		encoder: "browser-canvas-png";
		environment: RenderEnvironmentIdentity & {
			capabilitySnapshotHash?: string;
			wasmSha256?: string;
		};
		executionIdentity: AutomationRenderPreviewFrameRequest["expectedConnectionIdentity"];
	};
	editorState: {
		unchanged: true;
		playheadTicks: number;
		isPlaying: boolean;
		selectionFingerprint: string;
		canUndo: boolean;
		canRedo: boolean;
	};
}

export type AutomationRenderPreviewFrameResult =
	| AutomationRenderPreviewFrameCompletedResult
	| {
			status: "conflict" | "rejected";
			operationId: string;
			code:
				| "SOURCE_CONFLICT"
				| "SAVE_RECEIPT_CONFLICT"
				| "TIME_OUT_OF_BOUNDS"
				| "TIME_ALIGNMENT_REQUIRED"
				| "UNSUPPORTED_FRAME_RATE"
				| "FONT_READINESS_FAILED"
				| "RENDERER_FAILED";
			reason: string;
	  };

export type AutomationPreviewRangeSelector =
	| { kind: "media-time"; startTicks: number; endTicksExclusive: number }
	| {
			kind: "frame-index";
			startFrameIndex: number;
			endFrameIndexExclusive: number;
	  };

export interface AutomationRenderPreviewRangeRequest {
	contractVersion: 1;
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: AutomationRenderPreviewFrameRequest["expectedConnectionIdentity"];
	operationId: string;
	projectId: string;
	sceneId: string;
	expectedRevision: number;
	expectedProjectContentHash: string;
	expectedWriteVersion: number;
	saveReceiptOperationId: string;
	expectedSaveReceiptId: string;
	range: AutomationPreviewRangeSelector;
	canvasSize: TCanvasSize;
	output: { kind: "frame-sequence"; frameFormat: "png"; includeAudio: boolean };
	baseUrl: string;
	limits: { maxDurationTicks: number; maxFrames: number };
	capabilitySnapshotHash: string;
	wasmSha256?: string;
}

export type AutomationRenderPreviewRangeResult =
	| {
			status: "rendered" | "cancelled";
			contractVersion: 1;
			operationId: string;
			projectId: string;
			sceneId: string;
			revision: number;
			contentIdentity: ProjectContentHashResult;
			writeVersion: number;
			saveReceiptId: string;
			saveReceiptOperationId: string;
			saveReceipt: AutomationSaveReceipt;
			capabilitySnapshotHash: string;
			schedule: FrameRangeSchedule;
			fontReadiness: AutomationRenderPreviewFrameCompletedResult["fontReadiness"];
			sourceVerification: AutomationRenderPreviewFrameCompletedResult["sourceVerification"];
			renderer: Omit<
				AutomationRenderPreviewFrameCompletedResult["renderer"],
				"pipeline" | "encoder"
			> & {
				pipeline: "editor-native-exact-frame-sequence";
				encoder: "browser-canvas-png-sequence";
			};
			editorState: AutomationRenderPreviewFrameCompletedResult["editorState"];
	  }
	| {
			status: "conflict" | "rejected";
			operationId: string;
			code:
				| "SOURCE_CONFLICT"
				| "SAVE_RECEIPT_CONFLICT"
				| "TIME_OUT_OF_BOUNDS"
				| "INVALID_RANGE"
				| "EMPTY_RANGE"
				| "RANGE_DURATION_LIMIT_EXCEEDED"
				| "RANGE_FRAME_LIMIT_EXCEEDED"
				| "UNSUPPORTED_FRAME_RATE"
				| "ARITHMETIC_OVERFLOW"
				| "FONT_READINESS_FAILED"
				| "RENDERER_FAILED";
			reason: string;
	  };

export interface AutomationComparisonSourceBinding {
	revision: number;
	projectContentHash: string;
	projectionName: "opencut-project-content";
	projectionVersion: 1 | 2;
	writeVersion: number;
	saveReceiptOperationId: string;
	saveReceiptId: string;
}

export interface AutomationCompareProjectStatesRequest {
	contractVersion: 1;
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: AutomationRenderPreviewFrameRequest["expectedConnectionIdentity"];
	operationId: string;
	projectId: string;
	sceneId: string;
	before: AutomationComparisonSourceBinding;
	after: AutomationComparisonSourceBinding;
	range: AutomationPreviewRangeSelector;
	canvasSize: TCanvasSize;
	normalization: {
		canvas: "none";
		color: "none";
		fonts: "exact";
		timing: "shared-schedule";
	};
	output: {
		frameFormat: "png";
		comparison: "side-by-side" | "wipe";
		wipePosition?: number;
		includeAudio: boolean;
	};
	pixelTolerance: number;
	audioSampleTolerance: number;
	beforeBaseUrl: string;
	afterBaseUrl: string;
	limits: { maxDurationTicks: number; maxFrames: number };
	capabilitySnapshotHash: string;
	wasmSha256?: string;
}

export type AutomationCompareProjectStatesResult =
	| {
			status: "rendered" | "cancelled";
			contractVersion: 1;
			operationId: string;
			projectId: string;
			sceneId: string;
			revision: number;
			contentHash: string;
			contentHashProjectionVersion: 1 | 2;
			capabilitySnapshotHash: string;
			normalization: AutomationCompareProjectStatesRequest["normalization"];
			schedule: FrameRangeSchedule;
			before: AutomationComparisonSideEvidence;
			after: AutomationComparisonSideEvidence;
			renderer: {
				provider: "opencut-web-renderer";
				pipeline: "editor-native-before-after-comparison";
				compositor: "opencut-wasm-webgl";
				browser: string;
				encoder: "browser-canvas-png-sequence";
				environment: Record<string, unknown>;
				executionIdentity: AutomationRenderPreviewFrameRequest["expectedConnectionIdentity"];
			};
			editorState: AutomationRenderPreviewFrameCompletedResult["editorState"];
	  }
	| {
			status: "conflict" | "rejected";
			operationId: string;
			code: string;
			reason: string;
	  };

export interface AutomationComparisonSideEvidence {
	projectId: string;
	sceneId: string;
	binding: AutomationComparisonSourceBinding;
	schedule: FrameRangeSchedule;
	renderSource: {
		canvas: TCanvasSize;
		rate: { numerator: number; denominator: number };
		sceneDurationTicks: number;
		rendererSettingsDigest: string;
	};
	fontReadiness: AutomationRenderPreviewFrameCompletedResult["fontReadiness"] & {
		substituted: false;
	};
	saveReceipt: AutomationSaveReceipt;
	sourceVerification: {
		retainedSnapshot: true;
		expiresAt: string;
		mediaSha256: string[];
	};
}
