import { Command, type CommandResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";

export class EditPlanCommandError extends Error {
	readonly code = "EDIT_PLAN_COMMAND_FAILED";

	constructor({
		operationIndex,
		message,
		options,
	}: {
		operationIndex: number;
		message: string;
		options?: { cause?: unknown };
	}) {
		super(message, options);
		this.name = "EditPlanCommandError";
		this.operationIndex = operationIndex;
	}

	readonly operationIndex: number;
}

export class SceneScopedCommand extends Command {
	constructor({
		editor,
		sceneId,
		command,
	}: {
		editor: EditorCore;
		sceneId: string;
		command: Command;
	}) {
		super();
		this.editor = editor;
		this.sceneId = sceneId;
		this.command = command;
	}

	private readonly editor: EditorCore;
	private readonly sceneId: string;
	private readonly command: Command;

	execute(): CommandResult | undefined {
		return this.inScene(() => this.command.execute());
	}

	async preparePersistence(): Promise<void> {
		await this.command.preparePersistence();
	}

	async rollbackPersistence(): Promise<void> {
		await this.command.rollbackPersistence();
	}

	undo(): void {
		this.inScene(() => this.command.undo());
	}

	redo(): CommandResult | undefined {
		return this.inScene(() => this.command.redo());
	}

	private inScene<TResult>(run: () => TResult): TResult | undefined {
		const priorSceneId = this.editor.scenes.getActiveScene().id;
		if (
			!this.editor.scenes.getScenes().some((scene) => scene.id === this.sceneId)
		) {
			throw new Error(`scene not found: ${this.sceneId}`);
		}
		const changesActiveScene = priorSceneId !== this.sceneId;
		const priorSelection = changesActiveScene
			? this.editor.selection.getSnapshot()
			: null;
		if (changesActiveScene) {
			this.editor.scenes.setScenes({
				scenes: this.editor.scenes.getScenes(),
				activeSceneId: this.sceneId,
			});
		}
		try {
			const result = run();
			return changesActiveScene ? undefined : result;
		} finally {
			if (changesActiveScene) {
				this.editor.scenes.setScenes({
					scenes: this.editor.scenes.getScenes(),
					activeSceneId: priorSceneId,
				});
				if (priorSelection) {
					this.editor.selection.restoreSnapshot({ snapshot: priorSelection });
				}
			}
		}
	}
}

export class SequentialEditPlanCommand<TOperation> extends Command {
	private readonly commands: Command[] = [];

	constructor({
		operations,
		buildCommand,
		stateFingerprint,
	}: {
		operations: readonly TOperation[];
		buildCommand: (input: {
			operation: TOperation;
			operationIndex: number;
		}) => Command;
		stateFingerprint: () => string;
	}) {
		super();
		this.operations = operations;
		this.buildCommand = buildCommand;
		this.stateFingerprint = stateFingerprint;
	}

	private readonly operations: readonly TOperation[];
	private readonly buildCommand: (input: {
		operation: TOperation;
		operationIndex: number;
	}) => Command;
	private readonly stateFingerprint: () => string;

	execute(): CommandResult | undefined {
		if (this.commands.length !== 0) {
			throw new Error("edit plan command has already executed");
		}
		let latestSelection: CommandResult | undefined;
		let activeOperationIndex = 0;
		try {
			for (const [operationIndex, operation] of this.operations.entries()) {
				activeOperationIndex = operationIndex;
				const before = this.stateFingerprint();
				const command = this.buildOperation({ operation, operationIndex });
				const result = command.execute();
				this.commands.push(command);
				if (this.stateFingerprint() === before) {
					throw new EditPlanCommandError({
						operationIndex,
						message: `operation ${operationIndex} completed without changing editor state`,
					});
				}
				if (result?.selection !== undefined) latestSelection = result;
			}
			return latestSelection;
		} catch (error) {
			const executed = [...this.commands];
			this.commands.length = 0;
			this.rollback({ commands: executed });
			if (error instanceof EditPlanCommandError) throw error;
			throw new EditPlanCommandError({
				operationIndex: activeOperationIndex,
				message:
					error instanceof Error ? error.message : "native edit command failed",
				options: { cause: error },
			});
		}
	}

	undo(): void {
		this.rollback({ commands: this.commands });
	}

	async preparePersistence(): Promise<void> {
		for (const command of this.commands) await command.preparePersistence();
	}

	async rollbackPersistence(): Promise<void> {
		for (const command of [...this.commands].reverse()) {
			await command.rollbackPersistence();
		}
	}

	redo(): CommandResult | undefined {
		let latestSelection: CommandResult | undefined;
		const redone: Command[] = [];
		try {
			for (const [operationIndex, command] of this.commands.entries()) {
				const before = this.stateFingerprint();
				const result = command.redo();
				redone.push(command);
				if (this.stateFingerprint() === before) {
					throw new EditPlanCommandError({
						operationIndex,
						message: `operation ${operationIndex} redo completed without changing editor state`,
					});
				}
				if (result?.selection !== undefined) latestSelection = result;
			}
			return latestSelection;
		} catch (error) {
			this.rollback({ commands: redone });
			throw error;
		}
	}

	private buildOperation({
		operation,
		operationIndex,
	}: {
		operation: TOperation;
		operationIndex: number;
	}): Command {
		try {
			return this.buildCommand({ operation, operationIndex });
		} catch (error) {
			throw new EditPlanCommandError({
				operationIndex,
				message:
					error instanceof Error
						? error.message
						: "native command build failed",
				options: { cause: error },
			});
		}
	}

	private rollback({ commands }: { commands: readonly Command[] }): void {
		let firstError: unknown = null;
		for (const command of [...commands].reverse()) {
			try {
				command.undo();
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) {
			throw new Error("edit plan rollback failed", { cause: firstError });
		}
	}
}
