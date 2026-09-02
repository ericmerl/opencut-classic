import type { EditorCore } from "@/core";
import type { PersistedProjectWrite } from "./project-manager";

type SaveManagerOptions = {
	debounceMs?: number;
};

const MAX_AUTOSAVE_RETRY_DELAY_MS = 30_000;

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private dirtyGeneration = 0;
	private persistedGeneration = 0;
	private inFlightSave: Promise<PersistedProjectWrite | null> | null = null;
	private lastPersistedWrite: PersistedProjectWrite | null = null;
	private lastSaveError: unknown = null;
	private lastFailedGeneration: number | null = null;
	private consecutiveSaveFailures = 0;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		debounceMs = 800,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave()) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.dirtyGeneration += 1;
		if (!this.isPaused) this.queueSave();
	}

	async flush(): Promise<PersistedProjectWrite | null> {
		if (!this.editor.project.getActiveOrNull()) return null;
		this.assertReadyForExplicitSave();
		if (!this.getIsDirty()) this.dirtyGeneration += 1;
		this.clearTimer();

		do {
			await this.getOrStartSaveDrain();
		} while (this.hasPendingSave());

		return this.lastPersistedWrite;
	}

	getIsDirty(): boolean {
		return this.hasPendingSave() || this.isSaving;
	}

	getLastSaveError(): unknown {
		return this.lastSaveError;
	}

	private queueSave({
		delayMs = this.debounceMs,
	}: { delayMs?: number } = {}): void {
		if (this.isPaused || this.inFlightSave) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			if (!this.canSave()) return;
			void this.getOrStartSaveDrain().catch((error: unknown) => {
				console.error("Failed to save project:", error);
			});
		}, delayMs);
	}

	private getOrStartSaveDrain(): Promise<PersistedProjectWrite | null> {
		if (this.inFlightSave) return this.inFlightSave;
		const save = this.drainSaves();
		this.inFlightSave = save;
		void save.then(
			() => this.finishSaveDrain({ save, succeeded: true }),
			() => this.finishSaveDrain({ save, succeeded: false }),
		);
		return save;
	}

	private async drainSaves(): Promise<PersistedProjectWrite | null> {
		this.isSaving = true;
		this.clearTimer();
		while (this.hasPendingSave()) {
			this.assertReadyForExplicitSave();
			const generation = this.dirtyGeneration;
			try {
				const persistedWrite = await this.editor.project.saveCurrentProject();
				if (!persistedWrite) {
					throw new Error("The active project closed before it could be saved");
				}
				this.lastPersistedWrite = persistedWrite;
				this.persistedGeneration = generation;
				this.lastSaveError = null;
				this.lastFailedGeneration = null;
				this.consecutiveSaveFailures = 0;
			} catch (error) {
				this.lastSaveError = error;
				this.lastFailedGeneration = generation;
				this.consecutiveSaveFailures += 1;
				throw error;
			}
		}
		return this.lastPersistedWrite;
	}

	private finishSaveDrain({
		save,
		succeeded,
	}: {
		save: Promise<PersistedProjectWrite | null>;
		succeeded: boolean;
	}): void {
		if (this.inFlightSave !== save) return;
		this.inFlightSave = null;
		this.isSaving = false;
		if (succeeded && this.hasPendingSave()) {
			this.queueSave();
			return;
		}
		if (
			!succeeded &&
			this.lastFailedGeneration !== null &&
			this.dirtyGeneration > this.lastFailedGeneration
		) {
			this.queueSave({ delayMs: this.getAutosaveRetryDelay() });
		}
	}

	private getAutosaveRetryDelay(): number {
		const baseDelay = Math.max(this.debounceMs, 1);
		const exponent = Math.min(this.consecutiveSaveFailures - 1, 5);
		return Math.min(baseDelay * 2 ** exponent, MAX_AUTOSAVE_RETRY_DELAY_MS);
	}

	private hasPendingSave(): boolean {
		return this.dirtyGeneration > this.persistedGeneration;
	}

	private canSave(): boolean {
		return (
			!this.isPaused &&
			Boolean(this.editor.project.getActiveOrNull()) &&
			!this.editor.project.getIsLoading() &&
			!this.editor.project.getMigrationState().isMigrating
		);
	}

	private assertReadyForExplicitSave(): void {
		if (this.isPaused) throw new Error("Project saving is paused");
		if (!this.editor.project.getActiveOrNull()) {
			throw new Error("No active project is available to save");
		}
		if (this.editor.project.getIsLoading()) {
			throw new Error("The active project is still loading");
		}
		if (this.editor.project.getMigrationState().isMigrating) {
			throw new Error("The active project is still migrating");
		}
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
