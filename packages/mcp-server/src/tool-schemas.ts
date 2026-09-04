import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { BOOTSTRAP_PROJECT_ID } from "./managed-editor-worker";
import { operationIdSchema } from "./operation-tool-schemas";

const legacyCompatibleOperationIdSchema = operationIdSchema.optional();

function withLegacyOperationIdDefault<T extends z.ZodType>(
	schema: T,
	field = "operationId",
) {
	return schema.transform((value) => {
		if (
			value !== null &&
			typeof value === "object" &&
			(value as Record<string, unknown>)[field] === undefined
		) {
			return { ...value, [field]: `legacy:${randomUUID()}` };
		}
		return value;
	});
}

export const connectionIdentitySchema = z.object({
	serverInstanceId: z.string().min(1).describe("MCP bridge process affinity"),
	editorInstanceId: z
		.string()
		.min(1)
		.describe("Durable browser editor affinity"),
	editorSessionId: z.string().min(1).describe("Browser-session affinity"),
	connectionGeneration: z
		.number()
		.int()
		.positive()
		.describe("Monotonic connection affinity generation"),
});

const connectionAffinitySchema = z.union([
	z.object({
		bridgeProtocolVersion: z.literal(1).optional(),
		expectedConnectionIdentity: z.never().optional(),
	}),
	z.object({
		bridgeProtocolVersion: z.literal(2),
		expectedConnectionIdentity: connectionIdentitySchema.describe(
			"Required v2 routing affinity. This detects retargeting; it is not an authorization credential.",
		),
	}),
]);

export function withConnectionAffinity<T extends z.ZodType>(schema: T) {
	return z.intersection(schema, connectionAffinitySchema);
}

export function withMutationOperationId<
	T extends z.ZodType,
	TField extends string = "operationId",
>(schema: T, field = "operationId" as TField) {
	return withConnectionAffinity(schema)
		.superRefine((value, context) => {
			if (
				value.bridgeProtocolVersion === 2 &&
				(value as Record<string, unknown>)[field] === undefined
			) {
				context.addIssue({
					code: "custom",
					path: [field],
					message: `bridge protocol v2 mutations require ${field}`,
				});
			}
		})
		.transform((value): typeof value & Record<TField, string> => {
			const result =
				(value as Record<string, unknown>)[field] === undefined
					? { ...value, [field]: `legacy:${randomUUID()}` }
					: value;
			return result as typeof value & Record<TField, string>;
		});
}

export function withProjectMutationSafety<T extends z.ZodType>(schema: T) {
	return withMutationOperationId(
		z.intersection(
			schema,
			z.object({
				expectedProjectContentHash: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional(),
			}),
		),
	).superRefine((value, context) => {
		if (
			value.bridgeProtocolVersion === 2 &&
			!value.expectedProjectContentHash
		) {
			context.addIssue({
				code: "custom",
				path: ["expectedProjectContentHash"],
				message: "bridge protocol v2 requires expectedProjectContentHash",
			});
		}
	});
}

export function withTargetProjectMutationSafety<T extends z.ZodType>(
	schema: T,
) {
	return withMutationOperationId(schema).superRefine((value, context) => {
		if (value.bridgeProtocolVersion !== 2) return;
		const fields = value as Record<string, unknown>;
		if (!fields.expectedTargetContentHash) {
			context.addIssue({
				code: "custom",
				path: ["expectedTargetContentHash"],
				message: "bridge protocol v2 requires expectedTargetContentHash",
			});
		}
		if (!fields.expectedTargetWriteVersion) {
			context.addIssue({
				code: "custom",
				path: ["expectedTargetWriteVersion"],
				message: "bridge protocol v2 requires expectedTargetWriteVersion",
			});
		}
	});
}

const lifecyclePreflightBindingSchema = z.object({
	preflightFingerprint: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});

function requireLifecyclePreflight<T extends z.ZodType>(schema: T) {
	return schema.superRefine((value, context) => {
		const fields = value as Record<string, unknown>;
		if (fields.bridgeProtocolVersion === 2 && !fields.preflightFingerprint) {
			context.addIssue({
				code: "custom",
				path: ["preflightFingerprint"],
				message:
					"bridge protocol v2 lifecycle mutations require a preflightFingerprint",
			});
		}
	});
}

export function withLifecycleProjectMutationSafety<T extends z.ZodType>(
	schema: T,
) {
	return requireLifecyclePreflight(
		withProjectMutationSafety(
			z.intersection(schema, lifecyclePreflightBindingSchema),
		),
	);
}

export function withLifecycleTargetProjectMutationSafety<T extends z.ZodType>(
	schema: T,
) {
	return requireLifecyclePreflight(
		withTargetProjectMutationSafety(
			z.intersection(schema, lifecyclePreflightBindingSchema),
		),
	);
}

const frameRateSchema = z
	.object({
		numerator: z.number().int().positive(),
		denominator: z.number().int().positive(),
	})
	.strict();

const canvasSizeSchema = z
	.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	})
	.strict();

export const previewTimeSelectorSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("frame-index"),
			frameIndex: z.number().int().min(0).max(10_000_000),
		})
		.strict(),
	z
		.object({
			kind: z.literal("media-time"),
			ticks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
			rounding: z.enum(["exact", "floor", "nearest", "ceil"]),
		})
		.strict(),
]);

export const renderPreviewFrameInputSchema = z
	.object({
		contractVersion: z.literal(2),
		bridgeProtocolVersion: z.literal(2),
		expectedConnectionIdentity: connectionIdentitySchema,
		operationId: operationIdSchema,
		projectId: z.string().min(1),
		sceneId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		expectedProjectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
		expectedWriteVersion: z.number().int().positive(),
		saveReceiptOperationId: operationIdSchema,
		expectedSaveReceiptId: z.string().min(1).max(512),
		time: previewTimeSelectorSchema,
		canvasSize: z
			.object({
				width: z.number().int().min(16).max(4096),
				height: z.number().int().min(16).max(4096),
			})
			.strict(),
		format: z.literal("png"),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.canvasSize.width * value.canvasSize.height > 8_294_400) {
			context.addIssue({
				code: "custom",
				path: ["canvasSize"],
				message: "preview canvas exceeds the 16777216-pixel limit",
			});
		}
	});

export const getPreviewFrameInputSchema = z
	.object({ receiptId: z.string().min(1).max(512) })
	.strict();

export const listPreviewFramesInputSchema = z
	.object({
		projectId: z.string().min(1).optional(),
		sceneId: z.string().min(1).optional(),
		limit: z.number().int().min(1).max(100).default(25),
		cursor: z.string().min(1).max(512).optional(),
	})
	.strict();

export const previewRangeSelectorSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("media-time"),
			startTicks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
			endTicksExclusive: z
				.number()
				.int()
				.positive()
				.max(Number.MAX_SAFE_INTEGER),
		})
		.strict(),
	z
		.object({
			kind: z.literal("frame-index"),
			startFrameIndex: z.number().int().min(0).max(10_000_000),
			endFrameIndexExclusive: z.number().int().positive().max(10_000_001),
		})
		.strict(),
]);

export const renderPreviewRangeInputSchema = z
	.object({
		contractVersion: z.literal(1),
		bridgeProtocolVersion: z.literal(2),
		expectedConnectionIdentity: connectionIdentitySchema,
		operationId: operationIdSchema,
		projectId: z.string().min(1),
		sceneId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		expectedProjectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
		expectedWriteVersion: z.number().int().positive(),
		saveReceiptOperationId: operationIdSchema,
		expectedSaveReceiptId: z.string().min(1).max(512),
		range: previewRangeSelectorSchema,
		canvasSize: z
			.object({
				width: z.number().int().min(16).max(4096),
				height: z.number().int().min(16).max(4096),
			})
			.strict(),
		output: z
			.object({
				kind: z.literal("frame-sequence"),
				frameFormat: z.literal("png"),
				includeAudio: z.boolean().default(false),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.canvasSize.width * value.canvasSize.height > 16_777_216)
			context.addIssue({
				code: "custom",
				path: ["canvasSize"],
				message: "preview canvas exceeds the 16777216-pixel limit",
				input: value,
			});
		const start =
			value.range.kind === "media-time"
				? value.range.startTicks
				: value.range.startFrameIndex;
		const end =
			value.range.kind === "media-time"
				? value.range.endTicksExclusive
				: value.range.endFrameIndexExclusive;
		if (end <= start)
			context.addIssue({
				code: "custom",
				path: ["range"],
				message: "preview range end must be greater than its start",
				input: value,
			});
	});

export const cancelPreviewRangeInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
		targetOperationId: operationIdSchema,
	}),
);

export const getPreviewRangeInputSchema = z
	.object({ receiptId: z.string().min(1).max(512) })
	.strict();

export const listPreviewRangesInputSchema = z
	.object({
		projectId: z.string().min(1).optional(),
		sceneId: z.string().min(1).optional(),
		limit: z.number().int().min(1).max(100).default(25),
	})
	.strict();

export const comparisonSourceBindingSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		projectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
		projectionName: z.literal("opencut-project-content"),
		projectionVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
		writeVersion: z.number().int().positive(),
		saveReceiptOperationId: operationIdSchema,
		saveReceiptId: z.string().min(1).max(512),
	})
	.strict();

const comparisonCanvasSizeSchema = z
	.object({
		width: z.number().int().min(16).max(4096),
		height: z.number().int().min(16).max(4096),
	})
	.strict();

const comparisonNormalizationSchema = z
	.object({
		canvas: z.literal("none"),
		color: z.literal("none"),
		fonts: z.literal("exact"),
		timing: z.literal("shared-schedule"),
	})
	.strict();

const comparisonOutputSchema = z
	.object({
		frameFormat: z.literal("png"),
		comparison: z.enum(["side-by-side", "wipe"]),
		wipePosition: z.number().min(0).max(1).optional(),
		includeAudio: z.literal(true),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.comparison === "wipe" && value.wipePosition === undefined) {
			context.addIssue({
				code: "custom",
				path: ["wipePosition"],
				message: "wipe comparisons require wipePosition",
			});
		}
		if (value.comparison !== "wipe" && value.wipePosition !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["wipePosition"],
				message: "wipePosition is only valid for wipe comparisons",
			});
		}
	});

export const compareProjectStatesInputSchema = z
	.object({
		contractVersion: z.literal(1),
		bridgeProtocolVersion: z.literal(2),
		expectedConnectionIdentity: connectionIdentitySchema,
		operationId: operationIdSchema,
		projectId: z.string().min(1),
		sceneId: z.string().min(1),
		before: comparisonSourceBindingSchema,
		after: comparisonSourceBindingSchema,
		range: previewRangeSelectorSchema,
		canvasSize: comparisonCanvasSizeSchema,
		normalization: comparisonNormalizationSchema,
		output: comparisonOutputSchema,
		pixelTolerance: z.number().int().min(0).max(255),
		audioSampleTolerance: z.number().int().min(0).max(32_767),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.canvasSize.width * value.canvasSize.height > 16_777_216) {
			context.addIssue({
				code: "custom",
				path: ["canvasSize"],
				message: "comparison canvas exceeds the 8294400-pixel limit",
				input: value,
			});
		}
		if (
			value.output.comparison === "side-by-side" &&
			value.canvasSize.width * value.canvasSize.height * 2 > 16_777_216
		) {
			context.addIssue({
				code: "custom",
				path: ["canvasSize"],
				message:
					"side-by-side comparison output exceeds the 16777216-pixel composite limit",
				input: value,
			});
		}
		const start =
			value.range.kind === "media-time"
				? value.range.startTicks
				: value.range.startFrameIndex;
		const end =
			value.range.kind === "media-time"
				? value.range.endTicksExclusive
				: value.range.endFrameIndexExclusive;
		if (end <= start) {
			context.addIssue({
				code: "custom",
				path: ["range"],
				message: "comparison range end must be greater than its start",
				input: value,
			});
		}
	});

export const cancelComparisonInputSchema = z
	.object({
		bridgeProtocolVersion: z.literal(2),
		expectedConnectionIdentity: connectionIdentitySchema,
		operationId: operationIdSchema,
		targetOperationId: operationIdSchema,
	})
	.strict();

export const getComparisonInputSchema = z
	.object({ receiptId: z.string().min(1).max(512) })
	.strict();

export const listComparisonsInputSchema = z
	.object({
		projectId: z.string().min(1).optional(),
		sceneId: z.string().min(1).optional(),
		limit: z.number().int().min(1).max(100).default(25),
	})
	.strict();

export type ComparisonSourceBinding = z.infer<
	typeof comparisonSourceBindingSchema
>;
export type CompareProjectStatesInput = z.infer<
	typeof compareProjectStatesInputSchema
>;
export type CancelComparisonInput = z.infer<typeof cancelComparisonInputSchema>;
export type GetComparisonInput = z.infer<typeof getComparisonInputSchema>;
export type ListComparisonsInput = z.infer<typeof listComparisonsInputSchema>;

const backgroundSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("color"), color: z.string().min(1) }).strict(),
	z
		.object({
			type: z.literal("blur"),
			blurIntensity: z.number().int().nonnegative(),
		})
		.strict(),
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

export const searchStickersInputSchema = z.object({
	query: z.string().trim(),
	category: z.enum(["all", "flags", "shapes"]).default("all"),
	limit: z.number().int().min(1).max(200).default(50),
});

const captionStyleSchema = z
	.object({
		fontFamily: z.string().min(1).optional(),
		fontSize: z
			.number()
			.positive()
			.describe(
				"Font size in OpenCut app units. Typical captions use 4 through 8; the default is 5.",
			)
			.optional(),
		fontSizeRatioOfPlayHeight: z.number().positive().optional(),
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
			.strict()
			.optional(),
		placement: z
			.object({
				verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
				marginLeftRatio: z.number().min(0).max(1).optional(),
				marginRightRatio: z.number().min(0).max(1).optional(),
				marginVerticalRatio: z.number().min(0).max(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

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
	.strict()
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
	.strict()
	.refine((rect) => rect.x + rect.width <= 1, {
		message: "x + width must be at most 1",
	})
	.refine((rect) => rect.y + rect.height <= 1, {
		message: "y + height must be at most 1",
	});

const freeformPathPointSchema = z
	.object({
		id: z.string().trim().min(1),
		x: z.number().finite(),
		y: z.number().finite(),
		inX: z.number().finite(),
		inY: z.number().finite(),
		outX: z.number().finite(),
		outY: z.number().finite(),
	})
	.strict();

const maskParamValueSchema = z.union([
	z.string(),
	z.number().finite(),
	z.boolean(),
	z.array(freeformPathPointSchema),
]);

const elementParamRecordSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean()]),
);

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

const relationshipScopeSchema = z
	.enum(["element", "group", "link", "all"])
	.default("all");

const elementRefSchema = z
	.object({
		trackId: z.string().min(1),
		elementId: z.string().min(1),
	})
	.strict();
export const allocationRoleSchema = z.enum([
	"element",
	"caption-track",
	"caption-element",
	"track",
	"compound-element",
	"compound-auto-track",
	"compound-empty-main-track",
	"source-audio-track",
	"source-audio-element",
	"source-audio-link",
	"element-auto-track",
	"effect",
	"keyframe",
	"transition",
	"mask",
	"group",
	"link",
	"duplicate-element",
	"duplicate-track",
	"duplicate-transition",
	"duplicate-group",
	"duplicate-link",
	"duplicate-effect",
	"duplicate-mask",
	"duplicate-keyframe",
	"duplicate-nested-keyframe",
	"duplicate-nested-track",
	"duplicate-nested-element",
	"duplicate-nested-transition",
	"bookmark",
	"break-apart-element",
	"split-right",
	"split-group",
	"split-link",
	"split-effect",
	"split-mask",
	"split-left-boundary-keyframe",
	"split-right-boundary-keyframe",
	"duration-clamp-left-boundary-keyframe",
	"duration-clamp-right-boundary-keyframe",
	"split-nested-keyframe",
	"split-nested-track",
	"split-nested-element",
	"split-nested-transition",
]);
const objectIdAllocationSchema = z
	.object({
		role: allocationRoleSchema,
		sourceId: z.string().min(1),
		resolvedId: z.string().min(1),
	})
	.strict();

const baseEditOperationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("insert_text"),
		elementId: z.string().trim().min(1).optional(),
		content: z.string().min(1),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
		autoTrackId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("insert_graphic"),
		elementId: z.string().trim().min(1).optional(),
		definitionId: z.string().trim().min(1),
		name: z.string().trim().min(1).optional(),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
		trackId: z.string().min(1).optional(),
		params: elementParamRecordSchema.optional(),
		autoTrackId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("insert_sticker"),
		elementId: z.string().trim().min(1).optional(),
		stickerId: z.string().trim().min(1),
		name: z.string().trim().min(1).optional(),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
		trackId: z.string().min(1).optional(),
		params: elementParamRecordSchema.optional(),
		autoTrackId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("insert_adjustment_layer"),
		elementId: z.string().trim().min(1).optional(),
		effectType: z.string().trim().min(1),
		name: z.string().trim().min(1).optional(),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
		trackId: z.string().min(1).optional(),
		params: elementParamRecordSchema.optional(),
		autoTrackId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
	z.object({
		kind: z.literal("rename_track"),
		trackId: z.string().min(1),
		name: z.string().trim().min(1).max(256),
	}),
	z
		.object({
			kind: z.literal("reorder_tracks"),
			overlayTrackIds: z
				.array(z.string().min(1))
				.describe("Every overlay track ID in the new top-to-bottom order.")
				.optional(),
			audioTrackIds: z
				.array(z.string().min(1))
				.describe("Every audio track ID in the new top-to-bottom order.")
				.optional(),
		})
		.refine(
			(value) =>
				value.overlayTrackIds !== undefined ||
				value.audioTrackIds !== undefined,
			{ message: "at least one track order is required" },
		),
	z
		.object({
			kind: z.literal("remove_track"),
			trackId: z.string().min(1),
			occupied: z
				.enum(["reject", "delete", "move", "cascade"])
				.describe(
					"What to do when the track still holds elements: reject (default), delete them, move them to targetTrackId, or cascade through transitive group/link relationships.",
				)
				.default("reject"),
			targetTrackId: z.string().min(1).optional(),
			resolvedCascadeElementIds: z.array(z.string().min(1)).optional(),
		})
		.refine(
			(value) => value.occupied !== "move" || value.targetTrackId !== undefined,
			{ message: "the move policy requires targetTrackId" },
		),
	z.object({
		kind: z.literal("duplicate_track"),
		trackId: z.string().min(1),
		newTrackId: z.string().min(1).optional(),
		name: z.string().trim().min(1).max(256).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("set_main_track"),
		trackId: z
			.string()
			.min(1)
			.describe(
				"An overlay video track to promote; the current main track becomes the top overlay.",
			),
	}),
	z.object({
		kind: z.literal("add_bookmark"),
		bookmarkId: z.string().min(1).optional(),
		time: z.number().int().nonnegative(),
		duration: z.number().int().positive().optional(),
		note: z.string().max(4_096).optional(),
		color: z.string().trim().min(1).max(64).optional(),
	}),
	z
		.object({
			kind: z.literal("update_bookmark"),
			bookmarkId: z.string().min(1),
			note: z.string().max(4_096).optional(),
			color: z.string().trim().min(1).max(64).optional(),
			duration: z.number().int().positive().optional(),
			clear: z
				.array(z.enum(["note", "color", "duration"]))
				.describe("Optional bookmark fields to clear.")
				.default([]),
		})
		.refine(
			(value) =>
				value.note !== undefined ||
				value.color !== undefined ||
				value.duration !== undefined ||
				value.clear.length > 0,
			{ message: "at least one bookmark update is required" },
		),
	z.object({
		kind: z.literal("move_bookmark"),
		bookmarkId: z.string().min(1),
		time: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal("remove_bookmark"),
		bookmarkId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("instantiate_asset"),
		assetId: z
			.string()
			.min(1)
			.describe("A timeline media asset already in the project bin."),
		elementId: z.string().min(1).optional(),
		name: z.string().trim().min(1).optional(),
		startTime: z.number().int().nonnegative(),
		duration: z
			.number()
			.int()
			.positive()
			.describe(
				"Defaults to the asset's intrinsic duration; images default to five seconds.",
			)
			.optional(),
		trackId: z.string().min(1).optional(),
		autoTrackId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
		kind: z.literal("insert_captions"),
		trackId: z.string().trim().min(1).optional(),
		captions: z
			.array(
				z
					.object({
						elementId: z.string().trim().min(1).optional(),
						text: z.string().trim().min(1),
						startTime: z.number().int().nonnegative(),
						duration: z.number().int().positive(),
					})
					.strict(),
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
			resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
		ripple: z.boolean().default(false),
		relationshipScope: relationshipScopeSchema,
	}),
	z.object({
		kind: z.literal("duplicate_elements"),
		elements: z.array(elementRefSchema).min(1),
		duplicateIds: z.array(z.string().trim().min(1)).min(1).optional(),
		relationshipScope: relationshipScopeSchema,
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("create_compound"),
		compoundId: z.string().trim().min(1),
		name: z.string().trim().min(1).optional(),
		elements: z.array(elementRefSchema).min(2),
		relationshipScope: relationshipScopeSchema,
		targetTrackId: z.string().trim().min(1).optional(),
		autoTrackId: z.string().trim().min(1).optional(),
		emptyMainTrackId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("break_apart_compound"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		restoredElementIds: z.array(z.string().trim().min(1)).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("set_group"),
		groupId: z.string().trim().min(1),
		elements: z.array(elementRefSchema).min(2),
	}),
	z.object({
		kind: z.literal("clear_group"),
		groupId: z.string().trim().min(1),
	}),
	z.object({
		kind: z.literal("set_link"),
		linkId: z.string().trim().min(1),
		elements: z.array(elementRefSchema).min(2),
	}),
	z.object({
		kind: z.literal("clear_link"),
		linkId: z.string().trim().min(1),
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
		relationshipScope: relationshipScopeSchema,
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
				.strict()
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
			resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
		audioTrackId: z.string().trim().min(1).optional(),
		audioElementId: z.string().trim().min(1).optional(),
		linkId: z.string().trim().min(1).optional(),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("duck_audio"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		regions: z.array(
			z
				.object({
					startTime: z.number().int().nonnegative(),
					duration: z.number().int().positive(),
				})
				.strict(),
		),
		reductionDb: z.number().positive().max(60).default(12),
		attackDuration: z.number().int().nonnegative().default(12_000),
		releaseDuration: z.number().int().nonnegative().default(30_000),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
		ripple: z.boolean().default(false),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
	}),
	z.object({
		kind: z.literal("split"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		rightElementId: z.string().trim().min(1).optional(),
		splitTime: z
			.number()
			.int()
			.positive()
			.describe("Absolute timeline split position in canonical media ticks."),
		retainSide: z.enum(["both", "left", "right"]).optional(),
		ripple: z.boolean().default(false),
		resolvedAllocations: z.array(objectIdAllocationSchema).optional(),
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
	z.object({
		kind: z.literal("set_mask"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		maskId: z.string().trim().min(1),
		maskType: z.enum([
			"split",
			"cinematic-bars",
			"rectangle",
			"ellipse",
			"heart",
			"diamond",
			"star",
			"text",
			"freeform",
		]),
		params: z.record(z.string(), maskParamValueSchema).optional(),
	}),
	z.object({
		kind: z.literal("remove_mask"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		maskId: z.string().trim().min(1),
	}),
	z.object({
		kind: z.literal("set_audio_replacement_state"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
		enabled: z.boolean(),
	}),
	z.object({
		kind: z.literal("remove_audio_replacement"),
		trackId: z.string().min(1),
		elementId: z.string().min(1),
	}),
]);

const resolvedAllocationKinds = new Set([
	"insert_text",
	"insert_graphic",
	"insert_sticker",
	"insert_adjustment_layer",
	"duplicate_elements",
	"create_compound",
	"break_apart_compound",
	"set_audio",
	"separate_source_audio",
	"duck_audio",
	"update_caption",
	"set_retime",
	"trim",
	"split",
	"duplicate_track",
	"instantiate_asset",
]);
const resolvedSkipFields = new Map<string, Set<string>>(
	[...resolvedAllocationKinds].map((kind) => [
		kind,
		new Set([
			"resolvedAllocations",
			...([
				"insert_text",
				"insert_graphic",
				"insert_sticker",
				"insert_adjustment_layer",
				"create_compound",
				"instantiate_asset",
			].includes(kind)
				? ["autoTrackId"]
				: []),
			...(kind === "create_compound" ? ["emptyMainTrackId"] : []),
		]),
	]),
);
const resolvedCaptionSchema = z
	.object({
		elementId: z.string().trim().min(1).nullable(),
		text: z.string().trim().min(1),
		startTime: z.number().int().nonnegative(),
		duration: z.number().int().positive(),
		resolvedName: z.string().trim().min(1),
		resolvedContent: z.string().trim().min(1),
		resolvedParams: elementParamRecordSchema,
		resolvedLayoutVersion: z.literal("opencut.caption-layout.v1"),
		resolvedLayoutEngine: z.literal("browser-canvas-2d"),
	})
	.strict();

/**
 * Rust emits a JSON-only resolved DTO. Non-skipped Option fields are required
 * and explicit null, while the small allocation plumbing set retains its
 * declared optional transport shape.
 */
export const resolvedEditOperationSchema = z.discriminatedUnion(
	"kind",
	baseEditOperationSchema.options.map((schema) => {
		const strict: z.ZodObject = schema.strict();
		const kind = (strict.shape.kind as z.ZodLiteral<string>).value;
		const skipFields = resolvedSkipFields.get(kind) ?? new Set<string>();
		const resolvedShape: Record<string, z.ZodType> = {};
		for (const [fieldName, fieldSchema] of Object.entries(strict.shape)) {
			if (skipFields.has(fieldName)) continue;
			if (fieldSchema instanceof z.ZodOptional) {
				const inner = fieldSchema.unwrap() as unknown as z.ZodType;
				resolvedShape[fieldName] = inner.nullable();
			} else if (fieldSchema instanceof z.ZodDefault) {
				resolvedShape[fieldName] = fieldSchema.unwrap() as unknown as z.ZodType;
			}
		}
		if (kind === "insert_captions") {
			resolvedShape.captions = z.array(resolvedCaptionSchema).min(1);
		}
		return strict.safeExtend(resolvedShape).strict();
	}) as typeof baseEditOperationSchema.options,
);

export const editOperationSchema = z.discriminatedUnion(
	"kind",
	baseEditOperationSchema.options.map((schema) => {
		const strict: z.ZodObject = schema.strict();
		const kind = (strict.shape.kind as z.ZodLiteral<string>).value;
		return resolvedAllocationKinds.has(kind)
			? strict.safeExtend({ resolvedAllocations: z.never().optional() })
			: strict;
	}) as typeof baseEditOperationSchema.options,
);

export const EDIT_PLAN_OPERATION_VARIANTS = editOperationSchema.options
	.map((option) => option.shape.kind.value)
	.sort();

export const preflightPolicySchema = z
	.object({
		warningPolicy: z.enum(["allow", "reject-any"]),
		providerExecution: z.literal("forbidden"),
		costPolicy: z.enum(["require-exact", "allow-bounded", "allow-unavailable"]),
	})
	.strict();

/**
 * Read-only V2 contract. This intentionally does not use the legacy mutation
 * wrappers because a preflight ID identifies an immutable evidence receipt,
 * not an editor mutation.
 */
export const preflightEditPlanInputSchema = z
	.object({
		contractVersion: z.literal(2),
		bridgeProtocolVersion: z.literal(2),
		expectedConnectionIdentity: connectionIdentitySchema.strict(),
		preflightId: operationIdSchema,
		projectId: z.string().min(1).max(256),
		sceneId: z.string().min(1).max(256),
		expectedRevision: z.number().int().nonnegative(),
		expectedProjectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
		expectedWriteVersion: z.number().int().positive(),
		saveReceiptOperationId: operationIdSchema,
		expectedSaveReceiptId: z.string().min(1).max(512),
		description: z.string().trim().min(1).max(4_096),
		operations: z.array(editOperationSchema).min(1).max(1_000),
		policy: preflightPolicySchema,
	})
	.strict();

export const getEditPlanPreflightInputSchema = z
	.object({
		receiptId: z.string().min(1).max(512),
		verifyIntegrity: z.literal(true).default(true),
	})
	.strict();

export const listEditPlanPreflightsInputSchema = z
	.object({
		projectId: z.string().min(1).max(256).optional(),
		sceneId: z.string().min(1).max(256).optional(),
		limit: z.number().int().min(1).max(100).default(25),
		cursor: z.string().min(1).max(512).optional(),
	})
	.strict();

export const editPlanInputSchema = z
	.object({
		projectId: z.string().min(1),
		operationId: legacyCompatibleOperationIdSchema,
		expectedRevision: z.number().int().nonnegative(),
		description: z.string().min(1),
		operations: z.array(editOperationSchema).min(1),
		preflight: z
			.object({
				receiptId: z.string().min(1).max(512),
				planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				preflightFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				planDiffHash: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict()
			.optional(),
	})
	.superRefine((plan, context) => {
		for (const [index, operation] of plan.operations.entries()) {
			if (operation.kind !== "add_track") continue;
			const isPopulatedByLaterOperation = plan.operations
				.slice(index + 1)
				.some(
					(candidate) =>
						(candidate.kind === "move" &&
							candidate.targetTrackId === operation.trackId) ||
						((candidate.kind === "insert_graphic" ||
							candidate.kind === "insert_sticker" ||
							candidate.kind === "insert_adjustment_layer") &&
							candidate.trackId === operation.trackId),
				);
			if (!isPopulatedByLaterOperation) {
				context.addIssue({
					code: "custom",
					path: ["operations", index],
					message: `new track ${operation.trackId} must receive an element from a later operation in the same plan`,
				});
			}
		}
	});

export const importMediaInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
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
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
	path: z.string().min(1),
	style: captionStyleSchema.optional(),
});

export const exportSubtitlesInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
	outputPath: z.string().min(1),
	format: z.enum(["srt", "vtt"]),
	trackIds: z.array(z.string().min(1)).min(1).optional(),
});

export const transcribeTimelineInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
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
	operationId: legacyCompatibleOperationIdSchema,
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
	operationId: legacyCompatibleOperationIdSchema,
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

export const attachCleanAudioInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
	trackId: z.string().min(1),
	elementId: z.string().min(1),
	path: z.string().min(1),
	modelId: z.string().trim().min(1),
	modelVersion: z.string().trim().min(1),
});

export const cleanAudioInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
	trackId: z.string().min(1),
	elementId: z.string().min(1),
	noiseReduction: z.number().min(0).max(1).default(0.5),
	deReverb: z.number().min(0).max(1).default(0),
	deEss: z.number().min(0).max(1).default(0),
	highPassHz: z.number().min(0).max(300).default(80),
	normalize: z.boolean().default(false),
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
	operationId: legacyCompatibleOperationIdSchema,
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
	operationId: legacyCompatibleOperationIdSchema,
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

export const normalizeAudioInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
	targetLufs: z.number().min(-36).max(-5).default(-14),
	maxTruePeakDbtp: z.number().min(-9).max(0).default(-1),
	maxGainDb: z.number().min(0).max(20).default(20),
});

export const createProjectInputSchema = z.object({
	operationId: legacyCompatibleOperationIdSchema,
	name: z.string().trim().min(1),
});

export const openProjectInputSchema = z.object({
	operationId: legacyCompatibleOperationIdSchema,
	projectId: z.string().min(1),
});

export const saveProjectInputSchema = withMutationOperationId(
	z.object({
		projectId: z.string().min(1),
		sceneId: z.string().min(1).optional(),
		operationId: legacyCompatibleOperationIdSchema,
		expectedRevision: z.number().int().nonnegative(),
		expectedContentHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	}),
).superRefine((value, context) => {
	if (value.bridgeProtocolVersion === 2 && !value.expectedContentHash) {
		context.addIssue({
			code: "custom",
			path: ["expectedContentHash"],
			message: "bridge protocol v2 requires expectedContentHash",
		});
	}
});

export const getSaveReceiptInputSchema = z.object({
	operationId: z.string().min(1),
});

export const getExportReceiptInputSchema = z.object({
	operationId: z.string().min(1),
});

export const recordExportInspectionInputSchema = withMutationOperationId(
	z.object({
		operationId: operationIdSchema,
		inspectionOperationId: legacyCompatibleOperationIdSchema,
		outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
		watermarkStatus: z.enum(["verified-clean", "rejected"]),
		reviewer: z.string().trim().min(1).optional(),
		notes: z.string().trim().min(1).optional(),
	}),
	"inspectionOperationId",
);

export const exportProjectInputSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
	expectedProjectContentHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	outputPath: z.string().min(1),
	format: z.enum(["mp4", "webm"]),
	quality: z.enum(["low", "medium", "high", "very_high"]).default("high"),
	fps: frameRateSchema.optional(),
	includeAudio: z.boolean().default(true),
	canvasSize: canvasSizeSchema.optional(),
});

export const queueExportInputSchema = exportProjectInputSchema.extend({
	jobId: z.string().min(1),
});

export const platformExportPresetSchema = z.enum([
	"tiktok_9_16",
	"instagram_reels_9_16",
	"youtube_shorts_9_16",
	"instagram_square_1_1",
	"youtube_landscape_16_9",
]);

const exportBatchVariantSchema = z.object({
	variantId: z.string().trim().min(1),
	preset: platformExportPresetSchema,
	outputPath: z.string().min(1),
	format: z.enum(["mp4", "webm"]).optional(),
	quality: z.enum(["low", "medium", "high", "very_high"]).optional(),
	fps: frameRateSchema.optional(),
	includeAudio: z.boolean().optional(),
	canvasSize: canvasSizeSchema.optional(),
});

export const queueExportBatchInputSchema = z
	.object({
		operationId: legacyCompatibleOperationIdSchema,
		batchId: z.string().trim().min(1),
		projectId: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		expectedProjectContentHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		variants: z.array(exportBatchVariantSchema).min(1).max(20),
	})
	.superRefine((value, context) => {
		const variantIds = new Set<string>();
		const outputPaths = new Set<string>();
		value.variants.forEach((variant, index) => {
			if (variantIds.has(variant.variantId)) {
				context.addIssue({
					code: "custom",
					path: ["variants", index, "variantId"],
					message: "variant IDs must be unique",
				});
			}
			variantIds.add(variant.variantId);
			const outputKey = variant.outputPath.toLowerCase();
			if (outputPaths.has(outputKey)) {
				context.addIssue({
					code: "custom",
					path: ["variants", index, "outputPath"],
					message: "variant output paths must be unique",
				});
			}
			outputPaths.add(outputKey);
		});
	});

export const getExportBatchInputSchema = z.object({
	batchId: z.string().trim().min(1),
});

export const listExportBatchesInputSchema = z.object({
	limit: z.number().int().min(1).max(100).default(25),
});

export const getExportJobInputSchema = z.object({
	jobId: z.string().min(1),
});

export const listExportJobsInputSchema = z.object({
	statuses: z
		.array(
			z.enum([
				"queued",
				"running",
				"completed",
				"failed",
				"cancelled",
				"cancelling",
				"blocked",
				"recovery-required",
			]),
		)
		.min(1)
		.optional(),
	limit: z.number().int().min(1).max(100).default(25),
});

export const runExportJobsInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
		limit: z.number().int().min(1).max(100).default(1),
	}),
);

export const startEditorWorkerInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
		projectId: z.string().min(1).default(BOOTSTRAP_PROJECT_ID),
	}),
);

export const stopEditorWorkerInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
	}),
);

export const undoInputSchema = z.object({
	operationId: legacyCompatibleOperationIdSchema,
	projectId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative(),
	undoOfOperationId: operationIdSchema.optional(),
});

export const cancelExportJobInputSchema = withMutationOperationId(
	getExportJobInputSchema.extend({
		operationId: legacyCompatibleOperationIdSchema,
	}),
);

export const cancelExportBatchInputSchema = withMutationOperationId(
	getExportBatchInputSchema.extend({
		operationId: legacyCompatibleOperationIdSchema,
	}),
);

export const JOB_TYPES = [
	"export",
	"preview-range",
	"comparison",
	"transcription",
	"provider",
	"qc",
	"packaging",
] as const;

export const JOB_STATES = [
	"queued",
	"starting",
	"running",
	"cancelling",
	"cancelled",
	"succeeded",
	"failed",
	"blocked",
	"recovery-required",
] as const;

export const getJobInputSchema = z.object({
	jobId: z.string().trim().min(1),
	includeHistory: z.boolean().default(false),
});

export const listJobsInputSchema = z.object({
	types: z.array(z.enum(JOB_TYPES)).min(1).optional(),
	states: z.array(z.enum(JOB_STATES)).min(1).optional(),
	projectId: z.string().trim().min(1).optional(),
	limit: z.number().int().min(1).max(200).default(25),
});

export const cancelJobInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
		jobId: z.string().trim().min(1),
		reason: z.string().trim().min(1).max(500).optional(),
	}),
);

export const retryJobInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
		jobId: z.string().trim().min(1),
		reason: z.string().trim().min(1).max(500).optional(),
	}),
);

export const resolveJobInputSchema = withMutationOperationId(
	z.object({
		operationId: legacyCompatibleOperationIdSchema,
		jobId: z.string().trim().min(1),
		resolution: z.enum(["rerun-as-new-attempt", "mark-failed"]),
		reason: z.string().trim().min(1).max(500).optional(),
	}),
);

// ---------------------------------------------------------------------------
// Project, scene, and media-bin lifecycle (issue #20)
// ---------------------------------------------------------------------------

export const renameProjectInputSchema = z.object({
	operationId: legacyCompatibleOperationIdSchema,
	projectId: z.string().min(1),
	name: z.string().trim().min(1).max(256),
	expectedTargetContentHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	expectedTargetWriteVersion: z.number().int().positive().optional(),
});

export const duplicateProjectInputSchema = z.object({
	operationId: legacyCompatibleOperationIdSchema,
	projectId: z.string().min(1),
	name: z
		.string()
		.trim()
		.min(1)
		.max(256)
		.describe(
			"Name for the copy; defaults to the editor's numbered duplicate name.",
		)
		.optional(),
	expectedTargetContentHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	expectedTargetWriteVersion: z.number().int().positive().optional(),
});

export const deleteProjectInputSchema = z.object({
	operationId: legacyCompatibleOperationIdSchema,
	projectId: z.string().min(1),
	fallbackProjectId: z
		.string()
		.min(1)
		.describe(
			"Project to activate when the active project is deleted. Defaults to the most recently updated remaining project, or a new blank project when none remains.",
		)
		.optional(),
	expectedTargetContentHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	expectedTargetWriteVersion: z.number().int().positive().optional(),
});

const activeProjectMutationSchema = z.object({
	projectId: z.string().min(1),
	operationId: legacyCompatibleOperationIdSchema,
	expectedRevision: z.number().int().nonnegative(),
});

export const listScenesInputSchema = z.object({
	projectId: z.string().min(1).optional(),
});

export const createSceneInputSchema = activeProjectMutationSchema.extend({
	name: z.string().trim().min(1).max(256),
	activate: z
		.boolean()
		.default(false)
		.describe("Switch to the new scene after creating it."),
});

export const cloneSceneInputSchema = activeProjectMutationSchema.extend({
	sceneId: z.string().min(1),
	newSceneId: z.string().min(1).optional(),
	name: z.string().trim().min(1).max(256).optional(),
	activate: z.boolean().default(false),
});

export const switchSceneInputSchema = activeProjectMutationSchema.extend({
	sceneId: z.string().min(1),
});

export const renameSceneInputSchema = activeProjectMutationSchema.extend({
	sceneId: z.string().min(1),
	name: z.string().trim().min(1).max(256),
});

export const deleteSceneInputSchema = activeProjectMutationSchema.extend({
	sceneId: z.string().min(1),
	replacementSceneId: z
		.string()
		.min(1)
		.describe(
			"Scene to activate when the deleted scene is active; defaults to the main scene.",
		)
		.optional(),
	newMainSceneId: z
		.string()
		.min(1)
		.describe(
			"Required when deleting the main scene: the scene promoted to main first.",
		)
		.optional(),
});

export const setMainSceneInputSchema = activeProjectMutationSchema.extend({
	sceneId: z.string().min(1),
});

export const reorderScenesInputSchema = activeProjectMutationSchema.extend({
	sceneIds: z
		.array(z.string().min(1))
		.min(1)
		.describe("Every scene ID in the new order."),
});

export const listMediaUsagesInputSchema = z.object({
	projectId: z.string().min(1).optional(),
	assetId: z.string().min(1).optional(),
});

export const importMediaAssetInputSchema = activeProjectMutationSchema.extend({
	path: z.string().min(1).describe("Absolute local path of the media file."),
	assetName: z.string().trim().min(1).max(256).optional(),
});

export const renameMediaAssetInputSchema = activeProjectMutationSchema.extend({
	assetId: z.string().min(1),
	name: z.string().trim().min(1).max(256),
});

export const relinkMediaAssetInputSchema = activeProjectMutationSchema.extend({
	assetId: z.string().min(1),
	path: z
		.string()
		.min(1)
		.describe("Absolute local path of the replacement media file."),
	allowIncompatible: z
		.boolean()
		.default(false)
		.describe(
			"Allow a replacement whose media type differs from the current asset.",
		),
});

export const preflightMediaRelinkInputSchema = z.object({
	projectId: z.string().min(1),
	assetId: z.string().min(1),
	path: z
		.string()
		.min(1)
		.describe("Absolute local path of the replacement media file."),
	expectedRevision: z.number().int().nonnegative(),
	expectedProjectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const removeMediaAssetInputSchema = activeProjectMutationSchema.extend({
	assetId: z.string().min(1),
	policy: z
		.enum(["unused-only", "cascade"])
		.default("unused-only")
		.describe(
			"unused-only refuses to remove a referenced asset; cascade also removes every element, matte, and audio replacement that references it in every scene.",
		),
});

const lifecyclePreflightActiveBinding = {
	expectedProjectContentHash: z.string().regex(/^[a-f0-9]{64}$/),
};

export const preflightLifecycleMutationInputSchema = z.discriminatedUnion(
	"method",
	[
		z.object({
			method: z.literal("rename_project"),
			request: renameProjectInputSchema.omit({ operationId: true }),
		}),
		z.object({
			method: z.literal("duplicate_project"),
			request: duplicateProjectInputSchema.omit({ operationId: true }),
		}),
		z.object({
			method: z.literal("delete_project"),
			request: deleteProjectInputSchema.omit({ operationId: true }),
		}),
		z.object({
			method: z.literal("create_scene"),
			request: createSceneInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("clone_scene"),
			request: cloneSceneInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("switch_scene"),
			request: switchSceneInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("rename_scene"),
			request: renameSceneInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("delete_scene"),
			request: deleteSceneInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("set_main_scene"),
			request: setMainSceneInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("reorder_scenes"),
			request: reorderScenesInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("import_media_asset"),
			request: importMediaAssetInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("rename_media_asset"),
			request: renameMediaAssetInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("relink_media_asset"),
			request: relinkMediaAssetInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
		z.object({
			method: z.literal("remove_media_asset"),
			request: removeMediaAssetInputSchema
				.omit({ operationId: true })
				.extend(lifecyclePreflightActiveBinding),
		}),
	],
);
