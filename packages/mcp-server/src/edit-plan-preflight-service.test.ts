import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	browserEditPlanPreflightReceiptChecksum,
	canonicalEditPlanSha256,
	deriveProjectChangedObjects,
	editPlanFingerprint,
	evaluationDiffHash,
	evaluationPreflightFingerprint,
	preflightEditPlanRequestFingerprint,
	type BrowserEditPlanPreflightResponse,
	type EditPlanEvaluation,
	type PreflightEditPlanInput,
} from "./edit-plan-preflight-contract";
import {
	deriveEditPlanCapabilitySnapshot,
	EditPlanPreflightService,
} from "./edit-plan-preflight-service";
import { EditPlanPreflightStore } from "./edit-plan-preflight-store";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("edit-plan preflight service", () => {
	test("derives browser evaluation readiness from the public capability snapshot", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		const browser = new DurableTestBrowser(() => ({
			status: "rejected",
			preflightId: "preflight-1",
			code: "SAVE_RECEIPT_MISMATCH",
			reason: "saved bytes changed",
		}));
		const publicSnapshot = {
			snapshotHash: "8".repeat(64),
			editor: { status: "ready", negotiatedProtocolVersion: 2 },
			tools: {
				registered: ["opencut_preflight_edit_plan", "opencut_apply_edit_plan"],
				editPlanOperationVariants: ["delete"],
			},
		};
		const service = new EditPlanPreflightService(browser, store, undefined, {
			captureCapabilitySnapshot: async () => publicSnapshot,
		});
		await service.preflight(input());
		expect(browser.capabilitySnapshot).toEqual(
			deriveEditPlanCapabilitySnapshot(publicSnapshot),
		);
		store.close();
	});

	test("persists and exactly replays a terminal rejection without redispatch", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		const browser = new DurableTestBrowser(() => ({
			status: "rejected",
			preflightId: "preflight-1",
			code: "SAVE_RECEIPT_MISMATCH",
			reason: "saved bytes changed",
		}));
		const service = new EditPlanPreflightService(
			browser,
			store,
			() => "2026-09-02T20:00:00.000Z",
		);
		const first = await service.preflight(input());
		const replay = await service.preflight(input());
		expect(first.disposition).toBe("evaluated");
		expect(replay).toEqual({ ...first, disposition: "replayed" });
		expect(browser.evaluations).toBe(1);
		store.close();
	});

	test("fails closed when browser evidence targets another preflight", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		const service = new EditPlanPreflightService(
			new DurableTestBrowser(() => ({
				status: "conflict",
				preflightId: "another-preflight",
				code: "SOURCE_STATE_CONFLICT",
				reason: "changed",
			})),
			store,
		);
		await expect(service.preflight(input())).rejects.toThrow(
			"browser preflight ID mismatch",
		);
		store.close();
	});

	test("replays a committed receipt after response loss without redispatch", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		let loseResponse = true;
		const browser = new DurableTestBrowser(() => ({
			status: "rejected",
			preflightId: "preflight-1",
			code: "SAVE_RECEIPT_MISMATCH",
			reason: "saved bytes changed",
		}));
		const service = new EditPlanPreflightService(browser, store, undefined, {
			afterReceiptCommit: () => {
				if (loseResponse) {
					loseResponse = false;
					throw new Error("injected response loss");
				}
			},
		});
		await expect(service.preflight(input())).rejects.toThrow(
			"injected response loss",
		);
		const replay = await service.preflight(input());
		expect(replay.disposition).toBe("replayed");
		expect(browser.evaluations).toBe(1);
		store.close();
	});

	test("recovers a browser receipt after pre-response loss without reevaluation", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const firstStore = new EditPlanPreflightStore(directory);
		const browser = new DurableTestBrowser(
			() => ({
				status: "rejected",
				preflightId: "preflight-1",
				code: "SAVE_RECEIPT_MISMATCH",
				reason: "saved bytes changed",
			}),
			true,
		);
		const firstService = new EditPlanPreflightService(browser, firstStore);
		await expect(firstService.preflight(input())).rejects.toThrow(
			"injected browser response loss",
		);
		firstStore.close();

		const restartedStore = new EditPlanPreflightStore(directory);
		const restartedService = new EditPlanPreflightService(
			browser,
			restartedStore,
		);
		const recovered = await restartedService.preflight(input());
		expect(recovered.disposition).toBe("replayed");
		expect(browser.evaluations).toBe(1);
		restartedStore.close();
	});

	test("fails closed when durable state is corrupted while an in-progress waiter polls", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const ownerStore = new EditPlanPreflightStore(directory);
		let observeFirstPoll = (): void => {};
		const firstPoll = new Promise<void>((resolve) => {
			observeFirstPoll = resolve;
		});
		class ObservedPreflightStore extends EditPlanPreflightStore {
			private observed = false;

			override async getByPreflightId(preflightId: string) {
				const result = await super.getByPreflightId(preflightId);
				if (!this.observed) {
					this.observed = true;
					observeFirstPoll();
				}
				return result;
			}
		}
		const waiterStore = new ObservedPreflightStore(directory);
		try {
			const request = input();
			await ownerStore.claim(
				request.preflightId,
				preflightEditPlanRequestFingerprint(request),
			);
			const browser = new DurableTestBrowser(() => {
				throw new Error("an in-progress waiter must not evaluate");
			});
			const waiting = new EditPlanPreflightService(
				browser,
				waiterStore,
			).preflight(request);
			await firstPoll;
			const database = new Database(
				join(directory, "edit-plan-preflights.sqlite"),
			);
			database.exec("DROP TRIGGER preflight_events_no_delete");
			database.close();

			await expect(waiting).rejects.toThrow(
				"preflight integrity triggers are missing",
			);
			expect(browser.evaluations).toBe(0);
		} finally {
			ownerStore.close();
			waiterStore.close();
		}
	});

	test("publishes only internally consistent full-project validation evidence", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		const request = input();
		const response = validatedResponse(request);
		const browser = new DurableTestBrowser(() => response);
		const service = new EditPlanPreflightService(browser, store);
		const result = await service.preflight(request);
		expect(result.result).toEqual(response);
		expect(await store.get(result.receiptId)).not.toBeNull();
		const evaluation = response.evaluation;
		const restartedIdentity = {
			...request.expectedConnectionIdentity,
			editorSessionId: "session-2",
			connectionGeneration: 2,
		};
		browser.currentRevision = 0;
		const verified = await service.verifiedApplication({
			projectId: request.projectId,
			expectedRevision: 0,
			expectedProjectContentHash: request.expectedProjectContentHash,
			expectedConnectionIdentity: restartedIdentity,
			description: request.description,
			operations: request.operations,
			preflight: {
				receiptId: result.receiptId,
				planFingerprint: evaluation.planFingerprint,
				preflightFingerprint: evaluation.preflightFingerprint,
				planDiffHash: evaluation.planDiffHash,
			},
		});
		expect(verified.evaluation.resolvedOperations).toEqual(request.operations);
		store.close();
	});

	test("rejects out-of-range and semantically false operation attribution", async () => {
		for (const mutation of [
			(response: ReturnType<typeof validatedResponse>) => {
				response.evaluation.timingConsequences[0]!.operationIndex = 1;
			},
			(response: ReturnType<typeof validatedResponse>) => {
				response.evaluation.resolvedOperations[0] = {
					kind: "delete",
					trackId: "track-1",
					elementId: "another-element",
					ripple: false,
					relationshipScope: "all",
				};
			},
		]) {
			const directory = await mkdtemp(
				join(tmpdir(), "opencut-preflight-service-"),
			);
			directories.push(directory);
			const store = new EditPlanPreflightStore(directory);
			const request = input();
			const response = validatedResponse(request);
			mutation(response);
			response.evaluation.planDiffHash = evaluationDiffHash(
				response.evaluation,
			);
			const service = new EditPlanPreflightService(
				new DurableTestBrowser(() => response),
				store,
			);
			await expect(service.preflight(request)).rejects.toThrow(
				/operation|timing/,
			);
			store.close();
		}
	});

	test("attributes track-removal timing consequences to elements owned by that track", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		const request = input();
		request.description = "remove an occupied overlay track";
		request.operations = [
			{
				kind: "remove_track",
				trackId: "track-1",
				occupied: "delete",
			},
		];
		const response = validatedResponse(request);
		Object.assign(response.evaluation, {
			resolvedOperations: [
				{
					kind: "remove_track",
					trackId: "track-1",
					occupied: "delete",
					targetTrackId: null,
					resolvedCascadeElementIds: [],
				},
			],
		});
		const service = new EditPlanPreflightService(
			new DurableTestBrowser(() => response),
			store,
		);

		await expect(service.preflight(request)).resolves.toMatchObject({
			result: { status: "validated" },
		});
		store.close();
	});

	test("validates and removes authenticated bridge metadata before receipt parsing", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "opencut-preflight-service-"),
		);
		directories.push(directory);
		const store = new EditPlanPreflightStore(directory);
		const durable = new DurableTestBrowser(() => ({
			status: "rejected",
			preflightId: "preflight-1",
			code: "PERSISTED_SOURCE_UNAVAILABLE",
			reason: "persisted source is unavailable",
		}));
		const request = input();
		const browser = {
			async request(
				method: string,
				params: unknown,
				_timeoutMs?: number,
				expectedIdentity?: typeof request.expectedConnectionIdentity,
			) {
				const result = await durable.request(method, params);
				return {
					...(result as Record<string, unknown>),
					bridgeProtocolVersion: 2,
					connectionIdentity: request.expectedConnectionIdentity,
					...(expectedIdentity
						? { requestConnectionIdentity: expectedIdentity }
						: {}),
				};
			},
		};
		const result = await new EditPlanPreflightService(browser, store).preflight(
			request,
		);
		expect(result.result.status).toBe("rejected");
		expect(durable.evaluations).toBe(1);
		store.close();
	});
});

class DurableTestBrowser {
	evaluations = 0;
	capabilitySnapshot: unknown = null;
	currentRevision: number | null = null;
	private receipt: ReturnType<DurableTestBrowser["buildReceipt"]> | null = null;

	constructor(
		private readonly evaluate: () => BrowserEditPlanPreflightResponse,
		private loseFirstResponse = false,
	) {}

	async request(method: string, params: unknown): Promise<unknown> {
		if (method === "get_edit_plan_preflight_receipt") {
			const query = params as {
				preflightId: string;
				requestFingerprint: string;
			};
			if (!this.receipt) {
				return { status: "not-found", preflightId: query.preflightId };
			}
			return this.receipt.requestFingerprint === query.requestFingerprint
				? { status: "found", receipt: this.receipt }
				: { status: "mismatched", preflightId: query.preflightId };
		}
		if (method === "read_project") {
			if (!this.receipt || this.receipt.result.status !== "validated") {
				throw new Error("validated receipt required for readback");
			}
			const { source } = this.receipt.result.evaluation;
			return {
				projectId: source.projectId,
				sceneId: this.receipt.result.evaluation.before.project.activeSceneId,
				revision: this.currentRevision ?? source.sessionRevision,
				contentIdentity: {
					status: "hashed",
					hash: { projectionVersion: 2, digest: source.canonicalProjectHash },
				},
			};
		}
		if (method === "verify_edit_plan_preflight_source") {
			return { status: "verified", observation: {} };
		}
		if (method !== "preflight_edit_plan")
			throw new Error(`unexpected ${method}`);
		const enrichedRequest = params as PreflightEditPlanInput & {
			capabilitySnapshot?: unknown;
		};
		const { capabilitySnapshot, ...request } = enrichedRequest;
		this.capabilitySnapshot = capabilitySnapshot ?? null;
		this.evaluations += 1;
		const result = this.evaluate();
		this.receipt = this.buildReceipt(request, result);
		if (this.loseFirstResponse) {
			this.loseFirstResponse = false;
			throw new Error("injected browser response loss");
		}
		return result;
	}

	private buildReceipt(
		request: PreflightEditPlanInput,
		result: BrowserEditPlanPreflightResponse,
	) {
		const receipt = {
			id: request.preflightId,
			receiptVersion: 1 as const,
			preflightId: request.preflightId,
			requestFingerprint: preflightEditPlanRequestFingerprint(request),
			planFingerprint: editPlanFingerprint(request),
			source: {
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
			},
			result,
			recordedAt: "2026-09-02T20:00:00.000Z",
			checksum: "0".repeat(64),
		};
		receipt.checksum = browserEditPlanPreflightReceiptChecksum(receipt);
		return receipt;
	}
}

function input(): PreflightEditPlanInput {
	return {
		contractVersion: 2 as const,
		bridgeProtocolVersion: 2 as const,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
		},
		preflightId: "preflight-1",
		projectId: "project-1",
		sceneId: "scene-1",
		expectedRevision: 4,
		expectedProjectContentHash: "a".repeat(64),
		expectedWriteVersion: 3,
		saveReceiptOperationId: "save-op-1",
		expectedSaveReceiptId: "save:project-1:3",
		description: "delete a gap",
		operations: [
			{
				kind: "delete" as const,
				trackId: "track-1",
				elementId: "element-1",
				ripple: true,
				relationshipScope: "all" as const,
			},
		],
		policy: {
			warningPolicy: "allow" as const,
			providerExecution: "forbidden" as const,
			costPolicy: "require-exact" as const,
		},
	};
}

function validatedResponse(request: ReturnType<typeof input>) {
	const element = {
		type: "text" as const,
		order: 0,
		id: "element-1",
		name: "Caption",
		groupId: null,
		linkId: null,
		startTime: 0,
		duration: 120_000,
		trimStart: 0,
		trimEnd: 0,
		sourceDuration: null,
		params: {},
		animations: {},
		hidden: null,
		effects: [],
	};
	const before = {
		projection: "opencut-project-content" as const,
		projectionVersion: 1 as const,
		project: {
			name: "Project",
			activeSceneId: "scene-active",
			mainSceneId: "scene-1",
			settings: {
				background: { type: "color", color: "#000000" },
				canvasSize: { width: 1080, height: 1920 },
				fps: { numerator: 30, denominator: 1 },
			},
			scenes: [
				{
					order: 0,
					id: "scene-active",
					name: "Active",
					isMain: false,
					bookmarks: [],
					tracks: [],
				},
				{
					order: 1,
					id: "scene-1",
					name: "Main",
					isMain: true,
					bookmarks: [],
					tracks: [
						{
							role: "main",
							order: 0,
							id: "track-1",
							name: "Main",
							type: "text",
							muted: null,
							hidden: null,
							transitions: [],
							elements: [element],
						},
					],
				},
			],
		},
		mediaAssets: [],
	};
	const predictedAfter = structuredClone(before);
	predictedAfter.project.scenes[1]!.tracks[0]!.elements = [];
	request.expectedProjectContentHash = canonicalEditPlanSha256(before);
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
	const requirements = {
		hash: "9".repeat(64),
		editPlanReady: true,
		providerExecution: "forbidden" as const,
		cost: { status: "not-applicable" as const },
	};
	const evaluation: EditPlanEvaluation = {
		schemaVersion: "opencut.edit-plan-preflight.v2",
		source,
		planFingerprint: editPlanFingerprint(request),
		preflightFingerprint: "0".repeat(64),
		planDiffHash: "0".repeat(64),
		predictedProjectHash: canonicalEditPlanSha256(predictedAfter),
		beforeSummary: {
			canonicalHash: canonicalEditPlanSha256(before),
			trackCount: 1,
			elementCount: 1,
			transitionCount: 0,
			durationTicks: 120_000,
		},
		predictedAfterSummary: {
			canonicalHash: canonicalEditPlanSha256(predictedAfter),
			trackCount: 1,
			elementCount: 0,
			transitionCount: 0,
			durationTicks: 0,
		},
		before,
		predictedAfter,
		resolvedOperations: request.operations,
		resolvedIds: [],
		changedObjects: deriveProjectChangedObjects(
			before,
			predictedAfter,
			request.projectId,
		),
		timingConsequences: [
			{
				operationIndex: 0,
				elementId: "element-1",
				beforeStartTicks: 0,
				afterStartTicks: null,
				beforeDurationTicks: 120_000,
				afterDurationTicks: null,
			},
		],
		rippleExpansion: [],
		relationshipExpansion: [],
		warnings: [],
		requirements,
		cost: requirements.cost,
	};
	evaluation.preflightFingerprint = evaluationPreflightFingerprint(
		evaluation.planFingerprint,
		evaluation.source,
		evaluation.requirements,
		request.policy,
	);
	evaluation.planDiffHash = evaluationDiffHash(evaluation);
	const observation = {
		projectId: request.projectId,
		sceneId: request.sceneId,
		sessionRevision: request.expectedRevision,
		canonicalProjectHash: request.expectedProjectContentHash,
		durableWriteVersion: request.expectedWriteVersion,
		saveReceiptId: request.expectedSaveReceiptId,
		saveOperationId: request.saveReceiptOperationId,
		connectionIdentity: {
			...request.expectedConnectionIdentity,
			bridgeProtocolVersion: 2 as const,
		},
		activeProjectId: request.projectId,
		activeSceneId: "scene-active",
		playheadTicks: 0,
		isPlaying: false,
		selectionFingerprint: "1".repeat(64),
		historyFingerprint: "2".repeat(64),
		persistenceFingerprint: "3".repeat(64),
	};
	return {
		status: "validated" as const,
		preflightId: request.preflightId,
		evaluation,
		sourceObservation: observation,
		noMutationProof: {
			unchanged: true as const,
			before: observation,
			after: observation,
		},
	};
}
