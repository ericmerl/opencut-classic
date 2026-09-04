import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	entryId: number;
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
}

export interface CommandHistoryEntryDescription {
	entryId: number;
	commandName: string;
}

export interface CommandHistorySnapshot {
	activitySequence: number;
	history: CommandHistoryEntryDescription[];
	redo: CommandHistoryEntryDescription[];
	pending: CommandHistoryEntryDescription | null;
	rippleEnabled: boolean;
}

export interface PendingCommandTransaction {
	readonly command: Command;
	commit(): Command;
	rollback(): void;
}

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	private nextEntryId = 1;
	private activitySequence = 0;
	private pendingEntry: CommandHistoryEntry | null = null;

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const transaction = this.begin({ command });
		return transaction.commit();
	}

	begin({
		command,
		useAmbientRipple = this.isRippleEnabled,
	}: {
		command: Command;
		useAmbientRipple?: boolean;
	}): PendingCommandTransaction {
		if (this.pendingEntry) {
			throw new Error("a command transaction is already pending");
		}
		const beforeTracks = useAmbientRipple
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		let result: CommandResult | undefined;
		let selectionOverride: EditorSelectionSnapshot | undefined;
		let commandCompleted = false;
		try {
			result = command.execute();
			commandCompleted = true;
			this.applyRippleIfEnabled({ beforeTracks, enabled: useAmbientRipple });
			selectionOverride = this.applySelectionOverride(result);
			this.runReactors();
		} catch (error) {
			let rollbackError: unknown = null;
			if (commandCompleted) {
				try {
					command.undo();
					this.editor.selection.restoreSnapshot({
						snapshot: previousSelection,
					});
				} catch (failure) {
					rollbackError = failure;
				}
			}
			this.activitySequence += 1;
			try {
				this.runReactors();
			} catch (failure) {
				rollbackError ??= failure;
			}
			if (rollbackError) {
				throw new Error("command begin rollback failed", {
					cause: { error, rollbackError },
				});
			}
			throw error;
		}
		const entry: CommandHistoryEntry = {
			entryId: this.nextEntryId,
			command,
			previousSelection,
			selectionOverride,
		};
		this.nextEntryId += 1;
		this.activitySequence += 1;
		this.pendingEntry = entry;
		let settled = false;
		return {
			command,
			commit: () => {
				if (settled || this.pendingEntry !== entry) {
					throw new Error("command transaction is no longer pending");
				}
				settled = true;
				this.pendingEntry = null;
				this.history.push(entry);
				this.redoStack = [];
				this.activitySequence += 1;
				return command;
			},
			rollback: () => {
				if (settled || this.pendingEntry !== entry) {
					throw new Error("command transaction is no longer pending");
				}
				settled = true;
				try {
					entry.command.undo();
					if (entry.selectionOverride !== undefined) {
						this.editor.selection.restoreSnapshot({
							snapshot: entry.previousSelection,
						});
					}
					this.runReactors();
				} finally {
					this.pendingEntry = null;
					this.activitySequence += 1;
				}
			},
		};
	}

	push({ command }: { command: Command }): void {
		if (this.pendingEntry) {
			throw new Error("cannot push while a command transaction is pending");
		}
		this.history.push({
			entryId: this.nextEntryId,
			command,
			previousSelection: this.getSelectionSnapshot(),
		});
		this.nextEntryId += 1;
		this.redoStack = [];
		this.activitySequence += 1;
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.pendingEntry) {
			throw new Error("cannot undo while a command transaction is pending");
		}
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
			this.activitySequence += 1;
		}
	}

	undoSteps(steps: number): CommandHistoryEntryDescription[] {
		this.assertStepCount(steps);
		if (this.history.length < steps) {
			throw new Error(
				`cannot undo ${steps} steps; only ${this.history.length} undo ${this.history.length === 1 ? "entry is" : "entries are"} available`,
			);
		}
		const moved: CommandHistoryEntryDescription[] = [];
		for (let index = 0; index < steps; index += 1) {
			const entry = this.history.at(-1);
			if (!entry) throw new Error("native undo history changed unexpectedly");
			moved.push(this.describeEntry(entry));
			this.undo();
		}
		return moved;
	}

	redo(): void {
		if (this.pendingEntry) {
			throw new Error("cannot redo while a command transaction is pending");
		}
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.history.push({
			entryId: entry.entryId,
			command: entry.command,
			previousSelection,
			selectionOverride,
		});
		this.activitySequence += 1;
	}

	redoSteps(steps: number): CommandHistoryEntryDescription[] {
		this.assertStepCount(steps);
		if (this.redoStack.length < steps) {
			throw new Error(
				`cannot redo ${steps} steps; only ${this.redoStack.length} redo ${this.redoStack.length === 1 ? "entry is" : "entries are"} available`,
			);
		}
		const moved: CommandHistoryEntryDescription[] = [];
		for (let index = 0; index < steps; index += 1) {
			const entry = this.redoStack.at(-1);
			if (!entry) throw new Error("native redo history changed unexpectedly");
			moved.push(this.describeEntry(entry));
			this.redo();
		}
		return moved;
	}

	restoreHistorySnapshot(target: CommandHistorySnapshot): {
		undone: CommandHistoryEntryDescription[];
		redone: CommandHistoryEntryDescription[];
	} {
		if (this.pendingEntry || target.pending) {
			throw new Error("cannot restore history while a command is pending");
		}
		const current = this.getHistorySnapshot();
		const currentSequence = this.completeSequence(current);
		const targetSequence = this.completeSequence(target);
		const reconstructible =
			target.redo.length > 0
				? this.sameSequence(currentSequence, targetSequence)
				: this.sequenceStartsWith(currentSequence, targetSequence);
		if (!reconstructible) {
			throw new Error(
				"native history has diverged from the recorded checkpoint",
			);
		}

		const delta = current.history.length - target.history.length;
		return delta > 0
			? { undone: this.undoSteps(delta), redone: [] }
			: delta < 0
				? { undone: [], redone: this.redoSteps(-delta) }
				: { undone: [], redone: [] };
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		if (this.pendingEntry) {
			throw new Error("cannot clear while a command transaction is pending");
		}
		this.history = [];
		this.redoStack = [];
		this.activitySequence += 1;
	}

	getHistorySnapshot(): CommandHistorySnapshot {
		return {
			activitySequence: this.activitySequence,
			history: this.history.map((entry) => this.describeEntry(entry)),
			redo: this.redoStack.map((entry) => this.describeEntry(entry)),
			pending: this.pendingEntry ? this.describeEntry(this.pendingEntry) : null,
			rippleEnabled: this.isRippleEnabled,
		};
	}

	private describeEntry(
		entry: CommandHistoryEntry,
	): CommandHistoryEntryDescription {
		return {
			entryId: entry.entryId,
			commandName: entry.command.constructor.name || "Command",
		};
	}

	private assertStepCount(steps: number): void {
		if (!Number.isSafeInteger(steps) || steps < 1) {
			throw new Error("history step count must be a positive safe integer");
		}
	}

	private completeSequence(
		snapshot: CommandHistorySnapshot,
	): CommandHistoryEntryDescription[] {
		return [...snapshot.history, ...snapshot.redo.toReversed()];
	}

	private sameSequence(
		left: CommandHistoryEntryDescription[],
		right: CommandHistoryEntryDescription[],
	): boolean {
		return left.length === right.length && this.sequenceStartsWith(left, right);
	}

	private sequenceStartsWith(
		sequence: CommandHistoryEntryDescription[],
		prefix: CommandHistoryEntryDescription[],
	): boolean {
		return prefix.every(
			(entry, index) =>
				sequence[index]?.entryId === entry.entryId &&
				sequence[index]?.commandName === entry.commandName,
		);
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private applyRippleIfEnabled({
		beforeTracks,
		enabled = this.isRippleEnabled,
	}: {
		beforeTracks: SceneTracks | null;
		enabled?: boolean;
	}): void {
		if (!enabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
