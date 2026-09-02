import { OperationLedger, type OperationClaimInput } from "./operation-ledger";

const [
	directory,
	operationId,
	action = "claim",
	fencingToken,
	fingerprint,
	ownerId,
] = process.argv.slice(2);
if (!directory || !operationId)
	throw new Error("directory and operation ID are required");

const startGate = process.env.OPENCUT_LEDGER_START_GATE;
while (startGate && !(await Bun.file(startGate).exists())) {
	await Bun.sleep(5);
}

const input: OperationClaimInput = {
	operationId,
	operationKind: "child-claim",
	description: "Exercise a child-process ledger operation",
	operationType: "mutation",
	requiresSaveVerification: false,
	canonicalInput: { operationId },
	ownerId: ownerId ?? `child-${process.pid}`,
	actor: { type: "service", id: `child-${process.pid}` },
	leaseDurationMs: 60_000,
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

const ledger = new OperationLedger(directory, {
	now:
		action === "adopt" ? () => new Date("2100-01-01T00:00:00.000Z") : undefined,
});
const inputFingerprint = fingerprint ?? ledger.fingerprint(input);
let output: unknown;
switch (action) {
	case "adopt":
		output = await ledger.adopt(operationId, inputFingerprint, {
			ownerId: input.ownerId,
			expectedFencingToken: fencingToken ?? "missing",
			leaseDurationMs: 60_000,
		});
		break;
	case "complete":
		output = await ledger.complete(
			operationId,
			inputFingerprint,
			{ status: "completed-by-child" },
			{
				ownerId: input.ownerId,
				fencingToken: fencingToken ?? "missing",
				revisionAfter: 8,
				contentHashAfter: "b".repeat(64),
			},
		);
		break;
	case "reconcile":
		output = await ledger.reconcile(operationId, inputFingerprint, {
			ownerId: input.ownerId,
			fencingToken: fencingToken ?? "missing",
			leaseDurationMs: 60_000,
			phase: "verifying",
			revisionAfter: 8,
			contentHashAfter: "b".repeat(64),
		});
		break;
	case "claim":
		output = await ledger.claim(input);
		break;
	default:
		throw new Error(`unsupported child action: ${action}`);
}
process.stdout.write(`${JSON.stringify(output)}\n`);
ledger.close();
