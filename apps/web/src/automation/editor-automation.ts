import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import {
	AddTrackCommand,
	DeleteElementsCommand,
	InsertElementCommand,
	SplitElementsCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	UpdateElementsCommand,
} from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { coerceParamValue } from "@/params";
import {
	buildElementParamValues,
	getElementParam,
	writeElementParamValue,
} from "@/params/registry";
import {
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
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import type {
	AutomationEditOperation,
	AutomationEditPlan,
	AutomationElementSnapshot,
	AutomationCreateProjectRequest,
	AutomationCreateProjectResult,
	AutomationExportCompletedResult,
	AutomationExportRequest,
	AutomationExportResult,
	AutomationImportAppliedResult,
	AutomationImportRequest,
	AutomationImportResult,
	AutomationAppliedResult,
	AutomationMutationResult,
	AutomationOpenProjectRequest,
	AutomationOpenProjectResult,
	AutomationProjectActivatedResult,
	AutomationProjectListResult,
	AutomationProjectSnapshot,
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
	private exportedOperations = new Map<
		string,
		{ fingerprint: string; result: AutomationExportCompletedResult }
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
			asset,
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
		};
		const result: AutomationExportCompletedResult = {
			status: "exported",
			operationId: request.operationId,
			revision: this.revision,
			outputPath: receipt.outputPath,
			bytesWritten: receipt.bytesWritten,
		};
		this.exportedOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private validateAndBuildCommand(operation: AutomationEditOperation): Command {
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
			return new AddTrackCommand({ type: operation.trackType });
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

		const element = this.findElement(operation.trackId, operation.elementId);
		if (!element) {
			throw new Error(
				`element not found: ${operation.trackId}/${operation.elementId}`,
			);
		}
		if (operation.kind === "delete") {
			return new DeleteElementsCommand({
				elements: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
					},
				],
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
			return new SplitElementsCommand({
				elements: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
					},
				],
				splitTime: operation.splitTime,
				retainSide: operation.retainSide,
			});
		}
		if (operation.kind === "set_params") {
			const entries = Object.entries(operation.params);
			if (entries.length === 0) throw new Error("params cannot be empty");
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
		assertMediaTime(operation.startTime, "startTime", true);
		if (operation.kind === "move") {
			return new UpdateElementsCommand({
				updates: [
					{
						trackId: operation.trackId,
						elementId: operation.elementId,
						patch: { startTime: operation.startTime },
					},
				],
			});
		}

		assertMediaTime(operation.duration, "duration", false);
		assertMediaTime(operation.trimStart, "trimStart", true);
		assertMediaTime(operation.trimEnd, "trimEnd", true);
		if (operation.trimEnd <= operation.trimStart) {
			throw new Error("trimEnd must be greater than trimStart");
		}
		return new UpdateElementsCommand({
			updates: [
				{
					trackId: operation.trackId,
					elementId: operation.elementId,
					patch: {
						startTime: operation.startTime,
						duration: operation.duration,
						trimStart: operation.trimStart,
						trimEnd: operation.trimEnd,
					},
				},
			],
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
		return {
			trackId,
			elementId: element.id,
			type: element.type,
			name: element.name,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			params: buildElementParamValues({ element }),
			...("mediaId" in element ? { mediaId: element.mediaId } : {}),
			...("sourceType" in element ? { sourceType: element.sourceType } : {}),
			...("sourceUrl" in element ? { sourceUrl: element.sourceUrl } : {}),
			...("hidden" in element && element.hidden != null
				? { hidden: element.hidden }
				: {}),
			...(isRetimableElement(element) && element.retime
				? { retime: element.retime }
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
		this.exportedOperations.clear();
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
