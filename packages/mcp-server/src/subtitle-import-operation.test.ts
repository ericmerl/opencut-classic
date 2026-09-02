import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorBridge } from "./editor-bridge";
import { McpLedgerBoundary } from "./mcp-ledger-boundary";
import { OperationLedger } from "./operation-ledger";
import {
	SubtitleImportOperation,
	type SubtitleImportInput,
} from "./subtitle-import-operation";

const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);
const ORIGINAL_SOURCE_HASH = "c".repeat(64);

describe("SubtitleImportOperation durable recovery", () => {
	test("reconstructs original source evidence after the file changes without rereading or redispatch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-subtitle-import-"));
		let ledger: OperationLedger | undefined;
		try {
			let sourceReads = 0;
			let currentSource = {
				fileName: "captions.srt",
				input: "1\n00:00:00,000 --> 00:00:01,000\nOriginal",
				bytesRead: 43,
				contentHash: ORIGINAL_SOURCE_HASH,
			};
			const subtitleFiles = {
				read: async () => {
					sourceReads += 1;
					return currentSource;
				},
			};
			const fixture = bridgeFixture();
			ledger = new OperationLedger(directory);
			let operation = new SubtitleImportOperation(fixture.bridge, subtitleFiles);
			const interrupted = await new McpLedgerBoundary(ledger, fixture.bridge, {
				ownerId: "subtitle-import-owner",
			}).execute(
				"opencut_import_subtitles",
				INPUT,
				(context) => operation.execute(INPUT, context),
				(context) => operation.recover(INPUT, context),
			);
			expect(interrupted).toMatchObject({ status: "recoverable" });
			ledger.close();
			ledger = undefined;

			currentSource = {
				fileName: "captions.srt",
				input: "1\n00:00:00,000 --> 00:00:01,000\nChanged",
				bytesRead: 42,
				contentHash: "d".repeat(64),
			};
			ledger = new OperationLedger(directory);
			operation = new SubtitleImportOperation(fixture.bridge, subtitleFiles);
			let restartedExecutions = 0;
			const recovered = await new McpLedgerBoundary(ledger, fixture.bridge, {
				ownerId: "subtitle-import-owner",
			}).execute(
				"opencut_import_subtitles",
				INPUT,
				async (context) => {
					restartedExecutions += 1;
					return operation.execute(INPUT, context);
				},
				(context) => operation.recover(INPUT, context),
			);

			expect(recovered).toMatchObject({
				status: "applied",
				sourcePath: INPUT.path,
				sourceBytes: 43,
				sourceSha256: ORIGINAL_SOURCE_HASH,
				durableOperationStatus: "completed",
			});
			expect({
				sourceReads,
				restartedExecutions,
				browserDispatches: fixture.browserDispatches(),
			}).toEqual({
				sourceReads: 1,
				restartedExecutions: 0,
				browserDispatches: 1,
			});
		} finally {
			ledger?.close();
			await rm(directory, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 50,
			});
		}
	});
});

const INPUT: SubtitleImportInput = {
	path: "C:/captions.srt",
	projectId: "project-1",
	operationId: "subtitle-source-restart",
	expectedRevision: 7,
	expectedProjectContentHash: BEFORE_HASH,
};

function bridgeFixture() {
	let browserDispatches = 0;
	let binding: unknown = null;
	const mutation = {
		status: "applied",
		operationId: INPUT.operationId,
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision: 8,
		trackId: "captions-1",
		snapshot: snapshot(AFTER_HASH, 8),
	};
	const bridge = {
		request: async (method: string, params: Record<string, unknown>) => {
			if (method === "import_subtitles") {
				browserDispatches += 1;
				binding = params.operationReceiptBinding;
				throw new Error("response lost after subtitle receipt commit");
			}
			if (method === "get_operation_receipt") {
				return {
					status: "found",
					operationId: INPUT.operationId,
					binding,
					afterState: {
						projectId: INPUT.projectId,
						sceneId: "scene-1",
						revisionAfter: 8,
						sessionRevisionAfter: 8,
						durableWriteVersion: 1,
						contentHashAfter: AFTER_HASH,
					},
					result: mutation,
				};
			}
			if (method === "save_project") return saveReceipt();
			if (method === "read_project") return snapshot(AFTER_HASH, 8);
			throw new Error(`unexpected bridge method ${method}`);
		},
	} as unknown as EditorBridge;
	return { bridge, browserDispatches: () => browserDispatches };
}

function snapshot(contentHash: string, revision: number) {
	return {
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision,
		contentIdentity: {
			status: "hashed",
			hash: { algorithm: "SHA-256", digest: contentHash },
		},
	};
}

function saveReceipt() {
	return {
		status: "saved",
		receiptId: `save:${INPUT.projectId}:1:${AFTER_HASH}`,
		operationId: `${INPUT.operationId}:ledger-save`,
		projectId: INPUT.projectId,
		sceneId: "scene-1",
		revision: 8,
		contentHash: AFTER_HASH,
		persistedAt: "2026-09-02T12:00:00.000Z",
		completedAt: "2026-09-02T12:00:01.000Z",
		storageSchemaVersion: 1,
		writeVersion: 1,
		reloadVerified: true,
		readbackContentHash: AFTER_HASH,
	};
}
