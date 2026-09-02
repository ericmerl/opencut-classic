import { describe, expect, test } from "bun:test";
import {
	getOperationInputSchema,
	listOperationHistoryInputSchema,
	operationIdSchema,
} from "./operation-tool-schemas";

describe("operation history MCP schemas", () => {
	test("uses the same bounded operation identity domain as the ledger", () => {
		expect(operationIdSchema.parse("edit/scene-1:attempt@2")).toBe(
			"edit/scene-1:attempt@2",
		);
		expect(() => operationIdSchema.parse("contains spaces")).toThrow();
		expect(() => operationIdSchema.parse("a".repeat(257))).toThrow();
		expect(getOperationInputSchema.parse({ operationId: "edit-1" })).toEqual({
			operationId: "edit-1",
		});
	});

	test("accepts bounded filters and an opaque monotonic cursor", () => {
		expect(
			listOperationHistoryInputSchema.parse({
				cursor: "42",
				projectId: "project-1",
				operationKinds: ["apply-edit-plan"],
				statuses: ["started"],
				dispositions: ["unknown"],
				actorId: "codex",
			}),
		).toMatchObject({ cursor: "42", limit: 50 });
		expect(() =>
			listOperationHistoryInputSchema.parse({ cursor: "0" }),
		).toThrow();
		expect(() =>
			listOperationHistoryInputSchema.parse({ limit: 101 }),
		).toThrow();
	});
});
