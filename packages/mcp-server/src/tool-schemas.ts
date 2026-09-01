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

const captionStyleSchema = z.object({
	fontFamily: z.string().min(1).optional(),
	fontSize: z
		.number()
		.positive()
		.describe(
			"Font size in OpenCut app units. Typical captions use 4 through 8; the default is 5.",
		)
		.optional(),
	color: z.string().min(1).optional(),
	textAlign: z.enum(["left", "center", "right"]).optional(),
	fontWeight: z.enum(["normal", "bold"]).optional(),
	fontStyle: z.enum(["normal", "italic"]).optional(),
	textDecoration: z.enum(["none", "underline", "line-through"]).optional(),
	letterSpacing: z.number().optional(),
	lineHeight: z.number().positive().optional(),
	background: z
		.object({
			enabled: z.boolean(),
			color: z.string().min(1),
			cornerRadius: z.number().optional(),
			paddingX: z.number().optional(),
			paddingY: z.number().optional(),
			offsetX: z.number().optional(),
			offsetY: z.number().optional(),
		})
		.optional(),
	placement: z
		.object({
			verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
			marginLeftRatio: z.number().min(0).max(1).optional(),
			marginRightRatio: z.number().min(0).max(1).optional(),
			marginVerticalRatio: z.number().min(0).max(1).optional(),
		})
		.optional(),
});

const audioFadeSchema = z
	.object({
		inDuration: z
			.number()
			.int()
			.nonnegative()
			.default(0)
			.describe("Fade-in duration in canonical media ticks."),
		outDuration: z
			.number()
			.int()
			.nonnegative()
			.default(0)
			.describe("Fade-out duration in canonical media ticks."),
		floorDb: z
			.number()
			.min(-60)
			.max(20)
			.default(-60)
			.describe("Gain at the silent ends of the fades, in dB."),
	})
	.describe(
		"Replace the clip's volume envelope with linear fades. Omitted durations default to zero; setting both to zero clears existing volume keyframes.",
	);

const transitionTypeSchema = z.enum([
	"crossfade",
	"fade-through-black",
	"slide",
	"wipe",
	"zoom",
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
		trackId: z
			.string()
			.min(1)
			.describe(
				"Caller-selected track ID. Use the same ID as targetTrackId in a later move within this edit plan.",
			),
	}),
	z
		.object({
			kind: z.literal("set_track_state"),
			trackId: z.string().min(1),
			muted: z.boolean().optional(),
			hidden: z.boolean().optional(),
		})
		.refine(
			(value) => value.muted !== undefined || value.hidden !== undefined,
			{ message: "at least one track state is required" },
		),
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
		kind: z.literal("insert_captions"),
		captions: z
			.array(
				z.object({
					text: z.string().trim().min(1),
					startTime: z.number().int().nonnegative(),
					duration: z.number().int().positive(),
				}),
			)
			.min(1),
		style: captionStyleSchema.optional(),
	}),
	z.object({
		kind: z.literal("delete"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("move"),
		trackId: z
			.string()
			.min(1)
			.describe("Current source track containing the element."),
		targetTrackId: z
			.string()
			.min(1)
			.describe("Compatible destination track. Defaults to the source track.")
			.optional(),
		elementId: z.string().min(1),
		startTime: z
			.number()
			.int()
			.nonnegative()
			.describe("New absolute timeline position in canonical media ticks."),
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
	z
		.object({
			kind: z.literal("set_audio"),
			trackId: z.string().min(1),
			elementId: z.string().min(1),
			volumeDb: z
				.number()
				.min(-60)
				.max(20)
				.describe("Base clip gain in dB.")
				.optional(),
			muted: z.boolean().optional(),
			fade: audioFadeSchema.optional(),
		})
		.refine(
			(value) =>
				value.volumeDb !== undefined ||
				value.muted !== undefined ||
				value.fade !== undefined,
			{ message: "at least one audio control is required" },
		),
	z.object({
		kind: z.literal("upsert_keyframe"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		propertyPath: z.string().trim().min(1),
		time: z
			.number()
			.int()
			.nonnegative()
			.describe(
				"Time relative to the element start, in canonical media ticks.",
			),
		value: z.union([z.string(), z.number(), z.boolean()]),
		interpolation: z.enum(["linear", "hold", "bezier"]).optional(),
		keyframeId: z
			.string()
			.trim()
			.min(1)
			.describe(
				"Stable caller-selected ID for creation, or an existing ID to update.",
			)
			.optional(),
	}),
	z.object({
		kind: z.literal("remove_keyframe"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		propertyPath: z.string().trim().min(1),
		keyframeId: z.string().trim().min(1),
	}),
	z.object({
		kind: z.literal("retime_keyframe"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		propertyPath: z.string().trim().min(1),
		keyframeId: z.string().trim().min(1),
		time: z
			.number()
			.int()
			.nonnegative()
			.describe(
				"New time relative to the element start, in canonical media ticks.",
			),
	}),
	z.object({
		kind: z.literal("upsert_transition"),
		trackId: z.string().min(1),
		transitionId: z.string().trim().min(1),
		fromElementId: z.string().min(1),
		toElementId: z.string().min(1),
		transitionType: transitionTypeSchema,
		duration: z
			.number()
			.int()
			.positive()
			.describe("Transition duration in canonical media ticks."),
	}),
	z.object({
		kind: z.literal("remove_transition"),
		trackId: z.string().min(1),
		transitionId: z.string().trim().min(1),
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
		startTime: z
			.number()
			.int()
			.nonnegative()
			.describe(
				"Optional new absolute timeline position. Omit to preserve the current position.",
			)
			.optional(),
		duration: z
			.number()
			.int()
			.positive()
			.describe(
				"Optional visible timeline duration. Omit to derive it from the source trims and retime rate.",
			)
			.optional(),
		trimStart: z
			.number()
			.int()
			.nonnegative()
			.describe("Amount removed from the beginning of the source, in ticks."),
		trimEnd: z
			.number()
			.int()
			.nonnegative()
			.describe("Amount removed from the end of the source, in ticks."),
	}),
	z.object({
		kind: z.literal("split"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		splitTime: z
			.number()
			.int()
			.positive()
			.describe("Absolute timeline split position in canonical media ticks."),
		retainSide: z.enum(["both", "left", "right"]).optional(),
	}),
]);

export const editPlanInputSchema = z
	.object({
		projectId: z.string().min(1),
		operationId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		description: z.string().min(1),
		operations: z.array(editOperationSchema).min(1),
	})
	.superRefine((plan, context) => {
		for (const [index, operation] of plan.operations.entries()) {
			if (operation.kind !== "add_track") continue;
			const isPopulatedByLaterMove = plan.operations
				.slice(index + 1)
				.some(
					(candidate) =>
						candidate.kind === "move" &&
						candidate.targetTrackId === operation.trackId,
				);
			if (!isPopulatedByLaterMove) {
				context.addIssue({
					code: "custom",
					path: ["operations", index],
					message: `new track ${operation.trackId} must receive an element from a later move in the same plan`,
				});
			}
		}
	});

export const importMediaInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	path: z.string().min(1),
	startTime: z.number().int().nonnegative(),
	trackId: z.string().min(1).optional(),
	adoptMediaSettings: z
		.boolean()
		.default(false)
		.describe(
			"When true, the first visual import adopts the media dimensions and frame rate. Defaults to false so imports preserve explicit project settings.",
		),
});

export const createProjectInputSchema = z.object({
	operationId: z.string().min(1),
	name: z.string().trim().min(1),
});

export const openProjectInputSchema = z.object({
	operationId: z.string().min(1),
	projectId: z.string().min(1),
});
