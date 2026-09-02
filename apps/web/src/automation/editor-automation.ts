import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import {
	AddTrackCommand,
	DeleteElementsCommand,
	DuplicateElementsCommand,
	InsertElementCommand,
	MoveElementCommand,
	SplitElementsCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	UpdateElementsCommand,
} from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import {
	collectAudioElements,
	createAudioContext,
	decodeAudioToFloat32,
} from "@/media/audio";
import { extractTimelineAudio } from "@/media/mediabunny";
import { coerceParamValue } from "@/params";
import {
	buildElementParamValues,
	getElementParam,
	writeElementParamValue,
} from "@/params/registry";
import {
	getTrackTransitionStates,
	isRetimableElement,
	type TimelineElement,
	type TimelineTrack,
} from "@/timeline";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { DEFAULTS } from "@/timeline/defaults";
import {
	buildElementFromMedia,
	buildTextElement,
} from "@/timeline/element-utils";
import {
	buildConstantRetime,
	MAX_RETIME_RATE,
	MIN_RETIME_RATE,
} from "@/retime";
import { DEFAULT_CANVAS_PRESETS } from "@/canvas/sizes";
import type { TProjectSettings } from "@/project/types";
import { buildSubtitleTextElement } from "@/subtitles/build-subtitle-text-element";
import { buildCaptionTrackInsertion } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { serializeSubtitles } from "@/subtitles/serialize";
import type { SubtitleCue, SubtitleStyleOverrides } from "@/subtitles/types";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { buildCaptionChunks } from "@/transcription/caption";
import { transcriptionService } from "@/services/transcription/service";
import {
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	TICKS_PER_SECOND,
} from "@/wasm";
import { getElementKeyframes } from "@/animation";
import { analyzeAutomationAudio } from "./audio-analysis";
import { prepareCleanAudioAttachment } from "./attach-clean-audio";
import { prepareMatteAttachment } from "./attach-matte";
import { buildAudioControlPatch } from "./audio-control";
import { buildAudioMixGainCommand } from "./audio-mix-gain";
import { buildSourceAudioSeparationCommand } from "./source-audio-control";
import { buildAudioDuckingPatch } from "./audio-ducking";
import {
	buildAudioEnvelope,
	findBestAudioLag,
	synchronizedTargetStart,
} from "./audio-sync";
import { buildCaptionCorrectionCommand } from "./caption-control";
import { buildEffectControlCommand, listEffectCatalog } from "./effect-control";
import { buildKeyframeCommand } from "./keyframe-control";
import {
	buildAudioReplacementControlCommand,
	buildAudioReplacementSnapshot,
	findAudioCapableElement,
} from "./audio-replacement-control";
import { buildMatteControlCommand, buildMatteSnapshot } from "./matte-control";
import {
	buildReframeControlCommand,
	buildReframeSnapshot,
} from "./reframe-control";
import { buildTransitionCommand } from "./transition-control";
import { withRipple } from "./ripple-control";
import {
	buildRelationshipControlCommand,
	buildRelationshipMoves,
	deferRelationshipCommand,
	expandElementRelationships,
} from "./relationship-control";
import { buildAuthoredMaskCommand } from "./authored-mask-control";
import {
	buildDefinitionParamPatch,
	buildVisualInsertionCommand,
} from "./visual-element-control";
import {
	listVisualAssetCatalog,
	searchAutomationStickers,
} from "./visual-asset-catalog";
import {
	buildTrimPatch,
	getElementSourceDuration,
	validateTrackCreationPlan,
} from "./timeline-surgery";
import {
	queryTimelineSnapshot,
	type AutomationTimelineQueryRequest,
	type AutomationTimelineQueryResult,
} from "./timeline-query";
import type {
	AutomationAudioAnalysisRequest,
	AutomationAudioAnalysisResult,
	AutomationAudioSyncAppliedResult,
	AutomationAudioSyncRequest,
	AutomationAudioSyncResult,
	AutomationAttachCleanAudioAppliedResult,
	AutomationAttachCleanAudioRequest,
	AutomationAttachCleanAudioResult,
	AutomationAttachMatteAppliedResult,
	AutomationAttachMatteRequest,
	AutomationAttachMatteResult,
	AutomationEditOperation,
	AutomationEditPlan,
	AutomationElementSnapshot,
	AutomationEffectCatalogEntry,
	AutomationStickerSearchRequest,
	AutomationStickerSearchResult,
	AutomationVisualAssetCatalog,
	AutomationCreateProjectRequest,
	AutomationCreateProjectResult,
	AutomationExportCompletedResult,
	AutomationExportRequest,
	AutomationExportResult,
	AutomationImportAppliedResult,
	AutomationImportRequest,
	AutomationImportResult,
	AutomationImportSubtitlesAppliedResult,
	AutomationImportSubtitlesRequest,
	AutomationImportSubtitlesResult,
	AutomationExportSubtitlesRequest,
	AutomationExportSubtitlesResult,
	AutomationAppliedResult,
	AutomationMutationResult,
	AutomationOpenProjectRequest,
	AutomationOpenProjectResult,
	AutomationProjectActivatedResult,
	AutomationProjectListResult,
	AutomationProjectSnapshot,
	AutomationTransferSourceRequest,
	AutomationTransferSourceResult,
	AutomationTranscriptionAppliedResult,
	AutomationTranscriptionRequest,
	AutomationTranscriptionResult,
	AutomationUndoResult,
} from "./types";

interface AppliedOperation {
	fingerprint: string;
	result: AutomationAppliedResult;
}

export class EditorAutomation {
	private revision = 0;
	private stateFingerprint = "";
	private appliedOperations = new Map<string, AppliedOperation>();
	private importedOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationImportAppliedResult }
	>();
	private importedSubtitleOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationImportSubtitlesAppliedResult }
	>();
	private transcriptionOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationTranscriptionAppliedResult }
	>();
	private audioSyncOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationAudioSyncAppliedResult }
	>();
	private exportedOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationExportCompletedResult }
	>();
	private attachedMatteOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationAttachMatteAppliedResult }
	>();
	private attachedCleanAudioOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationAttachCleanAudioAppliedResult }
	>();
	private projectOperations = new Map<
		string,
		{
			fingerprint: string;
			result: AutomationProjectActivatedResult & {
				status: "created" | "opened";
			};
		}
	>();
	private writer: Promise<void> = Promise.resolve();

	constructor(private editor: EditorCore) {}

	readProject(): AutomationProjectSnapshot {
		this.reconcileExternalChanges();
		return this.buildSnapshot();
	}

	queryTimeline(
		request: AutomationTimelineQueryRequest,
	): AutomationTimelineQueryResult {
		this.reconcileExternalChanges();
		return queryTimelineSnapshot({ snapshot: this.buildSnapshot(), request });
	}

	listEffects(): AutomationEffectCatalogEntry[] {
		return listEffectCatalog();
	}

	listVisualAssets(): AutomationVisualAssetCatalog {
		return listVisualAssetCatalog();
	}

	searchStickers(
		request: AutomationStickerSearchRequest,
	): Promise<AutomationStickerSearchResult> {
		return this.enqueue(() => searchAutomationStickers(request));
	}

	analyzeAudio(
		request: AutomationAudioAnalysisRequest,
	): Promise<AutomationAudioAnalysisResult> {
		return this.enqueue(() => {
			this.reconcileExternalChanges();
			return analyzeAutomationAudio({
				editor: this.editor,
				request,
				revision: this.revision,
			});
		});
	}

	syncAudio(
		request: AutomationAudioSyncRequest,
	): Promise<AutomationAudioSyncResult> {
		return this.enqueue(() => this.syncAudioNow(request));
	}

	listProjects(): Promise<AutomationProjectListResult> {
		return this.enqueue(() => this.listProjectsNow());
	}

	createProject(
		request: AutomationCreateProjectRequest,
	): Promise<AutomationCreateProjectResult> {
		return this.enqueue(() => this.createProjectNow(request));
	}

	openProject(
		request: AutomationOpenProjectRequest,
	): Promise<AutomationOpenProjectResult> {
		return this.enqueue(() => this.openProjectNow(request));
	}

	applyEditPlan(plan: AutomationEditPlan): Promise<AutomationMutationResult> {
		return this.enqueue(() => this.applyEditPlanNow(plan));
	}

	importMedia(
		request: AutomationImportRequest,
	): Promise<AutomationImportResult> {
		return this.enqueue(() => this.importMediaNow(request));
	}

	importSubtitles(
		request: AutomationImportSubtitlesRequest,
	): Promise<AutomationImportSubtitlesResult> {
		return this.enqueue(() => this.importSubtitlesNow(request));
	}

	exportSubtitles(
		request: AutomationExportSubtitlesRequest,
	): Promise<AutomationExportSubtitlesResult> {
		return this.enqueue(() => this.exportSubtitlesNow(request));
	}

	transcribeTimeline(
		request: AutomationTranscriptionRequest,
	): Promise<AutomationTranscriptionResult> {
		return this.enqueue(() => this.transcribeTimelineNow(request));
	}

	attachMatte(
		request: AutomationAttachMatteRequest,
	): Promise<AutomationAttachMatteResult> {
		return this.enqueue(() => this.attachMatteNow(request));
	}

	attachCleanAudio(
		request: AutomationAttachCleanAudioRequest,
	): Promise<AutomationAttachCleanAudioResult> {
		return this.enqueue(() => this.attachCleanAudioNow(request));
	}

	transferSourceMedia(
		request: AutomationTransferSourceRequest,
	): Promise<AutomationTransferSourceResult> {
		return this.enqueue(() => this.transferSourceMediaNow(request));
	}

	exportProject(
		request: AutomationExportRequest,
	): Promise<AutomationExportResult> {
		return this.enqueue(() => this.exportProjectNow(request));
	}

	undo({
		projectId,
		expectedRevision,
	}: {
		projectId: string;
		expectedRevision: number;
	}): Promise<AutomationUndoResult> {
		return this.enqueue(() => this.undoNow({ projectId, expectedRevision }));
	}

	private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
		const result = this.writer.then(work);
		this.writer = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async listProjectsNow(): Promise<AutomationProjectListResult> {
		await this.editor.project.loadAllProjects();
		const activeProjectId =
			this.editor.project.getActiveOrNull()?.metadata.id ?? null;
		const projects = this.editor.project
			.getSavedProjects()
			.map((project) => ({
				projectId: project.id,
				name: project.name,
				duration: project.duration,
				createdAt: project.createdAt.toISOString(),
				updatedAt: project.updatedAt.toISOString(),
				isActive: project.id === activeProjectId,
			}))
			.sort(
				(left, right) =>
					right.updatedAt.localeCompare(left.updatedAt) ||
					left.projectId.localeCompare(right.projectId),
			);
		return { activeProjectId, projects };
	}

	private async createProjectNow(
		request: AutomationCreateProjectRequest,
	): Promise<AutomationCreateProjectResult> {
		const fingerprint = stableSerialize({ method: "create_project", request });
		const prior = this.projectOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: "operationId was already used for a different project create",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		const name = request.name.trim();
		if (!request.operationId.trim()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "operationId is required",
			};
		}
		if (!name) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "project name is required",
			};
		}

		await this.editor.save.flush();
		const projectId = await this.editor.project.createNewProject({ name });
		this.resetProjectSession();
		const result: AutomationProjectActivatedResult & { status: "created" } = {
			status: "created",
			operationId: request.operationId,
			projectId,
			editorPath: `/editor/${projectId}`,
			revision: this.revision,
			snapshot: this.buildSnapshot(),
		};
		this.projectOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private async openProjectNow(
		request: AutomationOpenProjectRequest,
	): Promise<AutomationOpenProjectResult> {
		const fingerprint = stableSerialize({ method: "open_project", request });
		const prior = this.projectOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: "operationId was already used for a different project open",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (!request.operationId.trim()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "operationId is required",
			};
		}
		if (!request.projectId.trim()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "projectId is required",
			};
		}

		const activeProjectId =
			this.editor.project.getActiveOrNull()?.metadata.id ?? null;
		if (activeProjectId !== request.projectId) {
			await this.editor.project.loadAllProjects();
			const projectExists = this.editor.project
				.getSavedProjects()
				.some((project) => project.id === request.projectId);
			if (!projectExists) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: `project not found: ${request.projectId}`,
				};
			}
			await this.editor.save.flush();
			await this.editor.project.loadProject({ id: request.projectId });
			this.resetProjectSession();
		} else {
			this.reconcileExternalChanges();
		}

		const result: AutomationProjectActivatedResult & { status: "opened" } = {
			status: "opened",
			operationId: request.operationId,
			projectId: request.projectId,
			editorPath: `/editor/${request.projectId}`,
			revision: this.revision,
			snapshot: this.buildSnapshot(),
		};
		this.projectOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private async applyEditPlanNow(
		plan: AutomationEditPlan,
	): Promise<AutomationMutationResult> {
		this.reconcileExternalChanges();
		const shapeError = validatePlanShape(plan);
		if (shapeError) {
			return {
				status: "rejected",
				operationId: plan.operationId,
				reason: shapeError,
			};
		}

		const fingerprint = stableSerialize(plan);
		const prior = this.appliedOperations.get(plan.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: plan.operationId,
					reason: "operationId was already used for a different plan",
				};
			}
			return { ...prior.result, status: "replayed" };
		}

		const activeProjectId = this.getProjectId();
		if (plan.projectId !== activeProjectId) {
			return {
				status: "rejected",
				operationId: plan.operationId,
				reason: `active project is ${activeProjectId}`,
			};
		}
		if (plan.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: plan.operationId,
				expectedRevision: plan.expectedRevision,
				actualRevision: this.revision,
			};
		}

		let commands: Command[];
		try {
			validateTrackCreationPlan(plan.operations);
			commands = plan.operations.map((operation) =>
				this.validateAndBuildCommand(operation),
			);
		} catch (error) {
			return {
				status: "rejected",
				operationId: plan.operationId,
				reason: error instanceof Error ? error.message : "invalid edit plan",
			};
		}
		this.editor.command.execute({
			command: new BatchCommand(commands),
		});
		await this.editor.save.flush();
		this.recordCommittedState();

		const result: AutomationAppliedResult = {
			status: "applied",
			operationId: plan.operationId,
			revision: this.revision,
			snapshot: this.buildSnapshot(),
		};
		this.appliedOperations.set(plan.operationId, { fingerprint, result });
		return result;
	}

	private async undoNow({
		projectId,
		expectedRevision,
	}: {
		projectId: string;
		expectedRevision: number;
	}): Promise<AutomationUndoResult> {
		this.reconcileExternalChanges();
		if (projectId !== this.getProjectId()) {
			throw new Error(`active project is ${this.getProjectId()}`);
		}
		if (expectedRevision !== this.revision) {
			return {
				status: "conflict",
				expectedRevision,
				actualRevision: this.revision,
			};
		}
		if (!this.editor.command.canUndo()) {
			return { status: "nothing-to-undo", revision: this.revision };
		}

		this.editor.command.undo();
		await this.editor.save.flush();
		this.recordCommittedState();
		return {
			status: "undone",
			revision: this.revision,
			snapshot: this.buildSnapshot(),
		};
	}

	private async importMediaNow(
		request: AutomationImportRequest,
	): Promise<AutomationImportResult> {
		this.reconcileExternalChanges();
		const { url: _transferUrl, ...stableRequest } = request;
		const fingerprint = stableSerialize(stableRequest);
		const prior = this.importedOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: "operationId was already used for a different import",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}
		assertMediaTime(request.startTime, "startTime", true);
		const requestedTrack = request.trackId
			? this.getTracks().find((track) => track.id === request.trackId)
			: undefined;
		if (request.trackId && !requestedTrack) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `track not found: ${request.trackId}`,
			};
		}

		const response = await fetch(request.url);
		if (!response.ok)
			throw new Error(`media transfer failed with HTTP ${response.status}`);
		const blob = await response.blob();
		const file = new File([blob], request.name, { type: request.mimeType });
		const [asset] = await processMediaAssets({ files: [file] });
		if (!asset) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "OpenCut could not process the media file",
			};
		}
		const requiredTrackType = asset.type === "audio" ? "audio" : "video";
		if (requestedTrack && requestedTrack.type !== requiredTrackType) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `${asset.type} media cannot be placed on ${requestedTrack.type} tracks`,
			};
		}

		const addMedia = new AddMediaAssetCommand({
			projectId: request.projectId,
			asset: { ...asset, sourceFingerprint: request.sourceFingerprint },
			ratchetProjectFps: request.adoptMediaSettings ?? false,
		});
		const duration =
			asset.duration == null
				? DEFAULT_NEW_ELEMENT_DURATION
				: mediaTimeFromSeconds({ seconds: asset.duration });
		const insert = new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: addMedia.getAssetId(),
				mediaType: asset.type,
				name: asset.name,
				duration,
				startTime: request.startTime,
				buffer:
					asset.type === "audio"
						? new AudioBuffer({ length: 1, sampleRate: 44100 })
						: undefined,
			}),
			adoptMediaSettings: request.adoptMediaSettings ?? false,
			placement: request.trackId
				? { mode: "explicit", trackId: request.trackId }
				: {
						mode: "auto",
						trackType: asset.type === "audio" ? "audio" : "video",
					},
		});
		this.editor.command.execute({
			command: new BatchCommand([addMedia, insert]),
		});
		await addMedia.waitForPersistence();
		await this.editor.save.flush();
		this.recordCommittedState();

		const result: AutomationImportAppliedResult = {
			status: "applied",
			operationId: request.operationId,
			revision: this.revision,
			assetId: addMedia.getAssetId(),
			elementId: insert.getElementId(),
			snapshot: this.buildSnapshot(),
		};
		this.importedOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private async importSubtitlesNow(
		request: AutomationImportSubtitlesRequest,
	): Promise<AutomationImportSubtitlesResult> {
		this.reconcileExternalChanges();
		const { input: _input, ...stableRequest } = request;
		const fingerprint = stableSerialize(stableRequest);
		const prior = this.importedSubtitleOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason:
						"operationId was already used for a different subtitle import",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		let parsed;
		try {
			parsed = parseSubtitleFile({
				fileName: request.fileName,
				input: request.input,
			});
		} catch (error) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason:
					error instanceof Error ? error.message : "subtitle parsing failed",
			};
		}
		const captions = parsed.captions.map((caption) => ({
			...caption,
			style: mergeSubtitleStyles({
				base: caption.style,
				overrides: request.style,
			}),
		}));
		const insertion = buildCaptionTrackInsertion({
			editor: this.editor,
			captions,
		});
		if (!insertion) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "No valid subtitle cues were found in the subtitle file",
			};
		}

		this.editor.command.execute({ command: insertion.command });
		await this.editor.save.flush();
		this.recordCommittedState();
		const result: AutomationImportSubtitlesAppliedResult = {
			status: "applied",
			operationId: request.operationId,
			revision: this.revision,
			trackId: insertion.trackId,
			elementIds: insertion.elementIds,
			importedCueCount: captions.length,
			skippedCueCount: parsed.skippedCueCount,
			warnings: parsed.warnings,
			snapshot: this.buildSnapshot(),
		};
		this.importedSubtitleOperations.set(request.operationId, {
			fingerprint,
			result,
		});
		return result;
	}

	private exportSubtitlesNow(
		request: AutomationExportSubtitlesRequest,
	): AutomationExportSubtitlesResult {
		this.reconcileExternalChanges();
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		const requestedIds = request.trackIds ? new Set(request.trackIds) : null;
		const tracks = this.getTracks().filter(
			(track) =>
				track.type === "text" && (!requestedIds || requestedIds.has(track.id)),
		);
		if (requestedIds) {
			for (const trackId of requestedIds) {
				if (!tracks.some((track) => track.id === trackId)) {
					return {
						status: "rejected",
						reason: `text track not found: ${trackId}`,
					};
				}
			}
		}

		const captions: SubtitleCue[] = tracks
			.flatMap((track) =>
				track.elements
					.filter((element) => element.type === "text")
					.map((element) => ({
						text: String(element.params.content ?? "").trim(),
						startTime: mediaTimeToSeconds({ time: element.startTime }),
						duration: mediaTimeToSeconds({ time: element.duration }),
					})),
			)
			.filter((caption) => caption.text && caption.duration > 0)
			.sort(
				(left, right) =>
					left.startTime - right.startTime ||
					left.text.localeCompare(right.text),
			);
		if (captions.length === 0) {
			return { status: "rejected", reason: "No caption cues were found" };
		}

		return {
			status: "serialized",
			revision: this.revision,
			format: request.format,
			trackIds: tracks.map((track) => track.id),
			cueCount: captions.length,
			content: serializeSubtitles({ captions, format: request.format }),
		};
	}

	private async transcribeTimelineNow(
		request: AutomationTranscriptionRequest,
	): Promise<AutomationTranscriptionResult> {
		this.reconcileExternalChanges();
		const fingerprint = stableSerialize(request);
		const prior = this.transcriptionOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: "operationId was already used for a different transcription",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		try {
			const audioBlob = await extractTimelineAudio({
				tracks: this.editor.scenes.getActiveScene().tracks,
				mediaAssets: this.editor.media.getAssets(),
				totalDuration: this.editor.timeline.getTotalDuration(),
			});
			const { samples } = await decodeAudioToFloat32({
				audioBlob,
				sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
			});
			const transcription = await transcriptionService.transcribe({
				audioData: samples,
				language: request.language === "auto" ? undefined : request.language,
				modelId: request.modelId,
			});
			const captions = buildCaptionChunks({
				segments: transcription.segments,
				wordsPerChunk: request.wordsPerCaption,
				minDuration: request.minCaptionDuration,
			}).map((caption) => ({ ...caption, style: request.style }));
			const insertion = buildCaptionTrackInsertion({
				editor: this.editor,
				captions,
			});
			if (!insertion) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: "Transcription produced no caption cues",
				};
			}

			this.editor.command.execute({ command: insertion.command });
			await this.editor.save.flush();
			this.recordCommittedState();
			const result: AutomationTranscriptionAppliedResult = {
				status: "applied",
				operationId: request.operationId,
				revision: this.revision,
				language: transcription.language,
				modelId: request.modelId,
				transcript: transcription.text,
				segmentCount: transcription.segments.length,
				captionCount: captions.length,
				trackId: insertion.trackId,
				elementIds: insertion.elementIds,
				snapshot: this.buildSnapshot(),
			};
			this.transcriptionOperations.set(request.operationId, {
				fingerprint,
				result,
			});
			return result;
		} catch (error) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason:
					error instanceof Error
						? error.message
						: "timeline transcription failed",
			};
		}
	}

	private async syncAudioNow(
		request: AutomationAudioSyncRequest,
	): Promise<AutomationAudioSyncResult> {
		this.reconcileExternalChanges();
		const fingerprint = stableSerialize(request);
		const prior = this.audioSyncOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason:
						"operationId was already used for different audio synchronization",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}
		if (
			request.reference.trackId === request.target.trackId &&
			request.reference.elementId === request.target.elementId
		) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "reference and target audio elements must differ",
			};
		}

		const reference = this.findElement(
			request.reference.trackId,
			request.reference.elementId,
		);
		const target = this.findElement(
			request.target.trackId,
			request.target.elementId,
		);
		if (
			!reference ||
			(reference.type !== "audio" && reference.type !== "video")
		) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "reference must identify a video or audio element",
			};
		}
		if (!target || (target.type !== "audio" && target.type !== "video")) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: "target must identify a video or audio element",
			};
		}

		const context = createAudioContext();
		try {
			const decoded = await collectAudioElements({
				tracks: this.editor.scenes.getActiveScene().tracks,
				mediaAssets: this.editor.media.getAssets(),
				audioContext: context,
			});
			const referenceAudio = decoded.find(
				(item) => item.timelineElement.id === reference.id,
			);
			const targetAudio = decoded.find(
				(item) => item.timelineElement.id === target.id,
			);
			if (!referenceAudio || !targetAudio) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason:
						"selected elements do not both contain decodable enabled audio",
				};
			}
			const maxDuration = request.maxAnalysisDurationTicks / TICKS_PER_SECOND;
			const referenceEnvelope = buildAudioEnvelope({
				buffer: referenceAudio.buffer,
				trimStart: referenceAudio.trimStart,
				clipDuration: referenceAudio.duration,
				retime: referenceAudio.retime,
				analysisSampleRate: request.analysisSampleRate,
				maxDuration,
			});
			const targetEnvelope = buildAudioEnvelope({
				buffer: targetAudio.buffer,
				trimStart: targetAudio.trimStart,
				clipDuration: targetAudio.duration,
				retime: targetAudio.retime,
				analysisSampleRate: request.analysisSampleRate,
				maxDuration,
			});
			const minimumLength = Math.min(
				referenceEnvelope.length,
				targetEnvelope.length,
			);
			const correlation = findBestAudioLag({
				reference: referenceEnvelope,
				target: targetEnvelope,
				maxLagSamples: Math.round(
					(request.maxOffsetTicks / TICKS_PER_SECOND) *
						request.analysisSampleRate,
				),
				minOverlapSamples: Math.max(
					20,
					Math.min(
						request.analysisSampleRate * 2,
						Math.floor(minimumLength * 0.25),
					),
				),
			});
			if (correlation.score < request.minCorrelation) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: `best audio correlation ${correlation.score.toFixed(3)} is below ${request.minCorrelation.toFixed(3)}`,
				};
			}
			const startTime = synchronizedTargetStart({
				referenceStart: reference.startTime,
				lagSamples: correlation.lagSamples,
				analysisSampleRate: request.analysisSampleRate,
				ticksPerSecond: TICKS_PER_SECOND,
			});
			if (startTime < 0) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: `audio alignment requires a negative target start time: ${startTime}`,
				};
			}
			this.editor.command.execute({
				command: new MoveElementCommand({
					moves: [
						{
							sourceTrackId: request.target.trackId,
							targetTrackId: request.target.trackId,
							elementId: target.id,
							newStartTime: mediaTime({ ticks: startTime }),
						},
					],
				}),
			});
			await this.editor.save.flush();
			this.recordCommittedState();
			const lagTicks = mediaTime({
				ticks: Math.round(
					(correlation.lagSamples / request.analysisSampleRate) *
						TICKS_PER_SECOND,
				),
			});
			const result: AutomationAudioSyncAppliedResult = {
				status: "applied",
				operationId: request.operationId,
				revision: this.revision,
				correlation: correlation.score,
				lagTicks,
				previousStartTime: target.startTime,
				startTime: mediaTime({ ticks: startTime }),
				snapshot: this.buildSnapshot(),
			};
			this.audioSyncOperations.set(request.operationId, {
				fingerprint,
				result,
			});
			return result;
		} catch (error) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason:
					error instanceof Error
						? error.message
						: "audio synchronization failed",
			};
		} finally {
			await context.close();
		}
	}

	private async attachMatteNow(
		request: AutomationAttachMatteRequest,
	): Promise<AutomationAttachMatteResult> {
		this.reconcileExternalChanges();
		const { url: _transferUrl, ...stableRequest } = request;
		const fingerprint = stableSerialize(stableRequest);
		const prior = this.attachedMatteOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason:
						"operationId was already used for a different matte attachment",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		try {
			const prepared = await prepareMatteAttachment({
				editor: this.editor,
				request,
			});
			this.editor.command.execute({ command: prepared.command });
			await prepared.addMedia.waitForPersistence();
			await this.editor.save.flush();
			this.recordCommittedState();
			const result: AutomationAttachMatteAppliedResult = {
				status: "applied",
				operationId: request.operationId,
				revision: this.revision,
				assetId: prepared.addMedia.getAssetId(),
				snapshot: this.buildSnapshot(),
			};
			this.attachedMatteOperations.set(request.operationId, {
				fingerprint,
				result,
			});
			return result;
		} catch (error) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason:
					error instanceof Error ? error.message : "matte attachment failed",
			};
		}
	}

	private async attachCleanAudioNow(
		request: AutomationAttachCleanAudioRequest,
	): Promise<AutomationAttachCleanAudioResult> {
		this.reconcileExternalChanges();
		const { url: _transferUrl, ...stableRequest } = request;
		const fingerprint = stableSerialize(stableRequest);
		const prior = this.attachedCleanAudioOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason:
						"operationId was already used for a different cleaned-audio attachment",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		try {
			const prepared = await prepareCleanAudioAttachment({
				editor: this.editor,
				request,
			});
			this.editor.command.execute({ command: prepared.command });
			await prepared.addMedia.waitForPersistence();
			await this.editor.save.flush();
			this.recordCommittedState();
			const result: AutomationAttachCleanAudioAppliedResult = {
				status: "applied",
				operationId: request.operationId,
				revision: this.revision,
				assetId: prepared.addMedia.getAssetId(),
				snapshot: this.buildSnapshot(),
			};
			this.attachedCleanAudioOperations.set(request.operationId, {
				fingerprint,
				result,
			});
			return result;
		} catch (error) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason:
					error instanceof Error
						? error.message
						: "cleaned-audio attachment failed",
			};
		}
	}

	private async transferSourceMediaNow(
		request: AutomationTransferSourceRequest,
	): Promise<AutomationTransferSourceResult> {
		this.reconcileExternalChanges();
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		try {
			const element = findAudioCapableElement({
				tracks: this.editor.scenes.getActiveScene().tracks,
				trackId: request.trackId,
				elementId: request.elementId,
			});
			if (!("mediaId" in element)) {
				throw new Error("library audio cannot be transferred as source media");
			}
			const asset = this.editor.media
				.getAssets()
				.find((candidate) => candidate.id === element.mediaId);
			if (!asset) throw new Error(`source media not found: ${element.mediaId}`);
			const mimeType = asset.file.type || "application/octet-stream";
			const upload = await fetch(request.url, {
				method: "PUT",
				headers: { "Content-Type": mimeType },
				body: asset.file,
			});
			if (!upload.ok) {
				throw new Error(`source transfer failed with HTTP ${upload.status}`);
			}
			const receipt = (await upload.json()) as { bytesWritten: number };
			return {
				status: "transferred",
				revision: this.revision,
				mediaId: asset.id,
				name: asset.name,
				mimeType,
				bytesTransferred: receipt.bytesWritten,
				sourceFingerprint: asset.sourceFingerprint ?? null,
			};
		} catch (error) {
			return {
				status: "rejected",
				reason:
					error instanceof Error ? error.message : "source transfer failed",
			};
		}
	}

	private async exportProjectNow(
		request: AutomationExportRequest,
	): Promise<AutomationExportResult> {
		this.reconcileExternalChanges();
		const { url: _transferUrl, ...stableRequest } = request;
		const fingerprint = stableSerialize(stableRequest);
		const prior = this.exportedOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: request.operationId,
					reason: "operationId was already used for a different export",
				};
			}
			return { ...prior.result, status: "replayed" };
		}
		if (request.projectId !== this.getProjectId()) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: `active project is ${this.getProjectId()}`,
			};
		}
		if (request.expectedRevision !== this.revision) {
			return {
				status: "conflict",
				operationId: request.operationId,
				expectedRevision: request.expectedRevision,
				actualRevision: this.revision,
			};
		}

		const exported = await this.editor.renderer.exportProject({
			options: {
				format: request.format,
				quality: request.quality,
				fps: request.fps,
				includeAudio: request.includeAudio,
			},
		});
		if (!exported.success || !exported.buffer) {
			return {
				status: "rejected",
				operationId: request.operationId,
				reason: exported.cancelled
					? "export was cancelled"
					: (exported.error ?? "OpenCut did not produce an export buffer"),
			};
		}
		const upload = await fetch(request.url, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: exported.buffer,
		});
		if (!upload.ok) {
			throw new Error(`export transfer failed with HTTP ${upload.status}`);
		}
		const receipt = (await upload.json()) as {
			outputPath: string;
			bytesWritten: number;
			sha256: string;
		};
		const result: AutomationExportCompletedResult = {
			status: "exported",
			operationId: request.operationId,
			revision: this.revision,
			outputPath: receipt.outputPath,
			bytesWritten: receipt.bytesWritten,
			sha256: receipt.sha256,
		};
		this.exportedOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private validateAndBuildCommand(operation: AutomationEditOperation): Command {
		if (
			operation.kind === "insert_graphic" ||
			operation.kind === "insert_sticker" ||
			operation.kind === "insert_adjustment_layer"
		) {
			return buildVisualInsertionCommand({ operation });
		}
		if (
			operation.kind === "set_matte_state" ||
			operation.kind === "remove_matte"
		) {
			return buildMatteControlCommand({
				operation,
				projectId: this.getProjectId(),
				tracks: this.editor.scenes.getActiveScene().tracks,
			});
		}
		if (
			operation.kind === "set_audio_replacement_state" ||
			operation.kind === "remove_audio_replacement"
		) {
			return buildAudioReplacementControlCommand({
				operation,
				projectId: this.getProjectId(),
				tracks: this.editor.scenes.getActiveScene().tracks,
			});
		}
		if (operation.kind === "adjust_mix_gain") {
			return buildAudioMixGainCommand({
				tracks: this.editor.scenes.getActiveScene().tracks,
				mediaAssets: this.editor.media.getAssets(),
				gainDb: operation.gainDb,
			});
		}
		if (operation.kind === "insert_text") {
			assertMediaTime(operation.startTime, "startTime", true);
			assertMediaTime(operation.duration, "duration", false);
			if (!operation.content.trim())
				throw new Error("text content is required");
			return new InsertElementCommand({
				element: buildTextElement({
					raw: {
						...DEFAULTS.text.element,
						duration: operation.duration,
						params: {
							...DEFAULTS.text.element.params,
							content: operation.content,
						},
					},
					startTime: operation.startTime,
				}),
				placement: { mode: "auto" },
			});
		}
		if (operation.kind === "add_track") {
			return new AddTrackCommand({
				type: operation.trackType,
				trackId: operation.trackId,
			});
		}
		if (operation.kind === "set_track_state") {
			if (operation.muted === undefined && operation.hidden === undefined) {
				throw new Error("at least one track state is required");
			}
			const track = this.getTracks().find(
				(candidate) => candidate.id === operation.trackId,
			);
			if (!track) throw new Error(`track not found: ${operation.trackId}`);
			const commands: Command[] = [];
			if (operation.muted !== undefined) {
				if (!("muted" in track)) {
					throw new Error(`${track.type} tracks cannot be muted`);
				}
				if (track.muted !== operation.muted) {
					commands.push(new ToggleTrackMuteCommand(operation.trackId));
				}
			}
			if (operation.hidden !== undefined) {
				if (!("hidden" in track)) {
					throw new Error(`${track.type} tracks cannot be hidden`);
				}
				if (track.hidden !== operation.hidden) {
					commands.push(new ToggleTrackVisibilityCommand(operation.trackId));
				}
			}
			return new BatchCommand(commands);
		}
		if (operation.kind === "set_project_settings") {
			if (!operation.fps && !operation.canvasSize && !operation.background) {
				throw new Error("at least one project setting is required");
			}
			const settings: Partial<TProjectSettings> = {};
			if (operation.fps) {
				if (
					!Number.isSafeInteger(operation.fps.numerator) ||
					operation.fps.numerator <= 0 ||
					!Number.isSafeInteger(operation.fps.denominator) ||
					operation.fps.denominator <= 0
				) {
					throw new Error("frame-rate values must be positive safe integers");
				}
				settings.fps = operation.fps;
			}
			if (operation.canvasSize) {
				if (
					!Number.isSafeInteger(operation.canvasSize.width) ||
					operation.canvasSize.width <= 0 ||
					!Number.isSafeInteger(operation.canvasSize.height) ||
					operation.canvasSize.height <= 0
				) {
					throw new Error("canvas dimensions must be positive safe integers");
				}
				const isPreset = DEFAULT_CANVAS_PRESETS.some(
					(size) =>
						size.width === operation.canvasSize?.width &&
						size.height === operation.canvasSize?.height,
				);
				settings.canvasSize = operation.canvasSize;
				settings.canvasSizeMode = isPreset ? "preset" : "custom";
				if (!isPreset) settings.lastCustomCanvasSize = operation.canvasSize;
			}
			if (operation.background) {
				if (
					operation.background.type === "color" &&
					!operation.background.color.trim()
				) {
					throw new Error("background color is required");
				}
				if (
					operation.background.type === "blur" &&
					(!Number.isFinite(operation.background.blurIntensity) ||
						operation.background.blurIntensity < 0)
				) {
					throw new Error("background blur intensity must be non-negative");
				}
				settings.background = operation.background;
			}
			return new UpdateProjectSettingsCommand(settings);
		}
		if (operation.kind === "insert_captions") {
			if (operation.captions.length === 0) {
				throw new Error("at least one caption is required");
			}
			const project = this.editor.project.getActive();
			if (!project) throw new Error("No active project");
			const addTrack = new AddTrackCommand({ type: "text", index: 0 });
			const trackId = addTrack.getTrackId();
			const insertCommands = operation.captions.map((caption, index) => {
				if (!caption.text.trim()) throw new Error("caption text is required");
				assertMediaTime(caption.startTime, "caption startTime", true);
				assertMediaTime(caption.duration, "caption duration", false);
				return new InsertElementCommand({
					placement: { mode: "explicit", trackId },
					element: buildSubtitleTextElement({
						index,
						caption: {
							text: caption.text,
							startTime: mediaTimeToSeconds({ time: caption.startTime }),
							duration: mediaTimeToSeconds({ time: caption.duration }),
							style: operation.style,
						},
						canvasSize: project.settings.canvasSize,
					}),
				});
			});
			return new BatchCommand([addTrack, ...insertCommands]);
		}
		if (
			operation.kind === "set_group" ||
			operation.kind === "clear_group" ||
			operation.kind === "set_link" ||
			operation.kind === "clear_link"
		) {
			return buildRelationshipControlCommand({
				tracks: this.editor.scenes.getActiveScene().tracks,
				operation,
			});
		}
		if (operation.kind === "duplicate_elements") {
			expandElementRelationships({
				tracks: this.editor.scenes.getActiveScene().tracks,
				refs: operation.elements,
				scope: operation.relationshipScope,
			});
			return deferRelationshipCommand(
				(tracks) =>
					new DuplicateElementsCommand({
						elements: expandElementRelationships({
							tracks,
							refs: operation.elements,
							scope: operation.relationshipScope,
						}).map(({ trackId, elementId }) => ({ trackId, elementId })),
					}),
			);
		}
		if (
			operation.kind === "upsert_transition" ||
			operation.kind === "remove_transition"
		) {
			const track = this.getTracks().find(
				(candidate) => candidate.id === operation.trackId,
			);
			if (!track) throw new Error(`track not found: ${operation.trackId}`);
			return buildTransitionCommand({ track, operation });
		}

		const element = this.findElement(operation.trackId, operation.elementId);
		if (!element) {
			throw new Error(
				`element not found: ${operation.trackId}/${operation.elementId}`,
			);
		}
		if (operation.kind === "update_caption") {
			return buildCaptionCorrectionCommand({ element, operation });
		}
		if (operation.kind === "delete") {
			const refs = [
				{ trackId: operation.trackId, elementId: operation.elementId },
			];
			expandElementRelationships({
				tracks: this.editor.scenes.getActiveScene().tracks,
				refs,
				scope: operation.relationshipScope,
			});
			return withRipple({
				enabled: operation.ripple,
				command: deferRelationshipCommand(
					(tracks) =>
						new DeleteElementsCommand({
							elements: expandElementRelationships({
								tracks,
								refs,
								scope: operation.relationshipScope,
							}).map(({ trackId, elementId }) => ({ trackId, elementId })),
						}),
				),
			});
		}
		if (operation.kind === "split") {
			assertMediaTime(operation.splitTime, "splitTime", false);
			const endTime = element.startTime + element.duration;
			if (
				operation.splitTime <= element.startTime ||
				operation.splitTime >= endTime
			) {
				throw new Error("splitTime must be inside the element");
			}
			return withRipple({
				enabled: operation.ripple,
				command: new SplitElementsCommand({
					elements: [
						{
							trackId: operation.trackId,
							elementId: operation.elementId,
						},
					],
					splitTime: operation.splitTime,
					retainSide: operation.retainSide,
				}),
			});
		}
		if (operation.kind === "set_params") {
			const entries = Object.entries(operation.params);
			if (entries.length === 0) throw new Error("params cannot be empty");
			const definitionPatch = buildDefinitionParamPatch({
				element,
				requested: operation.params,
			});
			if (definitionPatch) {
				return new UpdateElementsCommand({
					updates: [
						{
							trackId: operation.trackId,
							elementId: operation.elementId,
							patch: definitionPatch,
						},
					],
				});
			}
			let updatedElement = element;
			for (const [key, requestedValue] of entries) {
				const param = getElementParam({ element: updatedElement, key });
				if (!param) {
					throw new Error(
						`parameter ${key} is not supported for ${element.type} elements`,
					);
				}
				const value = coerceParamValue({ param, value: requestedValue });
				if (value === null) {
					throw new Error(`invalid value for parameter ${key}`);
				}
				updatedElement = writeElementParamValue({
					element: updatedElement,
					param,
					value,
				});
			}
			return new UpdateElementsCommand({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: updatedElement,
					},
				],
			});
		}
		if (operation.kind === "set_reframe") {
			return buildReframeControlCommand({ element, operation });
		}
		if (operation.kind === "set_mask" || operation.kind === "remove_mask") {
			return buildAuthoredMaskCommand({ element, operation });
		}
		if (operation.kind === "set_audio") {
			return new UpdateElementsCommand({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: buildAudioControlPatch({
							element,
							control: {
								volumeDb: operation.volumeDb,
								muted: operation.muted,
								fade: operation.fade,
							},
						}),
					},
				],
			});
		}
		if (operation.kind === "separate_source_audio") {
			return buildSourceAudioSeparationCommand({
				element,
				trackId: operation.trackId,
				mediaAsset:
					element.type === "video"
						? (this.editor.media
								.getAssets()
								.find((asset) => asset.id === element.mediaId) ?? null)
						: null,
			});
		}
		if (operation.kind === "duck_audio") {
			return new UpdateElementsCommand({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: buildAudioDuckingPatch({ element, control: operation }),
					},
				],
			});
		}
		if (
			operation.kind === "upsert_effect" ||
			operation.kind === "remove_effect" ||
			operation.kind === "reorder_effects"
		) {
			return buildEffectControlCommand({ element, operation });
		}
		if (
			operation.kind === "upsert_keyframe" ||
			operation.kind === "remove_keyframe" ||
			operation.kind === "retime_keyframe"
		) {
			return buildKeyframeCommand({ element, operation });
		}
		if (operation.kind === "set_retime") {
			if (!isRetimableElement(element)) {
				throw new Error("only video and audio elements can be retimed");
			}
			if (
				!Number.isFinite(operation.rate) ||
				operation.rate < MIN_RETIME_RATE ||
				operation.rate > MAX_RETIME_RATE
			) {
				throw new Error(
					`rate must be between ${MIN_RETIME_RATE} and ${MAX_RETIME_RATE}`,
				);
			}
			return new UpdateElementsCommand({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: {
							retime: buildConstantRetime({
								rate: operation.rate,
								maintainPitch: operation.maintainPitch,
							}),
						},
					},
				],
			});
		}
		if (operation.kind === "move") {
			assertMediaTime(operation.startTime, "startTime", true);
			const anchor = {
				trackId: operation.trackId,
				elementId: operation.elementId,
			};
			buildRelationshipMoves({
				tracks: this.editor.scenes.getActiveScene().tracks,
				anchor,
				startTime: operation.startTime,
				targetTrackId: operation.targetTrackId,
				scope: operation.relationshipScope,
			});
			return deferRelationshipCommand(
				(tracks) =>
					new MoveElementCommand({
						moves: buildRelationshipMoves({
							tracks,
							anchor,
							startTime: operation.startTime,
							targetTrackId: operation.targetTrackId,
							scope: operation.relationshipScope,
						}),
					}),
			);
		}

		return withRipple({
			enabled: operation.ripple,
			command: new UpdateElementsCommand({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: buildTrimPatch({
							element,
							startTime: operation.startTime,
							duration: operation.duration,
							trimStart: operation.trimStart,
							trimEnd: operation.trimEnd,
						}),
					},
				],
			}),
		});
	}

	private findElement(
		trackId: string,
		elementId: string,
	): TimelineElement | null {
		return (
			this.getTracks()
				.find((track) => track.id === trackId)
				?.elements.find((element) => element.id === elementId) ?? null
		);
	}

	private getTracks(): TimelineTrack[] {
		const tracks = this.editor.scenes.getActiveScene().tracks;
		return [tracks.main, ...tracks.overlay, ...tracks.audio];
	}

	private getProjectId(): string {
		const project = this.editor.project.getActive();
		if (!project) throw new Error("No active project");
		return project.metadata.id;
	}

	private buildSnapshot(): AutomationProjectSnapshot {
		const scene = this.editor.scenes.getActiveScene();
		const project = this.editor.project.getActive();
		if (!project) throw new Error("No active project");
		const tracks = this.getTracks();
		return {
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			projectVersion: project.version,
			sceneId: scene.id,
			sceneName: scene.name,
			revision: this.revision,
			settings: {
				fps: project.settings.fps,
				canvasSize: project.settings.canvasSize,
				background: project.settings.background,
			},
			tracks: tracks.map((track) => ({
				trackId: track.id,
				name: track.name,
				type: track.type,
				role:
					track.id === scene.tracks.main.id
						? "main"
						: track.type === "audio"
							? "audio"
							: "overlay",
				...("muted" in track ? { muted: track.muted } : {}),
				...("hidden" in track ? { hidden: track.hidden } : {}),
			})),
			transitions: tracks.flatMap((track) =>
				getTrackTransitionStates({ track }).map((state) => ({
					transitionId: state.transition.id,
					trackId: track.id,
					fromElementId: state.transition.fromElementId,
					toElementId: state.toElement.id,
					type: state.transition.type,
					duration: state.transition.duration,
					valid: state.isAdjacent,
				})),
			),
			mediaAssets: this.editor.media.getAssets().map((asset) => ({
				assetId: asset.id,
				name: asset.name,
				type: asset.type,
				size: asset.file.size,
				...(asset.width == null ? {} : { width: asset.width }),
				...(asset.height == null ? {} : { height: asset.height }),
				...(asset.duration == null ? {} : { duration: asset.duration }),
				...(asset.fps == null ? {} : { fps: asset.fps }),
				...(asset.hasAudio == null ? {} : { hasAudio: asset.hasAudio }),
				...(asset.sourceFingerprint == null
					? {}
					: { sourceFingerprint: asset.sourceFingerprint }),
				...(asset.role == null ? {} : { role: asset.role }),
			})),
			elements: tracks.flatMap((track) =>
				track.elements.map((element) =>
					this.buildElementSnapshot(track.id, element),
				),
			),
		};
	}

	private buildElementSnapshot(
		trackId: string,
		element: TimelineElement,
	): AutomationElementSnapshot {
		const keyframes = getElementKeyframes({ animations: element.animations });
		const assets = this.editor.media.getAssets();
		const reframe = buildReframeSnapshot({ element });
		const params =
			element.type === "graphic" || element.type === "effect"
				? { ...element.params }
				: buildElementParamValues({ element });
		return {
			trackId,
			elementId: element.id,
			type: element.type,
			name: element.name,
			...(element.groupId ? { groupId: element.groupId } : {}),
			...(element.linkId ? { linkId: element.linkId } : {}),
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			sourceDuration: getElementSourceDuration({ element }),
			params,
			...(reframe ? { reframe } : {}),
			...("mediaId" in element ? { mediaId: element.mediaId } : {}),
			...("sourceType" in element ? { sourceType: element.sourceType } : {}),
			...("sourceUrl" in element ? { sourceUrl: element.sourceUrl } : {}),
			...("hidden" in element && element.hidden != null
				? { hidden: element.hidden }
				: {}),
			...(isRetimableElement(element) && element.retime
				? { retime: element.retime }
				: {}),
			...(element.type === "video" && element.matte
				? {
						matte: buildMatteSnapshot({
							matte: element.matte,
							assets,
							source: assets.find(
								(asset) => asset.id === element.matte?.sourceMediaId,
							),
						}),
					}
				: {}),
			...((element.type === "audio" || element.type === "video") &&
			element.audioReplacement
				? {
						audioReplacement: buildAudioReplacementSnapshot({
							audioReplacement: element.audioReplacement,
							assets,
							source: assets.find(
								(asset) => asset.id === element.audioReplacement?.sourceMediaId,
							),
						}),
					}
				: {}),
			...(element.type === "video"
				? { sourceAudioSeparated: element.isSourceAudioEnabled === false }
				: {}),
			...(element.type === "graphic"
				? { graphicDefinitionId: element.definitionId }
				: {}),
			...(element.type === "sticker"
				? {
						stickerId: element.stickerId,
						...(element.intrinsicWidth === undefined
							? {}
							: { stickerIntrinsicWidth: element.intrinsicWidth }),
						...(element.intrinsicHeight === undefined
							? {}
							: { stickerIntrinsicHeight: element.intrinsicHeight }),
					}
				: {}),
			...(element.type === "effect" ? { effectType: element.effectType } : {}),
			...("masks" in element && element.masks?.length
				? {
						masks: element.masks.map((mask) => ({
							maskId: mask.id,
							maskType: mask.type,
							params: { ...mask.params },
						})),
					}
				: {}),
			...(keyframes.length > 0 ? { keyframes } : {}),
			...("effects" in element && element.effects?.length
				? {
						effects: element.effects.map((effect) => ({
							effectId: effect.id,
							effectType: effect.type,
							enabled: effect.enabled,
							params: effect.params,
						})),
					}
				: {}),
		};
	}

	private reconcileExternalChanges(): void {
		const nextFingerprint = stableSerialize(this.buildTimelineProjection());
		if (!this.stateFingerprint) {
			this.stateFingerprint = nextFingerprint;
			return;
		}
		if (nextFingerprint !== this.stateFingerprint) {
			this.revision += 1;
			this.stateFingerprint = nextFingerprint;
		}
	}

	private recordCommittedState(): void {
		this.revision += 1;
		this.stateFingerprint = stableSerialize(this.buildTimelineProjection());
	}

	private resetProjectSession(): void {
		this.revision = 0;
		this.appliedOperations.clear();
		this.importedOperations.clear();
		this.importedSubtitleOperations.clear();
		this.transcriptionOperations.clear();
		this.exportedOperations.clear();
		this.attachedMatteOperations.clear();
		this.attachedCleanAudioOperations.clear();
		this.editor.command.clear();
		this.editor.selection.clearSelection();
		this.stateFingerprint = stableSerialize(this.buildTimelineProjection());
	}

	private buildTimelineProjection(): unknown {
		const scene = this.editor.scenes.getActiveScene();
		const project = this.editor.project.getActive();
		if (!project) throw new Error("No active project");
		return {
			projectId: project.metadata.id,
			sceneId: scene.id,
			settings: project.settings,
			tracks: scene.tracks,
		};
	}
}

function mergeSubtitleStyles({
	base,
	overrides,
}: {
	base: SubtitleStyleOverrides | undefined;
	overrides: SubtitleStyleOverrides | undefined;
}): SubtitleStyleOverrides | undefined {
	if (!base && !overrides) return undefined;
	const background = overrides?.background
		? { ...base?.background, ...overrides.background }
		: base?.background;
	return {
		...base,
		...overrides,
		...(background ? { background } : {}),
		...(base?.placement || overrides?.placement
			? { placement: { ...base?.placement, ...overrides?.placement } }
			: {}),
	};
}

function validatePlanShape(plan: AutomationEditPlan): string | null {
	if (!plan.operationId.trim()) return "operationId is required";
	if (!plan.description.trim()) return "description is required";
	if (
		!Number.isSafeInteger(plan.expectedRevision) ||
		plan.expectedRevision < 0
	) {
		return "expectedRevision must be a non-negative safe integer";
	}
	if (plan.operations.length === 0) return "at least one operation is required";
	return null;
}

function assertMediaTime(
	value: number,
	name: string,
	allowZero: boolean,
): void {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(
			`${name} must be ${allowZero ? "non-negative" : "positive"} ticks`,
		);
	}
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
