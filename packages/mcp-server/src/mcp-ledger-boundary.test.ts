import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorBridge } from "./editor-bridge";
import { McpLedgerBoundary } from "./mcp-ledger-boundary";
import { OperationLedger } from "./operation-ledger";

describe("MCP ledger handler recovery", () => {
	test("recovers a save from its envelope receipt without redispatching the save", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-save-envelope-"));
		const input = {
			bridgeProtocolVersion: 2,
			projectId: "project-1",
			sceneId: "scene-1",
			operationId: "save-before-response-loss",
			expectedRevision: 8,
			expectedContentHash: "a".repeat(64),
		};
		const saved = {
			...saveReceipt(input.operationId, "a"),
			operationId: input.operationId,
			receiptId: `save:project-1:1:${"a".repeat(64)}`,
		};
		let receiptReads = 0;
		let recoveryRequests = 0;
		const bridge = {
			request: async (method: string, params: unknown) => {
				if (method === "read_project") return projectSnapshot("a");
				if (method === "get_operation_receipt") {
					receiptReads += 1;
					return { status: "not-found", operationId: input.operationId };
				}
				if (method === "recover_save_project") {
					recoveryRequests += 1;
					expect(params).toEqual(input);
					return { ...saved, status: "replayed" };
				}
				throw new Error(`unexpected method ${method}`);
			},
		} as unknown as EditorBridge;
		let ledger = new OperationLedger(directory);
		const interrupted = await new McpLedgerBoundary(ledger, bridge, {
			ownerId: "opencut-mcp:101:dead-process",
		}).execute("opencut_save_project", input, async (context) => {
			await context.prepareBrowserMutation("save_project", input);
			throw new Error(
				"browser died after envelope commit, before receipt commit",
			);
		});
		expect(interrupted).toMatchObject({ status: "recoverable" });
		ledger.close();

		ledger = new OperationLedger(directory);
		let saveExecutions = 0;
		let recoveryReads = 0;
		const recovered = await new McpLedgerBoundary(ledger, bridge, {
			ownerId: "opencut-mcp:202:restarted-process",
		}).execute(
			"opencut_save_project",
			input,
			async () => {
				saveExecutions += 1;
				return saved;
			},
			async () => {
				recoveryReads += 1;
				return bridge.request("recover_save_project", input);
			},
		);
		expect(recovered).toMatchObject({
			status: "replayed",
			durableOperationStatus: "completed",
			receiptId: saved.receiptId,
			writeVersion: saved.writeVersion,
		});
		expect({
			receiptReads,
			recoveryReads,
			recoveryRequests,
			saveExecutions,
		}).toEqual({
			receiptReads: 1,
			recoveryReads: 1,
			recoveryRequests: 1,
			saveExecutions: 0,
		});
		ledger.close();
		await rm(directory, { recursive: true, force: true });
	});

	test("recovers pre-response browser commit through verification-only save without redispatch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-browser-receipt-"));
		const input = {
			bridgeProtocolVersion: 2,
			projectId: "project-1",
			operationId: "browser-restart-edit",
			expectedRevision: 7,
			expectedProjectContentHash: "a".repeat(64),
		};
		const mutation = {
			status: "applied",
			operationId: input.operationId,
			projectId: "project-1",
			sceneId: "scene-1",
			revision: 8,
			snapshot: projectSnapshot("b"),
			affectedObjects: [
				{ objectType: "element", objectId: "clip-1", action: "updated" },
				{
					objectType: "relationship",
					objectId: "link:dialogue-1",
					action: "updated",
				},
			],
		};
		let mutationCalls = 0;
		let verificationCalls = 0;
		let receiptReads = 0;
		const bridge = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "save_project") {
					throw new Error("normal save must not run during recovery");
				}
				if (method === "verify_operation_receipt") {
					verificationCalls += 1;
					return saveReceipt(input.operationId, "b");
				}
				if (method === "read_project")
					return { ...projectSnapshot("b"), revision: 0 };
				if (method === "get_operation_receipt") {
					return {
						status: "found",
						operationId: input.operationId,
						binding: params.binding,
						afterState: {
							projectId: "project-1",
							sceneId: "scene-1",
							revisionAfter: 8,
							sessionRevisionAfter: 8,
							durableWriteVersion: 1,
							contentHashAfter: "b".repeat(64),
						},
						result: mutation,
					};
				}
				if (method === "get_save_receipt") {
					receiptReads += 1;
					return { status: "not-found", operationId: params.operationId };
				}
				throw new Error(`unexpected method ${method}`);
			},
		} as unknown as EditorBridge;
		let ledger = new OperationLedger(directory);
		const interrupted = await new McpLedgerBoundary(ledger, bridge, {
			ownerId: "test-owner",
		}).execute("opencut_apply_edit_plan", input, async (context) => {
			mutationCalls += 1;
			await context.prepareBrowserMutation("apply_edit_plan", input);
			throw new Error("socket lost after browser receipt commit");
		});
		expect(interrupted).toMatchObject({ status: "recoverable" });
		ledger.close();

		ledger = new OperationLedger(directory);
		let effects = 0;
		const recovered = await new McpLedgerBoundary(ledger, bridge, {
			ownerId: "test-owner",
		}).execute("opencut_apply_edit_plan", input, async () => {
			effects += 1;
			return mutation;
		});
		expect(recovered).toMatchObject({
			status: "applied",
			durableOperationStatus: "completed",
			operationRecord: {
				contentHashAfter: "b".repeat(64),
				saveReceipt: { operationId: `${input.operationId}:ledger-save` },
				affectedObjects: expect.arrayContaining([
					{ objectType: "element", objectId: "clip-1", action: "updated" },
					{
						objectType: "relationship",
						objectId: "link:dialogue-1",
						action: "updated",
					},
				]),
			},
		});
		expect({ mutationCalls, verificationCalls, receiptReads, effects }).toEqual(
			{
				mutationCalls: 1,
				verificationCalls: 1,
				receiptReads: 1,
				effects: 0,
			},
		);
		ledger.close();
		await rm(directory, { recursive: true, force: true });
	});

	test("reconstructs an exact composite subtitle result without treating its inner receipt as terminal", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-composite-receipt-"),
		);
		const input = {
			projectId: "project-1",
			operationId: "subtitle-composite",
			expectedRevision: 7,
			expectedProjectContentHash: "a".repeat(64),
			path: "C:/captions.srt",
		};
		const mutation = {
			status: "applied",
			operationId: input.operationId,
			projectId: "project-1",
			sceneId: "scene-1",
			revision: 8,
			snapshot: projectSnapshot("b"),
			trackId: "captions-1",
		};
		let browserDispatches = 0;
		const bridge = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "get_operation_receipt") {
					return {
						status: "found",
						operationId: input.operationId,
						binding: params.binding,
						afterState: {
							projectId: "project-1",
							sceneId: "scene-1",
							revisionAfter: 8,
							sessionRevisionAfter: 8,
							durableWriteVersion: 1,
							contentHashAfter: "b".repeat(64),
						},
						result: mutation,
					};
				}
				if (method === "save_project")
					return saveReceipt(input.operationId, "b");
				if (method === "read_project") return projectSnapshot("b");
				throw new Error(`unexpected method ${method}`);
			},
		} as unknown as EditorBridge;
		let ledger = new OperationLedger(directory);
		const ownerId = "subtitle-composite-owner";
		const interrupted = await new McpLedgerBoundary(ledger, bridge, {
			ownerId,
		}).execute("opencut_import_subtitles", input, async (context) => {
			browserDispatches += 1;
			await context.prepareBrowserStep(
				"import_subtitles",
				{ ...input, input: "1\n00:00:00,000 --> 00:00:01,000\nHi" },
				"import-subtitles:browser-mutation",
			);
			throw new Error("response lost after composite browser receipt");
		});
		expect(interrupted).toMatchObject({ status: "recoverable" });
		ledger.close();

		ledger = new OperationLedger(directory);
		const withoutFinalizer = await new McpLedgerBoundary(ledger, bridge, {
			ownerId,
		}).execute("opencut_import_subtitles", input, async () => mutation);
		expect(withoutFinalizer).toMatchObject({ status: "recoverable" });
		const recovered = await new McpLedgerBoundary(ledger, bridge, {
			ownerId,
		}).execute(
			"opencut_import_subtitles",
			input,
			async () => {
				browserDispatches += 1;
				return mutation;
			},
			async (context) => {
				const recoveredMutation = await context.recoverBrowserStep(
					"import-subtitles:browser-mutation",
				);
				return recoveredMutation && typeof recoveredMutation === "object"
					? {
							...recoveredMutation,
							sourcePath: input.path,
							sourceBytes: 42,
							sourceSha256: "c".repeat(64),
						}
					: null;
			},
		);
		expect(recovered).toMatchObject({
			status: "applied",
			sourcePath: input.path,
			sourceBytes: 42,
			sourceSha256: "c".repeat(64),
			durableOperationStatus: "completed",
		});
		expect(browserDispatches).toBe(1);
		ledger.close();
		await rm(directory, { recursive: true, force: true });
	});

	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-mcp-boundary-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("records the authoritative live hash when an edit plan is rejected", async () => {
		const staleHash = "a".repeat(64);
		const liveHash = "b".repeat(64);
		let projectReads = 0;
		const bridge = {
			request: async (method: string) => {
				if (method === "read_project") {
					projectReads += 1;
					return projectSnapshot("b");
				}
				throw new Error(`unexpected bridge request: ${method}`);
			},
		} as unknown as EditorBridge;
		const ledger = new OperationLedger(directory);
		const result = await new McpLedgerBoundary(ledger, bridge).execute(
			"opencut_apply_edit_plan",
			{
				bridgeProtocolVersion: 2,
				projectId: "project-1",
				operationId: "stale-edit-plan",
				expectedRevision: 8,
				expectedProjectContentHash: staleHash,
			},
			async () => ({
				status: "content-hash-conflict",
				code: "CONTENT_HASH_CONFLICT",
				operationId: "stale-edit-plan",
				projectId: "project-1",
				expectedProjectContentHash: staleHash,
				actualProjectContentHash: liveHash,
			}),
		);

		ledger.close();

		expect(result).toMatchObject({
			status: "content-hash-conflict",
			code: "CONTENT_HASH_CONFLICT",
			durableOperationStatus: "completed",
			operationDisposition: "not-applied",
			operationRecord: {
				contentHashBefore: liveHash,
				diagnostics: { code: "CONTENT_HASH_CONFLICT" },
				affectedObjects: [],
			},
		});
		expect(projectReads).toBe(1);
	});

	test("terminalizes a durable export receipt without rerendering", async () => {
		const bridge = buildBridge();
		const input = {
			operationId: "export-recovery-1",
			projectId: "project-1",
			expectedRevision: 4,
			expectedProjectContentHash: "b".repeat(64),
			outputPath: join(directory, "video.mp4"),
			format: "mp4",
			quality: "high",
			includeAudio: true,
		};
		const firstLedger = new OperationLedger(directory);
		const first = await new McpLedgerBoundary(firstLedger, bridge, {
			ownerId: "export-recovery-owner",
		}).execute("opencut_export_project", input, async () => {
			throw new Error("simulated crash after durable export commit");
		});
		expect(first).toMatchObject({
			status: "recoverable",
			disposition: "unknown",
		});
		firstLedger.close();

		let rendererCalls = 0;
		const restartedLedger = new OperationLedger(directory);
		const recovered = await new McpLedgerBoundary(restartedLedger, bridge, {
			ownerId: "export-recovery-owner",
		}).execute(
			"opencut_export_project",
			input,
			async () => {
				rendererCalls += 1;
				throw new Error("renderer must not run during receipt recovery");
			},
			async () => exportResult(input.outputPath),
		);
		expect(rendererCalls).toBe(0);
		expect(recovered).toMatchObject({
			status: "replayed",
			durableOperationStatus: "completed",
			operationDisposition: "applied-verified",
			operationRecord: {
				artifacts: [
					{
						artifactId: "export-recovery-1",
						kind: "export",
						state: "verified",
						sha256: "a".repeat(64),
						bytes: 1234,
						path: input.outputPath,
						mimeType: "video/mp4",
					},
				],
				providerProvenance: [
					{
						provider: "opencut-web-renderer",
						artifactHash: "a".repeat(64),
						metadata: {
							pipeline: "editor-native-export",
							protocolVersion: 2,
						},
					},
				],
				checkpoints: [
					{
						checkpointId: "export-recovery-1",
						kind: "filesystem",
						state: "verified",
						metadata: {
							outputPath: input.outputPath,
							bytes: 1234,
							container: "mp4",
							exportReceiptId: "export-recovery-1",
							saveReceiptId: "save-receipt-1",
						},
					},
				],
			},
		});
		restartedLedger.close();
	});
});

function projectSnapshot(digest: string) {
	return {
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 8,
		contentIdentity: {
			status: "hashed",
			hash: { algorithm: "SHA-256", digest: digest.repeat(64) },
		},
	};
}

function saveReceipt(operationId: string, digest: string) {
	return {
		status: "saved",
		receiptId: `receipt:${operationId}`,
		operationId: `${operationId}:ledger-save`,
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 8,
		contentHash: digest.repeat(64),
		persistedAt: "2026-09-02T00:00:00.000Z",
		completedAt: "2026-09-02T00:00:01.000Z",
		storageSchemaVersion: 1,
		writeVersion: 1,
		reloadVerified: true,
		readbackContentHash: digest.repeat(64),
	};
}

function buildBridge(): EditorBridge {
	return {
		request: async (method: string) => {
			if (method === "get_operation_receipt") {
				return { status: "not-found", operationId: "export-recovery-1" };
			}
			if (method === "read_project") {
				return {
					projectId: "project-1",
					sceneId: "scene-1",
					revision: 4,
					contentIdentity: {
						status: "hashed",
						hash: { digest: "b".repeat(64) },
					},
				};
			}
			throw new Error(`unexpected bridge request: ${method}`);
		},
	} as unknown as EditorBridge;
}

function exportResult(outputPath: string) {
	return {
		status: "replayed",
		operationId: "export-recovery-1",
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 4,
		outputPath,
		bytesWritten: 1234,
		sha256: "a".repeat(64),
		container: "mp4",
		exportReceiptId: "export-recovery-1",
		saveReceiptId: "save-receipt-1",
		renderer: {
			provider: "opencut-web-renderer",
			pipeline: "editor-native-export",
			protocolVersion: 2,
		},
	};
}
