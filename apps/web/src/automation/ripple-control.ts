import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";

export class AutomationRippleCommand extends Command {
	constructor(private command: Command) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const beforeTracks = editor.scenes.getActiveScene().tracks;
		const result = this.command.execute();
		if (editor.command.isRippleEnabled) return result;
		const afterTracks = editor.scenes.getActiveScene().tracks;
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length > 0) {
			editor.timeline.updateTracks(
				applyRippleAdjustments({ tracks: afterTracks, adjustments }),
			);
		}
		return result;
	}

	undo(): void {
		this.command.undo();
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}
}

export function withRipple({
	command,
	enabled,
}: {
	command: Command;
	enabled: boolean | undefined;
}): Command {
	return enabled ? new AutomationRippleCommand(command) : command;
}
