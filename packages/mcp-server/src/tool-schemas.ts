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

export const timelineQueryInputSchema = z
	.object({
		projectId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		startTime: z.number().int().nonnegative().optional(),
		endTime: z.number().int().nonnegative().optional(),
		trackIds: z.array(z.string().min(1)).min(1).optional(),
		elementTypes: z.array(z.string().min(1)).min(1).optional(),
	})
	.refine(
		(value) =>
			value.startTime === undefined ||
			value.endTime === undefined ||
			value.endTime >= value.startTime,
		{ message: "endTime must not precede startTime" },
	);

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

const normalizedRectSchema = z
	.object({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().min(0.001).max(1),
		height: z.number().min(0.001).max(1),
	})
	.refine((rect) => rect.x + rect.width <= 1, {
		message: "x + width must be at most 1",
	})
	.refine((rect) => rect.y + rect.height <= 1, {
		message: "y + height must be at most 1",
	});

const reframeLayoutSchema = z.enum([
	"full-frame",
	"split-left",
	"split-right",
	"split-top",
	"split-bottom",
	"pip-top-left",
	"pip-top-right",
	"pip-bottom-left",
	"pip-bottom-right",
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
	z
		.object({
			kind: z.literal("update_caption"),
			trackId: z.string().min(1),
			elementId: z.string().min(1),
			text: z.string().trim().min(1).optional(),
			startTime: z.number().int().nonnegative().optional(),
			duration: z.number().int().positive().optional(),
		})
		.refine(
			(value) =>
				value.text !== undefined ||
				value.startTime !== undefined ||
				value.duration !== undefined,
			{ message: "at least one caption correction is required" },
		),
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
			kind: z.literal("set_reframe"),
			trackId: z.string().min(1),
			elementId: z.string().min(1),
			mode: z.enum(["fit", "fill", "contain", "cover", "stretch"]).optional(),
			crop: normalizedRectSchema.optional(),
			focalPoint: z
				.object({
					x: z.number().min(0).max(1),
					y: z.number().min(0).max(1),
				})
				.optional(),
			targetRect: normalizedRectSchema.optional(),
			layout: reframeLayoutSchema.optional(),
		})
		.superRefine((value, context) => {
			if (
				value.mode === undefined &&
				value.crop === undefined &&
				value.focalPoint === undefined &&
				value.targetRect === undefined &&
				value.layout === undefined
			) {
				context.addIssue({
					code: "custom",
					message: "at least one reframe control is required",
				});
			}
			if (value.targetRect && value.layout) {
				context.addIssue({
					code: "custom",
					message: "targetRect and layout cannot be combined",
				});
			}
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
		kind: z.literal("separate_source_audio"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("duck_audio"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		regions: z.array(
			z.object({
				startTime: z.number().int().nonnegative(),
				duration: z.number().int().positive(),
			}),
		),
		reductionDb: z.number().positive().max(60).default(12),
		attackDuration: z.number().int().nonnegative().default(12_000),
		releaseDuration: z.number().int().nonnegative().default(30_000),
	}),
	z.object({
		kind: z.literal("adjust_mix_gain"),
		gainDb: z
			.number()
			.min(-60)
			.max(20)
			.describe(
				"Uniform gain adjustment in dB for every audible timeline element and its volume keyframes.",
			),
	}),
	z.object({
		kind: z.literal("upsert_effect"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectId: z.string().trim().min(1),
		effectType: z.string().trim().min(1),
		params: z
			.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
			.optional(),
		enabled: z.boolean().optional(),
	}),
	z.object({
		kind: z.literal("remove_effect"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectId: z.string().trim().min(1),
	}),
	z.object({
		kind: z.literal("reorder_effects"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		effectIds: z.array(z.string().trim().min(1)),
	}),
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
	z.object({
		kind: z.literal("set_matte_state"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		enabled: z.boolean(),
	}),
	z.object({
		kind: z.literal("remove_matte"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
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

export const importSubtitlesInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	path: z.string().min(1),
	style: captionStyleSchema.optional(),
});

export const exportSubtitlesInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	outputPath: z.string().min(1),
	format: z.enum(["srt", "vtt"]),
	trackIds: z.array(z.string().min(1)).min(1).optional(),
});

export const transcribeTimelineInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	language: z.string().trim().min(1).default("auto"),
	modelId: z
		.enum([
			"whisper-tiny",
			"whisper-small",
			"whisper-medium",
			"whisper-large-v3-turbo",
		])
		.default("whisper-small"),
	wordsPerCaption: z.number().int().min(1).max(20).default(3),
	minCaptionDuration: z.number().min(0.1).max(10).default(0.8),
	style: captionStyleSchema.optional(),
});

export const attachMatteInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	trackId: z.string().min(1),
	elementId: z.string().min(1),
	path: z.string().min(1),
	channel: z
		.enum(["alpha", "red"])
		.default("red")
		.describe(
			"Channel containing foreground opacity. Use red for grayscale mattes and alpha for RGBA mattes.",
		),
	modelId: z.string().trim().min(1),
	modelVersion: z.string().trim().min(1),
});

export const generateMatteInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	trackId: z.string().min(1),
	elementId: z.string().min(1),
	modelId: z.string().trim().min(1).optional(),
	modelVersion: z.string().trim().min(1).optional(),
	options: z
		.record(
			z.string(),
			z.union([z.string(), z.number(), z.boolean(), z.null()]),
		)
		.default({}),
	timeoutSeconds: z.number().int().min(1).max(7200).default(1800),
});

export const trackSubjectInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	trackId: z.string().min(1),
	elementId: z.string().min(1),
	trackingMode: z.enum(["focal-point", "crop"]).default("focal-point"),
	subjectPrompt: z.string().trim().min(1).optional(),
	initialBox: normalizedRectSchema.optional(),
	sampleIntervalTicks: z
		.number()
		.int()
		.min(1)
		.default(12_000)
		.describe("Tracker sampling interval in canonical media ticks."),
	maxSamples: z.number().int().min(1).max(10_000).default(2_000),
	minConfidence: z.number().min(0).max(1).default(0.25),
	smoothing: z
		.number()
		.min(0)
		.max(0.99)
		.default(0.75)
		.describe("Exponential smoothing strength. Zero disables smoothing."),
	padding: z
		.number()
		.min(0)
		.max(2)
		.default(0.25)
		.describe("Crop padding as a fraction of the tracked box size."),
	modelId: z.string().trim().min(1).optional(),
	modelVersion: z.string().trim().min(1).optional(),
	options: z
		.record(
			z.string(),
			z.union([z.string(), z.number(), z.boolean(), z.null()]),
		)
		.default({}),
	timeoutSeconds: z.number().int().min(1).max(7200).default(1800),
});

const elementReferenceSchema = z.object({
	trackId: z.string().min(1),
	elementId: z.string().min(1),
});

export const syncAudioInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	reference: elementReferenceSchema,
	target: elementReferenceSchema,
	maxOffsetTicks: z.number().int().positive().max(7_200_000).default(1_200_000),
	analysisSampleRate: z.number().int().min(50).max(1_000).default(200),
	maxAnalysisDurationTicks: z
		.number()
		.int()
		.positive()
		.max(14_400_000)
		.default(7_200_000),
	minCorrelation: z.number().min(0).max(1).default(0.35),
});

export const createProjectInputSchema = z.object({
	operationId: z.string().min(1),
	name: z.string().trim().min(1),
});

export const openProjectInputSchema = z.object({
	operationId: z.string().min(1),
	projectId: z.string().min(1),
});
