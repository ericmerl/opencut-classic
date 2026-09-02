import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MUTATING_TOOL_MANIFEST } from "./mutating-tool-manifest";

describe("MCP durable operation boundary registration", () => {
	test("routes every declared mutator through the handler boundary", async () => {
		const source = await readFile(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			"utf8",
		);
		for (const toolName of Object.keys(MUTATING_TOOL_MANIFEST)) {
			const registration = source.indexOf(`\"${toolName}\"`);
			expect(registration).toBeGreaterThan(-1);
			const nextRegistration = source.indexOf(
				"server.registerTool(",
				registration + toolName.length + 2,
			);
			const handler = source.slice(
				registration,
				nextRegistration === -1 ? source.length : nextRegistration,
			);
			expect(handler).toContain(`ledgerBoundary.execute(`);
			expect(handler).toContain(`\"${toolName}\"`);
		}
	});

	test("has no unmanifested boundary registrations", async () => {
		const source = await readFile(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			"utf8",
		);
		const names = [
			...source.matchAll(/ledgerBoundary\.execute\(\s*"([^"]+)"/g),
		].map((match) => match[1]);
		expect(new Set(names)).toEqual(
			new Set(Object.keys(MUTATING_TOOL_MANIFEST)),
		);
	});
});
