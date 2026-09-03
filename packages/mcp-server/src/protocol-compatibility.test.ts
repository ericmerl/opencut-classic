import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorBridge } from "./editor-bridge";
import { McpLedgerBoundary } from "./mcp-ledger-boundary";
import { OperationLedger } from "./operation-ledger";
import {
	LEGACY_V1_MUTATION_FLAG,
	readProtocolCompatibility,
} from "./protocol-compatibility";

describe("protocol v1 mutation compatibility", () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("is safely disabled by default and reports explicit opt-in as degraded", () => {
		expect(readProtocolCompatibility({})).toEqual({
			status: "ready",
			protocolV1Mutation: {
				enabled: false,
				configurationFlag: LEGACY_V1_MUTATION_FLAG,
				scope: "protocol-bearing-mutations",
				exemptTools: [
					"opencut_start_editor_worker",
					"opencut_stop_editor_worker",
				],
				reason: "Protocol v1 mutation is disabled; use protocol v2",
			},
		});
		expect(
			readProtocolCompatibility({ [LEGACY_V1_MUTATION_FLAG]: "1" }),
		).toEqual({
			status: "degraded",
			protocolV1Mutation: {
				enabled: true,
				configurationFlag: LEGACY_V1_MUTATION_FLAG,
				scope: "protocol-bearing-mutations",
				exemptTools: [
					"opencut_start_editor_worker",
					"opencut_stop_editor_worker",
				],
				reason:
					"Protocol v1 mutation is explicitly enabled without v2 safety guarantees",
			},
		});
	});

	test("rejects ambiguous configuration instead of silently enabling it", () => {
		expect(() =>
			readProtocolCompatibility({ [LEGACY_V1_MUTATION_FLAG]: "true" }),
		).toThrow(`${LEGACY_V1_MUTATION_FLAG} must be 1 when set`);
	});

	test("rejects explicit and omitted v1 mutation before ledger or effect side effects", async () => {
		const directory = await createDirectory();
		const ledger = new OperationLedger(directory);
		let effects = 0;
		const boundary = new McpLedgerBoundary(ledger, inertBridge());

		for (const input of [
			{ operationId: "legacy-explicit", bridgeProtocolVersion: 1 },
			{ operationId: "legacy-omitted" },
		]) {
			const result = await boundary.execute(
				"opencut_run_export_jobs",
				input,
				async () => {
					effects += 1;
					return { connected: false, processed: [] };
				},
			);
			expect(result).toMatchObject({
				status: "rejected",
				code: "PROTOCOL_V1_MUTATION_DISABLED",
				retryable: false,
				operationId: input.operationId,
				details: {
					configurationFlag: LEGACY_V1_MUTATION_FLAG,
					nextAction: expect.stringContaining("bridgeProtocolVersion 2"),
				},
			});
			expect(await ledger.get(input.operationId)).toBeNull();
		}
		expect(effects).toBe(0);
		ledger.close();
	});

	test("allows explicit v2 and bootstrap controls while the legacy gate is closed", async () => {
		const directory = await createDirectory();
		const ledger = new OperationLedger(directory);
		const boundary = new McpLedgerBoundary(ledger, inertBridge());

		const v2 = await boundary.execute(
			"opencut_run_export_jobs",
			{ operationId: "v2-run-jobs", bridgeProtocolVersion: 2 },
			async () => ({ connected: false, processed: [] }),
		);
		const bootstrap = await boundary.execute(
			"opencut_stop_editor_worker",
			{ operationId: "bootstrap-stop" },
			async () => ({ running: false, connected: false }),
		);

		expect(v2).toMatchObject({ durableOperationStatus: "completed" });
		expect(bootstrap).toMatchObject({
			running: false,
			durableOperationStatus: "completed",
		});
		ledger.close();
	});

	test("preserves the legacy mutation path only with explicit opt-in", async () => {
		const directory = await createDirectory();
		const ledger = new OperationLedger(directory);
		let effects = 0;
		const boundary = new McpLedgerBoundary(ledger, inertBridge(), {
			allowProtocolV1Mutation: true,
		});

		const result = await boundary.execute(
			"opencut_run_export_jobs",
			{ operationId: "legacy-run-jobs", bridgeProtocolVersion: 1 },
			async () => {
				effects += 1;
				return { connected: false, processed: [] };
			},
		);

		expect(result).toMatchObject({
			connected: false,
			processed: [],
			durableOperationStatus: "completed",
		});
		expect(effects).toBe(1);
		ledger.close();
	});

	async function createDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "opencut-protocol-v1-"));
		directories.push(directory);
		return directory;
	}
});

function inertBridge(): EditorBridge {
	return {
		request: async (method: string) => {
			throw new Error(`unexpected bridge request: ${method}`);
		},
	} as unknown as EditorBridge;
}
