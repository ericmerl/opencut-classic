import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationExecutionContext } from "./execute-ledgered-operation";
import type { OperationCheckpoint, OperationLedgerRecord } from "./operation-ledger";
import { SubtitleFiles } from "./subtitle-files";
import {
	executeSubtitleExport,
	recoverSubtitleExport,
} from "./subtitle-export-operation";

describe("subtitle export durable publication", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-subtitle-recovery-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("recovers a published file after response loss without reserializing", async () => {
		let requests = 0;
		const bridge = {
			request: async () => {
				requests += 1;
				return serialized();
			},
		};
		const files = new SubtitleFiles();
		const context = fixtureContext({ failCommittedCheckpoint: true });
		const input = {
			operationId: "subtitle-op-1",
			outputPath: join(directory, "captions.srt"),
			format: "srt" as const,
		};
		await expect(
			executeSubtitleExport(bridge, files, input, context),
		).rejects.toThrow("simulated response loss");

		const recovered = await recoverSubtitleExport(
			bridge,
			files,
			input,
			context,
		);

		expect(recovered).toMatchObject({
			status: "replayed",
			projectId: "project-1",
			sceneId: "scene-1",
			bytesWritten: 44,
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(requests).toBe(1);
	});
});

function serialized() {
	return {
		status: "serialized",
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 4,
		format: "srt",
		trackIds: ["captions"],
		cueCount: 1,
		content: "1\n00:00:00,000 --> 00:00:01,000\nHello world\n",
		bridgeProtocolVersion: 2,
		connectionIdentity: null,
		requestConnectionIdentity: null,
		contentIdentity: null,
	};
}

function fixtureContext(
	options: { failCommittedCheckpoint?: boolean } = {},
): OperationExecutionContext {
	const checkpoints: OperationCheckpoint[] = [];
	return {
		record: () => ({ checkpoints }) as unknown as OperationLedgerRecord,
		checkpoint: async ({ checkpoint }) => {
			if (checkpoint.state === "committed" && options.failCommittedCheckpoint) {
				throw new Error("simulated response loss");
			}
			const prior = checkpoints.findIndex(
				(value) => value.checkpointId === checkpoint.checkpointId,
			);
			if (prior >= 0) checkpoints.splice(prior, 1, checkpoint);
			else checkpoints.push(checkpoint);
			return { checkpoints } as unknown as OperationLedgerRecord;
		},
	};
}
