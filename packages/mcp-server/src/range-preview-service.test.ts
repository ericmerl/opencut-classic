import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { McpOperationExecutionContext } from "./mcp-ledger-boundary";
import { RangePreviewEvidenceStore } from "./range-preview-evidence-store";
import {
	RangePreviewService,
	semanticPreviewRangeInputHash,
	type RenderPreviewRangeInput,
} from "./range-preview-service";

describe("RangePreviewService", () => {
	let directory: string;
	let store: RangePreviewEvidenceStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-range-service-test-"));
		store = new RangePreviewEvidenceStore(directory, 32191, limits);
		await store.readiness();
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("captures one capability snapshot, finalizes verified frames, and replays", async () => {
		let browserCalls = 0;
		let capabilityCalls = 0;
		const bridge = {
			request: async (_method: string, params: unknown) => {
				browserCalls++;
				const request = params as RenderPreviewRangeInput & { baseUrl: string };
				const token = request.baseUrl.split("/").at(-1)!;
				const schedule = frameSchedule();
				await store.receive(token, "manifest", jsonRequest(schedule));
				const png = await sharp({
					create: { width: 16, height: 16, channels: 4, background: "#abcdef" },
				})
					.png()
					.toBuffer();
				await store.receive(token, "frames/0", putRequest(png));
				await store.receive(token, "frames/1", putRequest(png));
				return browserResult(request, schedule, "rendered");
			},
		};
		const service = new RangePreviewService(
			bridge as never,
			store,
			limits,
			async () => {
				capabilityCalls++;
				return capability();
			},
		);
		const rendered = await service.render(input(), context());
		expect(rendered).toMatchObject({
			status: "rendered",
			receiptId: "preview-range:range-1",
			execution: { status: "succeeded", completed: 2, total: 2 },
			frames: [{ ordinal: 0 }, { ordinal: 1 }],
		});
		const replay = await service.render(input(), context());
		expect(replay).toMatchObject({
			status: "replayed",
			checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect({ browserCalls, capabilityCalls }).toEqual({
			browserCalls: 1,
			capabilityCalls: 1,
		});
	});

	test("returns and persists terminal cancellation with partial verified artifacts", async () => {
		const bridge = {
			request: async (_method: string, params: unknown) => {
				const request = params as RenderPreviewRangeInput & { baseUrl: string };
				const token = request.baseUrl.split("/").at(-1)!;
				const schedule = frameSchedule();
				await store.receive(token, "manifest", jsonRequest(schedule));
				await store.cancel(request.operationId);
				return browserResult(request, schedule, "cancelled");
			},
		};
		const service = new RangePreviewService(
			bridge as never,
			store,
			limits,
			async () => capability(),
		);
		const result = await service.render(input(), context());
		expect(result).toMatchObject({
			status: "cancelled",
			execution: { status: "cancelled", completed: 0, total: 2 },
		});
	});

	test("rejects terminal evidence with a false source or renderer binding", async () => {
		const bridge = {
			request: async (_method: string, params: unknown) => {
				const request = params as RenderPreviewRangeInput & { baseUrl: string };
				const token = request.baseUrl.split("/").at(-1)!;
				const schedule = frameSchedule();
				await store.receive(token, "manifest", jsonRequest(schedule));
				const png = await sharp({
					create: {
						width: 16,
						height: 16,
						channels: 4,
						background: "#abcdef",
					},
				})
					.png()
					.toBuffer();
				await store.receive(token, "frames/0", putRequest(png));
				await store.receive(token, "frames/1", putRequest(png));
				return {
					...browserResult(request, schedule, "rendered"),
					editorState: { unchanged: false },
				};
			},
		};
		const service = new RangePreviewService(
			bridge as never,
			store,
			limits,
			async () => capability(),
		);
		await expect(service.render(input(), context())).rejects.toThrow(
			"incomplete or source-mismatched",
		);
		expect((await store.getByOperation("range-1"))?.execution.status).toBe(
			"failed",
		);
	});

	test("rejects unbound nested renderer and font provenance", async () => {
		const corruptions = [
			(result: ReturnType<typeof browserResult>) => ({
				...result,
				renderer: {
					...result.renderer,
					environment: { ...result.renderer.environment, browser: "spoofed" },
				},
			}),
			(result: ReturnType<typeof browserResult>) => ({
				...result,
				fontReadiness: {
					...result.fontReadiness,
					descriptorsSha256: "f".repeat(64),
				},
			}),
		];
		for (const [index, corrupt] of corruptions.entries()) {
			const operationInput = {
				...input(),
				operationId: `range-corrupt-${index}`,
			};
			const bridge = {
				request: async (_method: string, params: unknown) => {
					const request = params as RenderPreviewRangeInput & {
						baseUrl: string;
					};
					const token = request.baseUrl.split("/").at(-1)!;
					const schedule = frameSchedule();
					await store.receive(token, "manifest", jsonRequest(schedule));
					const png = await sharp({
						create: {
							width: 16,
							height: 16,
							channels: 4,
							background: "#abcdef",
						},
					})
						.png()
						.toBuffer();
					await store.receive(token, "frames/0", putRequest(png));
					await store.receive(token, "frames/1", putRequest(png));
					return corrupt(browserResult(request, schedule, "rendered"));
				},
			};
			const service = new RangePreviewService(
				bridge as never,
				store,
				limits,
				async () => capability(),
			);
			await expect(service.render(operationInput, context())).rejects.toThrow(
				/renderer provenance|font digest/,
			);
		}
	});

	test("recovery reuses the durable original capability binding", async () => {
		const request = input();
		const session = await store.createSession({
			operationId: request.operationId,
			inputFingerprint: "f".repeat(64),
			semanticInputHash: "e".repeat(64),
			projectId: request.projectId,
			sceneId: request.sceneId,
			revision: request.expectedRevision,
			contentHash: request.expectedProjectContentHash,
			writeVersion: request.expectedWriteVersion,
			saveReceiptId: request.expectedSaveReceiptId,
			includeAudio: false,
			canvasSize: request.canvasSize,
			capabilitySnapshotHash: "b".repeat(64),
			requiredWasmSha256: "c".repeat(64),
		});
		const token = session.baseUrl.split("/").at(-1)!;
		const schedule = frameSchedule();
		await store.receive(token, "manifest", jsonRequest(schedule));
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#abcdef" },
		})
			.png()
			.toBuffer();
		await store.receive(token, "frames/0", putRequest(png));
		await store.receive(token, "frames/1", putRequest(png));
		let capabilityCalls = 0;
		const service = new RangePreviewService(
			{} as never,
			store,
			limits,
			async () => {
				capabilityCalls++;
				return { snapshotHash: "changed" };
			},
		);
		const recovered = await service.recover(request, {
			...context(),
			recoverBrowserStep: async () =>
				browserResult(request, schedule, "rendered"),
		} as never);
		expect(recovered).toMatchObject({
			status: "rendered",
			capabilitySnapshotHash: "b".repeat(64),
			execution: { status: "succeeded" },
		});
		expect(capabilityCalls).toBe(0);
	});

	test("semantic input hashing ignores operation and connection transport identity", () => {
		const first = input();
		const second = {
			...first,
			operationId: "range-2",
			expectedConnectionIdentity: {
				...first.expectedConnectionIdentity,
				editorSessionId: "session-2",
				connectionGeneration: 2,
			},
		};
		expect(semanticPreviewRangeInputHash(first)).toBe(
			semanticPreviewRangeInputHash(second),
		);
		expect(semanticPreviewRangeInputHash(first)).toMatch(/^[a-f0-9]{64}$/);
	});
});

const limits = {
	maxDurationSeconds: 10,
	maxDurationTicks: 1_200_000,
	maxFrames: 300,
};

function input(): RenderPreviewRangeInput {
	return {
		contractVersion: 1,
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server-1",
			editorInstanceId: "editor-1",
			editorSessionId: "session-1",
			connectionGeneration: 1,
		},
		operationId: "range-1",
		projectId: "project-1",
		sceneId: "scene-1",
		expectedRevision: 2,
		expectedProjectContentHash: "a".repeat(64),
		expectedWriteVersion: 3,
		saveReceiptOperationId: "save-1",
		expectedSaveReceiptId: "save:1",
		range: {
			kind: "frame-index",
			startFrameIndex: 0,
			endFrameIndexExclusive: 2,
		},
		canvasSize: { width: 16, height: 16 },
		output: { kind: "frame-sequence", frameFormat: "png", includeAudio: false },
	};
}

function capability() {
	return {
		snapshotHash: "b".repeat(64),
		renderer: { wasm: { sha256: "c".repeat(64) } },
	};
}

function frameSchedule() {
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
			endFrameIndexExclusive: 2,
		},
		frameCount: 2,
		requestedDurationTicks: 8_000,
		resolvedStartTicks: 0,
		resolvedEndTicksExclusive: 8_000,
		startFrameIndex: 0,
		endFrameIndexExclusive: 2,
		scheduledDurationTicks: 8_000,
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
			{
				ordinal: 1,
				frameIndex: 1,
				timelineTicks: 4_000,
				outputTicks: 4_000,
				durationTicks: 4_000,
			},
		],
	};
}

function browserResult(
	request: RenderPreviewRangeInput,
	schedule: ReturnType<typeof frameSchedule>,
	status: "rendered" | "cancelled",
) {
	return {
		status,
		contractVersion: 1,
		operationId: request.operationId,
		projectId: request.projectId,
		sceneId: request.sceneId,
		revision: request.expectedRevision,
		writeVersion: request.expectedWriteVersion,
		saveReceiptId: request.expectedSaveReceiptId,
		saveReceiptOperationId: request.saveReceiptOperationId,
		capabilitySnapshotHash: "b".repeat(64),
		contentIdentity: {
			status: "hashed",
			hash: { digest: request.expectedProjectContentHash },
		},
		renderer: {
			provider: "opencut-web-renderer",
			pipeline: "editor-native-exact-frame-sequence",
			compositor: "opencut-wasm-webgl",
			browser: "test",
			encoder: "browser-canvas-png-sequence",
			environment: {
				status: "ready",
				reason: null,
				compositor: "opencut-wasm-webgl",
				backend: "webgpu",
				pinnedBackend: "webgpu",
				backendMatchesPin: true,
				rendererClass: "unknown",
				adapterMatchesClass: null,
				adapter: {
					vendor: "test-vendor",
					architecture: "test-architecture",
					device: "test-device",
					description: "test-adapter",
					isFallbackAdapter: null,
				},
				surfaceFormat: "bgra8unorm",
				browser: "test",
				wasmPackageVersion: "0.1.0",
				capabilitySnapshotHash: "b".repeat(64),
				wasmSha256: "c".repeat(64),
			},
			executionIdentity: request.expectedConnectionIdentity,
		},
		fontReadiness: {
			status: "ready",
			families: [],
			descriptors: [],
			descriptorsSha256: createHash("sha256").update("[]").digest("hex"),
		},
		editorState: { unchanged: true },
		sourceVerification: {
			revisionBefore: request.expectedRevision,
			revisionAfter: request.expectedRevision,
			contentHashBefore: request.expectedProjectContentHash,
			contentHashAfter: request.expectedProjectContentHash,
		},
		saveReceipt: {
			receiptId: request.expectedSaveReceiptId,
			operationId: request.saveReceiptOperationId,
			projectId: request.projectId,
			sceneId: request.sceneId,
			revision: request.expectedRevision,
			contentHash: request.expectedProjectContentHash,
			readbackContentHash: request.expectedProjectContentHash,
			writeVersion: request.expectedWriteVersion,
			reloadVerified: true,
		},
		schedule,
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

function jsonRequest(value: unknown) {
	return new Request("http://localhost", {
		method: "PUT",
		body: JSON.stringify(value),
	});
}

function putRequest(value: Uint8Array) {
	const copy = new Uint8Array(value.byteLength);
	copy.set(value);
	return new Request("http://localhost", {
		method: "PUT",
		body: new Blob([copy.buffer]),
	});
}
