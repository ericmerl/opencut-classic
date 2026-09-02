import * as z from "zod/v4";
import {
	operationDispositionSchema,
	operationStatusSchema,
} from "./operation-ledger";

export const operationIdSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
	.describe("Globally unique durable operation identity");

export const getOperationInputSchema = z.object({
	operationId: operationIdSchema,
});

export const listOperationHistoryInputSchema = z.object({
	limit: z.number().int().min(1).max(100).default(50),
	cursor: z
		.string()
		.regex(/^[1-9]\d*$/)
		.optional(),
	projectId: z.string().min(1).max(256).optional(),
	sceneId: z.string().min(1).max(256).optional(),
	operationKinds: z
		.array(z.string().min(1).max(256))
		.min(1)
		.max(100)
		.optional(),
	statuses: z.array(operationStatusSchema).min(1).max(3).optional(),
	dispositions: z.array(operationDispositionSchema).min(1).max(3).optional(),
	actorId: z.string().min(1).max(256).optional(),
});
