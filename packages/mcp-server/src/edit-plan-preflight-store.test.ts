import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	EditPlanPreflightIntegrityError,
	EditPlanPreflightReuseError,
	EditPlanPreflightStore,
	type EditPlanPreflightReceipt,
} from "./edit-plan-preflight-store";
import { removeTestDirectory } from "./test-filesystem";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await removeTestDirectory(directory);
	}
});

describe("durable edit-plan preflight receipts", () => {
	test("claims once, replays the exact terminal receipt, and survives restart", async () => {
		const directory = await testDirectory();
		const store = new EditPlanPreflightStore(directory);
		expect(await store.claim("preflight-1", "a".repeat(64))).toEqual({
			status: "claimed",
		});
		const receipt = makeReceipt();
		expect(await store.complete(receipt)).toEqual(receipt);
		expect(await store.claim("preflight-1", "a".repeat(64))).toEqual({
			status: "replayed",
			receipt,
		});
		store.close();

		const restarted = new EditPlanPreflightStore(directory);
		expect(await restarted.get(receipt.receiptId)).toEqual(receipt);
		expect((await restarted.list({ limit: 10 })).receipts).toEqual([receipt]);
		restarted.close();
	});

	test("serializes identical claims and rejects changed reuse", async () => {
		const directory = await testDirectory();
		const left = new EditPlanPreflightStore(directory);
		const right = new EditPlanPreflightStore(directory);
		const outcomes = await Promise.all([
			left.claim("shared", "b".repeat(64)),
			right.claim("shared", "b".repeat(64)),
		]);
		expect(outcomes.filter(({ status }) => status === "claimed")).toHaveLength(
			1,
		);
		expect(
			outcomes.filter(({ status }) => status === "in-progress"),
		).toHaveLength(1);
		await expect(right.claim("shared", "c".repeat(64))).rejects.toBeInstanceOf(
			EditPlanPreflightReuseError,
		);
		left.close();
		right.close();
	});

	test("reconciles a verified external receipt across live claim owners", async () => {
		const directory = await testDirectory();
		const owner = new EditPlanPreflightStore(directory);
		const peer = new EditPlanPreflightStore(directory);
		expect(await owner.claim("preflight-1", "a".repeat(64))).toEqual({
			status: "claimed",
		});
		expect(await peer.claim("preflight-1", "a".repeat(64))).toEqual({
			status: "in-progress",
		});
		const receipt = makeReceipt();
		expect(await peer.reconcile(receipt)).toEqual(receipt);
		expect(await owner.complete(receipt)).toEqual(receipt);
		expect(await peer.claim("preflight-1", "a".repeat(64))).toEqual({
			status: "replayed",
			receipt,
		});
		owner.close();
		peer.close();
	});

	test("fails closed on receipt corruption and event-tail deletion", async () => {
		const directory = await testDirectory();
		const store = new EditPlanPreflightStore(directory);
		await store.claim("preflight-1", "a".repeat(64));
		await store.complete(makeReceipt());
		store.close();

		const database = new Database(
			join(directory, "edit-plan-preflights.sqlite"),
		);
		database.exec("DROP TRIGGER preflight_receipts_immutable");
		database.query("UPDATE preflight_receipts SET receipt_json='{}'").run();
		database.close();
		const corrupt = new EditPlanPreflightStore(directory);
		await expect(corrupt.readiness()).rejects.toBeInstanceOf(
			EditPlanPreflightIntegrityError,
		);
		corrupt.close();

		const tailDirectory = await testDirectory();
		const tail = new EditPlanPreflightStore(tailDirectory);
		await tail.claim("preflight-1", "a".repeat(64));
		await tail.complete(makeReceipt());
		tail.close();
		const tailDatabase = new Database(
			join(tailDirectory, "edit-plan-preflights.sqlite"),
		);
		tailDatabase.exec("DROP TRIGGER preflight_events_no_delete");
		tailDatabase
			.query(
				"DELETE FROM preflight_events WHERE sequence=(SELECT MAX(sequence) FROM preflight_events)",
			)
			.run();
		tailDatabase.close();
		const deletedTail = new EditPlanPreflightStore(tailDirectory);
		await expect(deletedTail.readiness()).rejects.toBeInstanceOf(
			EditPlanPreflightIntegrityError,
		);
		deletedTail.close();

		const claimDirectory = await testDirectory();
		const claimStore = new EditPlanPreflightStore(claimDirectory);
		await claimStore.claim("preflight-1", "a".repeat(64));
		claimStore.close();
		const claimDatabase = new Database(
			join(claimDirectory, "edit-plan-preflights.sqlite"),
		);
		claimDatabase.exec("DROP TRIGGER preflight_claim_identity_immutable");
		claimDatabase
			.query("UPDATE preflight_claims SET request_fingerprint=?")
			.run("f".repeat(64));
		claimDatabase.close();
		const corruptClaim = new EditPlanPreflightStore(claimDirectory);
		await expect(corruptClaim.readiness()).rejects.toBeInstanceOf(
			EditPlanPreflightIntegrityError,
		);
		corruptClaim.close();
	});

	test("adopts a claim owned by a terminated process and fences live owners", async () => {
		const directory = await testDirectory();
		const script = `const { EditPlanPreflightStore } = await import("./packages/mcp-server/src/edit-plan-preflight-store.ts"); const store = new EditPlanPreflightStore(${JSON.stringify(directory)}); await store.claim("orphan", "${"f".repeat(64)}"); process.exit(17);`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		expect(await child.exited).toBe(17);
		const adopted = new EditPlanPreflightStore(directory);
		expect(await adopted.claim("orphan", "f".repeat(64))).toEqual({
			status: "claimed",
		});
		const livePeer = new EditPlanPreflightStore(directory);
		expect(await livePeer.claim("orphan", "f".repeat(64))).toEqual({
			status: "in-progress",
		});
		adopted.close();
		livePeer.close();
	});

	test("serializes synchronized cross-process cold start and claims", async () => {
		const directory = await testDirectory();
		const gate = join(directory, "start.gate");
		const release = join(directory, "release.gate");
		const script = `const { existsSync } = await import("node:fs"); const { EditPlanPreflightStore } = await import("./packages/mcp-server/src/edit-plan-preflight-store.ts"); while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5); const store = new EditPlanPreflightStore(${JSON.stringify(directory)}); const result = await store.claim("shared", "${"b".repeat(64)}"); console.log(JSON.stringify(result)); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5); store.close();`;
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, "-e", script], {
				cwd: resolve(import.meta.dir, "../../.."),
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			}),
		);
		await writeFile(gate, "start", { flag: "wx" });
		try {
			const outputs = await Promise.all(
				children.map((child) => readJsonLine(child.stdout)),
			);
			expect(outputs.filter(({ status }) => status === "claimed")).toHaveLength(
				1,
			);
			expect(
				outputs.filter(({ status }) => status === "in-progress"),
			).toHaveLength(1);
		} finally {
			if (!existsSync(release))
				await writeFile(release, "release", { flag: "wx" });
			expect(await Promise.all(children.map((child) => child.exited))).toEqual([
				0, 0,
			]);
		}

		const changed = new EditPlanPreflightStore(directory);
		await expect(
			changed.claim("shared", "c".repeat(64)),
		).rejects.toBeInstanceOf(EditPlanPreflightReuseError);
		changed.close();
	});

	test("rejects an unsupported persistent schema version", async () => {
		const directory = await testDirectory();
		const store = new EditPlanPreflightStore(directory);
		await store.readiness();
		store.close();
		const database = new Database(
			join(directory, "edit-plan-preflights.sqlite"),
		);
		database.exec("PRAGMA user_version=99");
		database.close();
		const unsupported = new EditPlanPreflightStore(directory);
		await expect(unsupported.readiness()).rejects.toThrow(
			"unsupported edit-plan preflight schema version: 99",
		);
		unsupported.close();
	});

	test("uses stable durable cursors across restart and source filters", async () => {
		const directory = await testDirectory();
		const store = new EditPlanPreflightStore(directory);
		for (let index = 1; index <= 3; index += 1) {
			const fingerprint = String(index).repeat(64);
			await store.claim(`preflight-${index}`, fingerprint);
			await store.complete(makeReceipt(index));
		}
		const first = await store.list({ projectId: "project-1", limit: 2 });
		expect(first.receipts.map(({ preflightId }) => preflightId)).toEqual([
			"preflight-3",
			"preflight-2",
		]);
		expect(first.nextCursor).toBeString();
		await expect(
			store.list({ sceneId: "scene-1", limit: 2, cursor: first.nextCursor }),
		).rejects.toThrow("cursor does not match the requested filters");
		store.close();

		const restarted = new EditPlanPreflightStore(directory);
		const second = await restarted.list({
			projectId: "project-1",
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.receipts.map(({ preflightId }) => preflightId)).toEqual([
			"preflight-1",
		]);
		expect(second.nextCursor).toBeUndefined();
		restarted.close();
	});
});

async function readJsonLine(
	stream: ReadableStream<Uint8Array>,
): Promise<{ status: string }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) throw new Error("child exited before publishing its claim");
			output += decoder.decode(value, { stream: true });
			const newline = output.indexOf("\n");
			if (newline >= 0) {
				return JSON.parse(output.slice(0, newline).trim()) as {
					status: string;
				};
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function testDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "opencut-preflight-test-"));
	directories.push(directory);
	return directory;
}

function makeReceipt(index?: number): EditPlanPreflightReceipt {
	const suffix = index ?? 1;
	return {
		schemaVersion: 1,
		receiptId: `preflight-receipt:preflight-${suffix}`,
		preflightId: `preflight-${suffix}`,
		requestFingerprint: (index === undefined ? "a" : String(index)).repeat(64),
		planFingerprint: "b".repeat(64),
		preflightFingerprint: "c".repeat(64),
		planDiffHash: "d".repeat(64),
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 7,
		contentHash: "e".repeat(64),
		writeVersion: 9,
		saveReceiptOperationId: "save-op-1",
		saveReceiptId: "save:project-1:9",
		createdAt: `2026-09-02T20:00:0${suffix}.000Z`,
		terminalResult: {
			status: "rejected",
			preflightId: `preflight-${suffix}`,
			code: "PERSISTED_SOURCE_UNAVAILABLE",
			reason: "persisted source is unavailable",
		},
	};
}
