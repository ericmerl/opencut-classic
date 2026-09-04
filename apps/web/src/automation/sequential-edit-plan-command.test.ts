import { describe, expect, mock, test } from "bun:test";
import { Command } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import {
	EditPlanCommandError,
	SceneScopedCommand,
	SequentialEditPlanCommand,
} from "./sequential-edit-plan-command";

type TestOperation =
	| { kind: "create"; id: string }
	| { kind: "rename"; id: string; name: string }
	| { kind: "fail" }
	| { kind: "noop" };

describe("SequentialEditPlanCommand", () => {
	test("preserves the active scene and UI selection for a non-active scene command", () => {
		let activeSceneId = "scene-active";
		const scenes = [{ id: "scene-active" }, { id: "scene-target" }];
		const selection = {
			selectedElements: [{ trackId: "main", elementId: "active" }],
		};
		const restoreSnapshot = mock(() => undefined);
		const editor = Object.assign(Object.create(null), {
			scenes: {
				getActiveScene: () =>
					scenes.find((scene) => scene.id === activeSceneId)!,
				getScenes: () => scenes,
				setScenes: ({ activeSceneId: next }: { activeSceneId: string }) => {
					activeSceneId = next;
				},
			},
			selection: {
				getSnapshot: () => selection,
				restoreSnapshot,
			},
		}) as EditorCore;
		class SelectingCommand extends Command {
			execute() {
				return {
					selection: {
						selectedElements: [
							{ trackId: "target-main", elementId: "created" },
						],
					},
				};
			}
			undo(): void {}
		}

		const result = new SceneScopedCommand({
			editor,
			sceneId: "scene-target",
			command: new SelectingCommand(),
		}).execute();

		expect(result).toBeUndefined();
		expect(activeSceneId).toBe("scene-active");
		expect(restoreSnapshot).toHaveBeenCalledWith({ snapshot: selection });
	});

	test("builds later operations against state produced by earlier operations", () => {
		const state = new Map<string, string>();
		const builtAgainst: string[][] = [];
		const command = createPlanCommand({
			state,
			operations: [
				{ kind: "create", id: "resolved-1" },
				{ kind: "rename", id: "resolved-1", name: "Final" },
			],
			onBuild: () => builtAgainst.push([...state.keys()]),
		});

		command.execute();

		expect(builtAgainst).toEqual([[], ["resolved-1"]]);
		expect([...state.entries()]).toEqual([["resolved-1", "Final"]]);
		command.undo();
		expect([...state.entries()]).toEqual([]);
		command.redo();
		expect([...state.entries()]).toEqual([["resolved-1", "Final"]]);
	});

	test("rolls every prior operation back when a later operation fails", () => {
		const state = new Map<string, string>();
		const command = createPlanCommand({
			state,
			operations: [{ kind: "create", id: "resolved-1" }, { kind: "fail" }],
		});

		expect(() => command.execute()).toThrow(EditPlanCommandError);
		expect([...state.entries()]).toEqual([]);
	});

	test("turns a silent native no-op into a typed failure and rollback", () => {
		const state = new Map<string, string>();
		const command = createPlanCommand({
			state,
			operations: [{ kind: "create", id: "resolved-1" }, { kind: "noop" }],
		});

		try {
			command.execute();
			throw new Error("expected strict no-op rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(EditPlanCommandError);
			if (!(error instanceof EditPlanCommandError)) throw error;
			expect(error.operationIndex).toBe(1);
			expect(error.code).toBe("EDIT_PLAN_COMMAND_FAILED");
		}
		expect([...state.entries()]).toEqual([]);
	});
});

function createPlanCommand({
	state,
	operations,
	onBuild = () => undefined,
}: {
	state: Map<string, string>;
	operations: TestOperation[];
	onBuild?: () => void;
}): SequentialEditPlanCommand<TestOperation> {
	return new SequentialEditPlanCommand({
		operations,
		buildCommand: ({ operation }) => {
			onBuild();
			switch (operation.kind) {
				case "create":
					return new MapCommand({
						state,
						key: operation.id,
						before: undefined,
						after: "Created",
					});
				case "rename": {
					if (!state.has(operation.id)) throw new Error("missing resolved id");
					return new MapCommand({
						state,
						key: operation.id,
						before: state.get(operation.id),
						after: operation.name,
					});
				}
				case "fail":
					return new ThrowingCommand();
				case "noop":
					return new NoopCommand();
			}
		},
		stateFingerprint: () => JSON.stringify([...state.entries()]),
	});
}

class MapCommand extends Command {
	private readonly state: Map<string, string>;
	private readonly key: string;
	private readonly before: string | undefined;
	private readonly after: string;

	constructor({
		state,
		key,
		before,
		after,
	}: {
		state: Map<string, string>;
		key: string;
		before: string | undefined;
		after: string;
	}) {
		super();
		this.state = state;
		this.key = key;
		this.before = before;
		this.after = after;
	}

	execute(): undefined {
		this.state.set(this.key, this.after);
	}

	undo(): void {
		if (this.before === undefined) this.state.delete(this.key);
		else this.state.set(this.key, this.before);
	}
}

class ThrowingCommand extends Command {
	execute(): undefined {
		throw new Error("injected failure");
	}
}

class NoopCommand extends Command {
	execute(): undefined {}
	undo(): void {}
}
