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

export interface CommandHistorySnapshot {
	activitySequence: number;
	history: Array<{ entryId: number; commandName: string }>;
	redo: Array<{ entryId: number; commandName: string }>;
	pending: { entryId: number; commandName: string } | null;
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
					this.editor.selection.restoreSnapshot({ snapshot: previousSelection });
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
			pending: this.pendingEntry
				? this.describeEntry(this.pendingEntry)
				: null,
			rippleEnabled: this.isRippleEnabled,
		};
	}

	private describeEntry(
		entry: CommandHistoryEntry,
	): { entryId: number; commandName: string } {
		return {
			entryId: entry.entryId,
			commandName: entry.command.constructor.name || "Command",
		};
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
