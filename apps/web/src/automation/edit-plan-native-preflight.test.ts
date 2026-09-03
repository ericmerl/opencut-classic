/// <reference types="bun" />

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type {
	EditPlanEvaluationResponse,
	EvaluateEditPlanOptions,
} from "opencut-wasm";
import type { PreflightSourceCapture } from "./edit-plan-preflight-source";
import type {
	AutomationEditPlanPreflightRequest,
	AutomationNoMutationObservation,
} from "./types";

const receiptRows = new Map<string, unknown>();
mock.module("@/services/storage/indexeddb-adapter", () => ({
	deleteDatabase: async () => undefined,
	IndexedDBAdapter: class {
		async get(key: string) {
			return receiptRows.get(key) ?? null;
		}
		async set({ key, value }: { key: string; value: unknown }) {
			receiptRows.set(key, structuredClone(value));
		}
	},
}));

mock.module("opencut-wasm", () => ({
	evaluateEditPlan: () => {
		throw new Error("test must inject the native evaluator");
	},
}));
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	TICKS_PER_SECOND: 120000,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	roundMediaTime: ({ time }: { time: number }) => time,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
}));

const { evaluateNativeEditPlanPreflight } =
	await import("./edit-plan-native-preflight");
const { mediaTime } = await import("@/wasm");
const { buildEditorProjectContentInput } =
	await import("./project-content-identity");
const { buildCanonicalProjectState, canonicalSerialize } =
	await import("./project-content-hash");
const { toNativeEditOperations } =
	await import("./edit-plan-operation-adapter");
const {
	editPlanPreflightFingerprints,
	normalizeEditPlanFingerprintOperations,
} = await import("./edit-plan-preflight-receipt");

describe("native edit-plan preflight adapter", () => {
	beforeEach(() => receiptRows.clear());
	test("binds the exact persisted source and returns an immutable no-mutation proof", async () => {
		const request = await buildRequest();
		const capture = capturedSource(request);
		const captureSource = mock(async () => capture);
		const received: EvaluateEditPlanOptions[] = [];
		const prepared = await validated(request);
		const evaluate = (options: EvaluateEditPlanOptions) => {
			received.push(options);
			return prepared;
		};

		const result = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource,
			evaluate,
		});

		const options = received[0];
		if (!options) throw new Error("native evaluator was not called");
		expect(options.source).toEqual({
			connectionIdentity: {
				...request.expectedConnectionIdentity,
				bridgeProtocolVersion: 2,
			},
			projectId: request.projectId,
			sceneId: request.sceneId,
			sessionRevision: request.expectedRevision,
			canonicalProjectHash: request.expectedProjectContentHash,
			durableWriteVersion: request.expectedWriteVersion,
			saveReceiptId: request.expectedSaveReceiptId,
			saveOperationId: request.saveReceiptOperationId,
		});
		expect(options.before.project.scenes.map((scene) => scene.id)).toEqual([
			"scene-active",
			"scene-requested",
		]);
		expect(options.capabilitySnapshot).toMatchObject({
			editPlanReady: true,
			providerExecution: "forbidden",
			cost: { status: "not-applicable" },
		});
		expect(options.capabilitySnapshot.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(await hash(options.before)).toBe(
			options.source.canonicalProjectHash,
		);
		expect(captureSource).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			status: "validated",
			preflightId: request.preflightId,
			noMutationProof: { unchanged: true },
		});
		if (result.status !== "validated") throw new Error(result.reason);
		expect(result.noMutationProof.before).toEqual(capture.observation);
		expect(result.noMutationProof.after).toEqual(capture.observation);
	});

	test("returns the typed native rejection without a second source read", async () => {
		const request = await buildRequest();
		const captureSource = mock(async () => capturedSource(request));
		const result = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource,
			evaluate: () => ({
				status: "rejected",
				error: {
					code: "UNKNOWN_REFERENCE",
					message: "missing element",
					operationIndex: 0,
					path: "operations[0].elementId",
				},
			}),
		});

		expect(result).toMatchObject({
			status: "rejected",
			code: "NATIVE_EVALUATION_REJECTED",
			error: { code: "UNKNOWN_REFERENCE", operationIndex: 0 },
		});
		expect(captureSource).toHaveBeenCalledTimes(1);
	});

	test("records caption materialization failures as typed terminal rejections", async () => {
		const request = await buildRequest();
		const captureSource = mock(async () => capturedSource(request));
		const evaluate = mock(() => awaitlessValidatedFailure());
		const result = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource,
			materializeCaptions: () => {
				throw new Error("canvas measurement unavailable");
			},
			evaluate,
		});

		expect(result).toMatchObject({
			status: "rejected",
			code: "NATIVE_EVALUATION_REJECTED",
			error: {
				code: "INVALID_VALUE",
				message: "canvas measurement unavailable",
				path: "operations",
			},
		});
		expect(captureSource).toHaveBeenCalledTimes(1);
		expect(evaluate).not.toHaveBeenCalled();
	});

	test("rejects evaluator evidence rebound to a different source", async () => {
		const request = await buildRequest();
		const prepared = await validated(request);
		const result = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource: async () => capturedSource(request),
			evaluate: () => {
				const response = prepared;
				if (response.status !== "validated") return response;
				return {
					...response,
					result: {
						...response.result,
						source: { ...response.result.source, sceneId: "other-scene" },
					},
				};
			},
		});

		expect(result).toMatchObject({
			status: "rejected",
			code: "NATIVE_EVALUATION_REJECTED",
			error: { code: "SOURCE_MISMATCH" },
		});
	});

	test("replays the exact durable terminal result after reconstruction without reevaluation", async () => {
		const request = await buildRequest();
		const prepared = await validated(request);
		const firstCapture = mock(async () => capturedSource(request));
		const firstEvaluate = mock(() => prepared);
		const first = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource: firstCapture,
			evaluate: firstEvaluate,
		});

		const secondCapture = mock(async () => capturedSource(request));
		const secondEvaluate = mock(() => {
			throw new Error("native evaluator must not run during receipt replay");
		});
		const replay = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 0,
			knownStateFingerprint: "reconstructed-state",
			captureSource: secondCapture,
			evaluate: secondEvaluate,
		});

		expect(replay).toEqual(first);
		expect(firstEvaluate).toHaveBeenCalledTimes(1);
		expect(firstCapture).toHaveBeenCalledTimes(2);
		expect(secondEvaluate).not.toHaveBeenCalled();
		expect(secondCapture).not.toHaveBeenCalled();
	});

	test("rejects reuse of a durable preflight ID with a changed request", async () => {
		const request = await buildRequest();
		await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource: async () => capturedSource(request),
			evaluate: () => awaitlessValidatedFailure(),
		});
		const captureSource = mock(async () => capturedSource(request));
		const evaluate = mock(() => awaitlessValidatedFailure());
		const rejected = await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request: { ...request, description: "Different plan" },
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource,
			evaluate,
		});

		expect(rejected).toEqual({
			status: "rejected",
			preflightId: request.preflightId,
			code: "PREFLIGHT_ID_REUSED",
			reason: "preflightId was already used for a different request",
		});
		expect(captureSource).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
	});

	test("fails closed when durable terminal bytes are corrupted", async () => {
		const request = await buildRequest();
		await evaluateNativeEditPlanPreflight({
			editor: emptyEditor(),
			request,
			sessionRevision: 7,
			knownStateFingerprint: "known-state",
			captureSource: async () => capturedSource(request),
			evaluate: () => awaitlessValidatedFailure(),
		});
		const stored = receiptRows.get(request.preflightId);
		if (!stored || typeof stored !== "object")
			throw new Error("missing receipt");
		receiptRows.set(request.preflightId, {
			...stored,
			result: {
				status: "rejected",
				preflightId: request.preflightId,
				code: "INVENTED_TERMINAL_CODE",
				reason: "corrupted",
			},
		});

		await expect(
			evaluateNativeEditPlanPreflight({
				editor: emptyEditor(),
				request,
				sessionRevision: 7,
				knownStateFingerprint: "known-state",
				captureSource: async () => capturedSource(request),
				evaluate: () => awaitlessValidatedFailure(),
			}),
		).rejects.toThrow("receipt fields are invalid");
	});

	test("canonical request fingerprints equate omitted Rust options with null slots", async () => {
		const request = await buildRequest();
		const operation = request.operations[0];
		if (!operation || operation.kind !== "insert_text") {
			throw new Error("insert text fixture is missing");
		}
		const { elementId: _omitted, ...withoutElementId } = operation;
		const omittedRequest = { ...request, operations: [withoutElementId] };
		const omitted = await editPlanPreflightFingerprints(omittedRequest);
		const explicitUndefined = await editPlanPreflightFingerprints({
			...omittedRequest,
			operations: omittedRequest.operations.map((candidate) => ({
				...candidate,
				elementId: undefined,
			})),
		});
		const changed = await editPlanPreflightFingerprints({
			...omittedRequest,
			operations: omittedRequest.operations.map((candidate) => ({
				...candidate,
				elementId: "resolved-title",
			})),
		});
		expect(
			normalizeEditPlanFingerprintOperations(omittedRequest.operations),
		).toEqual(
			normalizeEditPlanFingerprintOperations(
				omittedRequest.operations.map((candidate) => ({
					...candidate,
					elementId: undefined,
				})),
			),
		);

		expect(explicitUndefined).toEqual(omitted);
		expect(changed.planFingerprint).not.toBe(omitted.planFingerprint);
		expect(changed.requestFingerprint).not.toBe(omitted.requestFingerprint);
	});
});

function awaitlessValidatedFailure(): EditPlanEvaluationResponse {
	return {
		status: "rejected",
		error: {
			code: "INVALID_VALUE",
			message: "fixture rejection",
			operationIndex: null,
			path: null,
		},
	};
}

async function validated(
	request: AutomationEditPlanPreflightRequest,
): Promise<EditPlanEvaluationResponse> {
	const before = buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: buildProject(),
			mediaAssets: [],
		}),
	);
	const source = {
		connectionIdentity: {
			...request.expectedConnectionIdentity,
			bridgeProtocolVersion: 2 as const,
		},
		projectId: request.projectId,
		sceneId: request.sceneId,
		sessionRevision: request.expectedRevision,
		canonicalProjectHash: request.expectedProjectContentHash,
		durableWriteVersion: request.expectedWriteVersion,
		saveReceiptId: request.expectedSaveReceiptId,
		saveOperationId: request.saveReceiptOperationId,
	};
	const readiness = {
		editPlanReady: true,
		providerExecution: "forbidden" as const,
		cost: { status: "not-applicable" as const },
	};
	const capabilitySnapshot = {
		...readiness,
		hash: await hash(readiness),
	};
	const fingerprints = await editPlanPreflightFingerprints(request);
	const preflightFingerprint = await hash({
		planFingerprint: fingerprints.planFingerprint,
		source,
		capabilitySnapshot,
		policy: request.policy,
	});
	const planDiffHash = await hash({
		predictedProjectHash: request.expectedProjectContentHash,
		changedObjects: [],
		timingConsequences: [],
		rippleExpansion: [],
		relationshipExpansion: [],
	});
	const summary = {
		canonicalHash: request.expectedProjectContentHash,
		trackCount: 2,
		elementCount: 0,
		transitionCount: 0,
		durationTicks: 0,
	};
	const [operation] = toNativeEditOperations(request.operations);
	if (!operation || operation.kind !== "insert_text") {
		throw new Error("fixture requires one insert_text operation");
	}
	return {
		status: "validated",
		result: {
			schemaVersion: "opencut.edit-plan-preflight.v2",
			source,
			planFingerprint: fingerprints.planFingerprint,
			preflightFingerprint,
			planDiffHash,
			predictedProjectHash: request.expectedProjectContentHash,
			beforeSummary: summary,
			predictedAfterSummary: summary,
			before,
			predictedAfter: before,
			resolvedOperations: [
				{
					...operation,
					elementId: operation.elementId ?? null,
				},
			],
			resolvedIds: [],
			changedObjects: [],
			timingConsequences: [],
			rippleExpansion: [],
			relationshipExpansion: [],
			warnings: [],
			requirements: capabilitySnapshot,
			cost: capabilitySnapshot.cost,
		},
	};
}

async function buildRequest(): Promise<AutomationEditPlanPreflightRequest> {
	const before = buildCanonicalProjectState(
		buildEditorProjectContentInput({
			project: buildProject(),
			mediaAssets: [],
		}),
	);
	return {
		contractVersion: 2,
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 3,
		},
		preflightId: "preflight-1",
		projectId: "project-1",
		sceneId: "scene-requested",
		expectedRevision: 7,
		expectedProjectContentHash: await hash(before),
		expectedWriteVersion: 4,
		saveReceiptOperationId: "save-4",
		expectedSaveReceiptId: "receipt-4",
		description: "Add a title",
		operations: [
			{
				kind: "insert_text",
				elementId: "title-1",
				content: "Hello",
				startTime: mediaTime({ ticks: 0 }),
				duration: mediaTime({ ticks: 120000 }),
			},
		],
		policy: {
			warningPolicy: "allow",
			providerExecution: "forbidden",
			costPolicy: "require-exact",
		},
	};
}

async function hash(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalSerialize(value)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function capturedSource(
	request: AutomationEditPlanPreflightRequest,
): Extract<PreflightSourceCapture, { status: "captured" }> {
	const project = buildProject();
	const observation: AutomationNoMutationObservation = {
		projectId: request.projectId,
		sceneId: request.sceneId,
		sessionRevision: request.expectedRevision,
		canonicalProjectHash: request.expectedProjectContentHash,
		durableWriteVersion: request.expectedWriteVersion,
		saveReceiptId: request.expectedSaveReceiptId,
		saveOperationId: request.saveReceiptOperationId,
		connectionIdentity: {
			...request.expectedConnectionIdentity,
			bridgeProtocolVersion: 2,
		},
		activeProjectId: request.projectId,
		activeSceneId: "scene-active",
		playheadTicks: mediaTime({ ticks: 0 }),
		isPlaying: false,
		selectionFingerprint: "1".repeat(64),
		historyFingerprint: "2".repeat(64),
		persistenceFingerprint: "3".repeat(64),
	};
	return {
		status: "captured",
		readback: {
			project,
			mediaAssets: [],
			persistence: {
				projectId: request.projectId,
				storageSchemaVersion: 1,
				writeVersion: request.expectedWriteVersion,
				snapshotAt: "2026-09-02T00:00:00.000Z",
				completedAt: "2026-09-02T00:00:01.000Z",
			},
		},
		scene: project.scenes[1]!,
		contentIdentity: {
			status: "hashed",
			hash: {
				projection: "opencut-project-content",
				projectionVersion: 1,
				algorithm: "SHA-256",
				digest: request.expectedProjectContentHash,
			},
		},
		observation,
	};
}

function buildProject(): TProject {
	const timestamp = new Date("2026-09-02T00:00:00.000Z");
	const scene = ({ id, isMain }: { id: string; isMain: boolean }) => ({
		id,
		name: id,
		isMain,
		tracks: {
			main: {
				id: `${id}-main`,
				name: "Main",
				type: "video" as const,
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [],
			audio: [],
		},
		bookmarks: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	return {
		metadata: {
			id: "project-1",
			name: "Preflight fixture",
			duration: mediaTime({ ticks: 0 }),
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		scenes: [
			scene({ id: "scene-active", isMain: true }),
			scene({ id: "scene-requested", isMain: false }),
		],
		currentSceneId: "scene-active",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}

function emptyEditor(): EditorCore {
	const editor: EditorCore = Object.create(null);
	return editor;
}
