import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HistoryCheckpointStore,
	type HistoryCheckpointRecord,
} from "./history-checkpoint-store";

let directory: string | null = null;

afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = null;
});

describe("durable history checkpoints", () => {
	test("survive restart with exact native history and stable bounded pagination", async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-history-checkpoints-"));
		const first = new HistoryCheckpointStore(directory);
		await first.readiness();
		await first.create(checkpoint("checkpoint-1", "First", 1));
		await first.create(checkpoint("checkpoint-2", "Second", 2));
		first.close();

		const restarted = new HistoryCheckpointStore(directory);
		await restarted.readiness();
		expect(await restarted.get("checkpoint-1")).toMatchObject({
			checkpointId: "checkpoint-1",
			name: "First",
			projectId: "project-1",
			contentHash: "a".repeat(64),
			connectionIdentity: {
				editorInstanceId: "editor-1",
				editorSessionId: "session-1",
			},
			nativeHistory: {
				history: [{ entryId: 1, commandName: "BatchCommand" }],
				redo: [],
			},
		});

		const firstPage = await restarted.list({ projectId: "project-1", limit: 1 });
		expect(firstPage.entries.map((entry) => entry.checkpointId)).toEqual([
			"checkpoint-2",
		]);
		expect(firstPage.nextCursor).toMatch(/^[1-9]\d*$/);
		const secondPage = await restarted.list({
			projectId: "project-1",
			limit: 1,
			cursor: firstPage.nextCursor!,
		});
		expect(secondPage.entries.map((entry) => entry.checkpointId)).toEqual([
			"checkpoint-1",
		]);
		expect(secondPage.nextCursor).toBeNull();
		restarted.close();
	});

	test("rejects reuse of a checkpoint identity", async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-history-checkpoints-"));
		const store = new HistoryCheckpointStore(directory);
		await store.readiness();
		await store.create(checkpoint("checkpoint-1", "First", 1));
		await expect(
			store.create(checkpoint("checkpoint-1", "Different", 1)),
		).rejects.toThrow("already exists");
		store.close();
	});
});

function checkpoint(
	checkpointId: string,
	name: string,
	entryId: number,
): HistoryCheckpointRecord {
	return {
		schemaVersion: "opencut.history-checkpoint.v1",
		checkpointId,
		operationId: `create-${checkpointId}`,
		name,
		projectId: "project-1",
		sceneId: "scene-1",
		revision: entryId,
		contentHash: "a".repeat(64),
		contentHashProjectionVersion: 3,
		createdAt: `2026-09-04T00:00:0${entryId}.000Z`,
		connectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
			bridgeProtocolVersion: 2,
		},
		nativeHistory: {
			activitySequence: entryId,
			history: [{ entryId, commandName: "BatchCommand" }],
			redo: [],
			pending: null,
			rippleEnabled: false,
		},
	};
}
