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
							contentHashProjectionVersion: 2,
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
			bridgeProtocolVersion: 2,
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
							contentHashProjectionVersion: 2,
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

	test("verifies a non-activating scene mutation against the active scene", async () => {
		const input = {
			bridgeProtocolVersion: 2,
			projectId: "project-1",
			operationId: "create-scene-without-activation",
			expectedRevision: 7,
			expectedProjectContentHash: "a".repeat(64),
		};
		let projectReads = 0;
		const bridge = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "read_project") {
					projectReads += 1;
					return projectSnapshot("b");
				}
				if (method === "save_project") {
					expect(params.sceneId).toBe("scene-1");
					return saveReceipt(input.operationId, "b");
				}
				throw new Error(`unexpected bridge request: ${method}`);
			},
		} as unknown as EditorBridge;
		const ledger = new OperationLedger(directory);
		const result = await new McpLedgerBoundary(ledger, bridge).execute(
			"opencut_create_scene",
			input,
			async () => ({
				status: "applied",
				operationId: input.operationId,
				projectId: "project-1",
				sceneId: "scene-created",
				activeSceneId: "scene-1",
				revision: 8,
				snapshot: projectSnapshot("b"),
				affectedObjects: [
					{ objectType: "scene", objectId: "scene-created", action: "created" },
				],
			}),
		);
		ledger.close();

		expect(result).toMatchObject({
			status: "applied",
			durableOperationStatus: "completed",
			operationRecord: {
				sceneId: "scene-1",
				contentHashAfter: "b".repeat(64),
			},
		});
		expect(projectReads).toBe(1);
	});

	test("ledgers an activating clone against the clone as the active scene", async () => {
		const input = {
			bridgeProtocolVersion: 2,
			projectId: "project-1",
			operationId: "clone-scene-with-activation",
			expectedRevision: 7,
			expectedProjectContentHash: "a".repeat(64),
			sceneId: "scene-1",
			activate: true,
		};
		const bridge = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "read_project") {
					return { ...projectSnapshot("b"), sceneId: "scene-clone" };
				}
				if (method === "save_project") {
					expect(params.sceneId).toBe("scene-clone");
					return {
						...saveReceipt(input.operationId, "b"),
						sceneId: "scene-clone",
					};
				}
				throw new Error(`unexpected bridge request: ${method}`);
			},
		} as unknown as EditorBridge;
		const ledger = new OperationLedger(directory);
		const result = await new McpLedgerBoundary(ledger, bridge).execute(
			"opencut_clone_scene",
			input,
			async () => ({
				status: "applied",
				operationId: input.operationId,
				projectId: "project-1",
				sceneId: "scene-clone",
				activeSceneId: "scene-clone",
				revision: 8,
				snapshot: { ...projectSnapshot("b"), sceneId: "scene-clone" },
				affectedObjects: [
					{ objectType: "scene", objectId: "scene-clone", action: "created" },
				],
			}),
		);
		ledger.close();

		expect(result).toMatchObject({
			status: "applied",
			durableOperationStatus: "completed",
			operationRecord: {
				sceneId: "scene-clone",
				contentHashAfter: "b".repeat(64),
			},
		});
	});

	test("ledgers a mutation of an inactive scene against the active scene", async () => {
		const input = {
			bridgeProtocolVersion: 2,
			projectId: "project-1",
			operationId: "rename-inactive-scene",
			expectedRevision: 7,
			expectedProjectContentHash: "a".repeat(64),
			sceneId: "scene-2",
			name: "Renamed",
		};
		const bridge = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "read_project") return projectSnapshot("b");
				if (method === "save_project") {
					expect(params.sceneId).toBe("scene-1");
					return saveReceipt(input.operationId, "b");
				}
				throw new Error(`unexpected bridge request: ${method}`);
			},
		} as unknown as EditorBridge;
		const ledger = new OperationLedger(directory);
		const result = await new McpLedgerBoundary(ledger, bridge).execute(
			"opencut_rename_scene",
			input,
			async () => ({
				status: "applied",
				operationId: input.operationId,
				projectId: "project-1",
				sceneId: "scene-2",
				activeSceneId: "scene-1",
				revision: 8,
				snapshot: projectSnapshot("b"),
				affectedObjects: [
					{ objectType: "scene", objectId: "scene-2", action: "updated" },
				],
			}),
		);
		ledger.close();

		expect(result).toMatchObject({
			status: "applied",
			durableOperationStatus: "completed",
			operationRecord: {
				sceneId: "scene-1",
				contentHashAfter: "b".repeat(64),
			},
		});
	});

	test("ledgers a bootstrap worker start without a project identity", async () => {
		const bridge = buildBridge();
		const ledger = new OperationLedger(directory);
		const result = await new McpLedgerBoundary(ledger, bridge).execute(
			"opencut_start_editor_worker",
			{ operationId: "start-worker-bootstrap" },
			async () => ({
				enabled: true,
				running: true,
				connected: true,
				baseUrl: "http://127.0.0.1:3000",
				profileDirectory: directory,
				browserPath: null,
				projectId: null,
				lastError: null,
				rendererClass: "software",
				pinnedCompositorBackend: "webgpu",
			}),
		);
		ledger.close();

		expect(result).toMatchObject({
			connected: true,
			durableOperationStatus: "completed",
			operationDisposition: "applied-verified",
			operationRecord: { projectId: null, affectedObjects: [] },
		});
	});

	test("ledgers a named checkpoint with unchanged hash state and checkpoint relationships", async () => {
		const ledger = new OperationLedger(directory);
		const input = {
			bridgeProtocolVersion: 2,
			operationId: "create-checkpoint-1",
			checkpointId: "checkpoint-1",
			name: "Before titles",
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 8,
			expectedProjectContentHash: "a".repeat(64),
		};
		const result = await new McpLedgerBoundary(ledger, buildBridge()).execute(
			"opencut_create_checkpoint",
			input,
			async () => ({
				status: "checkpoint-created",
				checkpointId: input.checkpointId,
				projectId: input.projectId,
				sceneId: input.sceneId,
				revision: input.expectedRevision,
				contentHash: input.expectedProjectContentHash,
				contentHashProjectionVersion: 3,
				affectedObjects: [
					{
						objectType: "checkpoint",
						objectId: input.checkpointId,
						action: "created",
					},
				],
			}),
		);
		ledger.close();

		expect(result).toMatchObject({
			status: "checkpoint-created",
			durableOperationStatus: "completed",
			operationRecord: {
				projectId: "project-1",
				sceneId: "scene-1",
				revisionBefore: 8,
				revisionAfter: 8,
				contentHashBefore: "a".repeat(64),
				contentHashAfter: "a".repeat(64),
				relationships: { checkpointId: "checkpoint-1" },
				affectedObjects: expect.arrayContaining([
					{
						objectType: "checkpoint",
						objectId: "checkpoint-1",
						action: "created",
					},
				]),
			},
		});
	});

	test("binds project lifecycle records to the project they act on", async () => {
		const bridge = buildBridge();
		const ledger = new OperationLedger(directory);
		const boundary = new McpLedgerBoundary(ledger, bridge);
		const renamed = await boundary.execute(
			"opencut_rename_project",
			{
				bridgeProtocolVersion: 2,
				operationId: "rename-project-1",
				projectId: "project-1",
				name: "Renamed",
			},
			async () => ({
				status: "renamed",
				operationId: "rename-project-1",
				projectId: "project-1",
				renamedProjectId: "project-1",
				name: "Renamed",
			}),
		);
		const deleted = await boundary.execute(
			"opencut_delete_project",
			{
				bridgeProtocolVersion: 2,
				operationId: "delete-project-1",
				projectId: "project-1",
				fallbackProjectId: "project-2",
			},
			async () => ({
				status: "deleted",
				operationId: "delete-project-1",
				projectId: "project-2",
				activeProjectId: "project-2",
				deletedProjectId: "project-1",
				revision: 8,
				snapshot: {
					...projectSnapshot("b"),
					projectId: "project-2",
					sceneId: "scene-2",
				},
			}),
		);
		const history = await ledger.list({ limit: 10, projectId: "project-1" });
		ledger.close();

		expect(renamed).toMatchObject({
			durableOperationStatus: "completed",
			operationRecord: { projectId: "project-1" },
		});
		expect(deleted).toMatchObject({
			durableOperationStatus: "completed",
			operationRecord: { projectId: "project-1" },
		});
		expect(history.map((entry) => entry.record.operationId).sort()).toEqual([
			"delete-project-1",
			"rename-project-1",
		]);
	});

	test("terminalizes a durable export receipt without rerendering", async () => {
		const bridge = buildBridge();
		const input = {
			bridgeProtocolVersion: 2,
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
			hash: {
				algorithm: "SHA-256",
				projectionVersion: 2,
				digest: digest.repeat(64),
			},
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
		contentHashProjectionVersion: 2,
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
						hash: { projectionVersion: 2, digest: "b".repeat(64) },
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

describe("comparison ledger policy", () => {
	test("binds ledger before-state to the immutable comparison source without reading live editor state", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-comparison-ledger-"),
		);
		const ledger = new OperationLedger(directory);
		let bridgeRequests = 0;
		const bridge = {
			request: async () => {
				bridgeRequests += 1;
				throw new Error(
					"comparison policy must not resolve live project state",
				);
			},
		} as unknown as EditorBridge;
		const diffHash = "c".repeat(64);
		const compositeHash = "d".repeat(64);
		try {
			const result = await new McpLedgerBoundary(ledger, bridge).execute(
				"opencut_compare_project_states",
				{
					bridgeProtocolVersion: 2,
					operationId: "comparison-ledger-1",
					projectId: "project-1",
					sceneId: "scene-1",
					before: {
						revision: 4,
						projectContentHash: "a".repeat(64),
						projectionName: "opencut-project-content",
						projectionVersion: 2,
					},
				},
				async () => ({
					status: "rendered",
					schemaVersion: "opencut.comparison-receipt.v1",
					receiptId: "comparison:comparison-ledger-1",
					projectId: "project-1",
					sceneId: "scene-1",
					checksum: "e".repeat(64),
					scheduleSha256: "f".repeat(64),
					operationHistory: {
						beforeSaveOperationId: "save-before",
						afterSaveOperationId: "save-after",
						comparisonOperationId: "comparison-ledger-1",
					},
					frames: [
						{
							diff: {
								path: "C:/comparisons/diff.png",
								bytes: 123,
								pngSha256: diffHash,
							},
							comparison: {
								path: "C:/comparisons/side-by-side.png",
								bytes: 456,
								pngSha256: compositeHash,
							},
						},
					],
				}),
			);
			expect(result).toMatchObject({
				durableOperationStatus: "completed",
				operationDisposition: "applied-verified",
			});
			const record = await ledger.get("comparison-ledger-1");
			expect(record?.record).toMatchObject({
				projectId: "project-1",
				sceneId: "scene-1",
				revisionBefore: 4,
				contentHashBefore: "a".repeat(64),
				contentHashProjectionVersionBefore: 1,
				requiresSaveVerification: false,
				artifacts: [
					{
						artifactId: diffHash,
						kind: "receipt",
						state: "verified",
						sha256: diffHash,
						bytes: 123,
						path: "C:/comparisons/diff.png",
						mimeType: "image/png",
					},
					{
						artifactId: compositeHash,
						kind: "receipt",
						state: "verified",
						sha256: compositeHash,
						bytes: 456,
						path: "C:/comparisons/side-by-side.png",
						mimeType: "image/png",
					},
				],
			});
			expect(bridgeRequests).toBe(0);
		} finally {
			ledger.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("preview range ledger projection", () => {
	test("records the projection version carried by verified preview-range evidence", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preview-range-ledger-"),
		);
		const ledger = new OperationLedger(directory);
		const contentHash = "c".repeat(64);
		const bridge = {
			request: async (method: string) => {
				if (method !== "read_project")
					throw new Error(`unexpected bridge request: ${method}`);
				return {
					projectId: "project-1",
					sceneId: "scene-1",
					revision: 4,
					contentIdentity: {
						status: "hashed",
						hash: { projectionVersion: 3, digest: contentHash },
					},
				};
			},
		} as unknown as EditorBridge;
		try {
			const result = await new McpLedgerBoundary(ledger, bridge).execute(
				"opencut_render_preview_range",
				{
					bridgeProtocolVersion: 2,
					operationId: "preview-range-ledger-1",
					projectId: "project-1",
					sceneId: "scene-1",
					expectedRevision: 4,
					expectedProjectContentHash: contentHash,
				},
				async () => ({
					status: "rendered",
					receiptId: "preview-range:preview-range-ledger-1",
					projectId: "project-1",
					sceneId: "scene-1",
					revision: 4,
					contentHash,
					frames: [],
					evidence: {
						contentIdentity: {
							status: "hashed",
							hash: { projectionVersion: 3, digest: contentHash },
						},
					},
				}),
			);
			expect(result).toMatchObject({
				durableOperationStatus: "completed",
				operationDisposition: "applied-verified",
				operationRecord: {
					contentHashAfter: contentHash,
					contentHashProjectionVersionAfter: 3,
				},
			});
		} finally {
			ledger.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
