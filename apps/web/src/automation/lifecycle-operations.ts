import { AddMediaAssetCommand } from "@/commands/media";
import {
	mediaRelinkDescriptor,
	RelinkMediaAssetCommand,
	type MediaRelinkDifference,
} from "@/commands/media/relink-media-asset";
import { RemoveMediaAssetCommand } from "@/commands/media/remove-media-asset";
import { RenameMediaAssetCommand } from "@/commands/media/rename-media-asset";
import {
	CloneSceneCommand,
	CreateSceneCommand,
	DeleteSceneCommand,
	RenameSceneCommand,
	ReorderScenesCommand,
	SetMainSceneCommand,
	SwitchSceneCommand,
} from "@/commands/scene";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { processMediaAssets } from "@/media/processing";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import {
	calculateTotalDuration,
	type SceneTracks,
	type TScene,
	type TimelineElement,
} from "@/timeline";
import { hasMediaId } from "@/timeline/element-utils";
import { getMainScene } from "@/timeline/scenes";
import {
	cloneSceneTracksWithNewIds,
	type IdAllocator,
} from "@/timeline/track-clone";
import { generateUUID } from "@/utils/id";
import * as opencutWasm from "opencut-wasm";
import {
	buildCanonicalProjectState,
	canonicalSerialize,
	hashProjectContent,
} from "./project-content-hash";
import { buildEditorProjectContentInput } from "./project-content-identity";
import type {
	AutomationActiveProjectMutationRequest,
	AutomationAffectedObject,
	AutomationCloneSceneRequest,
	AutomationContentIdentityBlockedResult,
	AutomationCreateSceneRequest,
	AutomationDeleteProjectRequest,
	AutomationDeleteProjectResult,
	AutomationDeleteSceneRequest,
	AutomationDuplicateProjectRequest,
	AutomationDuplicateProjectResult,
	AutomationImportMediaAssetRequest,
	AutomationLifecycleRejectedResult,
	AutomationListMediaUsagesRequest,
	AutomationListMediaUsagesResult,
	AutomationListScenesRequest,
	AutomationListScenesResult,
	AutomationMediaMutationAppliedResult,
	AutomationMediaMutationResult,
	AutomationMediaUsage,
	AutomationProjectLifecycleAppliedResult,
	AutomationProjectSnapshot,
	AutomationPreflightMediaRelinkRequest,
	AutomationPreflightMediaRelinkResult,
	AutomationPreflightLifecycleMutationRequest,
	AutomationPreflightLifecycleMutationResult,
	AutomationLifecycleMutationMethod,
	AutomationRelinkMediaAssetRequest,
	AutomationRemoveMediaAssetRequest,
	AutomationRenameMediaAssetRequest,
	AutomationRenameProjectRequest,
	AutomationRenameProjectResult,
	AutomationRenameSceneRequest,
	AutomationReorderScenesRequest,
	AutomationSceneMutationAppliedResult,
	AutomationSceneMutationResult,
	AutomationSetMainSceneRequest,
	AutomationSwitchSceneRequest,
} from "./types";
import type { ProjectContentHashResult } from "./project-content-hash";
import { executePersistedCommand } from "./persisted-command";

/**
 * Editor-side services the lifecycle operations borrow from EditorAutomation.
 * Keeping them behind an interface lets the operations live in their own
 * module while sharing the automation session's revision and identity state.
 */
export interface LifecycleContext {
	editor: EditorCore;
	getProjectId(): string;
	getRevision(): number;
	contentIdentity(): ProjectContentHashResult | null;
	buildSnapshot(): AutomationProjectSnapshot;
	recordCommittedState(): void;
	refreshContentIdentity(): Promise<ProjectContentHashResult>;
	reconcileExternalChanges(): void;
	blockedProductionRequest(
		request: unknown,
	): Promise<AutomationContentIdentityBlockedResult | null>;
	resetProjectSession(): void;
}

interface ReplayEntry<TResult> {
	fingerprint: string;
	result: TResult;
}

type SceneApplied = AutomationSceneMutationAppliedResult;
type MediaApplied = AutomationMediaMutationAppliedResult;

interface LifecycleMutationPlan {
	preflightFingerprint: string;
	affectedObjects: AutomationAffectedObject[];
	consequences: Record<string, unknown>;
}

export class LifecycleOperations {
	private readonly projectOperations = new Map<
		string,
		ReplayEntry<AutomationProjectLifecycleAppliedResult & { status: string }>
	>();
	private sceneOperations = new Map<string, ReplayEntry<SceneApplied>>();
	private mediaOperations = new Map<string, ReplayEntry<MediaApplied>>();

	constructor(private readonly context: LifecycleContext) {}

	/** Forget per-project replay state when the editor moves to another project. */
	clearSession(): void {
		this.sceneOperations = new Map();
		this.mediaOperations = new Map();
	}

	async preflightMutation(
		input: AutomationPreflightLifecycleMutationRequest,
	): Promise<AutomationPreflightLifecycleMutationResult> {
		this.context.reconcileExternalChanges();
		const { method, request } = input;
		try {
			const projectId = requiredString(request.projectId, "projectId");
			const before = this.lifecycleObservation();
			const planned = await this.validateMutationPlan(method, request);
			const after = this.lifecycleObservation();
			if (before !== after) {
				throw new Error("lifecycle preflight changed observable editor state");
			}
			const identity = this.context.contentIdentity();
			if (identity?.status !== "hashed") {
				throw new Error("project content identity is unavailable");
			}
			return {
				status: "validated",
				method,
				preflightFingerprint: planned.preflightFingerprint,
				projectId,
				revision: this.context.getRevision(),
				projectContentHash: identity.hash.digest,
				affectedObjects: planned.affectedObjects,
				consequences: planned.consequences,
				noMutationProof: { before, after },
			};
		} catch (error) {
			return { status: "rejected", method, reason: errorMessage(error) };
		}
	}

	private async validateMutationPlan(
		method: AutomationLifecycleMutationMethod,
		request: Record<string, unknown>,
	): Promise<{
		preflightFingerprint: string;
		affectedObjects: AutomationAffectedObject[];
		consequences: Record<string, unknown>;
	}> {
		const editor = this.context.editor;
		await editor.project.loadAllProjects();
		const identity = this.context.contentIdentity();
		if (identity?.status !== "hashed") {
			throw new Error("project content identity is unavailable");
		}
		const targetPersistence = PROJECT_LIFECYCLE_METHODS.has(method)
			? await readVerifiedProjectPersistence(
					requiredString(request.projectId, "projectId"),
				)
			: null;
		const replacement =
			method === "import_media_asset" || method === "relink_media_asset"
				? await this.processTransfer(transferRequest(request))
				: null;
		const identitySources = await lifecycleIdentitySources({
			method,
			request,
			editor,
		});
		const evaluation = opencutWasm.evaluateLifecycleMutation({
			method,
			request: rustLifecycleRequest(request),
			state: {
				activeProjectId: this.activeProjectId() ?? undefined,
				activeSceneId: editor.scenes.getActiveScene().id,
				activeRevision: this.context.getRevision(),
				activeProjectContentHash: identity.hash.digest,
				projects: editor.project.getSavedProjects().map((project) => ({
					id: project.id,
					name: project.name,
					updatedAtMs: project.updatedAt.getTime(),
					contentHash:
						targetPersistence?.projectId === project.id
							? targetPersistence.contentHash
							: undefined,
					writeVersion:
						targetPersistence?.projectId === project.id
							? targetPersistence.writeVersion
							: undefined,
				})),
				scenes: editor.scenes.getScenes().map((scene) => ({
					id: scene.id,
					name: scene.name,
					isMain: scene.isMain,
				})),
				assets: editor.media.getAssets().map((asset) => ({
					id: asset.id,
					name: asset.name,
					descriptor: mediaRelinkDescriptor(asset),
				})),
				usages: editor.scenes
					.getScenes()
					.flatMap((scene) =>
						collectSceneUsages({ scene, tracks: scene.tracks }),
					)
					.map((usage) => ({
						assetId: usage.assetId,
						elementId: usage.elementId,
						kind: usage.kind,
					})),
				replacement: replacement
					? {
							name: replacement.name,
							descriptor: mediaRelinkDescriptor(replacement),
						}
					: undefined,
				identitySources,
			},
		});
		if (evaluation.status === "rejected") {
			throw new Error(evaluation.reason);
		}
		return {
			preflightFingerprint: evaluation.preflightFingerprint,
			affectedObjects: evaluation.affectedObjects as AutomationAffectedObject[],
			consequences: evaluation.consequences as Record<string, unknown>,
		};
	}

	// ----------------------------------------------------------------------
	// Projects
	// ----------------------------------------------------------------------

	async renameProject(
		request: AutomationRenameProjectRequest,
	): Promise<AutomationRenameProjectResult> {
		const fingerprint = stableSerialize({ method: "rename_project", request });
		const replay = this.replayProject(request.operationId, fingerprint);
		if (replay) return replay as AutomationRenameProjectResult;
		const plan = await this.requireLifecyclePreflight(
			"rename_project",
			request,
		);
		if ("status" in plan) return plan;
		const name = requiredConsequenceString(plan, "name");
		const isActive = this.activeProjectId() === request.projectId;
		await this.context.editor.save.flush();
		await this.context.editor.project.renameProject({
			id: request.projectId,
			name,
		});
		const renamed = await storageService.loadProject({ id: request.projectId });
		if (!renamed || renamed.project.metadata.name !== name) {
			return rejected(request.operationId, "project rename did not persist");
		}
		if (isActive) {
			this.context.recordCommittedState();
		} else {
			this.context.reconcileExternalChanges();
		}
		await this.context.refreshContentIdentity();
		const persistence = await this.verifiedProjectPersistence(
			request.projectId,
		);
		const result = {
			status: "renamed" as const,
			...this.projectLifecycleBase(request.operationId, plan.affectedObjects),
			renamedProjectId: request.projectId,
			name,
			persistence,
		};
		this.projectOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	async duplicateProject(
		request: AutomationDuplicateProjectRequest,
	): Promise<AutomationDuplicateProjectResult> {
		const fingerprint = stableSerialize({
			method: "duplicate_project",
			request,
		});
		const replay = this.replayProject(request.operationId, fingerprint);
		if (replay) return replay as AutomationDuplicateProjectResult;
		const plan = await this.requireLifecyclePreflight(
			"duplicate_project",
			request,
		);
		if ("status" in plan) return plan;
		const requestedName = requiredConsequenceString(plan, "name");
		const plannedProjectId = requiredConsequenceString(
			plan,
			"duplicateProjectId",
		);
		await this.context.editor.save.flush();
		const [duplicateProjectId] =
			await this.context.editor.project.duplicateProjects({
				ids: [request.projectId],
				newProjectIds: [plannedProjectId],
				newProjectNames: [requestedName],
			});
		if (!duplicateProjectId || duplicateProjectId !== plannedProjectId) {
			return rejected(
				request.operationId,
				"project duplication did not produce a project",
			);
		}
		// duplicateProjects copies the scene graph verbatim. Give every scene,
		// track, element, transition, and bookmark of the copy its own identity so
		// the two projects never share mutable object ids; media assets keep their
		// ids because they are bound by content identity.
		const loaded = await storageService.loadProject({ id: duplicateProjectId });
		if (!loaded) {
			return rejected(
				request.operationId,
				"duplicated project could not be read back",
			);
		}
		const allocations = consequenceAllocationQueue(plan);
		const remapped = remapProjectIdentities(loaded.project, allocations.next);
		allocations.assertConsumed();
		const name = requestedName;
		await storageService.saveProject({
			project: {
				...remapped,
				metadata: { ...remapped.metadata, name, updatedAt: new Date() },
			},
		});
		await this.context.editor.project.loadAllProjects();
		this.context.reconcileExternalChanges();
		await this.context.refreshContentIdentity();
		const persistence =
			await this.verifiedProjectPersistence(duplicateProjectId);
		const result = {
			status: "duplicated" as const,
			...this.projectLifecycleBase(request.operationId, plan.affectedObjects),
			sourceProjectId: request.projectId,
			duplicateProjectId,
			name,
			mediaIdentity: "shared" as const,
			mediaBytes: "copied" as const,
			persistence,
		};
		this.projectOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	async deleteProject(
		request: AutomationDeleteProjectRequest,
	): Promise<AutomationDeleteProjectResult> {
		const fingerprint = stableSerialize({ method: "delete_project", request });
		const replay = this.replayProject(request.operationId, fingerprint);
		if (replay) return replay as AutomationDeleteProjectResult;
		const plan = await this.requireLifecyclePreflight(
			"delete_project",
			request,
		);
		if ("status" in plan) return plan;
		const editor = this.context.editor;
		await editor.save.flush();
		const fallback = requiredConsequenceString(plan, "fallback") as
			| "unchanged"
			| "opened-existing"
			| "created-blank";
		if (this.activeProjectId() === request.projectId) {
			const candidate = optionalConsequenceString(plan, "fallbackProjectId");
			if (candidate) {
				await editor.project.loadProject({ id: candidate });
			} else {
				const created = requiredConsequenceRecord(plan, "createdBlank");
				await editor.project.createNewProject({
					name: "Untitled Project",
					projectId: requiredRecordString(created, "projectId"),
					mainSceneId: requiredRecordString(created, "sceneId"),
					mainTrackId: requiredRecordString(created, "mainTrackId"),
				});
			}
			this.context.resetProjectSession();
		}
		await editor.project.deleteProjects({ ids: [request.projectId] });
		if (await this.projectExists(request.projectId)) {
			return rejected(request.operationId, "project deletion did not persist");
		}
		this.context.reconcileExternalChanges();
		await this.context.refreshContentIdentity();
		const result = {
			status: "deleted" as const,
			...this.projectLifecycleBase(request.operationId, plan.affectedObjects),
			deletedProjectId: request.projectId,
			fallback,
			recoverability: "irreversible" as const,
			persistence: {
				status: "deleted-verified" as const,
				projectId: request.projectId,
			},
		};
		this.projectOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	// ----------------------------------------------------------------------
	// Scenes
	// ----------------------------------------------------------------------

	async listScenes(
		request: AutomationListScenesRequest,
	): Promise<AutomationListScenesResult> {
		this.context.reconcileExternalChanges();
		const projectId = this.context.getProjectId();
		if (request.projectId !== undefined && request.projectId !== projectId) {
			throw new Error(`active project is ${projectId}`);
		}
		const editor = this.context.editor;
		const project = editor.project.getActive();
		const activeSceneId = editor.scenes.getActiveScene().id;
		const scenes = await Promise.all(
			project.scenes.map(async (scene, order) => ({
				...sceneSummary({ scene, order, activeSceneId }),
				contentHash: await sceneContentHash({ project, scene, editor }),
				bookmarks: scene.bookmarks.map((bookmark) => ({
					bookmarkId: bookmark.id,
					time: bookmark.time,
					...(bookmark.duration === undefined
						? {}
						: { duration: bookmark.duration }),
					...(bookmark.note === undefined ? {} : { note: bookmark.note }),
					...(bookmark.color === undefined ? {} : { color: bookmark.color }),
				})),
			})),
		);
		return {
			projectId,
			revision: this.context.getRevision(),
			activeSceneId,
			mainSceneId: getMainScene({ scenes: project.scenes })?.id ?? null,
			scenes,
		};
	}

	createScene(
		request: AutomationCreateSceneRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("create_scene", request, (plan) => {
			const name = requiredConsequenceString(plan, "name");
			const command = new CreateSceneCommand({
				name,
				isMain: false,
				sceneId: requiredConsequenceString(plan, "sceneId"),
				mainTrackId: requiredConsequenceString(plan, "mainTrackId"),
			});
			this.context.editor.command.execute({ command });
			const sceneId = command.getSceneId();
			if (plan.consequences.activate === true) {
				this.context.editor.command.execute({
					command: new SwitchSceneCommand({ sceneId }),
				});
			}
			return {
				sceneId,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	cloneScene(
		request: AutomationCloneSceneRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("clone_scene", request, (plan) => {
			const allocations = consequenceAllocationQueue(plan);
			const command = new CloneSceneCommand({
				sceneId: requiredConsequenceString(plan, "sourceSceneId"),
				newSceneId: requiredConsequenceString(plan, "newSceneId"),
				name: requiredConsequenceString(plan, "name"),
				allocate: allocations.next,
			});
			this.context.editor.command.execute({ command });
			allocations.assertConsumed();
			const sceneId = command.getSceneId();
			if (plan.consequences.activate === true) {
				this.context.editor.command.execute({
					command: new SwitchSceneCommand({ sceneId }),
				});
			}
			return {
				sceneId,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	switchScene(
		request: AutomationSwitchSceneRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("switch_scene", request, (plan) => {
			const sceneId = requiredConsequenceString(plan, "activeSceneId");
			this.context.editor.command.execute({
				command: new SwitchSceneCommand({ sceneId }),
			});
			return {
				sceneId,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	renameScene(
		request: AutomationRenameSceneRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("rename_scene", request, (plan) => {
			const name = requiredConsequenceString(plan, "name");
			this.context.editor.command.execute({
				command: new RenameSceneCommand({
					sceneId: request.sceneId,
					newName: name,
				}),
			});
			return {
				sceneId: request.sceneId,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	deleteScene(
		request: AutomationDeleteSceneRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("delete_scene", request, (plan) => {
			const editor = this.context.editor;
			const newMainSceneId = optionalConsequenceString(plan, "newMainSceneId");
			const replacementSceneId = optionalConsequenceString(
				plan,
				"replacementSceneId",
			);
			if (newMainSceneId) {
				editor.command.execute({
					command: new SetMainSceneCommand({ sceneId: newMainSceneId }),
				});
			}
			if (replacementSceneId) {
				editor.command.execute({
					command: new SwitchSceneCommand({ sceneId: replacementSceneId }),
				});
			}
			editor.command.execute({
				command: new DeleteSceneCommand(request.sceneId),
			});
			if (
				editor.scenes
					.getScenes()
					.some((candidate) => candidate.id === request.sceneId)
			) {
				throw new Error(`scene ${request.sceneId} could not be deleted`);
			}
			return {
				sceneId: request.sceneId,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	setMainScene(
		request: AutomationSetMainSceneRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("set_main_scene", request, (plan) => {
			const sceneId = requiredConsequenceString(plan, "mainSceneId");
			this.context.editor.command.execute({
				command: new SetMainSceneCommand({ sceneId }),
			});
			return {
				sceneId,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	reorderScenes(
		request: AutomationReorderScenesRequest,
	): Promise<AutomationSceneMutationResult> {
		return this.sceneMutation("reorder_scenes", request, (plan) => {
			const sceneIds = consequenceStringArray(plan, "sceneIds");
			this.context.editor.command.execute({
				command: new ReorderScenesCommand({ sceneIds }),
			});
			return {
				sceneId: this.context.editor.scenes.getActiveScene().id,
				affectedObjects: plan.affectedObjects,
			};
		});
	}

	// ----------------------------------------------------------------------
	// Media bin
	// ----------------------------------------------------------------------

	async listMediaUsages(
		request: AutomationListMediaUsagesRequest,
	): Promise<AutomationListMediaUsagesResult> {
		this.context.reconcileExternalChanges();
		const projectId = this.context.getProjectId();
		if (request.projectId !== undefined && request.projectId !== projectId) {
			throw new Error(`active project is ${projectId}`);
		}
		const editor = this.context.editor;
		const assets = editor.media.getAssets();
		if (
			request.assetId &&
			!assets.some((asset) => asset.id === request.assetId)
		) {
			throw new Error(`media asset not found: ${request.assetId}`);
		}
		const allUsages = editor.scenes
			.getScenes()
			.flatMap((scene) => collectSceneUsages({ scene, tracks: scene.tracks }));
		const usages = allUsages.filter(
			(usage) => !request.assetId || usage.assetId === request.assetId,
		);
		const used = new Set(allUsages.map((usage) => usage.assetId));
		const selectedAssets = request.assetId
			? assets.filter((asset) => asset.id === request.assetId)
			: assets;
		return {
			projectId,
			revision: this.context.getRevision(),
			usages,
			providerReferences: selectedAssets.flatMap((asset) =>
				asset.sourceIdentity?.kind === "provider"
					? [
							{
								assetId: asset.id,
								provider: asset.sourceIdentity.provider,
								providerVersion: asset.sourceIdentity.providerVersion,
								sourceUrl: asset.sourceIdentity.sourceUrl,
								contentHash: asset.sourceIdentity.contentHash.digest,
							},
						]
					: [],
			),
			packageReferences: [],
			unusedAssetIds: assets
				.filter((asset) => !used.has(asset.id))
				.map((asset) => asset.id)
				.sort(),
		};
	}

	async preflightMediaRelink(
		request: AutomationPreflightMediaRelinkRequest,
	): Promise<AutomationPreflightMediaRelinkResult> {
		this.context.reconcileExternalChanges();
		const projectId = this.context.getProjectId();
		const base = {
			projectId,
			assetId: request.assetId,
			revision: this.context.getRevision(),
		};
		try {
			const planned = await this.validateMutationPlan("relink_media_asset", {
				...request,
				allowIncompatible: false,
			});
			const compatible = planned.consequences.compatible === true;
			const differences = planned.consequences.differences as Array<{
				field: MediaRelinkDifference["field"];
				before: unknown;
				after: unknown;
			}>;
			const usageCount = Number(planned.consequences.usageCount);
			return {
				...base,
				status: "validated",
				preflightFingerprint: planned.preflightFingerprint,
				compatible,
				differences,
				usageCount,
			};
		} catch (error) {
			return { ...base, status: "rejected", reason: errorMessage(error) };
		}
	}

	importMediaAsset(
		request: AutomationImportMediaAssetRequest,
	): Promise<AutomationMediaMutationResult> {
		const { url: _transferUrl, ...stable } = request;
		return this.mediaMutation(
			"import_media_asset",
			request,
			stable,
			async (plan) => {
				const asset = await this.processTransfer(request);
				const command = new AddMediaAssetCommand({
					projectId: request.projectId,
					assetId: requiredConsequenceString(plan, "assetId"),
					asset: {
						...asset,
						name: requiredConsequenceString(plan, "name"),
						sourceFingerprint: request.sourceFingerprint,
					},
					ratchetProjectFps: false,
				});
				this.context.editor.command.execute({ command });
				await command.waitForPersistence();
				const assetId = command.getAssetId();
				return {
					assetId,
					affectedObjects: plan.affectedObjects,
				};
			},
		);
	}

	renameMediaAsset(
		request: AutomationRenameMediaAssetRequest,
	): Promise<AutomationMediaMutationResult> {
		return this.mediaMutation(
			"rename_media_asset",
			request,
			request,
			async (plan) => {
				const name = requiredConsequenceString(plan, "name");
				await executePersistedCommand({
					commands: this.context.editor.command,
					command: new RenameMediaAssetCommand({
						projectId: request.projectId,
						assetId: request.assetId,
						name,
					}),
				});
				return {
					assetId: request.assetId,
					affectedObjects: plan.affectedObjects,
				};
			},
		);
	}

	relinkMediaAsset(
		request: AutomationRelinkMediaAssetRequest,
	): Promise<AutomationMediaMutationResult> {
		const { url: _transferUrl, ...stable } = request;
		return this.mediaMutation(
			"relink_media_asset",
			request,
			stable,
			async (plan) => {
				const replacementAsset = await this.processTransfer(request);
				const command = new RelinkMediaAssetCommand({
					projectId: request.projectId,
					assetId: request.assetId,
					replacement: {
						...replacementAsset,
						sourceFingerprint: request.sourceFingerprint,
					},
					allowIncompatible: request.allowIncompatible ?? false,
				});
				await executePersistedCommand({
					commands: this.context.editor.command,
					command,
				});
				const differences = command.getDifferences().map(differenceSnapshot);
				if (
					stableSerialize(differences) !==
					stableSerialize(consequenceArray(plan, "differences"))
				) {
					throw new Error("media relink drifted from its Rust lifecycle plan");
				}
				return {
					assetId: request.assetId,
					differences,
					affectedObjects: plan.affectedObjects,
				};
			},
		);
	}

	removeMediaAsset(
		request: AutomationRemoveMediaAssetRequest,
	): Promise<AutomationMediaMutationResult> {
		return this.mediaMutation(
			"remove_media_asset",
			request,
			request,
			async (plan) => {
				const before = new Set(
					this.context.editor.scenes
						.getScenes()
						.flatMap((scene) => allElementIds(scene.tracks)),
				);
				await executePersistedCommand({
					commands: this.context.editor.command,
					command: new RemoveMediaAssetCommand({
						projectId: request.projectId,
						assetId: request.assetId,
						policy: request.policy,
						deferPersistence: true,
					}),
				});
				const after = new Set(
					this.context.editor.scenes
						.getScenes()
						.flatMap((scene) => allElementIds(scene.tracks)),
				);
				const removedElementIds = [...before]
					.filter((id) => !after.has(id))
					.sort();
				if (
					stableSerialize(removedElementIds) !==
					stableSerialize(consequenceStringArray(plan, "removedElementIds"))
				) {
					throw new Error("media cascade drifted from its Rust lifecycle plan");
				}
				const updatedElementIds = consequenceStringArray(
					plan,
					"updatedElementIds",
				);
				const remainingUsages = this.context.editor.scenes
					.getScenes()
					.flatMap((scene) =>
						collectSceneUsages({ scene, tracks: scene.tracks }),
					)
					.filter((usage) => usage.assetId === request.assetId);
				if (
					updatedElementIds.some((elementId) => !after.has(elementId)) ||
					remainingUsages.length > 0
				) {
					throw new Error(
						"media attachment cleanup drifted from its Rust lifecycle plan",
					);
				}
				return {
					assetId: request.assetId,
					removedElementIds,
					affectedObjects: plan.affectedObjects,
				};
			},
		);
	}

	// ----------------------------------------------------------------------
	// Shared machinery
	// ----------------------------------------------------------------------

	private lifecycleObservation(): string {
		const identity = this.context.contentIdentity();
		return stableSerialize({
			projectId: this.context.getProjectId(),
			sceneId: this.context.editor.scenes.getActiveScene().id,
			revision: this.context.getRevision(),
			projectContentHash:
				identity?.status === "hashed" ? identity.hash.digest : null,
			historyActivity:
				this.context.editor.command.getHistorySnapshot().activitySequence,
		});
	}

	private async requireLifecyclePreflight(
		method: AutomationLifecycleMutationMethod,
		request:
			| AutomationActiveProjectMutationRequest
			| AutomationRenameProjectRequest
			| AutomationDuplicateProjectRequest
			| AutomationDeleteProjectRequest,
	): Promise<AutomationLifecycleRejectedResult | LifecycleMutationPlan> {
		if (!request.preflightFingerprint) {
			return rejected(request.operationId, "preflightFingerprint is required");
		}
		let planned: Awaited<
			ReturnType<LifecycleOperations["validateMutationPlan"]>
		>;
		try {
			planned = await this.validateMutationPlan(
				method,
				request as unknown as Record<string, unknown>,
			);
		} catch (error) {
			return rejected(request.operationId, errorMessage(error));
		}
		return planned.preflightFingerprint === request.preflightFingerprint
			? planned
			: rejected(
					request.operationId,
					"lifecycle mutation does not match its preflight receipt",
				);
	}

	private replayProject(operationId: string, fingerprint: string) {
		const prior = this.projectOperations.get(operationId);
		if (!prior) return null;
		if (prior.fingerprint !== fingerprint) {
			return rejected(
				operationId,
				"operationId was already used for a different project operation",
			);
		}
		return { ...prior.result, status: "replayed" as const };
	}

	private projectLifecycleBase(
		operationId: string,
		affectedObjects: AutomationAffectedObject[],
	): Omit<AutomationProjectLifecycleAppliedResult, "persistence"> {
		const activeProjectId = this.context.getProjectId();
		return {
			operationId,
			projectId: activeProjectId,
			activeProjectId,
			revision: this.context.getRevision(),
			snapshot: this.context.buildSnapshot(),
			affectedObjects,
		};
	}

	private activeProjectId(): string | null {
		return this.context.editor.project.getActiveOrNull()?.metadata.id ?? null;
	}

	private async projectExists(projectId: string): Promise<boolean> {
		if (!projectId.trim()) return false;
		await this.context.editor.project.loadAllProjects();
		return this.context.editor.project
			.getSavedProjects()
			.some((project) => project.id === projectId);
	}

	private async verifiedProjectPersistence(projectId: string) {
		return readVerifiedProjectPersistence(projectId);
	}

	private async guard(
		request: AutomationActiveProjectMutationRequest,
	): Promise<AutomationLifecycleRejectedResult | null> {
		if (!request.operationId.trim()) {
			return rejected(request.operationId, "operationId is required");
		}
		return null;
	}

	private async sceneMutation(
		method: AutomationLifecycleMutationMethod,
		request: AutomationActiveProjectMutationRequest,
		apply: (plan: LifecycleMutationPlan) => {
			sceneId: string;
			affectedObjects: AutomationAffectedObject[];
		},
	): Promise<AutomationSceneMutationResult> {
		this.context.reconcileExternalChanges();
		const identityBlock = await this.context.blockedProductionRequest(request);
		if (identityBlock) return identityBlock;
		const fingerprint = stableSerialize({ method, request });
		const prior = this.sceneOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return rejected(
					request.operationId,
					"operationId was already used for a different scene operation",
				);
			}
			return { ...prior.result, status: "replayed" };
		}
		const blocked = await this.guard(request);
		if (blocked) return blocked;
		const plan = await this.requireLifecyclePreflight(method, request);
		if ("status" in plan) return plan;
		let applied: {
			sceneId: string;
			affectedObjects: AutomationAffectedObject[];
		};
		try {
			applied = apply(plan);
		} catch (error) {
			return rejected(request.operationId, errorMessage(error));
		}
		await this.context.editor.save.flush();
		this.context.recordCommittedState();
		await this.context.refreshContentIdentity();
		const result: SceneApplied = {
			status: "applied",
			operationId: request.operationId,
			revision: this.context.getRevision(),
			sceneId: applied.sceneId,
			activeSceneId: this.context.editor.scenes.getActiveScene().id,
			snapshot: this.context.buildSnapshot(),
			affectedObjects: applied.affectedObjects,
		};
		this.sceneOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private async mediaMutation(
		method: AutomationLifecycleMutationMethod,
		request: AutomationActiveProjectMutationRequest,
		stableRequest: unknown,
		apply: (plan: LifecycleMutationPlan) => Promise<{
			assetId: string;
			affectedObjects: AutomationAffectedObject[];
			differences?: AutomationMediaMutationAppliedResult["differences"];
			removedElementIds?: string[];
		}>,
	): Promise<AutomationMediaMutationResult> {
		this.context.reconcileExternalChanges();
		const identityBlock = await this.context.blockedProductionRequest(request);
		if (identityBlock) return identityBlock;
		const fingerprint = stableSerialize({ method, request: stableRequest });
		const prior = this.mediaOperations.get(request.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				return rejected(
					request.operationId,
					"operationId was already used for a different media operation",
				);
			}
			return { ...prior.result, status: "replayed" };
		}
		const blocked = await this.guard(request);
		if (blocked) return blocked;
		const plan = await this.requireLifecyclePreflight(method, request);
		if ("status" in plan) return plan;
		let applied: Awaited<ReturnType<typeof apply>>;
		try {
			applied = await apply(plan);
		} catch (error) {
			return rejected(request.operationId, errorMessage(error));
		}
		await this.context.editor.save.flush();
		this.context.recordCommittedState();
		await this.context.refreshContentIdentity();
		const result: MediaApplied = {
			status: "applied",
			operationId: request.operationId,
			revision: this.context.getRevision(),
			assetId: applied.assetId,
			snapshot: this.context.buildSnapshot(),
			affectedObjects: applied.affectedObjects,
			...(applied.differences ? { differences: applied.differences } : {}),
			...(applied.removedElementIds
				? { removedElementIds: applied.removedElementIds }
				: {}),
		};
		this.mediaOperations.set(request.operationId, { fingerprint, result });
		return result;
	}

	private async processTransfer(request: {
		url: string;
		name: string;
		mimeType: string;
	}): Promise<Omit<MediaAsset, "id">> {
		const response = await fetch(request.url);
		if (!response.ok) {
			throw new Error(`media transfer failed with HTTP ${response.status}`);
		}
		const blob = await response.blob();
		const file = new File([blob], request.name, { type: request.mimeType });
		const [asset] = await processMediaAssets({ files: [file] });
		if (!asset) throw new Error("OpenCut could not process the media file");
		return asset;
	}
}

export async function readVerifiedProjectPersistence(projectId: string) {
	const readback = await storageService.loadProjectFresh({ id: projectId });
	if (!readback) {
		throw new Error(`project ${projectId} could not be read back`);
	}
	const identity = await hashProjectContent(
		buildEditorProjectContentInput({
			project: readback.project,
			mediaAssets: readback.mediaAssets,
		}),
	);
	if (identity.status !== "hashed") {
		throw new Error(`project ${projectId} content identity is blocked`);
	}
	return {
		status: "verified" as const,
		projectId,
		sceneId: readback.project.currentSceneId,
		writeVersion: readback.persistence.writeVersion,
		storageSchemaVersion: readback.persistence.storageSchemaVersion,
		contentHash: identity.hash.digest,
		contentHashProjectionVersion: identity.hash.projectionVersion,
	};
}

function rejected(
	operationId: string,
	reason: string,
): AutomationLifecycleRejectedResult {
	return { status: "rejected", operationId, reason };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function differenceSnapshot(difference: MediaRelinkDifference) {
	return {
		field: difference.field,
		before: difference.before,
		after: difference.after,
	};
}

function sceneSummary({
	scene,
	order,
	activeSceneId,
}: {
	scene: TScene;
	order: number;
	activeSceneId: string;
}) {
	const tracks = [
		scene.tracks.main,
		...scene.tracks.overlay,
		...scene.tracks.audio,
	];
	return {
		sceneId: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		isActive: scene.id === activeSceneId,
		order,
		duration: calculateTotalDuration({ tracks: scene.tracks }),
		trackCount: tracks.length,
		elementCount: tracks.reduce(
			(total, track) => total + track.elements.length,
			0,
		),
		bookmarkCount: scene.bookmarks.length,
		createdAt: new Date(scene.createdAt).toISOString(),
		updatedAt: new Date(scene.updatedAt).toISOString(),
	};
}

/**
 * Hashes one scene through the project content projection so the digest uses
 * the same canonical field set (and bookmark identities) as the project hash.
 */
async function sceneContentHash({
	project,
	scene,
	editor,
}: {
	project: TProject;
	scene: TScene;
	editor: EditorCore;
}): Promise<string> {
	const canonical = buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: { ...project, scenes: [scene] },
			mediaAssets: editor.media.getAssets(),
		}),
	);
	const projected = canonical.project.scenes[0];
	return sha256Text(canonicalSerialize({ ...projected, order: 0 }));
}

function allElementIds(tracks: SceneTracks): string[] {
	const ids: string[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			ids.push(element.id);
			if (element.type === "compound")
				ids.push(...allElementIds(element.tracks));
		}
	}
	return ids;
}

function collectSceneUsages({
	scene,
	tracks,
	compoundElementId,
}: {
	scene: TScene;
	tracks: SceneTracks;
	compoundElementId?: string;
}): AutomationMediaUsage[] {
	const usages: AutomationMediaUsage[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements as TimelineElement[]) {
			const base = {
				sceneId: scene.id,
				trackId: track.id,
				elementId: element.id,
				...(compoundElementId ? { compoundElementId } : {}),
			};
			if (hasMediaId(element)) {
				usages.push({ ...base, assetId: element.mediaId, kind: "source" });
			}
			if (element.type === "video" && element.matte) {
				usages.push({ ...base, assetId: element.matte.assetId, kind: "matte" });
			}
			if (
				(element.type === "video" || element.type === "audio") &&
				element.audioReplacement
			) {
				usages.push({
					...base,
					assetId: element.audioReplacement.assetId,
					kind: "audio-replacement",
				});
			}
			if (element.type === "compound") {
				usages.push(
					...collectSceneUsages({
						scene,
						tracks: element.tracks,
						compoundElementId: element.id,
					}),
				);
			}
		}
	}
	return usages;
}

const PROJECT_LIFECYCLE_METHODS = new Set<AutomationLifecycleMutationMethod>([
	"rename_project",
	"duplicate_project",
	"delete_project",
]);

function stableLifecycleRequest(
	request: Record<string, unknown>,
): Record<string, unknown> {
	const {
		operationId: _operationId,
		preflightFingerprint: _preflightFingerprint,
		url: _url,
		preflightUrl: _preflightUrl,
		bridgeProtocolVersion: _bridgeProtocolVersion,
		expectedConnectionIdentity: _expectedConnectionIdentity,
		operationReceiptBinding: _operationReceiptBinding,
		editorInstanceId: _editorInstanceId,
		generation: _generation,
		sessionNonce: _sessionNonce,
		...stable
	} = request;
	return stable;
}

function rustLifecycleRequest(request: Record<string, unknown>) {
	const stable = stableLifecycleRequest(request);
	const field = (name: string) => stable[name];
	return {
		projectId: field("projectId") as string,
		expectedRevision: field("expectedRevision") as number | undefined,
		expectedProjectContentHash: field("expectedProjectContentHash") as
			| string
			| undefined,
		expectedTargetContentHash: field("expectedTargetContentHash") as
			| string
			| undefined,
		expectedTargetWriteVersion: field("expectedTargetWriteVersion") as
			| number
			| undefined,
		name: field("name") as string | undefined,
		fallbackProjectId: field("fallbackProjectId") as string | undefined,
		sceneId: field("sceneId") as string | undefined,
		newSceneId: field("newSceneId") as string | undefined,
		activate: field("activate") as boolean | undefined,
		replacementSceneId: field("replacementSceneId") as string | undefined,
		newMainSceneId: field("newMainSceneId") as string | undefined,
		sceneIds: field("sceneIds") as string[] | undefined,
		assetName: field("assetName") as string | undefined,
		assetId: field("assetId") as string | undefined,
		sourceFingerprint: field("sourceFingerprint") as string | undefined,
		mimeType: field("mimeType") as string | undefined,
		allowIncompatible: field("allowIncompatible") as boolean | undefined,
		policy: field("policy") as string | undefined,
	};
}

function requiredConsequenceString(
	plan: LifecycleMutationPlan,
	field: string,
): string {
	const value = plan.consequences[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Rust lifecycle plan omitted ${field}`);
	}
	return value;
}

function optionalConsequenceString(
	plan: LifecycleMutationPlan,
	field: string,
): string | undefined {
	const value = plan.consequences[field];
	if (value == null) return undefined;
	return requiredConsequenceString(plan, field);
}

function consequenceArray(
	plan: LifecycleMutationPlan,
	field: string,
): unknown[] {
	const value = plan.consequences[field];
	if (!Array.isArray(value)) {
		throw new Error(`Rust lifecycle plan omitted ${field}`);
	}
	return value;
}

function consequenceStringArray(
	plan: LifecycleMutationPlan,
	field: string,
): string[] {
	const value = plan.consequences[field];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Rust lifecycle plan omitted ${field}`);
	}
	return value;
}

function requiredConsequenceRecord(
	plan: LifecycleMutationPlan,
	field: string,
): Record<string, unknown> {
	const value = plan.consequences[field];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Rust lifecycle plan omitted ${field}`);
	}
	return value as Record<string, unknown>;
}

function requiredRecordString(
	value: Record<string, unknown>,
	field: string,
): string {
	const candidate = value[field];
	if (typeof candidate !== "string" || candidate.length === 0) {
		throw new Error(`Rust lifecycle plan omitted ${field}`);
	}
	return candidate;
}

function consequenceAllocationQueue(plan: LifecycleMutationPlan): {
	next: IdAllocator;
	assertConsumed: () => void;
} {
	const values = consequenceStringArray(plan, "identityAllocations");
	let index = 0;
	return {
		next: () => {
			const value = values[index++];
			if (!value) throw new Error("Rust lifecycle identity plan was exhausted");
			return value;
		},
		assertConsumed: () => {
			if (index !== values.length) {
				throw new Error("Rust lifecycle identity plan was not fully consumed");
			}
		},
	};
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} is required`);
	}
	return value;
}

function transferRequest(request: Record<string, unknown>): {
	url: string;
	name: string;
	mimeType: string;
} {
	return {
		url: requiredString(request.preflightUrl ?? request.url, "url"),
		name: requiredString(request.name, "name"),
		mimeType: requiredString(request.mimeType, "mimeType"),
	};
}

async function lifecycleIdentitySources({
	method,
	request,
	editor,
}: {
	method: AutomationLifecycleMutationMethod;
	request: Record<string, unknown>;
	editor: EditorCore;
}): Promise<string[]> {
	if (method === "create_scene") return ["scene", "main-track"];
	if (method === "import_media_asset") {
		return [
			`media:${requiredString(request.sourceFingerprint, "sourceFingerprint")}`,
		];
	}
	if (method === "delete_project") {
		const projectId = requiredString(request.projectId, "projectId");
		const needsBlankFallback =
			editor.project.getActiveOrNull()?.metadata.id === projectId &&
			!request.fallbackProjectId &&
			!editor.project
				.getSavedProjects()
				.some((project) => project.id !== projectId);
		return needsBlankFallback
			? ["fallback-project", "fallback-scene", "fallback-main-track"]
			: [];
	}
	if (method !== "clone_scene" && method !== "duplicate_project") return [];

	const sources: string[] = [method === "clone_scene" ? "scene" : "project"];
	let ordinal = 0;
	const allocate = () => {
		sources.push(`${method}:${ordinal}`);
		return `lifecycle-allocation-probe-${ordinal++}`;
	};
	if (method === "clone_scene") {
		const sceneId = requiredString(request.sceneId, "sceneId");
		const scene = editor.scenes
			.getScenes()
			.find((candidate) => candidate.id === sceneId);
		if (!scene) return sources;
		cloneSceneTracksWithNewIds({ tracks: scene.tracks, allocate });
		for (const _bookmark of scene.bookmarks) allocate();
		return sources;
	}

	const projectId = requiredString(request.projectId, "projectId");
	const loaded = await storageService.loadProjectFresh({ id: projectId });
	if (!loaded) return sources;
	remapProjectIdentities(loaded.project, allocate);
	return sources;
}

/**
 * Gives a copied project fresh scene, track, element, transition, and
 * bookmark identities while leaving media asset ids untouched.
 */
export function remapProjectIdentities(
	project: TProject,
	allocate: IdAllocator = generateUUID,
): TProject {
	const sceneIds = new Map(
		project.scenes.map((scene) => [scene.id, allocate()]),
	);
	const scenes = project.scenes.map((scene) => ({
		...scene,
		id: sceneIds.get(scene.id)!,
		tracks: cloneSceneTracksWithNewIds({ tracks: scene.tracks, allocate }),
		bookmarks: scene.bookmarks.map((bookmark) => ({
			...bookmark,
			id: allocate(),
		})),
	}));
	return {
		...project,
		scenes,
		currentSceneId:
			sceneIds.get(project.currentSceneId) ??
			scenes[0]?.id ??
			project.currentSceneId,
	};
}

function stableSerialize(value: unknown): string {
	return canonicalSerialize(JSON.parse(JSON.stringify(value)));
}

async function sha256Text(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
