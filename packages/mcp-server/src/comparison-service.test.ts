import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { McpOperationExecutionContext } from "./mcp-ledger-boundary";
import {
	ComparisonEvidenceStore,
	type ComparisonNativeAdapter,
} from "./comparison-evidence-store";
import {
	ComparisonService,
	semanticComparisonInputHash,
	type CompareProjectStatesInput,
} from "./comparison-service";

describe("ComparisonService", () => {
	let directory: string;
	let store: ComparisonEvidenceStore;

	beforeEach(async () => {
		directory = await mkdtemp(
			join(tmpdir(), "opencut-comparison-service-test-"),
		);
		store = new ComparisonEvidenceStore(directory, 32191, limits, native);
		await store.readiness();
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("captures capability once, validates two immutable sources, and replays", async () => {
		let browserCalls = 0;
		let capabilityCalls = 0;
		const bridge = {
			request: async (method: string, params: unknown) => {
				expect(method).toBe("compare_project_states");
				browserCalls++;
				const request = params as CompareProjectStatesInput & {
					beforeBaseUrl: string;
					afterBaseUrl: string;
				};
				await upload(store, request.beforeBaseUrl, "#000000");
				await upload(store, request.afterBaseUrl, "#ffffff");
				return browserResult(request);
			},
		};
		const service = new ComparisonService(
			bridge as never,
			store,
			limits,
			async () => {
				capabilityCalls++;
				return capability();
			},
		);
		const rendered = await service.compare(input(), context());
		expect(rendered).toMatchObject({
			status: "rendered",
			receiptId: "comparison:compare-1",
			execution: { status: "succeeded" },
		});
		const replay = await service.compare(input(), context());
		expect(replay).toMatchObject({ status: "replayed" });
		expect({ browserCalls, capabilityCalls }).toEqual({
			browserCalls: 1,
			capabilityCalls: 1,
		});
	});

	test("fails closed when a browser side does not match its save receipt binding", async () => {
		const request = input();
		const bridge = {
			request: async (_method: string, params: unknown) => {
				const browserRequest = params as CompareProjectStatesInput & {
					beforeBaseUrl: string;
					afterBaseUrl: string;
				};
				await upload(store, browserRequest.beforeBaseUrl, "#000000");
				await upload(store, browserRequest.afterBaseUrl, "#ffffff");
				const result = browserResult(browserRequest);
				return {
					...result,
					before: {
						...result.before,
						binding: { ...result.before.binding, revision: 999 },
					},
				};
			},
		};
		const service = new ComparisonService(
			bridge as never,
			store,
			limits,
			async () => capability(),
		);
		await expect(service.compare(request, context())).rejects.toThrow(
			"immutable source binding",
		);
		expect(
			(await store.getByOperation(request.operationId))?.execution.status,
		).toBe("failed");
	});

	test("rejects comparison evidence from an unpinned renderer build", async () => {
		const request = input();
		const bridge = {
			request: async (_method: string, params: unknown) => {
				const browserRequest = params as CompareProjectStatesInput & {
					beforeBaseUrl: string;
					afterBaseUrl: string;
				};
				await upload(store, browserRequest.beforeBaseUrl, "#000000");
				await upload(store, browserRequest.afterBaseUrl, "#ffffff");
				const result = browserResult(browserRequest);
				return {
					...result,
					renderer: {
						...result.renderer,
						environment: {
							...result.renderer.environment,
							wasmSha256: "f".repeat(64),
						},
					},
				};
			},
		};
		const service = new ComparisonService(
			bridge as never,
			store,
			limits,
			async () => capability(),
		);
		await expect(service.compare(request, context())).rejects.toThrow(
			"renderer",
		);
		expect(
			(await store.getByOperation(request.operationId))?.execution.status,
		).toBe("failed");
	});

	test("recovers from the captured browser result without recapturing capabilities", async () => {
		const request = input();
		const session = await store.createSession({
			operationId: request.operationId,
			inputFingerprint: "a".repeat(64),
			semanticInputHash: semanticComparisonInputHash(request),
			capabilitySnapshotHash: "c".repeat(64),
			requiredWasmSha256: "d".repeat(64),
			projectId: request.projectId,
			sceneId: request.sceneId,
			before: request.before,
			after: request.after,
			range: request.range,
			canvasSize: request.canvasSize,
			normalization: request.normalization,
			output: request.output,
			pixelTolerance: request.pixelTolerance,
			audioSampleTolerance: request.audioSampleTolerance,
		});
		await upload(store, session.beforeBaseUrl, "#000000");
		await upload(store, session.afterBaseUrl, "#ffffff");
		let capabilityCalls = 0;
		const service = new ComparisonService(
			{} as never,
			store,
			limits,
			async () => {
				capabilityCalls++;
				return capability();
			},
		);
		const recovered = await service.recover(request, {
			...context(),
			recoverBrowserStep: async () =>
				browserResult({ ...request, capabilitySnapshotHash: "c".repeat(64) }),
		} as never);
		expect(recovered).toMatchObject({
			status: "rendered",
			execution: { status: "succeeded" },
		});
		expect(capabilityCalls).toBe(0);
	});

	test("returns a typed unavailable historical-source blocker and terminalizes the job", async () => {
		const service = new ComparisonService(
			{
				request: async () => ({
					status: "rejected",
					operationId: "compare-1",
					code: "COMPARISON_SOURCE_UNAVAILABLE",
					reason: "retained source expired",
				}),
			} as never,
			store,
			limits,
			async () => capability(),
		);
		await expect(service.compare(input(), context())).resolves.toEqual({
			status: "rejected",
			operationId: "compare-1",
			code: "COMPARISON_SOURCE_UNAVAILABLE",
			reason: "retained source expired",
		});
		expect((await store.getByOperation("compare-1"))?.execution.status).toBe(
			"failed",
		);
	});

	test("semantic identity excludes operation and connection transport identity", () => {
		const first = input();
		const second = {
			...first,
			operationId: "compare-2",
			expectedConnectionIdentity: {
				...first.expectedConnectionIdentity,
				editorSessionId: "other-session",
				connectionGeneration: 2,
			},
		};
		expect(semanticComparisonInputHash(first)).toBe(
			semanticComparisonInputHash(second),
		);
	});
});

const limits = {
	maxDurationSeconds: 10,
	maxDurationTicks: 1_200_000,
	maxFrames: 300,
};

const native: ComparisonNativeAdapter = {
	compareRgba: ({ before, width, height }) => ({
		metrics: { totalPixels: width * height, changedPixels: width * height },
		regions: { items: [{ x: 0, y: 0, width, height }] },
		diffRgba: before,
	}),
	composeRgba: ({ before, width, height }) => ({ width, height, rgba: before }),
	aggregateFrameMetrics: (metrics) => ({ frameCount: metrics.length }),
	comparePcmI16: () => ({ changed: false }),
};

function input(): CompareProjectStatesInput {
	return {
		contractVersion: 1,
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
		},
		operationId: "compare-1",
		projectId: "project-1",
		sceneId: "scene-1",
		before: source("before", 1),
		after: source("after", 2),
		range: {
			kind: "frame-index",
			startFrameIndex: 0,
			endFrameIndexExclusive: 1,
		},
		canvasSize: { width: 16, height: 16 },
		normalization: {
			canvas: "none",
			color: "none",
			fonts: "exact",
			timing: "shared-schedule",
		},
		output: {
			frameFormat: "png",
			comparison: "side-by-side",
			includeAudio: false,
		},
		pixelTolerance: 4,
		audioSampleTolerance: 16,
	};
}

function source(name: "before" | "after", revision: number) {
	return {
		revision,
		projectContentHash: (name === "before" ? "1" : "2").repeat(64),
		projectionName: "opencut-project-content" as const,
		projectionVersion: 2 as const,
		writeVersion: revision,
		saveReceiptOperationId: `save-${name}`,
		saveReceiptId: `save:${name}`,
	};
}

function capability() {
	return {
		snapshotHash: "c".repeat(64),
		renderer: { wasm: { sha256: "d".repeat(64) } },
	};
}

async function upload(
	store: ComparisonEvidenceStore,
	baseUrl: string,
	color: string,
) {
	const token = baseUrl.split("/").at(-1)!;
	await store.receiveCapture(
		token,
		"manifest",
		new Request("http://localhost", {
			method: "PUT",
			body: JSON.stringify(schedule()),
		}),
	);
	const png = await sharp({
		create: { width: 16, height: 16, channels: 4, background: color },
	})
		.png()
		.toBuffer();
	await store.receiveCapture(
		token,
		"frames/0",
		new Request("http://localhost", {
			method: "PUT",
			body: new Blob([new Uint8Array(png).buffer]),
		}),
	);
}

function schedule() {
	return {
		schemaVersion: "opencut.frame-range-schedule.v1",
		sceneDurationTicks: 1_200_000,
		ticksPerSecond: 120_000,
		ticksPerFrame: 4_000,
		rate: { numerator: 30, denominator: 1 },
		endpointPolicy: "start-inclusive-end-exclusive",
		requestedRange: {
			kind: "frame-index",
			startFrameIndex: 0,
			endFrameIndexExclusive: 1,
		},
		frameCount: 1,
		requestedDurationTicks: 4_000,
		resolvedStartTicks: 0,
		resolvedEndTicksExclusive: 4_000,
		startFrameIndex: 0,
		endFrameIndexExclusive: 1,
		scheduledDurationTicks: 4_000,
		policy: {
			outputCadence: "constant-frame-rate",
			outputFrames: "contiguous-once-fail-on-missing",
			sourceSampling: "presentation-interval-containing-mapped-time",
			unavailableSourceFrame: "fail-range",
		},
		frames: [
			{
				ordinal: 0,
				frameIndex: 0,
				timelineTicks: 0,
				outputTicks: 0,
				durationTicks: 4_000,
			},
		],
	};
}

function browserResult(
	request: CompareProjectStatesInput & { capabilitySnapshotHash?: string },
) {
	const sharedSchedule = schedule();
	return {
		status: "rendered" as const,
		contractVersion: 1,
		operationId: request.operationId,
		projectId: request.projectId,
		sceneId: request.sceneId,
		capabilitySnapshotHash: request.capabilitySnapshotHash ?? "c".repeat(64),
		normalization: request.normalization,
		schedule: sharedSchedule,
		before: side(request, request.before, sharedSchedule),
		after: side(request, request.after, sharedSchedule),
		renderer: {
			provider: "opencut-web-renderer",
			pipeline: "editor-native-before-after-comparison",
			compositor: "opencut-wasm-webgl",
			encoder: "browser-canvas-png-sequence",
			environment: {
				status: "ready",
				capabilitySnapshotHash:
					request.capabilitySnapshotHash ?? "c".repeat(64),
				rendererSettingsDigest: "e".repeat(64),
				wasmSha256: "d".repeat(64),
			},
			executionIdentity: request.expectedConnectionIdentity,
		},
		editorState: { unchanged: true },
	};
}

function side(
	request: CompareProjectStatesInput,
	binding: CompareProjectStatesInput["before"],
	sharedSchedule: ReturnType<typeof schedule>,
) {
	return {
		projectId: request.projectId,
		sceneId: request.sceneId,
		binding,
		schedule: sharedSchedule,
		renderSource: {
			canvas: request.canvasSize,
			rate: { numerator: 30, denominator: 1 },
			sceneDurationTicks: 1_200_000,
			rendererSettingsDigest: "e".repeat(64),
		},
		fontReadiness: { status: "ready", substituted: false },
		saveReceipt: {
			receiptId: binding.saveReceiptId,
			operationId: binding.saveReceiptOperationId,
			projectId: request.projectId,
			sceneId: request.sceneId,
			revision: binding.revision,
			contentHash: binding.projectContentHash,
			readbackContentHash: binding.projectContentHash,
			writeVersion: binding.writeVersion,
			reloadVerified: true,
		},
	};
}

function context() {
	return {
		checkpoint: async () => ({}) as never,
		prepareBrowserStep: async (
			_method: string,
			request: Record<string, unknown>,
		) => request,
		recoverBrowserStep: async () => null,
	} as unknown as McpOperationExecutionContext;
}
