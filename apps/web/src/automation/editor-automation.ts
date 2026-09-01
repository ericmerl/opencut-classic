import { BatchCommand, type Command } from "@/commands";
import {
	InsertElementCommand,
	UpdateElementsCommand,
} from "@/commands/timeline";
import type { EditorCore } from "@/core";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { buildTextElement } from "@/timeline/element-utils";
import type {
	AutomationEditOperation,
	AutomationEditPlan,
	AutomationAppliedResult,
	AutomationMutationResult,
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
	private writer: Promise<void> = Promise.resolve();

	constructor(private editor: EditorCore) {}

	readProject(): AutomationProjectSnapshot {
		this.reconcileExternalChanges();
		return this.buildSnapshot();
	}

	applyEditPlan(plan: AutomationEditPlan): Promise<AutomationMutationResult> {
		return this.enqueue(() => this.applyEditPlanNow(plan));
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

		const element = this.findElement(operation.trackId, operation.elementId);
		if (!element) {
			throw new Error(
				`element not found: ${operation.trackId}/${operation.elementId}`,
			);
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
		return {
			projectId: this.getProjectId(),
			sceneId: scene.id,
			revision: this.revision,
			elements: this.getTracks().flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
					type: element.type,
					name: element.name,
					startTime: element.startTime,
					duration: element.duration,
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
				})),
			),
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

	private buildTimelineProjection(): unknown {
		const scene = this.editor.scenes.getActiveScene();
		return {
			projectId: this.getProjectId(),
			sceneId: scene.id,
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
