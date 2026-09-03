import type { Command } from "@/commands";
import type { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import type {
	ProjectSnapshot,
	ResolvedEditOperation,
	SourceBinding,
} from "opencut-wasm";
import { buildEditorProjectContentInput } from "./project-content-identity";
import {
	buildCanonicalProjectState,
	canonicalSerialize,
	hashProjectContent,
} from "./project-content-hash";
import { verifyEditPlanEvaluationIntegrity } from "./edit-plan-evaluation-integrity";
import { captureEditPlanPreflightSource } from "./edit-plan-preflight-source";
import {
	SceneScopedCommand,
	SequentialEditPlanCommand,
} from "./sequential-edit-plan-command";
import type { AutomationEditPlanV2 } from "./types";

export interface StrictEditPlanApplyEvidence {
	before: ProjectSnapshot;
	after: ProjectSnapshot;
	persistedWriteVersion: number;
}

export class StrictEditPlanApplyError extends Error {
	readonly code = "STRICT_EDIT_PLAN_APPLY_FAILED";
}

export async function executeStrictNativeEditPlan({
	editor,
	plan,
	sessionRevision,
	knownStateFingerprint,
	buildCommand,
	storage = storageService,
	captureSource = captureEditPlanPreflightSource,
}: {
	editor: EditorCore;
	plan: AutomationEditPlanV2;
	sessionRevision: number;
	knownStateFingerprint: string;
	buildCommand: (
		operation: ResolvedEditOperation,
		operationIndex: number,
	) => Command;
	storage?: Pick<typeof storageService, "loadProjectFreshReadOnly">;
	captureSource?: typeof captureEditPlanPreflightSource;
}): Promise<StrictEditPlanApplyEvidence> {
	const bindingError = validateApplyEnvelope(plan);
	if (bindingError) throw new StrictEditPlanApplyError(bindingError);
	const preflight = plan.preflight;
	if (!preflight) {
		throw new StrictEditPlanApplyError("V2 apply requires a durable preflight receipt");
	}
	const evaluation = preflight.evaluation;
	const expectedSource = sourceBinding(plan);
	const integrityError = await verifyEditPlanEvaluationIntegrity({
		evaluation,
		expectedSource,
		expectedOperations: plan.operations,
	});
	if (integrityError) throw new StrictEditPlanApplyError(integrityError);

	const source = await captureSource({
		editor,
		request: plan,
		sessionRevision,
		knownStateFingerprint,
	});
	if (source.status !== "captured") {
		throw new StrictEditPlanApplyError(source.reason);
	}
	const before = buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: source.readback.project,
			mediaAssets: source.readback.mediaAssets,
		}),
	);
	if (!equal({ left: before, right: evaluation.before })) {
		throw new StrictEditPlanApplyError(
			"fresh persisted source differs from native evaluation before-state",
		);
	}

	let transaction: ReturnType<EditorCore["command"]["begin"]> | null = null;
	let command: SceneScopedCommand | null = null;
	let savingPaused = false;
	try {
		editor.save.pause();
		savingPaused = true;
		command = new SceneScopedCommand({
			editor,
			sceneId: plan.sceneId,
			command: new SequentialEditPlanCommand({
				operations: evaluation.resolvedOperations,
				buildCommand: ({ operation, operationIndex }) =>
					buildCommand(operation, operationIndex),
				stateFingerprint: () => liveCanonical(editor),
			}),
		});
		transaction = editor.command.begin({
			command,
			useAmbientRipple: false,
		});
		const after = buildCanonicalProjectStateFromEditor(editor);
		const actualIdentity = await hashProjectContentFromEditor(editor);
		if (
			actualIdentity.status !== "hashed" ||
			actualIdentity.hash.digest !== evaluation.predictedProjectHash ||
			!equal({ left: after, right: evaluation.predictedAfter })
		) {
			throw new StrictEditPlanApplyError(
				"native apply result differs from the preflight prediction",
			);
		}
		await command.preparePersistence();

		editor.save.resume();
		savingPaused = false;
		editor.save.markDirty({ force: true });
		const write = await editor.save.flush();
		if (!write || write.writeVersion <= plan.expectedWriteVersion) {
			throw new StrictEditPlanApplyError(
				"strict apply did not produce a newer durable project write",
			);
		}
		await verifyPersistedAfter({
			plan,
			expected: after,
			expectedHash: evaluation.predictedProjectHash,
			expectedWriteVersion: write.writeVersion,
			storage,
		});
		transaction.commit();
		transaction = null;
		return { before, after, persistedWriteVersion: write.writeVersion };
	} catch (error) {
		const originalError = error;
		let rollbackError: unknown = null;
		try {
			transaction?.rollback();
		} catch (failure) {
			rollbackError = failure;
		}
		try {
			await command?.rollbackPersistence();
		} catch (failure) {
			rollbackError ??= failure;
		}
		if (savingPaused) editor.save.resume();
		if (transaction || rollbackError) {
			try {
				editor.save.markDirty({ force: true });
				await editor.save.flush();
			} catch (failure) {
				rollbackError ??= failure;
			}
		}
		if (rollbackError) {
			throw new StrictEditPlanApplyError("strict apply rollback could not be persisted", {
				cause: rollbackError,
			});
		}
		throw originalError;
	} finally {
		if (savingPaused) editor.save.resume();
	}
}

function validateApplyEnvelope(plan: AutomationEditPlanV2): string | null {
	if (!plan.preflight) return "V2 apply requires preflight evidence";
	if (!plan.preflight.preflightId.trim() || !plan.preflight.receiptId.trim()) {
		return "V2 preflight identifiers are required";
	}
	return null;
}

function sourceBinding(plan: AutomationEditPlanV2): SourceBinding {
	return {
		connectionIdentity: {
			...plan.expectedConnectionIdentity,
			bridgeProtocolVersion: 2,
		},
		projectId: plan.projectId,
		sceneId: plan.sceneId,
		sessionRevision: plan.expectedRevision,
		canonicalProjectHash: plan.expectedProjectContentHash,
		durableWriteVersion: plan.expectedWriteVersion,
		saveReceiptId: plan.expectedSaveReceiptId,
		saveOperationId: plan.saveReceiptOperationId,
	};
}

async function verifyPersistedAfter({
	plan,
	expected,
	expectedHash,
	expectedWriteVersion,
	storage,
}: {
	plan: AutomationEditPlanV2;
	expected: ProjectSnapshot;
	expectedHash: string;
	expectedWriteVersion: number;
	storage: Pick<typeof storageService, "loadProjectFreshReadOnly">;
}): Promise<void> {
	const readback = await storage.loadProjectFreshReadOnly({
		id: plan.projectId,
	});
	if (
		!readback ||
		!readback.project.scenes.some((scene) => scene.id === plan.sceneId) ||
		readback.persistence.writeVersion !== expectedWriteVersion
	) {
		throw new StrictEditPlanApplyError(
			"fresh persisted apply readback has the wrong project, scene, or write version",
		);
	}
	const persisted = buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: readback.project,
			mediaAssets: readback.mediaAssets,
		}),
	);
	const identity = await hashProjectContent(
		buildEditorProjectContentInput({
			project: readback.project,
			mediaAssets: readback.mediaAssets,
		}),
	);
	if (
		identity.status !== "hashed" ||
		identity.hash.digest !== expectedHash ||
		!equal({ left: persisted, right: expected })
	) {
		throw new StrictEditPlanApplyError(
			"fresh persisted apply readback differs from the verified native result",
		);
	}
}

function buildCanonicalProjectStateFromEditor(editor: EditorCore): ProjectSnapshot {
	const project = editor.project.getActive();
	if (!project) throw new StrictEditPlanApplyError("No active project");
	return buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: { ...project, scenes: editor.scenes.getScenes() },
			mediaAssets: editor.media.getAssets(),
		}),
	);
}

function hashProjectContentFromEditor(editor: EditorCore) {
	const project = editor.project.getActive();
	if (!project) throw new StrictEditPlanApplyError("No active project");
	return hashProjectContent(
		buildEditorProjectContentInput({
			project: { ...project, scenes: editor.scenes.getScenes() },
			mediaAssets: editor.media.getAssets(),
		}),
	);
}

function liveCanonical(editor: EditorCore): string {
	return canonicalSerialize(buildCanonicalProjectStateFromEditor(editor));
}

function equal({ left, right }: { left: unknown; right: unknown }): boolean {
	return canonicalSerialize(left) === canonicalSerialize(right);
}
