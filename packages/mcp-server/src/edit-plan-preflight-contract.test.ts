import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	canonicalEditPlanJson,
	canonicalEditPlanSha256,
	deriveProjectChangedObjects,
	editPlanEvaluationResponseSchema,
	editPlanProjectSnapshotSchema,
	preflightEditPlanRequestFingerprint,
} from "./edit-plan-preflight-contract";
import {
	allocationRoleSchema,
	preflightEditPlanInputSchema,
	resolvedEditOperationSchema,
} from "./tool-schemas";

const identity = {
	serverInstanceId: "server-1",
	editorInstanceId: "editor-1",
	editorSessionId: "session-1",
	connectionGeneration: 4,
};

function request() {
	return {
		contractVersion: 2 as const,
		bridgeProtocolVersion: 2 as const,
		expectedConnectionIdentity: identity,
		preflightId: "preflight-1",
		projectId: "project-1",
		sceneId: "scene-1",
		expectedRevision: 7,
		expectedProjectContentHash: "a".repeat(64),
		expectedWriteVersion: 9,
		saveReceiptOperationId: "save-op-1",
		expectedSaveReceiptId: "save:project-1:9",
		description: "insert title",
		operations: [
			{
				kind: "insert_text" as const,
				content: "Title",
				startTime: 0,
				duration: 120_000,
			},
		],
		policy: {
			warningPolicy: "allow" as const,
			providerExecution: "forbidden" as const,
			costPolicy: "require-exact" as const,
		},
	};
}

describe("edit-plan preflight contract", () => {
	test("rejects unknown keys at every operation depth", () => {
		expect(
			preflightEditPlanInputSchema.safeParse({
				...request(),
				operations: [
					{
						kind: "insert_captions",
						captions: [
							{
								text: "Hi",
								startTime: 0,
								duration: 100,
								ignored: true,
							},
						],
					},
				],
			}).success,
		).toBe(false);
		expect(
			preflightEditPlanInputSchema.safeParse({
				...request(),
				operations: [
					{
						kind: "split",
						trackId: "track-1",
						elementId: "element-1",
						splitTime: 60_000,
						resolvedAllocations: [],
					},
				],
			}).success,
		).toBe(false);
	});

	test("keeps deterministic auto-track allocations output-only", () => {
		expect(
			preflightEditPlanInputSchema.safeParse({
				...request(),
				operations: [
					{
						kind: "insert_text",
						content: "Title",
						startTime: 0,
						duration: 120_000,
						autoTrackId: "text-track-1",
					},
				],
			}).success,
		).toBe(true);
		expect(
			preflightEditPlanInputSchema.safeParse({
				...request(),
				operations: [
					{
						kind: "insert_text",
						content: "Title",
						startTime: 0,
						duration: 120_000,
						resolvedAllocations: [],
					},
				],
			}).success,
		).toBe(false);
		expect(
			resolvedEditOperationSchema.safeParse({
				kind: "insert_text",
				elementId: "text-1",
				content: "Title",
				startTime: 0,
				duration: 120_000,
				autoTrackId: "text-track-1",
				resolvedAllocations: [
					{
						role: "element-auto-track",
						sourceId: "text-1",
						resolvedId: "text-track-1",
					},
				],
			}).success,
		).toBe(true);
		expect(
			allocationRoleSchema.safeParse("duplicate-nested-keyframe").success,
		).toBe(true);
		expect(allocationRoleSchema.safeParse("split-keyframe").success).toBe(
			false,
		);
		expect(
			resolvedEditOperationSchema.safeParse({
				kind: "set_reframe",
				trackId: "track-1",
				elementId: "element-1",
				mode: "cover",
				crop: null,
				focalPoint: { x: 0.5, y: 0.5 },
				targetRect: null,
				layout: null,
			}).success,
		).toBe(true);
		expect(
			resolvedEditOperationSchema.safeParse({
				kind: "set_reframe",
				trackId: "track-1",
				elementId: "element-1",
				mode: "cover",
				focalPoint: { x: 0.5, y: 0.5 },
			}).success,
		).toBe(false);
	});

	test("accepts explicit nulls from rejected native evaluator DTOs", () => {
		const parsed = editPlanEvaluationResponseSchema.parse({
			status: "rejected",
			error: {
				code: "SOURCE_MISMATCH",
				message: "source changed",
				operationIndex: null,
				path: null,
			},
		});
		if (parsed.status !== "rejected") {
			throw new Error("expected rejected evaluation");
		}
		expect(parsed.error.operationIndex).toBeNull();
		expect(parsed.error.path).toBeNull();
	});

	test("accepts caption layout evidence only in resolved operations", () => {
		const caption = {
			elementId: "caption-1",
			text: "Hi",
			startTime: 0,
			duration: 120_000,
			speaker: null,
			resolvedName: "Caption 1",
			resolvedContent: "Hi",
			resolvedParams: {
				content: "Hi",
				fontSize: 5,
				"transform.positionY": 700,
			},
			resolvedLayoutVersion: "opencut.caption-layout.v1",
			resolvedLayoutEngine: "browser-canvas-2d",
		};
		expect(
			resolvedEditOperationSchema.safeParse({
				kind: "insert_captions",
				trackId: "captions-track",
				captions: [caption],
				style: null,
			}).success,
		).toBe(true);
		expect(
			preflightEditPlanInputSchema.safeParse({
				...request(),
				operations: [
					{
						kind: "insert_captions",
						captions: [caption],
					},
				],
			}).success,
		).toBe(false);
		expect(
			resolvedEditOperationSchema.safeParse({
				kind: "insert_captions",
				trackId: "captions-track",
				captions: [{ ...caption, resolvedLayoutEngine: "server" }],
				style: null,
			}).success,
		).toBe(false);
		expect(
			resolvedEditOperationSchema.safeParse({
				kind: "insert_captions",
				trackId: "captions-track",
				captions: [
					{
						...caption,
						resolvedLayoutEngine: undefined,
					},
				],
				style: null,
			}).success,
		).toBe(false);
	});

	test("accepts duration-clamp IDs only in resolved operations", () => {
		const resolvedAllocations = [
			{
				role: "duration-clamp-left-boundary-keyframe" as const,
				sourceId: "opacity",
				resolvedId: "opacity-left",
			},
			{
				role: "duration-clamp-right-boundary-keyframe" as const,
				sourceId: "opacity",
				resolvedId: "opacity-right",
			},
		];
		const operations = [
			{
				kind: "set_retime",
				trackId: "track-1",
				elementId: "element-1",
				rate: 2,
				maintainPitch: null,
				resolvedAllocations,
			},
			{
				kind: "trim",
				trackId: "track-1",
				elementId: "element-1",
				startTime: null,
				duration: null,
				trimStart: 0,
				trimEnd: 60_000,
				ripple: false,
				resolvedAllocations,
			},
			{
				kind: "update_caption",
				trackId: "captions",
				elementId: "caption-1",
				text: null,
				startTime: null,
				duration: 60_000,
				resolvedAllocations,
			},
		];

		for (const operation of operations) {
			expect(resolvedEditOperationSchema.safeParse(operation).success).toBe(
				true,
			);
			expect(
				preflightEditPlanInputSchema.safeParse({
					...request(),
					operations: [operation],
				}).success,
			).toBe(false);
		}
	});

	test("canonicalizes keys and normalizes negative zero deterministically", () => {
		expect(canonicalEditPlanJson({ z: -0, a: [2, { d: true, c: null }] })).toBe(
			'{"a":[2,{"c":null,"d":true}],"z":0}',
		);
		expect(
			canonicalEditPlanSha256({ z: -0, a: [2, { d: true, c: null }] }),
		).toBe("e93bef602af41cf5bc1262b4d9afe57e2d14a1d34bc71999c1f39dae677c260a");
	});

	test("rejects unsafe numbers and prototype-like keys before hashing", () => {
		expect(() =>
			canonicalEditPlanJson({ ticks: Number.MAX_SAFE_INTEGER + 1 }),
		).toThrow("safe numeric range");
		expect(() => canonicalEditPlanJson({ constructor: "unsafe" })).toThrow(
			"unsafe object key",
		);
	});

	test("semantic fingerprint ignores preflight identity but binds source and policy", () => {
		const first = preflightEditPlanRequestFingerprint(request());
		const replay = preflightEditPlanRequestFingerprint({
			...request(),
			preflightId: "different-transport-id",
		});
		const changedSource = preflightEditPlanRequestFingerprint({
			...request(),
			expectedWriteVersion: 10,
		});
		expect(replay).toBe(first);
		expect(changedSource).not.toBe(first);
	});

	test("accepts complete project-content v1, v2, and stable-bookmark v3 projections", () => {
		const projection = {
			projection: "opencut-project-content" as const,
			projectionVersion: 1 as const,
			project: {
				name: "P",
				activeSceneId: "scene-1",
				mainSceneId: "scene-1",
				settings: {
					background: { type: "blur", blurIntensity: 8 },
					canvasSize: { width: 1080, height: 1920 },
					fps: { numerator: 30, denominator: 1 },
				},
				scenes: [
					{
						order: 0,
						id: "scene-1",
						name: "Main",
						isMain: true,
						bookmarks: [],
						tracks: [],
					},
				],
			},
			mediaAssets: [],
		};
		expect(editPlanProjectSnapshotSchema.parse(projection)).toEqual(projection);
		expect(canonicalEditPlanSha256(projection)).toBe(
			"9d2dc5580999c5c3625cd0a4016ee9a9de03889e2d00f7590f49a381da7bd3e7",
		);
		const projectionV2 = {
			...projection,
			projectionVersion: 2 as const,
			project: { ...projection.project, id: "project-1" },
		};
		expect(editPlanProjectSnapshotSchema.parse(projectionV2)).toEqual(
			projectionV2,
		);
		const projectionV3 = {
			...projectionV2,
			projectionVersion: 3 as const,
			project: {
				...projectionV2.project,
				scenes: projectionV2.project.scenes.map((scene) => ({
					...scene,
					bookmarks: [
						{
							order: 0,
							id: "bookmark-1",
							time: 8_000,
							duration: null,
							note: null,
							color: "#ff0000",
						},
					],
				})),
			},
		};
		expect(editPlanProjectSnapshotSchema.parse(projectionV3)).toEqual(
			projectionV3,
		);
		const projectionWithCompositing = {
			...projectionV2,
			project: {
				...projectionV2.project,
				scenes: [
					{
						...projectionV2.project.scenes[0],
						tracks: [
							{
								role: "primary",
								order: 0,
								id: "track-1",
								name: "Foreground",
								type: "video",
								muted: null,
								hidden: null,
								trackMatte: {
									sourceTrackId: "track-matte",
									mode: "luma",
									inverted: false,
									enabled: true,
								},
								transitions: [],
								elements: [
									{
										order: 0,
										id: "video-1",
										name: "Keyed video",
										groupId: null,
										linkId: null,
										startTime: 0,
										duration: 1_000,
										trimStart: 0,
										trimEnd: 0,
										sourceDuration: 1_000,
										params: {},
										animations: {},
										type: "video",
										mediaId: "media-1",
										hidden: null,
										isSourceAudioEnabled: true,
										retime: {},
										effects: [],
										masks: [],
										key: {
											type: "chroma",
											keyColor: "#00ff00",
											similarity: 0.2,
											softness: 0.1,
											spillSuppression: 0.7,
											enabled: true,
										},
										matte: null,
										audioReplacement: null,
									},
								],
							},
						],
					},
				],
			},
		};
		const parsedCompositing = editPlanProjectSnapshotSchema.parse(
			projectionWithCompositing,
		);
		const parsedTrack = parsedCompositing.project.scenes[0]?.tracks[0];
		expect(parsedTrack?.trackMatte).toEqual({
			sourceTrackId: "track-matte",
			mode: "luma",
			inverted: false,
			enabled: true,
		});
		const parsedElement = parsedTrack?.elements[0];
		if (!parsedElement || parsedElement.type !== "video") {
			throw new Error("parsed keyed video is missing");
		}
		expect(parsedElement.key).toEqual({
			type: "chroma",
			keyColor: "#00ff00",
			similarity: 0.2,
			softness: 0.1,
			spillSuppression: 0.7,
			enabled: true,
		});
		expect(() =>
			editPlanProjectSnapshotSchema.parse({
				...projectionV2,
				project: { ...projection.project },
			}),
		).toThrow("project-content v2 requires project.id");
		expect(() =>
			editPlanProjectSnapshotSchema.parse({
				schemaVersion: "opencut.edit-plan-snapshot.v2",
				projectId: "project-1",
			}),
		).toThrow();
		const predicted = structuredClone(projection);
		predicted.project.name = "Predicted";
		expect(
			deriveProjectChangedObjects(projection, predicted, "project-1"),
		).toEqual([
			{
				objectType: "project",
				objectId: "project-1",
				fieldPath: "name",
				before: "P",
				after: "Predicted",
			},
		]);
	});

	test("attributes canonical diffs to stable nested object identities", () => {
		const fixture = editPlanProjectSnapshotSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						import.meta.dir,
						"../../../rust/crates/edit-plan/tests/fixtures/full-project-content-v1.json",
					),
					"utf8",
				),
			),
		);
		const predicted = structuredClone(fixture);
		predicted.project.settings.background = {
			type: "color",
			color: "#101010",
		};
		predicted.project.scenes[0]!.bookmarks[0]!.note = "reviewed";
		predicted.project.scenes[0]!.tracks[0]!.name = "Renamed";
		predicted.project.scenes[0]!.tracks[0]!.elements[0]!.name = "Hero";
		const video = predicted.project.scenes[0]!.tracks[0]!.elements[0]!;
		if (video.type !== "video") throw new Error("fixture video is missing");
		video.effects[0]!.enabled = false;
		video.masks.splice(0, 1);
		predicted.project.scenes[0]!.tracks[0]!.transitions[0]!.duration = 8_008;
		predicted.mediaAssets[0]!.name = "voice-clean.wav";
		const nestedTrack = fixture.project.scenes[0]!.tracks[0]!.elements[1];
		if (nestedTrack?.type !== "compound") {
			throw new Error("fixture compound is missing");
		}
		const predictedCompound =
			predicted.project.scenes[0]!.tracks[0]!.elements[1];
		if (predictedCompound?.type !== "compound") {
			throw new Error("predicted compound is missing");
		}
		predictedCompound.tracks[0]!.elements.splice(0, 1);

		const changes = deriveProjectChangedObjects(
			fixture,
			predicted,
			"project-golden",
		);
		expect(changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					objectType: "project",
					objectId: "project-golden",
					fieldPath: "settings.background.color",
				}),
				expect.objectContaining({
					objectType: "scene",
					objectId: "scene-main",
					fieldPath: "bookmarks[0].note",
				}),
				expect.objectContaining({
					objectType: "track",
					objectId: "track-main",
					fieldPath: "name",
				}),
				expect.objectContaining({
					objectType: "element",
					objectId: "video-1",
					fieldPath: "name",
				}),
				expect.objectContaining({
					objectType: "effect",
					objectId: "effect-1",
					fieldPath: "enabled",
				}),
				{
					objectType: "mask",
					objectId: "mask-1",
					fieldPath: "@scene:scene-main/track:track-main/element:video-1",
					before: {
						order: 0,
						type: "rectangle",
						params: { x: 0.1, points: [{ id: "point-1", x: 0.2 }] },
					},
					after: null,
				},
				expect.objectContaining({
					objectType: "transition",
					objectId: "transition-1",
					fieldPath: "duration",
				}),
				expect.objectContaining({
					objectType: "media-asset",
					objectId: "media-audio",
					fieldPath: "name",
				}),
				expect.objectContaining({
					objectType: "element",
					objectId: "nested-image",
					fieldPath:
						"@scene:scene-main/track:track-main/element:compound-1/track:nested-main",
					after: null,
				}),
			]),
		);
		expect(
			changes.some(({ objectId }) => objectId === "canonical-project"),
		).toBe(false);
	});

	test("qualifies repeated native IDs by deterministic ownership path", () => {
		const fixture = editPlanProjectSnapshotSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						import.meta.dir,
						"../../../rust/crates/edit-plan/tests/fixtures/full-project-content-v1.json",
					),
					"utf8",
				),
			),
		);
		const predicted = structuredClone(fixture);
		const compound = predicted.project.scenes[0]!.tracks[0]!.elements[1];
		if (compound?.type !== "compound") {
			throw new Error("fixture compound is missing");
		}
		compound.tracks[0]!.id = "track-main";

		const changes = deriveProjectChangedObjects(
			fixture,
			predicted,
			"project-golden",
		);
		expect(changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					objectType: "track",
					objectId: "nested-main",
					fieldPath: "@scene:scene-main/track:track-main/element:compound-1",
					before: expect.any(Object),
					after: null,
				}),
				expect.objectContaining({
					objectType: "track",
					objectId: "track-main",
					fieldPath: "@scene:scene-main/track:track-main/element:compound-1",
					before: null,
					after: expect.any(Object),
				}),
			]),
		);
		expect(
			changes.some(
				(change) =>
					change.objectType === "track" &&
					change.objectId === "track-main" &&
					change.fieldPath.startsWith("@scene:scene-main."),
			),
		).toBe(false);
	});

	test("requires explicit nulls for canonical nullable fields", () => {
		const fixture = JSON.parse(
			readFileSync(
				join(
					import.meta.dir,
					"../../../rust/crates/edit-plan/tests/fixtures/full-project-content-v1.json",
				),
				"utf8",
			),
		);
		const missingNullable = structuredClone(fixture);
		delete missingNullable.project.mainSceneId;
		expect(
			editPlanProjectSnapshotSchema.safeParse(missingNullable).success,
		).toBe(false);

		const incompleteSource = structuredClone(fixture);
		incompleteSource.mediaAssets[0].source.contentHash = null;
		expect(
			editPlanProjectSnapshotSchema.safeParse(incompleteSource).success,
		).toBe(true);
	});

	test("matches the shared web and Rust full-projection golden hash", () => {
		const fixture = JSON.parse(
			readFileSync(
				join(
					import.meta.dir,
					"../../../rust/crates/edit-plan/tests/fixtures/full-project-content-v1.json",
				),
				"utf8",
			),
		);
		const parsed = editPlanProjectSnapshotSchema.parse(fixture);
		expect(Buffer.byteLength(canonicalEditPlanJson(parsed), "utf8")).toBe(
			6_451,
		);
		expect(canonicalEditPlanSha256(parsed)).toBe(
			"3925eec0bcfda9c81c325e8436b3744f0794875189f8a508bf3d51f802a5424c",
		);
	});
});
