import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CommandGateway, type EditPlan, type ProjectSnapshot } from "./model";

const INITIAL: ProjectSnapshot = {
	projectId: "demo-project",
	revision: 0,
	elements: [
		{
			id: "clip-1",
			kind: "video",
			label: "Opening clip",
			startTick: 0,
			durationTicks: 300,
		},
	],
};

const ATOMIC_PLAN: EditPlan = {
	operationId: "agent-edit-001",
	expectedRevision: 0,
	description: "Move opening clip and add title",
	operations: [
		{ type: "move", elementId: "clip-1", startTick: 120 },
		{
			type: "insert",
			element: {
				id: "title-1",
				kind: "text",
				label: "Agentic edit",
				startTick: 0,
				durationTicks: 120,
			},
		},
	],
};

let gateway = new CommandGateway(INITIAL);

function printSnapshot(snapshot = gateway.read()): void {
	console.log(`\nProject ${snapshot.projectId}, revision ${snapshot.revision}`);
	console.table(snapshot.elements);
}

async function runScriptedDemo(): Promise<void> {
	console.log("MCP command gateway logic prototype");
	printSnapshot();

	console.log("\n1. Apply a two-operation edit plan as one revision");
	console.log(await gateway.apply(ATOMIC_PLAN));
	printSnapshot();

	console.log(
		"\n2. Retry the identical operation ID after a simulated lost response",
	);
	console.log(await gateway.apply(ATOMIC_PLAN));
	printSnapshot();

	console.log("\n3. Reject reuse of one operation ID for a different plan");
	console.log(
		await gateway.apply({
			...ATOMIC_PLAN,
			operations: [{ type: "move", elementId: "clip-1", startTick: 600 }],
		}),
	);

	console.log("\n4. Reject a stale writer");
	console.log(
		await gateway.apply({
			operationId: "agent-edit-stale",
			expectedRevision: 0,
			description: "Stale trim",
			operations: [{ type: "trim", elementId: "clip-1", durationTicks: 240 }],
		}),
	);

	console.log(
		"\n5. Reject an invalid batch without applying its first operation",
	);
	console.log(
		await gateway.apply({
			operationId: "agent-edit-invalid",
			expectedRevision: 1,
			description: "Atomic failure demonstration",
			operations: [
				{ type: "move", elementId: "clip-1", startTick: 999 },
				{ type: "remove", elementId: "missing-clip" },
			],
		}),
	);
	printSnapshot();

	console.log("\n6. Serialize two concurrent writers so only one can commit");
	const concurrentGateway = new CommandGateway(INITIAL);
	console.log(
		await Promise.all([
			concurrentGateway.apply({
				operationId: "writer-a",
				expectedRevision: 0,
				description: "Writer A",
				operations: [{ type: "move", elementId: "clip-1", startTick: 240 }],
			}),
			concurrentGateway.apply({
				operationId: "writer-b",
				expectedRevision: 0,
				description: "Writer B",
				operations: [{ type: "move", elementId: "clip-1", startTick: 480 }],
			}),
		]),
	);

	console.log("\n7. Undo the whole successful edit plan in one step");
	console.log(await gateway.undo(1));
	printSnapshot();
}

async function runInteractive(): Promise<void> {
	const input = createInterface({ input: stdin, output: stdout });
	console.log("MCP command gateway logic prototype");
	console.log(
		"Commands: snapshot, apply, replay, stale, concurrent, undo, reset, demo, quit",
	);

	for (;;) {
		const command = (await input.question("\ngateway> ")).trim().toLowerCase();
		switch (command) {
			case "snapshot":
				printSnapshot();
				break;
			case "apply":
			case "replay":
				console.log(await gateway.apply(ATOMIC_PLAN));
				break;
			case "stale":
				console.log(
					await gateway.apply({
						operationId: `stale-${Date.now()}`,
						expectedRevision: 0,
						description: "Stale move",
						operations: [{ type: "move", elementId: "clip-1", startTick: 600 }],
					}),
				);
				break;
			case "concurrent": {
				const revision = gateway.read().revision;
				console.log(
					await Promise.all([
						gateway.apply({
							operationId: `writer-a-${Date.now()}`,
							expectedRevision: revision,
							description: "Writer A",
							operations: [
								{ type: "move", elementId: "clip-1", startTick: 240 },
							],
						}),
						gateway.apply({
							operationId: `writer-b-${Date.now()}`,
							expectedRevision: revision,
							description: "Writer B",
							operations: [
								{ type: "move", elementId: "clip-1", startTick: 480 },
							],
						}),
					]),
				);
				break;
			}
			case "undo":
				console.log(await gateway.undo(gateway.read().revision));
				break;
			case "reset":
				gateway = new CommandGateway(INITIAL);
				printSnapshot();
				break;
			case "demo":
				gateway = new CommandGateway(INITIAL);
				await runScriptedDemo();
				break;
			case "quit":
			case "exit":
				input.close();
				return;
			default:
				console.log("Unknown command");
		}
	}
}

if (process.argv.includes("--demo") || !stdin.isTTY) {
	await runScriptedDemo();
} else {
	await runInteractive();
}
