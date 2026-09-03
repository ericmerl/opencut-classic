import type { EditorSelectionPatch } from "@/selection/editor-selection";
import type { ElementRef } from "@/timeline/types";

export interface CommandResult {
	selection?: EditorSelectionPatch;
}

export function createElementSelectionResult(
	selectedElements: ElementRef[],
): CommandResult {
	return {
		selection: {
			selectedElements,
			selectedKeyframes: [],
			keyframeSelectionAnchor: null,
			selectedMaskPoints: null,
		},
	};
}

export abstract class Command {
	abstract execute(): CommandResult | undefined;

	preparePersistence(): Promise<void> {
		return Promise.resolve();
	}

	rollbackPersistence(): Promise<void> {
		return Promise.resolve();
	}

	undo(): void {
		throw new Error("Undo not implemented for this command");
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}
}
