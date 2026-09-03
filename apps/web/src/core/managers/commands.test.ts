import { describe, expect, mock, test } from "bun:test";
import { Command, type CommandResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { CommandManager } from "./commands";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
}));

const emptySelection: EditorSelectionSnapshot = {
	selectedElements: [],
	selectedKeyframes: [],
	keyframeSelectionAnchor: null,
	selectedMaskPoints: null,
};

class CountingCommand extends Command {
	constructor(private readonly state: { value: number }) {
		super();
	}

	execute(): CommandResult | undefined {
		this.state.value += 1;
		return undefined;
	}

	undo(): void {
		this.state.value -= 1;
	}
}

describe("CommandManager pending transactions", () => {
	test("publishes one native history entry only after commit", () => {
		const state = { value: 0 };
		const manager = createManager();
		const transaction = manager.begin({
			command: new CountingCommand(state),
			useAmbientRipple: false,
		});

		expect(state.value).toBe(1);
		expect(manager.canUndo()).toBe(false);
		expect(manager.getHistorySnapshot()).toMatchObject({
			history: [],
			redo: [],
			pending: { entryId: 1, commandName: "CountingCommand" },
			rippleEnabled: false,
		});

		transaction.commit();
		expect(manager.canUndo()).toBe(true);
		expect(manager.getHistorySnapshot()).toMatchObject({
			history: [{ entryId: 1, commandName: "CountingCommand" }],
			redo: [],
			pending: null,
		});
	});

	test("rolls native state back without publishing undo history", () => {
		const state = { value: 0 };
		const manager = createManager();
		const transaction = manager.begin({
			command: new CountingCommand(state),
			useAmbientRipple: false,
		});

		transaction.rollback();

		expect(state.value).toBe(0);
		expect(manager.canUndo()).toBe(false);
		expect(manager.canRedo()).toBe(false);
		expect(manager.getHistorySnapshot()).toMatchObject({
			history: [],
			redo: [],
			pending: null,
		});
	});

	test("rejects interleaved native history changes while pending", () => {
		const manager = createManager();
		const state = { value: 0 };
		const transaction = manager.begin({
			command: new CountingCommand(state),
			useAmbientRipple: false,
		});

		expect(() => manager.undo()).toThrow("pending");
		expect(() =>
			manager.begin({ command: new CountingCommand(state) }),
		).toThrow("already pending");

		transaction.rollback();
	});

	test("rolls back command state when a post-execute boundary fails", () => {
		const state = { value: 0 };
		const restoreSnapshot = mock(() => undefined);
		const manager = createManager({
			applySelectionPatch: () => {
				throw new Error("selection failed");
			},
			restoreSnapshot,
		});
		class SelectingCommand extends CountingCommand {
			execute() {
				super.execute();
				return { selection: emptySelection };
			}
		}

		expect(() =>
			manager.begin({
				command: new SelectingCommand(state),
				useAmbientRipple: false,
			}),
		).toThrow("selection failed");
		expect(state.value).toBe(0);
		expect(restoreSnapshot).toHaveBeenCalledWith({ snapshot: emptySelection });
		expect(manager.getHistorySnapshot()).toMatchObject({
			history: [],
			redo: [],
			pending: null,
		});
	});
});

function createManager(
	selectionOverrides: Partial<EditorCore["selection"]> = {},
): CommandManager {
	const editor: EditorCore = Object.assign(Object.create(null), {
		scenes: { getActiveSceneOrNull: () => null },
		selection: {
			getSnapshot: () => emptySelection,
			applySelectionPatch: () => emptySelection,
			restoreSnapshot: () => undefined,
			...selectionOverrides,
		},
		timeline: { updateTracks: () => undefined },
	});
	return new CommandManager(editor);
}
