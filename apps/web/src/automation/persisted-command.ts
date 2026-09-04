import type { Command } from "@/commands/base-command";
import type { CommandManager } from "@/core/managers/commands";

/**
 * Runs a command whose durable side effects live in `preparePersistence` and
 * waits for them before the command joins history. Media-bin commands persist
 * asset metadata outside the project write, so a caller that verifies the
 * persisted project against the editor's after-state must see that metadata
 * land first. A persistence failure undoes the editor change and rolls the
 * stored metadata back before the error propagates.
 */
export async function executePersistedCommand({
	commands,
	command,
}: {
	commands: CommandManager;
	command: Command;
}): Promise<void> {
	const transaction = commands.begin({ command });
	try {
		await command.preparePersistence();
	} catch (error) {
		transaction.rollback();
		await command.rollbackPersistence().catch(() => undefined);
		throw error;
	}
	transaction.commit();
}
