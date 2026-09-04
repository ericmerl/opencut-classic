import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
	allocationRoleSchema,
	editOperationSchema,
	preflightEditPlanInputSchema,
	resolvedEditOperationSchema,
} from "./tool-schemas";
import { jsonValueSchema } from "./operation-ledger-schema";

export const EDIT_PLAN_PREFLIGHT_SCHEMA =
	"opencut.edit-plan-preflight.v2" as const;
export const EDIT_PLAN_PREFLIGHT_RECEIPT_SCHEMA_VERSION = 1 as const;

export type PreflightEditOperation = z.infer<typeof editOperationSchema>;
export type PreflightEditPlanInput = z.infer<
	typeof preflightEditPlanInputSchema
>;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const editPlanSourceBindingSchema = z
	.object({
		connectionIdentity: z
			.object({
				serverInstanceId: z.string().min(1),
				editorInstanceId: z.string().min(1),
				editorSessionId: z.string().min(1),
				connectionGeneration: z.number().int().positive(),
				bridgeProtocolVersion: z.literal(2),
			})
			.strict(),
		projectId: z.string().min(1).max(256),
		sceneId: z.string().min(1).max(256),
		sessionRevision: z.number().int().nonnegative(),
		canonicalProjectHash: digestSchema,
		durableWriteVersion: z.number().int().positive(),
		saveReceiptId: z.string().min(1).max(512),
		saveOperationId: z.string().min(1).max(256),
	})
	.strict();

export const editPlanCostSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("not-applicable") }).strict(),
	z
		.object({
			status: z.literal("exact"),
			currency: z.string().trim().min(1).max(16),
			minorUnits: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			status: z.literal("bounded"),
			currency: z.string().trim().min(1).max(16),
			maximumMinorUnits: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			status: z.literal("unavailable"),
			reason: z.string().trim().min(1).max(1_024),
		})
		.strict(),
]);

export const editPlanCapabilitySnapshotSchema = z
	.object({
		hash: digestSchema,
		editPlanReady: z.boolean(),
		providerExecution: z.literal("forbidden"),
		cost: editPlanCostSchema,
	})
	.strict();

const canonicalValueSchema: z.ZodType<z.infer<typeof jsonValueSchema>> = z.lazy(
	() =>
		z.union([
			z.null(),
			z.boolean(),
			z
				.number()
				.finite()
				.min(-Number.MAX_SAFE_INTEGER)
				.max(Number.MAX_SAFE_INTEGER),
			z.string(),
			z.array(canonicalValueSchema),
			z.record(z.string(), canonicalValueSchema),
		]),
);
const nullableStringSchema = z.string().nullable();
const nullableBooleanSchema = z.boolean().nullable();
const nullableNumberSchema = z.number().finite().nullable();
const canonicalAttachmentSchema = z
	.object({
		assetId: z.string().min(1),
		sourceMediaId: z.string().min(1),
		sourceFingerprint: nullableStringSchema,
		artifactHash: z.string().min(1),
		artifactFingerprint: z.string().min(1),
		modelId: z.string().min(1),
		modelVersion: z.string().min(1),
		enabled: z.boolean(),
		channel: z.string().min(1).optional(),
	})
	.strict();
const canonicalElementCommonShape = {
	order: z.number().int().nonnegative(),
	id: z.string().min(1),
	name: z.string(),
	groupId: nullableStringSchema,
	linkId: nullableStringSchema,
	startTime: z.number().int().nonnegative(),
	duration: z.number().int().positive(),
	trimStart: z.number().int().nonnegative(),
	trimEnd: z.number().int().nonnegative(),
	sourceDuration: z.number().int().nonnegative().nullable(),
	params: canonicalValueSchema,
	animations: canonicalValueSchema,
};
const canonicalEffectSchema = z
	.object({
		order: z.number().int().nonnegative(),
		id: z.string().min(1),
		type: z.string().min(1),
		enabled: z.boolean(),
		params: canonicalValueSchema,
	})
	.strict();
const canonicalMaskSchema = z
	.object({
		order: z.number().int().nonnegative(),
		id: z.string().min(1),
		type: z.string().min(1),
		params: canonicalValueSchema,
	})
	.strict();
const canonicalTransitionSchema = z
	.object({
		order: z.number().int().nonnegative(),
		id: z.string().min(1),
		fromElementId: z.string().min(1),
		toElementId: z.string().min(1),
		type: z.string().min(1),
		duration: z.number().int().positive(),
	})
	.strict();

type CanonicalTrack = {
	role: string;
	order: number;
	id: string;
	name: string;
	type: string;
	muted?: boolean | null;
	hidden?: boolean | null;
	transitions: z.infer<typeof canonicalTransitionSchema>[];
	elements: CanonicalElement[];
};
type CanonicalElement = z.infer<
	ReturnType<typeof canonicalElementVariantSchema>
>;

function canonicalElementVariantSchema(trackSchema: z.ZodType<CanonicalTrack>) {
	const attachment = canonicalAttachmentSchema.nullable();
	const media = { mediaId: z.string().min(1) };
	const visual = {
		hidden: nullableBooleanSchema,
		effects: z.array(canonicalEffectSchema),
	};
	return z.discriminatedUnion("type", [
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("audio"),
				sourceType: z.string().min(1),
				mediaId: nullableStringSchema,
				sourceUrl: nullableStringSchema,
				retime: canonicalValueSchema,
				audioReplacement: attachment,
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("video"),
				...media,
				...visual,
				isSourceAudioEnabled: nullableBooleanSchema,
				retime: canonicalValueSchema,
				masks: z.array(canonicalMaskSchema),
				matte: attachment,
				audioReplacement: attachment,
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("image"),
				...media,
				...visual,
				masks: z.array(canonicalMaskSchema),
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("text"),
				...visual,
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("sticker"),
				...visual,
				stickerId: z.string().min(1),
				intrinsicWidth: nullableNumberSchema,
				intrinsicHeight: nullableNumberSchema,
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("graphic"),
				...visual,
				definitionId: z.string().min(1),
				masks: z.array(canonicalMaskSchema),
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("effect"),
				effectType: z.string().min(1),
			})
			.strict(),
		z
			.object({
				...canonicalElementCommonShape,
				type: z.literal("compound"),
				hidden: nullableBooleanSchema,
				tracks: z.array(trackSchema),
			})
			.strict(),
	]);
}

const canonicalTrackSchema: z.ZodType<CanonicalTrack> = z.lazy(() =>
	z
		.object({
			role: z.string().min(1),
			order: z.number().int().nonnegative(),
			id: z.string().min(1),
			name: z.string(),
			type: z.string().min(1),
			muted: nullableBooleanSchema,
			hidden: nullableBooleanSchema,
			transitions: z.array(canonicalTransitionSchema),
			elements: z.array(canonicalElementVariantSchema(canonicalTrackSchema)),
		})
		.strict(),
);
const immutableHashSchema = z
	.object({ algorithm: z.literal("SHA-256"), digest: digestSchema })
	.strict();
const canonicalMediaSourceSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("local"),
			contentHash: immutableHashSchema.nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("provider"),
			sourceUrl: z.string().min(1),
			provider: z.string().nullable(),
			providerVersion: z.string().nullable(),
			contentHash: immutableHashSchema.nullable(),
		})
		.strict(),
]);

export const editPlanProjectSnapshotSchema = z
	.object({
		projection: z.literal("opencut-project-content"),
		projectionVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
		project: z
			.object({
				id: z.string().min(1).optional(),
				name: z.string(),
				activeSceneId: z.string().min(1),
				mainSceneId: nullableStringSchema,
				settings: z.record(z.string(), canonicalValueSchema),
				scenes: z.array(
					z
						.object({
							order: z.number().int().nonnegative(),
							id: z.string().min(1),
							name: z.string(),
							isMain: z.boolean(),
							bookmarks: z.array(
								z
									.object({
										order: z.number().int().nonnegative(),
										id: z.string().min(1).optional(),
										time: z.number().int().nonnegative(),
										duration: z.number().int().nonnegative().nullable(),
										note: nullableStringSchema,
										color: nullableStringSchema,
									})
									.strict(),
							),
							tracks: z.array(canonicalTrackSchema),
						})
						.strict(),
				),
			})
			.strict(),
		mediaAssets: z.array(
			z
				.object({
					id: z.string().min(1),
					name: z.string(),
					type: z.enum(["image", "video", "audio"]),
					size: z.number().int().nonnegative().nullable(),
					width: z.number().int().positive().nullable(),
					height: z.number().int().positive().nullable(),
					duration: nullableNumberSchema,
					fps: nullableNumberSchema,
					hasAudio: nullableBooleanSchema,
					sourceFingerprint: nullableStringSchema,
					source: canonicalMediaSourceSchema,
					role: nullableStringSchema,
				})
				.strict(),
		),
	})
	.strict()
	.superRefine((snapshot, context) => {
		if (snapshot.projectionVersion >= 2 && !snapshot.project.id) {
			context.addIssue({
				code: "custom",
				path: ["project", "id"],
				message: "project-content v2 requires project.id",
			});
		}
		if (snapshot.projectionVersion === 1 && snapshot.project.id !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["project", "id"],
				message: "project-content v1 does not contain project.id",
			});
		}
		for (const [sceneIndex, scene] of snapshot.project.scenes.entries()) {
			for (const [bookmarkIndex, bookmark] of scene.bookmarks.entries()) {
				if (snapshot.projectionVersion >= 3 && !bookmark.id) {
					context.addIssue({
						code: "custom",
						path: [
							"project",
							"scenes",
							sceneIndex,
							"bookmarks",
							bookmarkIndex,
							"id",
						],
						message: "project-content v3 requires bookmark.id",
					});
				}
				if (snapshot.projectionVersion < 3 && bookmark.id !== undefined) {
					context.addIssue({
						code: "custom",
						path: [
							"project",
							"scenes",
							sceneIndex,
							"bookmarks",
							bookmarkIndex,
							"id",
						],
						message: "project-content v1 and v2 do not contain bookmark.id",
					});
				}
			}
		}
	});

const summarySchema = z
	.object({
		canonicalHash: digestSchema,
		trackCount: z.number().int().nonnegative(),
		elementCount: z.number().int().nonnegative(),
		transitionCount: z.number().int().nonnegative(),
		durationTicks: z.number().int().nonnegative(),
	})
	.strict();
const changedObjectSchema = z
	.object({
		objectType: z.string().min(1),
		objectId: z.string().min(1),
		fieldPath: z.string(),
		before: jsonValueSchema,
		after: jsonValueSchema,
	})
	.strict()
	.superRefine((value, context) => {
		for (const key of ["before", "after"] as const) {
			try {
				canonicalEditPlanJson(value[key]);
			} catch (error) {
				context.addIssue({
					code: "custom",
					path: [key],
					message: String(error),
					input: value[key],
				});
			}
		}
	});
const expansionSchema = z
	.object({
		operationIndex: z.number().int().nonnegative(),
		causeId: z.string().min(1),
		affectedId: z.string().min(1),
	})
	.strict();

export const editPlanEvaluationSchema = z
	.object({
		schemaVersion: z.literal(EDIT_PLAN_PREFLIGHT_SCHEMA),
		source: editPlanSourceBindingSchema,
		planFingerprint: digestSchema,
		preflightFingerprint: digestSchema,
		planDiffHash: digestSchema,
		predictedProjectHash: digestSchema,
		beforeSummary: summarySchema,
		predictedAfterSummary: summarySchema,
		before: editPlanProjectSnapshotSchema,
		predictedAfter: editPlanProjectSnapshotSchema,
		resolvedOperations: z.array(resolvedEditOperationSchema).min(1),
		resolvedIds: z.array(
			z
				.object({
					operationIndex: z.number().int().nonnegative(),
					role: allocationRoleSchema,
					sourceId: z.string().min(1).nullable(),
					resolvedId: z.string().min(1),
				})
				.strict(),
		),
		changedObjects: z.array(changedObjectSchema),
		timingConsequences: z.array(
			z
				.object({
					operationIndex: z.number().int().nonnegative(),
					elementId: z.string().min(1),
					beforeStartTicks: z.number().int().nonnegative().nullable(),
					afterStartTicks: z.number().int().nonnegative().nullable(),
					beforeDurationTicks: z.number().int().nonnegative().nullable(),
					afterDurationTicks: z.number().int().nonnegative().nullable(),
				})
				.strict(),
		),
		rippleExpansion: z.array(expansionSchema),
		relationshipExpansion: z.array(expansionSchema),
		warnings: z.array(
			z
				.object({
					code: z.enum([
						"TIMELINE_GAP_POSSIBLE",
						"TRANSITION_REMOVED",
						"RELATIONSHIP_PRUNED",
					]),
					operationIndex: z.number().int().nonnegative(),
					objectId: z.string().nullable(),
					message: z.string().min(1),
				})
				.strict(),
		),
		requirements: editPlanCapabilitySnapshotSchema,
		cost: editPlanCostSchema,
	})
	.strict();

export const editPlanEvaluationResponseSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("validated"),
			result: editPlanEvaluationSchema,
		})
		.strict(),
	z
		.object({
			status: z.literal("rejected"),
			error: z
				.object({
					code: z.enum([
						"CONTRACT_VERSION",
						"SNAPSHOT_VERSION",
						"SOURCE_MISMATCH",
						"CAPABILITY_NOT_READY",
						"COST_UNAVAILABLE",
						"EMPTY_PLAN",
						"TOO_MANY_OPERATIONS",
						"INVALID_VALUE",
						"DUPLICATE_ID",
						"UNKNOWN_REFERENCE",
						"INCOMPATIBLE_TRACK",
						"UNSUPPORTED_FRAME_RATE",
						"BOUNDS",
						"SILENT_NO_OP",
						"ARITHMETIC_OVERFLOW",
					]),
					message: z.string().min(1),
					operationIndex: z.number().int().nonnegative().nullable().optional(),
					path: z.string().nullable().optional(),
				})
				.strict(),
		})
		.strict(),
]);

export type EditPlanEvaluation = z.infer<typeof editPlanEvaluationSchema>;
export type EditPlanEvaluationResponse = z.infer<
	typeof editPlanEvaluationResponseSchema
>;

export const preflightNoMutationObservationSchema = z
	.object({
		projectId: z.string().min(1),
		sceneId: z.string().min(1),
		sessionRevision: z.number().int().nonnegative(),
		canonicalProjectHash: digestSchema,
		durableWriteVersion: z.number().int().positive(),
		saveReceiptId: z.string().min(1).max(512),
		saveOperationId: z.string().min(1).max(256),
		connectionIdentity: z
			.object({
				serverInstanceId: z.string().min(1),
				editorInstanceId: z.string().min(1),
				editorSessionId: z.string().min(1),
				connectionGeneration: z.number().int().positive(),
				bridgeProtocolVersion: z.literal(2),
			})
			.strict(),
		activeProjectId: z.string().min(1),
		activeSceneId: z.string().min(1),
		playheadTicks: z.number().int().nonnegative(),
		isPlaying: z.boolean(),
		selectionFingerprint: digestSchema,
		historyFingerprint: digestSchema,
		persistenceFingerprint: digestSchema,
	})
	.strict();

const editPlanErrorSchema =
	editPlanEvaluationResponseSchema.options[1].shape.error;

export const browserEditPlanPreflightResponseSchema = z.union([
	z
		.object({
			status: z.literal("validated"),
			preflightId: z.string().min(1).max(256),
			evaluation: editPlanEvaluationSchema,
			sourceObservation: preflightNoMutationObservationSchema,
			noMutationProof: z
				.object({
					unchanged: z.literal(true),
					before: preflightNoMutationObservationSchema,
					after: preflightNoMutationObservationSchema,
				})
				.strict(),
		})
		.strict(),
	z.union([
		z
			.object({
				status: z.literal("rejected"),
				preflightId: z.string().min(1).max(256),
				code: z.enum([
					"PERSISTED_SOURCE_UNAVAILABLE",
					"PERSISTED_SOURCE_MISMATCH",
					"SAVE_RECEIPT_MISMATCH",
					"PREFLIGHT_ID_REUSED",
				]),
				reason: z.string().min(1).max(4_096),
			})
			.strict(),
		z
			.object({
				status: z.literal("rejected"),
				preflightId: z.string().min(1).max(256),
				code: z.literal("NATIVE_EVALUATION_REJECTED"),
				reason: z.string().min(1).max(4_096),
				error: editPlanErrorSchema,
			})
			.strict(),
	]),
	z
		.object({
			status: z.literal("conflict"),
			preflightId: z.string().min(1).max(256),
			code: z.enum(["SOURCE_STATE_CONFLICT", "STATE_CHANGED_DURING_PREFLIGHT"]),
			reason: z.string().min(1).max(4_096),
		})
		.strict(),
]);

export type BrowserEditPlanPreflightResponse = z.infer<
	typeof browserEditPlanPreflightResponseSchema
>;

export const browserEditPlanPreflightReceiptSchema = z
	.object({
		id: z.string().min(1).max(256),
		receiptVersion: z.literal(1),
		preflightId: z.string().min(1).max(256),
		requestFingerprint: digestSchema,
		planFingerprint: digestSchema,
		source: editPlanSourceBindingSchema,
		result: browserEditPlanPreflightResponseSchema,
		recordedAt: z.iso.datetime({ offset: true }),
		checksum: digestSchema,
	})
	.strict();

export const browserEditPlanPreflightReceiptQuerySchema = z.discriminatedUnion(
	"status",
	[
		z
			.object({
				status: z.literal("found"),
				receipt: browserEditPlanPreflightReceiptSchema,
			})
			.strict(),
		z
			.object({
				status: z.enum(["not-found", "mismatched"]),
				preflightId: z.string().min(1).max(256),
			})
			.strict(),
	],
);

export type BrowserEditPlanPreflightReceipt = z.infer<
	typeof browserEditPlanPreflightReceiptSchema
>;

export function browserEditPlanPreflightReceiptChecksum(
	receipt: BrowserEditPlanPreflightReceipt,
): string {
	return canonicalEditPlanSha256({
		receiptVersion: receipt.receiptVersion,
		preflightId: receipt.preflightId,
		requestFingerprint: receipt.requestFingerprint,
		planFingerprint: receipt.planFingerprint,
		source: receipt.source,
		result: receipt.result,
		recordedAt: receipt.recordedAt,
	});
}

export type CanonicalEditPlanValue =
	| null
	| boolean
	| number
	| string
	| CanonicalEditPlanValue[]
	| { [key: string]: CanonicalEditPlanValue };

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

export function canonicalEditPlanJson(value: unknown): string {
	return serializeCanonical(parseCanonicalValue(value, []));
}

export function canonicalEditPlanSha256(value: unknown): string {
	return createHash("sha256")
		.update(canonicalEditPlanJson(value))
		.digest("hex");
}

export function editPlanFingerprint(input: PreflightEditPlanInput): string {
	const parsed = preflightEditPlanInputSchema.parse(input);
	return editPlanSemanticFingerprint(parsed.description, parsed.operations);
}

export function editPlanSemanticFingerprint(
	description: string,
	operations: PreflightEditOperation[],
): string {
	return canonicalEditPlanSha256({
		contractVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
		description,
		operations: operations.map(normalizeRustOperationOptions),
	});
}

export function preflightEditPlanRequestFingerprint(
	input: PreflightEditPlanInput,
): string {
	const parsed = preflightEditPlanInputSchema.parse(input);
	return canonicalEditPlanSha256({
		schemaVersion: EDIT_PLAN_PREFLIGHT_SCHEMA,
		planFingerprint: editPlanFingerprint(parsed),
		projectId: parsed.projectId,
		sceneId: parsed.sceneId,
		revision: parsed.expectedRevision,
		contentHash: parsed.expectedProjectContentHash,
		writeVersion: parsed.expectedWriteVersion,
		saveReceiptOperationId: parsed.saveReceiptOperationId,
		saveReceiptId: parsed.expectedSaveReceiptId,
		connectionIdentity: parsed.expectedConnectionIdentity,
		policy: parsed.policy,
	});
}

export function evaluationPreflightFingerprint(
	planFingerprint: string,
	source: z.infer<typeof editPlanSourceBindingSchema>,
	capabilitySnapshot: z.infer<typeof editPlanCapabilitySnapshotSchema>,
	policy: PreflightEditPlanInput["policy"],
): string {
	return canonicalEditPlanSha256({
		planFingerprint,
		source,
		capabilitySnapshot,
		policy,
	});
}

export function evaluationDiffHash(
	evaluation: Pick<
		EditPlanEvaluation,
		| "predictedProjectHash"
		| "changedObjects"
		| "timingConsequences"
		| "rippleExpansion"
		| "relationshipExpansion"
	>,
): string {
	return canonicalEditPlanSha256({
		predictedProjectHash: evaluation.predictedProjectHash,
		changedObjects: evaluation.changedObjects,
		timingConsequences: evaluation.timingConsequences,
		rippleExpansion: evaluation.rippleExpansion,
		relationshipExpansion: evaluation.relationshipExpansion,
	});
}

export function deriveProjectChangedObjects(
	before: z.infer<typeof editPlanProjectSnapshotSchema>,
	after: z.infer<typeof editPlanProjectSnapshotSchema>,
	projectId = "canonical-project",
): EditPlanEvaluation["changedObjects"] {
	const beforeObjects = flattenProjectObjects(before, projectId);
	const afterObjects = flattenProjectObjects(after, projectId);
	const changes: EditPlanEvaluation["changedObjects"] = [];
	const keys = [...new Set([...beforeObjects.keys(), ...afterObjects.keys()])];
	for (const key of keys) {
		const beforeInstances = beforeObjects.get(key) ?? new Map();
		const afterInstances = afterObjects.get(key) ?? new Map();
		const owners = [
			...new Set([...beforeInstances.keys(), ...afterInstances.keys()]),
		].sort();
		const beforeFirst = [...beforeInstances.keys()].sort()[0];
		const afterFirst = [...afterInstances.keys()].sort()[0];
		const qualify = owners.length > 1 || beforeFirst !== afterFirst;
		for (const ownerPath of owners) {
			const beforeObject = beforeInstances.get(ownerPath);
			const afterObject = afterInstances.get(ownerPath);
			const owner = beforeObject ?? afterObject;
			if (!owner) throw new Error("changed-object owner is missing");
			diffCanonicalValues(
				beforeObject?.value ?? null,
				afterObject?.value ?? null,
				qualify ? `@${ownerPath}` : "",
				changes,
				owner.objectType,
				owner.objectId,
			);
		}
	}
	changes.sort((left, right) =>
		compareTuple(
			[left.objectType, left.objectId, left.fieldPath],
			[right.objectType, right.objectId, right.fieldPath],
		),
	);
	return changes;
}

interface OwnedCanonicalObject {
	objectType: string;
	objectId: string;
	value: { [key: string]: CanonicalEditPlanValue };
}

function flattenProjectObjects(
	snapshot: z.infer<typeof editPlanProjectSnapshotSchema>,
	projectId: string,
): Map<string, Map<string, OwnedCanonicalObject>> {
	const objects = new Map<string, Map<string, OwnedCanonicalObject>>();
	const add = (
		objectType: string,
		objectId: string,
		ownerPath: string,
		value: { [key: string]: CanonicalEditPlanValue },
	): void => {
		const key = canonicalEditPlanJson({ objectType, objectId });
		const instances =
			objects.get(key) ?? new Map<string, OwnedCanonicalObject>();
		instances.set(ownerPath, { objectType, objectId, value });
		objects.set(key, instances);
	};
	const without = (
		value: unknown,
		keys: readonly string[],
	): { [key: string]: CanonicalEditPlanValue } => {
		const canonical = parseCanonicalValue(value, []);
		if (!isCanonicalObject(canonical)) {
			throw new Error("changed-object owner must be a canonical object");
		}
		for (const key of keys) delete canonical[key];
		return canonical;
	};
	const walkTrack = (track: CanonicalTrack, ownerPath: string): void => {
		const trackOwner = `${ownerPath}/track:${track.id}`;
		add(
			"track",
			track.id,
			ownerPath,
			without(track, ["id", "transitions", "elements"]),
		);
		for (const transition of track.transitions) {
			add("transition", transition.id, trackOwner, without(transition, ["id"]));
		}
		for (const element of track.elements) {
			const elementOwner = `${trackOwner}/element:${element.id}`;
			const canonical = without(element, ["id", "effects", "masks", "tracks"]);
			add("element", element.id, trackOwner, canonical);
			if ("effects" in element) {
				for (const effect of element.effects) {
					add("effect", effect.id, elementOwner, without(effect, ["id"]));
				}
			}
			if ("masks" in element) {
				for (const mask of element.masks) {
					add("mask", mask.id, elementOwner, without(mask, ["id"]));
				}
			}
			if (element.type === "compound") {
				for (const childTrack of element.tracks) {
					walkTrack(childTrack, elementOwner);
				}
			}
		}
	};

	add("project", projectId, "project", without(snapshot.project, ["scenes"]));
	for (const scene of snapshot.project.scenes) {
		const sceneOwner = `scene:${scene.id}`;
		add("scene", scene.id, sceneOwner, without(scene, ["id", "tracks"]));
		for (const track of scene.tracks) walkTrack(track, sceneOwner);
	}
	for (const asset of snapshot.mediaAssets) {
		add("media-asset", asset.id, "media-bin", without(asset, ["id"]));
	}
	return objects;
}

export function deriveProjectSummary(
	snapshot: z.infer<typeof editPlanProjectSnapshotSchema>,
): z.infer<typeof summarySchema> {
	let trackCount = 0;
	let elementCount = 0;
	let transitionCount = 0;
	let durationTicks = 0;
	const visitTracks = (tracks: CanonicalTrack[]): void => {
		trackCount += tracks.length;
		for (const track of tracks) {
			transitionCount += track.transitions.length;
			elementCount += track.elements.length;
			for (const element of track.elements) {
				const end = element.startTime + element.duration;
				if (!Number.isSafeInteger(end)) {
					throw new Error(
						"project summary duration exceeds the safe integer range",
					);
				}
				durationTicks = Math.max(durationTicks, end);
				if (element.type === "compound") visitTracks(element.tracks);
			}
		}
	};
	for (const scene of snapshot.project.scenes) visitTracks(scene.tracks);
	return {
		canonicalHash: canonicalEditPlanSha256(snapshot),
		trackCount,
		elementCount,
		transitionCount,
		durationTicks,
	};
}

function compareTuple(left: string[], right: string[]): number {
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] === right[index]) continue;
		return left[index]! < right[index]! ? -1 : 1;
	}
	return 0;
}

function diffCanonicalValues(
	before: CanonicalEditPlanValue,
	after: CanonicalEditPlanValue,
	fieldPath: string,
	changes: EditPlanEvaluation["changedObjects"],
	objectType: string,
	objectId: string,
): void {
	if (serializeCanonical(before) === serializeCanonical(after)) return;
	if (isCanonicalObject(before) && isCanonicalObject(after)) {
		for (const key of [
			...new Set([...Object.keys(before), ...Object.keys(after)]),
		].sort()) {
			diffCanonicalValues(
				before[key] ?? null,
				after[key] ?? null,
				fieldPath ? `${fieldPath}.${key}` : key,
				changes,
				objectType,
				objectId,
			);
		}
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		for (
			let index = 0;
			index < Math.max(before.length, after.length);
			index += 1
		) {
			diffCanonicalValues(
				before[index] ?? null,
				after[index] ?? null,
				`${fieldPath}[${index}]`,
				changes,
				objectType,
				objectId,
			);
		}
		return;
	}
	changes.push({
		objectType,
		objectId,
		fieldPath,
		before,
		after,
	});
}

function isCanonicalObject(
	value: CanonicalEditPlanValue,
): value is { [key: string]: CanonicalEditPlanValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRustOperationOptions(
	operation: PreflightEditOperation,
): CanonicalEditPlanValue {
	const value = { ...operation } as { [key: string]: unknown };
	delete value.resolvedCascadeElementIds;
	const optional: Partial<Record<PreflightEditOperation["kind"], string[]>> = {
		insert_text: ["elementId"],
		insert_graphic: ["elementId", "name", "trackId", "params"],
		insert_sticker: ["elementId", "name", "trackId", "params"],
		insert_adjustment_layer: ["elementId", "name", "trackId", "params"],
		set_track_state: ["muted", "hidden"],
		set_project_settings: ["fps", "canvasSize", "background"],
		insert_captions: ["trackId", "style"],
		update_caption: ["text", "startTime", "duration"],
		duplicate_elements: ["duplicateIds"],
		create_compound: ["name", "targetTrackId"],
		break_apart_compound: ["restoredElementIds"],
		move: ["targetTrackId"],
		set_reframe: ["mode", "crop", "focalPoint", "targetRect", "layout"],
		set_audio: ["volumeDb", "muted", "fade"],
		separate_source_audio: ["audioTrackId", "audioElementId", "linkId"],
		upsert_effect: ["params", "enabled"],
		upsert_keyframe: ["interpolation", "keyframeId"],
		set_retime: ["maintainPitch"],
		trim: ["startTime", "duration"],
		split: ["rightElementId", "retainSide"],
		set_mask: ["params"],
		reorder_tracks: ["overlayTrackIds", "audioTrackIds"],
		remove_track: ["targetTrackId"],
		duplicate_track: ["newTrackId", "name"],
		add_bookmark: ["bookmarkId", "duration", "note", "color"],
		update_bookmark: ["note", "color", "duration"],
		instantiate_asset: ["elementId", "name", "duration", "trackId"],
	};
	for (const key of optional[operation.kind] ?? []) {
		if (!(key in value)) value[key] = null;
	}
	if (operation.kind === "insert_captions") {
		value.captions = operation.captions.map((caption) => ({
			elementId: caption.elementId ?? null,
			text: caption.text,
			startTime: caption.startTime,
			duration: caption.duration,
		}));
	}
	return parseCanonicalValue(value, []);
}

function parseCanonicalValue(
	value: unknown,
	path: PropertyKey[],
): CanonicalEditPlanValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (containsUnpairedSurrogate(value)) {
			throw new Error(`unpaired UTF-16 surrogate at ${formatPath(path)}`);
		}
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
			throw new Error(
				`number exceeds the finite safe numeric range at ${formatPath(path)}`,
			);
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		return value.map((child, index) =>
			parseCanonicalValue(child, [...path, index]),
		);
	}
	if (typeof value !== "object" || value === undefined) {
		throw new Error(`unsupported JSON value at ${formatPath(path)}`);
	}
	const object = value as { [key: string]: unknown };
	const parsed: { [key: string]: CanonicalEditPlanValue } = Object.create(null);
	for (const key of Object.keys(object).sort()) {
		if (unsafeKeys.has(key) || key.includes("\0")) {
			throw new Error(`unsafe object key at ${formatPath([...path, key])}`);
		}
		if (containsUnpairedSurrogate(key)) {
			throw new Error(
				`unpaired UTF-16 surrogate at ${formatPath([...path, key])}`,
			);
		}
		parsed[key] = parseCanonicalValue(object[key], [...path, key]);
	}
	return parsed;
}

function serializeCanonical(value: CanonicalEditPlanValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(serializeCanonical).join(",")}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key]!)}`)
		.join(",")}}`;
}

function containsUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function formatPath(path: PropertyKey[]): string {
	return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}
