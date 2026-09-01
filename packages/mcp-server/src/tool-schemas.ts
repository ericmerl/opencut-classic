import * as z from "zod/v4";

const frameRateSchema = z.object({
	numerator: z.number().int().positive(),
	denominator: z.number().int().positive(),
});

const canvasSizeSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});

const backgroundSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("color"), color: z.string().min(1) }),
	z.object({
		type: z.literal("blur"),
		blurIntensity: z.number().nonnegative(),
	}),
]);

const editOperationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("insert_text"),
		content: z.string().min(1),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("add_track"),
		trackType: z.enum(["video", "text", "audio", "graphic", "effect"]),
	}),
	z
		.object({
			kind: z.literal("set_project_settings"),
			fps: frameRateSchema.optional(),
			canvasSize: canvasSizeSchema.optional(),
			background: backgroundSchema.optional(),
		})
		.refine(
			(value) =>
				value.fps !== undefined ||
				value.canvasSize !== undefined ||
				value.background !== undefined,
			{ message: "at least one project setting is required" },
		),
	z.object({
		kind: z.literal("delete"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("move"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		startTime: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal("set_params"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		params: z
			.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
			.refine((value) => Object.keys(value).length > 0, {
				message: "params cannot be empty",
			}),
	}),
	z.object({
		kind: z.literal("set_retime"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		rate: z.number().min(0.01).max(5),
		maintainPitch: z.boolean().optional(),
	}),
	z.object({
		kind: z.literal("trim"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
		trimStart: z.number().int().nonnegative(),
		trimEnd: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("split"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		splitTime: z.number().int().positive(),
		retainSide: z.enum(["both", "left", "right"]).optional(),
	}),
]);

export const editPlanInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	description: z.string().min(1),
	operations: z.array(editOperationSchema).min(1),
});

export const importMediaInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	path: z.string().min(1),
	startTime: z.number().int().nonnegative(),
	trackId: z.string().min(1).optional(),
});
