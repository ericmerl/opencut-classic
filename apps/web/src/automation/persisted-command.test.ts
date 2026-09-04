/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Command } from "@/commands/base-command";
import type { CommandManager } from "@/core/managers/commands";
import { executePersistedCommand } from "./persisted-command";

describe("executePersistedCommand", () => {
	test("waits for persistence before the command joins history", async () => {
		const events: string[] = [];
		let releasePersistence: () => void = () => {};
		const command = fakeCommand(events, {
			preparePersistence: () =>
				new Promise<void>((resolve) => {
					events.push("persist:start");
					releasePersistence = () => {
						events.push("persist:done");
						resolve();
					};
				}),
		});
		const commands = fakeCommandManager(events);

		const pending = executePersistedCommand({ commands, command });
		await Promise.resolve();
		expect(events).toEqual(["execute", "persist:start"]);
		releasePersistence();
		await pending;

		expect(events).toEqual([
			"execute",
			"persist:start",
			"persist:done",
			"commit",
		]);
	});

	test("undoes the editor change and rolls persistence back on failure", async () => {
		const events: string[] = [];
		const failure = new Error("quota exceeded");
		const command = fakeCommand(events, {
			preparePersistence: async () => {
				throw failure;
			},
		});
		const commands = fakeCommandManager(events);

		await expect(
			executePersistedCommand({ commands, command }),
		).rejects.toBe(failure);
		expect(events).toEqual(["execute", "rollback", "undo", "rollbackPersistence"]);
	});
});

function fakeCommand(
	events: string[],
	overrides: Partial<Command>,
): Command {
	return {
		execute: () => {
			events.push("execute");
			return undefined;
		},
		undo: () => {
			events.push("undo");
		},
		preparePersistence: async () => {
			events.push("preparePersistence");
		},
		rollbackPersistence: async () => {
			events.push("rollbackPersistence");
		},
		...overrides,
	} as unknown as Command;
}

function fakeCommandManager(events: string[]): CommandManager {
	return {
		begin: ({ command }: { command: Command }) => {
			command.execute();
			return {
				command,
				commit: () => {
					events.push("commit");
					return command;
				},
				rollback: () => {
					events.push("rollback");
					command.undo();
				},
			};
		},
	} as unknown as CommandManager;
}
