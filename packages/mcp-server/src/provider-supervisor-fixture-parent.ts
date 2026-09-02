import { readFile, writeFile } from "node:fs/promises";
import { DurableProviderSupervisor } from "./provider-supervisor";
import type { ProviderSupervisorSubmission } from "./provider-supervisor-store";

const [directory, submissionPath, readyPath, commitDelayValue] =
	process.argv.slice(2);
if (!directory || !submissionPath || !readyPath) {
	throw new Error("fixture MCP parent arguments are required");
}
const submission = JSON.parse(
	await readFile(submissionPath, "utf8"),
) as ProviderSupervisorSubmission;
const supervisor = new DurableProviderSupervisor({
	directory,
	workerEnvironment: {
		OPENCUT_PROVIDER_SUPERVISOR_TEST_COMMIT_DELAY_MS:
			commitDelayValue ?? "0",
	},
});
await supervisor.submit(submission);
await writeFile(readyPath, String(process.pid));
await new Promise(() => undefined);
