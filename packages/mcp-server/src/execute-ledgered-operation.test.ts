import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executeLedgeredOperation,
	semanticOperationInput,
	type LedgeredOperationSpec,
} from "./execute-ledgered-operation";
import {
	OperationLedger,
	OperationLedgerReuseError,
	type OperationLedgerRecord,
} from "./operation-ledger";

const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);

describe("executeLedgeredOperation", () => {
	let directory: string;
	let ledger: OperationLedger;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-executor-"));
		ledger = new OperationLedger(directory);
	});

	afterEach(async () => {
		ledger.close();
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	});

	test("claims and marks unknown before invoking the side-effect callback", async () => {
		let observed: OperationLedgerRecord | null = null;
		const result = await executeLedgeredOperation({
			...operationSpec(ledger, "claim-first"),
			execute: async () => {
				observed = (await ledger.get("claim-first"))!.record;
				return applied("claim-first");
			},
		});
		expect(observed).toMatchObject({
			status: "started",
			disposition: "unknown",
			phase: "reconciling",
		});
		expect(result).toMatchObject({
			status: "completed",
			disposition: "applied-verified",
		});
	});

	test("excludes reconnect affinity and transient tickets but rejects semantic reuse", async () => {
		let executions = 0;
		const first = operationSpec(ledger, "semantic");
		first.input = {
			projectId: "project-1",
			expectedRevision: 7,
			url: "http://127.0.0.1/one-time-ticket",
			expectedConnectionIdentity: {
				serverInstanceId: "server-a",
				editorInstanceId: "editor-1",
				editorSessionId: "session-a",
				connectionGeneration: 1,
			},
		};
		first.execute = async () => {
			executions += 1;
			return applied("semantic");
		};
		await executeLedgeredOperation(first);

		const reconnect = operationSpec(ledger, "semantic");
		reconnect.input = {
			projectId: "project-1",
			expectedRevision: 7,
			url: "http://127.0.0.1/another-ticket",
			expectedConnectionIdentity: {
				serverInstanceId: "server-b",
				editorInstanceId: "editor-1",
				editorSessionId: "session-b",
				connectionGeneration: 2,
			},
		};
		const replay = await executeLedgeredOperation(reconnect);
		expect(replay.status).toBe("replayed");
		expect(executions).toBe(1);

		await expect(
			executeLedgeredOperation({
				...reconnect,
				input: { ...reconnect.input, expectedRevision: 8 },
			}),
		).rejects.toBeInstanceOf(OperationLedgerReuseError);
	});

	test("refreshes transient state only after validating a matching replay", async () => {
		const initial = operationSpec(ledger, "refresh-replay");
		await executeLedgeredOperation(initial);
		let refreshes = 0;
		const replayed = await executeLedgeredOperation({
			...operationSpec(ledger, "refresh-replay"),
			replay: async () => {
				refreshes += 1;
				return { status: "connected", generation: 2 };
			},
		});
		expect(replayed).toMatchObject({
			status: "replayed",
			value: { status: "connected", generation: 2 },
		});
		expect(refreshes).toBe(1);

		await expect(
			executeLedgeredOperation({
				...operationSpec(ledger, "refresh-replay"),
				input: { projectId: "different-project" },
				replay: async () => {
					refreshes += 1;
					return { status: "connected" };
				},
			}),
		).rejects.toBeInstanceOf(OperationLedgerReuseError);
		expect(refreshes).toBe(1);
	});

	test("keeps unknown outcomes recoverable and completes from durable recovery evidence", async () => {
		let initialExecutions = 0;
		const unknown = await executeLedgeredOperation({
			...operationSpec(ledger, "recover"),
			execute: async () => {
				initialExecutions += 1;
				return {
					disposition: "unknown",
					reason: "response was lost after editor dispatch",
				};
			},
		});
		expect(unknown.status).toBe("recoverable");
		ledger.close();

		ledger = new OperationLedger(directory);
		let recoveryCalls = 0;
		const recovered = await executeLedgeredOperation({
			...operationSpec(ledger, "recover"),
			recover: async () => {
				recoveryCalls += 1;
				return applied("recover");
			},
			execute: async () => {
				throw new Error("an incomplete operation must not execute again");
			},
		});
		expect(recovered.status).toBe("completed");
		expect(initialExecutions).toBe(1);
		expect(recoveryCalls).toBe(1);
	});

	test("returns bounded schema issue paths for recoverable validation failures", async () => {
		const result = await executeLedgeredOperation({
			...operationSpec(ledger, "schema-detail"),
			execute: async () => {
				const error = new Error("validation failed") as Error & {
					issues: Array<{ path: Array<string | number>; message: string }>;
				};
				error.name = "ZodError";
				error.issues = [
					{
						path: ["fontReadiness", "descriptors", 0],
						message: "variable face does not cover requested weight",
					},
				];
				throw error;
			},
		});

		expect(result).toMatchObject({
			status: "recoverable",
			reason:
				"ZodError: fontReadiness.descriptors.0: variable face does not cover requested weight",
		});
	});

	test("persists composite provider and artifact checkpoints for recovery", async () => {
		const result = await executeLedgeredOperation({
			...operationSpec(ledger, "checkpoint"),
			requiresSaveVerification: false,
			execute: async (context) => {
				const recordedAt = "2026-09-02T12:00:00.000Z";
				await context.checkpoint({
					checkpoint: {
						checkpointId: "provider-output",
						kind: "provider",
						state: "verified",
						recordedAt,
						metadata: { billableRequestId: "provider-request-1" },
					},
					providerProvenance: [
						{
							provider: "cleaner",
							modelId: "model-1",
							artifactHash: AFTER_HASH,
						},
					],
					artifacts: [
						{
							artifactId: "clean-output",
							kind: "provider-output",
							state: "verified",
							sha256: AFTER_HASH,
							bytes: 42,
							path: "C:/safe/clean.wav",
							mimeType: "audio/wav",
						},
					],
				});
				return {
					disposition: "applied-verified",
					value: { status: "attached" },
					evidence: {
						providerProvenance: context.record().providerProvenance,
						artifacts: context.record().artifacts,
						checkpoints: context.record().checkpoints,
					},
				};
			},
		});
		expect(result.operation).toMatchObject({
			checkpoints: [{ checkpointId: "provider-output", state: "verified" }],
			artifacts: [{ artifactId: "clean-output", sha256: AFTER_HASH }],
			providerProvenance: [{ provider: "cleaner" }],
		});
	});

	test("records known non-applied outcomes as terminal failures", async () => {
		const result = await executeLedgeredOperation({
			...operationSpec(ledger, "rejected"),
			execute: async () => ({
				disposition: "not-applied",
				value: { status: "conflict" },
				diagnostics: {
					code: "REVISION_CONFLICT",
					message: "revision changed before dispatch",
					details: null,
				},
			}),
		});
		expect(result).toMatchObject({
			status: "completed",
			disposition: "not-applied",
			operation: {
				status: "failed",
				disposition: "not-applied",
				affectedObjects: [],
			},
		});
	});

	test("enforces global operation ID uniqueness across operation kinds", async () => {
		await executeLedgeredOperation(operationSpec(ledger, "global-id"));
		await expect(
			executeLedgeredOperation({
				...operationSpec(ledger, "global-id"),
				operationKind: "export-project",
				description: "Export the project",
			}),
		).rejects.toBeInstanceOf(OperationLedgerReuseError);
	});

	test("atomically takes over an unexpired lease owned by a dead server process", async () => {
		const spec = operationSpec(ledger, "dead-owner-takeover");
		const deadOwnerId = "opencut-mcp:2147483647:dead-server";
		await claimFromSpec(spec, deadOwnerId);
		let recoveries = 0;
		const result = await executeLedgeredOperation({
			...spec,
			ownerId: `opencut-mcp:${process.pid}:replacement-server`,
			recover: async () => {
				recoveries += 1;
				return applied(spec.operationId);
			},
			execute: async () => {
				throw new Error("takeover must reconcile rather than execute");
			},
		});
		expect(result).toMatchObject({ status: "completed" });
		expect(recoveries).toBe(1);
		expect(result.operation.attempt).toBe(2);
	});

	test("does not steal an unexpired lease from an overlapping live server", async () => {
		const spec = operationSpec(ledger, "live-owner-fence");
		await claimFromSpec(spec, `opencut-mcp:${process.pid}:first-server`);
		let recoveries = 0;
		const result = await executeLedgeredOperation({
			...spec,
			ownerId: `opencut-mcp:${process.pid}:second-server`,
			recover: async () => {
				recoveries += 1;
				return applied(spec.operationId);
			},
		});
		expect(result).toMatchObject({
			status: "recoverable",
			disposition: "unknown",
		});
		expect(recoveries).toBe(0);
	});

	test("does not steal an expired lease while its encoded owner process is alive", async () => {
		ledger.close();
		ledger = new OperationLedger(directory, {
			now: () => new Date("2020-01-01T00:00:00.000Z"),
		});
		const spec = operationSpec(ledger, "expired-live-owner-fence");
		await claimFromSpec(spec, `opencut-mcp:${process.pid}:first-server`);
		let recoveries = 0;
		const result = await executeLedgeredOperation({
			...spec,
			ownerId: `opencut-mcp:${process.pid}:second-server`,
			recover: async () => {
				recoveries += 1;
				return applied(spec.operationId);
			},
		});
		expect(result).toMatchObject({
			status: "recoverable",
			disposition: "unknown",
			operation: { attempt: 1 },
		});
		expect(recoveries).toBe(0);
	});
});

async function claimFromSpec(
	spec: LedgeredOperationSpec<Record<string, unknown>, { status: string }>,
	ownerId: string,
): Promise<void> {
	await spec.ledger.claim({
		operationId: spec.operationId,
		operationKind: spec.operationKind,
		description: spec.description,
		operationType: "mutation",
		requiresSaveVerification: spec.requiresSaveVerification,
		canonicalInput: semanticOperationInput(spec.input),
		ownerId,
		leaseDurationMs: spec.leaseDurationMs,
		actor: spec.actor,
		requestIdentity: spec.requestIdentity,
		connectionAffinity: spec.connectionAffinity ?? null,
		projectId: spec.before?.projectId ?? null,
		sceneId: spec.before?.sceneId ?? null,
		revisionBefore: spec.before?.revision ?? null,
		contentHashBefore: spec.before?.contentHash ?? null,
		contentHashProjectionVersionBefore:
			spec.before?.contentHashProjectionVersion,
		affectedObjects: spec.affectedObjects,
		relationships: spec.relationships,
	});
}

function operationSpec(
	ledger: OperationLedger,
	operationId: string,
): LedgeredOperationSpec<Record<string, unknown>, { status: string }> {
	return {
		ledger,
		input: { projectId: "project-1", expectedRevision: 7 },
		operationId,
		operationKind: "apply-edit-plan",
		description: "Apply a deterministic edit plan",
		actor: { type: "agent", id: "codex" },
		requestIdentity: `request:${operationId}`,
		ownerId: "mcp-server",
		leaseDurationMs: 60_000,
		connectionAffinity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
			protocolVersion: 2,
		},
		before: {
			projectId: "project-1",
			sceneId: "scene-1",
			revision: 7,
			contentHash: BEFORE_HASH,
			contentHashProjectionVersion: 2,
		},
		requiresSaveVerification: true,
		affectedObjects: [
			{ objectType: "project", objectId: "project-1", action: "updated" },
		],
		execute: async () => applied(operationId),
	};
}

function applied(
	operationId: string,
): ReturnType<typeof projectAppliedOutcome> {
	return projectAppliedOutcome(operationId);
}

function projectAppliedOutcome(operationId: string) {
	return {
		disposition: "applied-verified" as const,
		value: { status: "applied" },
		evidence: {
			revisionAfter: 8,
			contentHashAfter: AFTER_HASH,
			contentHashProjectionVersionAfter: 2 as const,
			saveReceipt: {
				receiptId: `save:project-1:1:${AFTER_HASH}`,
				operationId: `${operationId}:save-barrier`,
				projectId: "project-1",
				sceneId: "scene-1",
				revision: 8,
				contentHash: AFTER_HASH,
				contentHashProjectionVersion: 2 as const,
				persistedAt: "2026-09-02T12:00:00.000Z",
				completedAt: "2026-09-02T12:00:01.000Z",
				storageSchemaVersion: 1,
				writeVersion: 1,
				reloadVerified: true as const,
				readbackContentHash: AFTER_HASH,
			},
		},
	};
}
