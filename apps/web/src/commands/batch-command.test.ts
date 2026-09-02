/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { Command, type CommandResult } from "./base-command";
import { BatchCommand } from "./batch-command";

class AppendCommand extends Command {
	constructor({ values, value }: { values: string[]; value: string }) {
		super();
		this.values = values;
		this.value = value;
	}

	private values: string[];
	private value: string;

	execute(): CommandResult | undefined {
		this.values.push(this.value);
		return undefined;
	}

	undo(): void {
		this.values.pop();
	}
}

class FailingCommand extends Command {
	execute(): CommandResult | undefined {
		throw new Error("planned failure");
	}
}

describe("BatchCommand", () => {
	test("rolls back commands already executed when a later command fails", () => {
		const values: string[] = [];
		const command = new BatchCommand([
			new AppendCommand({ values, value: "first" }),
			new AppendCommand({ values, value: "second" }),
			new FailingCommand(),
		]);

		expect(() => command.execute()).toThrow("planned failure");
		expect(values).toEqual([]);
	});
});
