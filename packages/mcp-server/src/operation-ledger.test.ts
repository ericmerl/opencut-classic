import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OperationLedger,
	OperationLedgerCorruptionError,
	OperationLedgerLeaseError,
	OperationLedgerReadinessError,
	OperationLedgerReplayMismatchError,
	OperationLedgerReuseError,
	OperationLedgerUnsupportedVersionError,
	checksumRecord,
	type OperationClaimInput,
	type OperationLedgerRecord,
} from "./operation-ledger";

describe("OperationLedger SQLite durability", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-ledger-"));
	});
	afterEach(async () => {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	});

	test("commits, hash-chains, and exactly replays after restart", async () => {
		const ledger = new OperationLedger(directory);
		const claim = await ledger.claim(operation());
		const completed = await ledger.complete(
			"edit-1",
			claim.record.inputFingerprint,
			{ status: "applied" },
			evidence(claim.record),
		);
		ledger.close();
		const restarted = new OperationLedger(directory);
		const versions = await restarted.versions("edit-1");
		expect(versions).toHaveLength(2);
		expect(versions[1]!.previousChecksum).toBe(checksumRecord(versions[0]!));
		expect(await restarted.claim(operation())).toEqual({
			state: "replayed",
			record: completed.record,
		});
		expect(
			await restarted.complete(
				"edit-1",
				claim.record.inputFingerprint,
				{ status: "applied" },
				evidence(claim.record),
			),
		).toEqual({ replayed: true, record: completed.record });
		await expect(
			restarted.complete(
				"edit-1",
				claim.record.inputFingerprint,
				{ status: "different" },
				evidence(claim.record),
			),
		).rejects.toBeInstanceOf(OperationLedgerReplayMismatchError);
		restarted.close();
	});

	test("includes every semantic context field in bytewise canonical fingerprints", async () => {
		const ledger = new OperationLedger(directory);
		const first = operation("canonical");
		first.canonicalInput = { alpha: true, nested: { a: 1, b: 2 } };
		expect(ledger.fingerprint(first)).toBe(
			ledger.fingerprint({
				...first,
				canonicalInput: { nested: { b: 2, a: 1 }, alpha: true },
			}),
		);
		const changes: Array<(value: OperationClaimInput) => void> = [
			(value) => {
				value.operationKind = "other";
			},
			(value) => {
				value.operationType = "nonmutation";
			},
			(value) => {
				value.projectId = "project-2";
			},
			(value) => {
				value.sceneId = "scene-2";
			},
			(value) => {
				value.connectionAffinity!.editorInstanceId = "editor-2";
			},
			(value) => {
				value.revisionBefore = 9;
			},
			(value) => {
				value.contentHashBefore = "c".repeat(64);
			},
			(value) => {
				value.canonicalInput = { changed: true };
			},
		];
		for (let index = 0; index < changes.length; index += 1) {
			const original = operation(`semantic-${index}`);
			await ledger.claim(original);
			const changed = structuredClone(original);
			changes[index]!(changed);
			await expect(ledger.claim(changed)).rejects.toBeInstanceOf(
				OperationLedgerReuseError,
			);
		}
		ledger.close();
	});

	test("rejects non-JSON values and invalid nested identity", async () => {
		const ledger = new OperationLedger(directory);
		await expect(
			ledger.claim({ ...operation(), canonicalInput: { date: new Date() } }),
		).rejects.toThrow("plain objects");
		await expect(
			ledger.claim({ ...operation(), canonicalInput: { missing: undefined } }),
		).rejects.toThrow();
		await expect(
			ledger.claim({
				...operation(),
				connectionAffinity: {
					...operation().connectionAffinity!,
					connectionGeneration: 0,
				},
			}),
		).rejects.toThrow();
		ledger.close();
	});

	test("uses cross-process BEGIN IMMEDIATE claims for the same and different IDs", async () => {
		const same = await Promise.all([
			runChild(directory, "same"),
			runChild(directory, "same"),
		]);
		expect(same.map((value) => value.json?.state).sort()).toEqual([
			"claimed",
			"in-progress",
		]);
		const different = await Promise.all([
			runChild(directory, "different-a"),
			runChild(directory, "different-b"),
		]);
		expect(different.every((value) => value.json?.state === "claimed")).toBe(
			true,
		);
		expect([...same, ...different].every((value) => value.exitCode === 0)).toBe(
			true,
		);
	});

	test("serializes synchronized two-process cold-start initialization", async () => {
		const gate = join(directory, "cold-start.gate");
		const children = Promise.all([
			runChild(directory, "cold-a", undefined, gate),
			runChild(directory, "cold-b", undefined, gate),
		]);
		await Bun.sleep(50);
		await writeFile(gate, "start");
		const results = await children;
		expect(results.every((result) => result.exitCode === 0)).toBe(true);
		const ledger = new OperationLedger(directory);
		expect((await ledger.get("cold-a"))!.record.status).toBe("started");
		expect((await ledger.get("cold-b"))!.record.status).toBe("started");
		expect((await ledger.readiness()).integrity).toBe("ok");
		ledger.close();
	});

	test("rolls back a process exit before commit and exposes a commit before exit", async () => {
		const before = await runChild(directory, "before", "before-commit");
		expect(before.exitCode).toBe(86);
		const afterBefore = new OperationLedger(directory);
		expect(await afterBefore.get("before")).toBeNull();
		afterBefore.close();

		const after = await runChild(directory, "after", "after-commit");
		expect(after.exitCode).toBe(87);
		const afterCommit = new OperationLedger(directory);
		expect((await afterCommit.get("after"))!.record.status).toBe("started");
		afterCommit.close();
	});

	test("fences phase, reconcile, terminal, and competing adoption", async () => {
		let now = new Date("2026-09-02T12:00:00.000Z");
		const ledger = new OperationLedger(directory, { now: () => now });
		const claim = await ledger.claim({
			...operation(),
			leaseDurationMs: 1_000,
		});
		await expect(
			ledger.reconcile("edit-1", claim.record.inputFingerprint, {
				ownerId: "worker-1",
				fencingToken: "00000000-0000-4000-8000-000000000000",
				leaseDurationMs: 1_000,
			}),
		).rejects.toBeInstanceOf(OperationLedgerLeaseError);
		now = new Date("2026-09-02T12:00:02.000Z");
		const token = claim.record.lease!.fencingToken;
		const adopted = await ledger.adopt(
			"edit-1",
			claim.record.inputFingerprint,
			{
				ownerId: "worker-2",
				expectedFencingToken: token,
				leaseDurationMs: 5_000,
			},
		);
		await expect(
			ledger.adopt("edit-1", claim.record.inputFingerprint, {
				ownerId: "worker-3",
				expectedFencingToken: token,
				leaseDurationMs: 5_000,
			}),
		).rejects.toBeInstanceOf(OperationLedgerLeaseError);
		await expect(
			ledger.complete(
				"edit-1",
				claim.record.inputFingerprint,
				{ stale: true },
				{
					...evidence(claim.record),
					ownerId: "worker-1",
					fencingToken: token,
				},
			),
		).rejects.toBeInstanceOf(OperationLedgerLeaseError);
		await ledger.reconcile("edit-1", claim.record.inputFingerprint, {
			ownerId: "worker-2",
			fencingToken: adopted.lease!.fencingToken,
			leaseDurationMs: 5_000,
			phase: "verifying",
			revisionAfter: 8,
			contentHashAfter: "b".repeat(64),
		});
		const latest = (await ledger.get("edit-1"))!.record;
		await ledger.complete(
			"edit-1",
			claim.record.inputFingerprint,
			{ recovered: true },
			evidence(latest),
		);
		const race = await ledger.claim({
			...operation("adopt-race"),
			leaseDurationMs: 1_000,
		});
		ledger.close();
		const adoptions = await Promise.all([
			runAdoptChild(
				directory,
				"adopt-race",
				race.record.lease!.fencingToken,
				race.record.inputFingerprint,
			),
			runAdoptChild(
				directory,
				"adopt-race",
				race.record.lease!.fencingToken,
				race.record.inputFingerprint,
			),
		]);
		expect(adoptions.map((result) => result.exitCode).sort()).toEqual([0, 1]);
		const adoptedRace = new OperationLedger(directory);
		expect((await adoptedRace.get("adopt-race"))!.record.attempt).toBe(2);
		adoptedRace.close();
	});

	test("atomically fences a child-process adoption against completion", async () => {
		const now = new Date("2026-09-02T12:00:00.000Z");
		const ledger = new OperationLedger(directory, { now: () => now });
		const claim = await ledger.claim({
			...operation("adopt-complete"),
			ownerId: "race-worker",
			leaseDurationMs: 1,
			requiresSaveVerification: false,
		});
		const token = claim.record.lease!.fencingToken;
		const fingerprint = claim.record.inputFingerprint;
		ledger.close();
		const [adopt, complete] = await Promise.all([
			runActionChild(
				directory,
				"adopt-complete",
				"adopt",
				token,
				fingerprint,
				"adopter",
			),
			runActionChild(
				directory,
				"adopt-complete",
				"complete",
				token,
				fingerprint,
				"race-worker",
			),
		]);
		expect([adopt.exitCode, complete.exitCode].sort()).toEqual([0, 1]);
		const restarted = new OperationLedger(directory);
		const versions = await restarted.versions("adopt-complete");
		expect(versions).toHaveLength(2);
		const latest = versions.at(-1)!;
		expect(
			latest.status === "completed" ||
				(latest.status === "started" &&
					latest.lease?.ownerId === "adopter" &&
					latest.lease.fencingToken !== token),
		).toBe(true);
		restarted.close();
	});

	test("atomically serializes child-process reconcile against completion", async () => {
		const ledger = new OperationLedger(directory);
		const claim = await ledger.claim({
			...operation("reconcile-complete"),
			ownerId: "race-worker",
			requiresSaveVerification: false,
		});
		const token = claim.record.lease!.fencingToken;
		const fingerprint = claim.record.inputFingerprint;
		ledger.close();
		const [reconcile, complete] = await Promise.all([
			runActionChild(
				directory,
				"reconcile-complete",
				"reconcile",
				token,
				fingerprint,
				"race-worker",
			),
			runActionChild(
				directory,
				"reconcile-complete",
				"complete",
				token,
				fingerprint,
				"race-worker",
			),
		]);
		expect(complete.exitCode).toBe(0);
		expect([0, 1]).toContain(reconcile.exitCode);
		const restarted = new OperationLedger(directory);
		const versions = await restarted.versions("reconcile-complete");
		expect(versions.at(-1)!.status).toBe("completed");
		expect(versions).toHaveLength(reconcile.exitCode === 0 ? 3 : 2);
		restarted.close();
	});

	test("requires verified project completion and permits known not-applied failures", async () => {
		const ledger = new OperationLedger(directory);
		const mutation = await ledger.claim(operation("mutation"));
		await expect(
			ledger.complete(
				"mutation",
				mutation.record.inputFingerprint,
				{ invalid: true },
				{
					ownerId: "worker-1",
					fencingToken: mutation.record.lease!.fencingToken,
				},
			),
		).rejects.toThrow("completed project mutations require");
		await ledger.fail("mutation", mutation.record.inputFingerprint, {
			ownerId: "worker-1",
			fencingToken: mutation.record.lease!.fencingToken,
			diagnostics: new Error("verified failure"),
		});
		const read = await ledger.claim({
			...operation("read"),
			operationType: "nonmutation",
			requiresSaveVerification: false,
		});
		expect(
			(
				await ledger.fail("read", read.record.inputFingerprint, {
					ownerId: "worker-1",
					fencingToken: read.record.lease!.fencingToken,
					diagnostics: new Error("read failed"),
				})
			).record.status,
		).toBe("failed");
		ledger.close();
	});

	test("strictly links typed save receipts to live-readback terminal state", async () => {
		const ledger = new OperationLedger(directory);
		const claim = await ledger.claim(operation("receipt-link"));
		const invalid = evidence(claim.record);
		invalid.saveReceipt.readbackContentHash = "c".repeat(64);
		await expect(
			ledger.complete(
				"receipt-link",
				claim.record.inputFingerprint,
				{ ok: true },
				invalid,
			),
		).rejects.toThrow("readback hash must match content hash");
		const stillRecoverable = (await ledger.get("receipt-link"))!.record;
		expect(stillRecoverable.status).toBe("started");
		expect(stillRecoverable.disposition).toBe("not-applied");
		await ledger.complete(
			"receipt-link",
			claim.record.inputFingerprint,
			{ ok: true },
			evidence(claim.record),
		);
		ledger.close();
	});

	test("redacts signed URLs and URL userinfo only in payload-bearing fields", async () => {
		const ledger = new OperationLedger(directory);
		const input = {
			...operation("token-operation"),
			ownerId: "secret-worker",
			actor: {
				type: "agent" as const,
				id: "secret-agent",
				label: "Bearer abc.secret",
			},
			requestIdentity: "credential-request",
			providerProvenance: [
				{
					provider: "aws-provider",
					metadata: {
						url: "https://user:pass@s3.test/a?X-Amz-Credential=cred&X-Amz-Signature=sig&X-Amz-Security-Token=tok",
					},
				},
			],
		};
		const claim = await ledger.claim(input);
		const failed = await ledger.fail(
			input.operationId,
			claim.record.inputFingerprint,
			{
				...evidence(claim.record),
				diagnostics: {
					code: "FAILED",
					message: "TOKEN=diagnostic-secret",
					details: null,
				},
				result: { signature: "raw-signature", safe: "retained" },
			},
		);
		expect(failed.record).toMatchObject({
			operationId: "token-operation",
			actor: { id: "secret-agent", label: "Bearer [REDACTED]" },
			requestIdentity: "credential-request",
			result: { signature: "[REDACTED]", safe: "retained" },
			diagnostics: { message: "TOKEN=[REDACTED]" },
		});
		const url = failed.record.providerProvenance[0]!.metadata!.url as string;
		expect(url).not.toContain("user:pass");
		expect(url).not.toContain("cred");
		expect(url).not.toContain("sig");
		expect(url).not.toContain("tok");
		ledger.close();
	});

	test("preserves routing identity IDs inside terminal results", async () => {
		const ledger = new OperationLedger(directory);
		const input = operation("identity-result");
		const claim = await ledger.claim(input);
		const completed = await ledger.complete(
			input.operationId,
			claim.record.inputFingerprint,
			{
				connectionIdentity: {
					serverInstanceId: "server-1",
					editorInstanceId: "editor-1",
					editorSessionId: "session-1",
					connectionGeneration: 1,
				},
			},
			evidence(claim.record),
		);
		expect(completed.record.result).toMatchObject({
			connectionIdentity: { editorSessionId: "session-1" },
		});
		ledger.close();
	});

	test("prevents SQL tail deletion and fails closed on database corruption", async () => {
		const ledger = new OperationLedger(directory);
		await ledger.claim(operation());
		const path = (await ledger.readiness()).databasePath;
		ledger.close();
		const database = new Database(path);
		expect(() =>
			database.query("DELETE FROM operation_versions").run(),
		).toThrow("append-only");
		database.close();
		await writeFile(path, "not a sqlite database");
		await expect(
			new OperationLedger(directory).readiness(),
		).rejects.toBeInstanceOf(OperationLedgerReadinessError);
	});

	test("rejects unsupported SQLite schema versions explicitly", async () => {
		const path = join(directory, "operation-ledger.sqlite");
		const database = new Database(path, { create: true });
		database.exec("PRAGMA user_version=2");
		database.close();
		await expect(
			new OperationLedger(directory).readiness(),
		).rejects.toBeInstanceOf(OperationLedgerUnsupportedVersionError);
	});

	test("reports SQLite readiness and durable event ordering", async () => {
		const ledger = new OperationLedger(directory);
		expect(await ledger.readiness()).toMatchObject({
			journalMode: "wal",
			synchronous: "full",
			foreignKeys: true,
			integrity: "ok",
		});
		for (const operationId of ["edit-1", "edit-2", "edit-3"]) {
			const claim = await ledger.claim(operation(operationId));
			await ledger.complete(
				operationId,
				claim.record.inputFingerprint,
				{ ok: true },
				evidence(claim.record),
			);
		}
		const history = await ledger.list({ limit: 2 });
		expect(history.map(id)).toEqual(["edit-3", "edit-2"]);
		expect(history[0]!.record.eventSequence).toBeGreaterThan(
			history[1]!.record.eventSequence,
		);
		ledger.close();
	});

	test("paginates and filters durable history by stable event cursor", async () => {
		const ledger = new OperationLedger(directory);
		for (const operationId of ["history-1", "history-2", "history-3"]) {
			const claim = await ledger.claim({
				...operation(operationId),
				operationKind:
					operationId === "history-2" ? "import-media" : "apply-edit-plan",
			});
			await ledger.complete(
				operationId,
				claim.record.inputFingerprint,
				{ ok: true },
				evidence(claim.record),
			);
		}
		const first = await ledger.listPage({
			limit: 1,
			projectId: "project-1",
			statuses: ["completed"],
			dispositions: ["applied-verified"],
			actorId: "codex",
		});
		expect(first.entries.map(id)).toEqual(["history-3"]);
		expect(first.nextCursor).not.toBeNull();
		const second = await ledger.listPage({
			limit: 1,
			cursor: first.nextCursor!,
			operationKinds: ["import-media"],
		});
		expect(second.entries.map(id)).toEqual(["history-2"]);
		expect(second.nextCursor).toBeNull();
		await expect(
			ledger.listPage({ limit: 1, cursor: "not-a-cursor" }),
		).rejects.toThrow("invalid operation history cursor");
		ledger.close();
	});
});

function operation(operationId = "edit-1"): OperationClaimInput {
	return {
		operationId,
		operationKind: "apply-edit-plan",
		description: "Apply a deterministic edit plan",
		operationType: "mutation",
		requiresSaveVerification: true,
		canonicalInput: { projectId: "project-1", value: "same" },
		ownerId: "worker-1",
		leaseDurationMs: 60_000,
		actor: { type: "agent", id: "codex" },
		requestIdentity: `request:${operationId}`,
		connectionAffinity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
			protocolVersion: 2,
		},
		projectId: "project-1",
		sceneId: "scene-1",
		revisionBefore: 7,
		contentHashBefore: "a".repeat(64),
	};
}

function evidence(record: OperationLedgerRecord) {
	const contentHash = "b".repeat(64);
	return {
		ownerId: record.lease!.ownerId,
		fencingToken: record.lease!.fencingToken,
		revisionAfter: 8,
		contentHashAfter: contentHash,
		saveReceipt: {
			receiptId: `save:${record.projectId}:1:${contentHash}`,
			operationId: record.operationId,
			projectId: record.projectId!,
			sceneId: record.sceneId!,
			revision: 8,
			contentHash,
			persistedAt: "2026-09-02T12:01:00.000Z",
			completedAt: "2026-09-02T12:01:01.000Z",
			storageSchemaVersion: 1,
			writeVersion: 1,
			reloadVerified: true as const,
			readbackContentHash: contentHash,
		},
	};
}

async function runChild(
	directory: string,
	operationId: string,
	fault?: string,
	startGate?: string,
) {
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "operation-ledger-child.ts"),
			directory,
			operationId,
		],
		{
			env: {
				...process.env,
				...(fault ? { OPENCUT_LEDGER_TEST_FAULT: fault } : {}),
				...(startGate ? { OPENCUT_LEDGER_START_GATE: startGate } : {}),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0 && !fault) {
		throw new Error(`ledger child failed (${exitCode}): ${stderr}`);
	}
	return {
		exitCode,
		stderr,
		json: stdout.trim() ? JSON.parse(stdout.trim()) : null,
	};
}

async function runAdoptChild(
	directory: string,
	operationId: string,
	fencingToken: string,
	fingerprint: string,
) {
	return runActionChild(
		directory,
		operationId,
		"adopt",
		fencingToken,
		fingerprint,
	);
}

async function runActionChild(
	directory: string,
	operationId: string,
	action: "adopt" | "complete" | "reconcile",
	fencingToken: string,
	fingerprint: string,
	ownerId?: string,
) {
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "operation-ledger-child.ts"),
			directory,
			operationId,
			action,
			fencingToken,
			fingerprint,
			...(ownerId ? [ownerId] : []),
		],
		{ env: process.env, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return {
		exitCode,
		stderr,
		json: stdout.trim() ? JSON.parse(stdout.trim()) : null,
	};
}

function id(entry: { record: { operationId: string } }): string {
	return entry.record.operationId;
}
