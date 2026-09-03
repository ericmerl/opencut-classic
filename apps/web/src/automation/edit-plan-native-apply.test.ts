/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline";
import type {
	EditPlanEvaluation,
	ProjectSnapshot,
	ResolvedEditOperation,
	SourceBinding,
} from "opencut-wasm";
import type { AutomationEditPlanV2 } from "./types";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	TICKS_PER_SECOND: 120000,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundMediaTime: ({ time }: { time: number }) => time,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
}));

const { Command } = await import("@/commands/base-command");
const { mediaTime } = await import("@/wasm");
const { executeStrictNativeEditPlan } =
	await import("./edit-plan-native-apply");
const { buildEditorProjectContentInput } =
	await import("./project-content-identity");
const { buildCanonicalProjectState, canonicalSerialize } =
	await import("./project-content-hash");
const { diffProjectSnapshots } =
	await import("./edit-plan-evaluation-integrity");

describe("strict native edit-plan apply", () => {
	test("applies to a non-active scene as one history entry and verifies persistence", async () => {
		const fixture = await buildFixture();
		const evidence = await executeStrictNativeEditPlan({
			editor: fixture.editor,
			plan: fixture.plan,
			sessionRevision: 4,
			knownStateFingerprint: "known",
			captureSource: fixture.captureSource,
			storage: fixture.storage,
			buildCommand: () => fixture.command(),
		});

		expect(evidence.after).toEqual(fixture.evaluation.predictedAfter);
		expect(evidence.persistedWriteVersion).toBe(2);
		expect(fixture.state.activeSceneId).toBe("scene-active");
		expect(fixture.state.historyCommits).toBe(1);
		expect(fixture.state.flushes).toBe(1);
		expect(fixture.state.persistencePrepared).toBe(1);
		expect(fixture.state.persistenceRolledBack).toBe(0);
	});

	test("rolls back and durably restores every command when prediction differs", async () => {
		const fixture = await buildFixture();

		await expect(
			executeStrictNativeEditPlan({
				editor: fixture.editor,
				plan: fixture.plan,
				sessionRevision: 4,
				knownStateFingerprint: "known",
				captureSource: fixture.captureSource,
				storage: fixture.storage,
				buildCommand: () => fixture.command("#445566"),
			}),
		).rejects.toThrow();
		expect(fixture.state.project.settings.background).toEqual({
			type: "color",
			color: "#000000",
		});
		expect(fixture.state.historyCommits).toBe(0);
		expect(fixture.state.flushes).toBe(1);
		expect(fixture.state.activeSceneId).toBe("scene-active");
		expect(fixture.state.persistencePrepared).toBe(0);
		expect(fixture.state.persistenceRolledBack).toBe(1);
	});
});

async function buildFixture() {
	const beforeProject = projectFixture();
	const afterProject = structuredClone(beforeProject);
	afterProject.settings.background = { type: "color", color: "#112233" };
	const before = snapshot(beforeProject);
	const after = snapshot(afterProject);
	const beforeHash = await hash(before);
	const afterHash = await hash(after);
	const source: SourceBinding = {
		connectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 2,
			bridgeProtocolVersion: 2,
		},
		projectId: "project-1",
		sceneId: "scene-target",
		sessionRevision: 4,
		canonicalProjectHash: beforeHash,
		durableWriteVersion: 1,
		saveReceiptId: "receipt-1",
		saveOperationId: "save-1",
	};
	const operation: ResolvedEditOperation = {
		kind: "set_project_settings",
		fps: null,
		canvasSize: null,
		background: { type: "color", color: "#112233" },
	};
	const requirements = {
		editPlanReady: true,
		providerExecution: "forbidden" as const,
		cost: { status: "not-applicable" as const },
		hash: await hash({
			editPlanReady: true,
			providerExecution: "forbidden",
			cost: { status: "not-applicable" },
		}),
	};
	const changedObjects = diffProjectSnapshots({ before, after });
	const planDiffHash = await hash({
		predictedProjectHash: afterHash,
		changedObjects,
		timingConsequences: [],
		rippleExpansion: [],
		relationshipExpansion: [],
	});
	const evaluation: EditPlanEvaluation = {
		schemaVersion: "opencut.edit-plan-preflight.v2",
		source,
		planFingerprint: "a".repeat(64),
		preflightFingerprint: "b".repeat(64),
		planDiffHash,
		predictedProjectHash: afterHash,
		beforeSummary: summary({
			snapshotValue: before,
			canonicalHash: beforeHash,
		}),
		predictedAfterSummary: summary({
			snapshotValue: after,
			canonicalHash: afterHash,
		}),
		before,
		predictedAfter: after,
		resolvedOperations: [operation],
		resolvedIds: [],
		changedObjects,
		timingConsequences: [],
		rippleExpansion: [],
		relationshipExpansion: [],
		warnings: [],
		requirements,
		cost: requirements.cost,
	};
	const plan: AutomationEditPlanV2 = {
		contractVersion: 2,
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 2,
		},
		projectId: "project-1",
		sceneId: "scene-target",
		operationId: "apply-1",
		expectedRevision: 4,
		expectedProjectContentHash: beforeHash,
		expectedWriteVersion: 1,
		saveReceiptOperationId: "save-1",
		expectedSaveReceiptId: "receipt-1",
		description: "change background",
		operations: [operation],
		preflight: {
			preflightId: "preflight-1",
			receiptId: "ledger-1",
			evaluation,
		},
	};
	const state = {
		project: structuredClone(beforeProject),
		activeSceneId: "scene-active",
		persisted: structuredClone(beforeProject),
		writeVersion: 1,
		historyCommits: 0,
		flushes: 0,
		persistencePrepared: 0,
		persistenceRolledBack: 0,
	};
	const editor = buildEditor(state);
	class SettingsCommand extends Command {
		private prior = state.project.settings.background;
		constructor(private readonly color: string) {
			super();
		}
		execute() {
			this.prior = state.project.settings.background;
			state.project = {
				...state.project,
				settings: {
					...state.project.settings,
					background: { type: "color", color: this.color },
				},
			};
			return undefined;
		}
		undo() {
			state.project = {
				...state.project,
				settings: { ...state.project.settings, background: this.prior },
			};
		}
		preparePersistence() {
			state.persistencePrepared += 1;
			return Promise.resolve();
		}
		rollbackPersistence() {
			state.persistenceRolledBack += 1;
			return Promise.resolve();
		}
	}
	return {
		state,
		editor,
		plan,
		evaluation,
		command: (color = "#112233") => new SettingsCommand(color),
		captureSource: async () => ({
			status: "captured" as const,
			readback: readback({ project: beforeProject, writeVersion: 1 }),
			scene: beforeProject.scenes[1]!,
			contentIdentity: {
				status: "hashed" as const,
				hash: {
					projection: "opencut-project-content" as const,
					projectionVersion: 1 as const,
					algorithm: "SHA-256" as const,
					digest: beforeHash,
				},
			},
			observation: {
				projectId: "project-1",
				sceneId: "scene-target",
				sessionRevision: 4,
				canonicalProjectHash: beforeHash,
				durableWriteVersion: 1,
				saveReceiptId: "receipt-1",
				saveOperationId: "save-1",
				connectionIdentity: {
					...source.connectionIdentity,
					bridgeProtocolVersion: 2 as const,
				},
				activeProjectId: "project-1",
				activeSceneId: "scene-active",
				playheadTicks: mediaTime({ ticks: 0 }),
				isPlaying: false,
				selectionFingerprint: "1".repeat(64),
				historyFingerprint: "2".repeat(64),
				persistenceFingerprint: "3".repeat(64),
			},
		}),
		storage: {
			loadProjectFreshReadOnly: async () =>
				readback({
					project: state.persisted,
					writeVersion: state.writeVersion,
				}),
		},
	};
}

function buildEditor(state: {
	project: TProject;
	activeSceneId: string;
	persisted: TProject;
	writeVersion: number;
	historyCommits: number;
	flushes: number;
	persistencePrepared: number;
	persistenceRolledBack: number;
}): EditorCore {
	const editor: EditorCore = Object.assign(Object.create(null), {
		project: {
			getActive: () => state.project,
			getActiveOrNull: () => state.project,
			setActiveProject: ({ project }: { project: TProject }) => {
				state.project = project;
			},
		},
		scenes: {
			getScenes: () => state.project.scenes,
			getActiveScene: () =>
				state.project.scenes.find((scene) => scene.id === state.activeSceneId)!,
			setScenes: ({
				scenes,
				activeSceneId,
			}: {
				scenes: TScene[];
				activeSceneId?: string;
			}) => {
				state.project = { ...state.project, scenes };
				if (activeSceneId) state.activeSceneId = activeSceneId;
			},
		},
		media: { getAssets: () => [] },
		selection: {
			getSnapshot: () => ({ selectedElements: [] }),
			restoreSnapshot: () => undefined,
			applySelectionPatch: () => ({ selectedElements: [] }),
		},
		command: {
			begin: ({ command }: { command: InstanceType<typeof Command> }) => {
				command.execute();
				let settled = false;
				return {
					command,
					commit: () => {
						if (settled) throw new Error("settled");
						settled = true;
						state.historyCommits += 1;
						return command;
					},
					rollback: () => {
						if (settled) throw new Error("settled");
						settled = true;
						command.undo();
					},
				};
			},
		},
		save: {
			pause: () => undefined,
			resume: () => undefined,
			markDirty: () => undefined,
			flush: async () => {
				state.flushes += 1;
				state.writeVersion += 1;
				state.persisted = structuredClone(state.project);
				return { writeVersion: state.writeVersion };
			},
		},
	});
	return editor;
}

function projectFixture(): TProject {
	const created = new Date("2026-09-02T00:00:00.000Z");
	const scene = ({ id, isMain }: { id: string; isMain: boolean }): TScene => ({
		id,
		name: id,
		isMain,
		tracks: {
			main: {
				id: `${id}-main`,
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [],
			audio: [],
		},
		bookmarks: [],
		createdAt: created,
		updatedAt: created,
	});
	return {
		metadata: {
			id: "project-1",
			name: "Apply fixture",
			duration: mediaTime({ ticks: 0 }),
			createdAt: created,
			updatedAt: created,
		},
		scenes: [
			scene({ id: "scene-active", isMain: true }),
			scene({ id: "scene-target", isMain: false }),
		],
		currentSceneId: "scene-active",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}

function snapshot(project: TProject): ProjectSnapshot {
	return buildCanonicalProjectState(
		buildEditorProjectContentInput({ project, mediaAssets: [] }),
	);
}

function readback({
	project,
	writeVersion,
}: {
	project: TProject;
	writeVersion: number;
}) {
	return {
		project: structuredClone(project),
		mediaAssets: [],
		persistence: {
			projectId: "project-1",
			storageSchemaVersion: 1,
			writeVersion,
			snapshotAt: "2026-09-02T00:00:00.000Z",
			completedAt: "2026-09-02T00:00:01.000Z",
		},
	};
}

function summary({
	snapshotValue,
	canonicalHash,
}: {
	snapshotValue: ProjectSnapshot;
	canonicalHash: string;
}) {
	return {
		canonicalHash,
		trackCount: snapshotValue.project.scenes.length,
		elementCount: 0,
		transitionCount: 0,
		durationTicks: 0,
	};
}

async function hash(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalSerialize(value)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
