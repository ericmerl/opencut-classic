import { Command, type CommandResult } from "./base-command";

export class BatchCommand extends Command {
	constructor(private commands: Command[]) {
		super();
	}

	execute(): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;
		const executedCommands: Command[] = [];

		try {
			for (const command of this.commands) {
				const result = command.execute();
				executedCommands.push(command);
				if (result?.selection !== undefined) {
					latestSelectionResult = result;
				}
			}
		} catch (error) {
			for (const command of executedCommands.reverse()) command.undo();
			throw error;
		}

		return latestSelectionResult;
	}

	undo(): void {
		for (const command of [...this.commands].reverse()) {
			command.undo();
		}
	}

	redo(): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;
		const redoneCommands: Command[] = [];

		try {
			for (const command of this.commands) {
				const result = command.redo();
				redoneCommands.push(command);
				if (result?.selection !== undefined) {
					latestSelectionResult = result;
				}
			}
		} catch (error) {
			for (const command of redoneCommands.reverse()) command.undo();
			throw error;
		}

		return latestSelectionResult;
	}
}
