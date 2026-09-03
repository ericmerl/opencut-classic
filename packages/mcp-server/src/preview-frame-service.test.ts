import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PreviewEvidenceStore } from "./preview-evidence-store";
import {
	PreviewFrameService,
	type RenderPreviewFrameInput,
} from "./preview-frame-service";
import type { McpOperationExecutionContext } from "./mcp-ledger-boundary";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe("preview frame response-loss recovery", () => {
	test("finalizes a committed browser receipt after response loss without rerendering", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-preview-service-"));
		directories.push(directory);
		const store = new PreviewEvidenceStore(directory, 32191);
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#336699" },
		})
			.png()
			.toBuffer();
		let invocations = 0;
		let snapshotHash = "c".repeat(64);
		let wasmSha256 = "d".repeat(64);
		const durableBrowserResult: {
			current: ReturnType<typeof browserResult> | null;
		} = { current: null };
		const bridge = {
			request: async (_method: string, params: unknown) => {
				invocations += 1;
				const request = params as RenderPreviewFrameInput & { url: string };
				const id = new URL(request.url).pathname.split("/").at(-1)!;
				const uploaded = await store.receive(
					id,
					new Request(request.url, {
						method: "PUT",
						headers: { "Content-Type": "image/png" },
						body: requestBody(png),
					}),
				);
				const upload = (await store.uploadIdentity(request.operationId))!;
				durableBrowserResult.current = browserResult(
					request,
					uploaded,
					upload.pixel_rgba_sha256,
				);
				throw new Error("simulated socket response loss");
			},
		};
		const service = new PreviewFrameService(
			bridge as never,
			store,
			async () => ({
				snapshotHash,
				renderer: { wasm: { sha256: wasmSha256 } },
			}),
		);
		const input = previewInput();
		await expect(service.render(input, context(null))).rejects.toThrow(
			"response loss",
		);
		expect(invocations).toBe(1);
		const committedBrowserResult = durableBrowserResult.current;
		if (!committedBrowserResult)
			throw new Error("browser terminal receipt was not captured");
		snapshotHash = "e".repeat(64);
		wasmSha256 = "f".repeat(64);
		const mismatchedSaveOperation = {
			...committedBrowserResult,
			saveReceipt: {
				...committedBrowserResult.saveReceipt,
				operationId: "different-save-operation",
			},
		};
		await expect(
			service.recover(input, context(mismatchedSaveOperation)),
		).rejects.toThrow("source-mismatched");
		expect(await store.getByOperation(input.operationId)).toBeNull();
		const recovered = await service.recover(
			input,
			context(committedBrowserResult),
		);
		expect(recovered).toMatchObject({
			status: "rendered",
			operationId: input.operationId,
			renderer: {
				capabilityHash: "c".repeat(64),
				environment: {
					wasmSha256: "d".repeat(64),
					fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
		});
		store.close();

		const restartedStore = new PreviewEvidenceStore(directory, 32191);
		const replay = await new PreviewFrameService(
			bridge as never,
			restartedStore,
		).render(input, context(null));
		expect(replay).toMatchObject({
			status: "replayed",
			sha256: recovered?.sha256,
		});
		expect(invocations).toBe(1);
		restartedStore.close();
	});

	test("does not rerender when upload committed but no browser terminal receipt exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-preview-service-"));
		directories.push(directory);
		const store = new PreviewEvidenceStore(directory, 32191);
		let invocations = 0;
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#000" },
		})
			.png()
			.toBuffer();
		const bridge = {
			request: async (_method: string, params: unknown) => {
				invocations += 1;
				const request = params as RenderPreviewFrameInput & { url: string };
				const id = new URL(request.url).pathname.split("/").at(-1)!;
				await store.receive(
					id,
					new Request(request.url, {
						method: "PUT",
						headers: { "Content-Type": "image/png" },
						body: requestBody(png),
					}),
				);
				throw new Error("simulated hard kill before browser terminal receipt");
			},
		};
		const service = new PreviewFrameService(bridge as never, store);
		const input = previewInput();
		await expect(service.render(input, context(null))).rejects.toThrow(
			"hard kill",
		);
		expect(await service.recover(input, context(null))).toBeNull();
		expect(invocations).toBe(1);
		store.close();
	});
});

function context(
	recovered: Record<string, unknown> | null,
): McpOperationExecutionContext {
	return {
		prepareBrowserMutation: async (_method, request) => request,
		prepareBrowserStep: async (_method, request) => request,
		recoverBrowserStep: async () => recovered,
		record: () => ({}) as never,
		checkpoint: async () => ({}) as never,
	};
}

function previewInput(): RenderPreviewFrameInput {
	return {
		contractVersion: 2,
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "server",
			editorInstanceId: "editor",
			editorSessionId: "session",
			connectionGeneration: 1,
		},
		operationId: "preview-operation",
		projectId: "project-1",
		sceneId: "scene-1",
		expectedRevision: 3,
		expectedProjectContentHash: "a".repeat(64),
		expectedWriteVersion: 7,
		saveReceiptOperationId: "save-operation",
		expectedSaveReceiptId: "save:project-1:7",
		time: { kind: "frame-index", frameIndex: 0 },
		canvasSize: { width: 16, height: 16 },
		format: "png",
	};
}

function browserResult(
	input: RenderPreviewFrameInput,
	uploaded: { bytesWritten: number; sha256: string },
	pixelRgbaSha256: string,
) {
	const timestamp = new Date().toISOString();
	return {
		status: "rendered",
		operationId: input.operationId,
		projectId: input.projectId,
		sceneId: input.sceneId,
		revision: input.expectedRevision,
		writeVersion: input.expectedWriteVersion,
		saveReceiptId: input.expectedSaveReceiptId,
		saveReceiptOperationId: input.saveReceiptOperationId,
		requestedTicks: 0,
		resolvedTicks: 0,
		frameIndex: 0,
		ticksPerFrame: 4_000,
		fps: { numerator: 30, denominator: 1 },
		rounding: "exact",
		width: 16,
		height: 16,
		bytesWritten: uploaded.bytesWritten,
		sha256: uploaded.sha256,
		pixelRgbaSha256,
		saveReceipt: {
			status: "saved",
			receiptId: input.expectedSaveReceiptId,
			operationId: input.saveReceiptOperationId,
			projectId: input.projectId,
			sceneId: input.sceneId,
			revision: input.expectedRevision,
			contentHash: input.expectedProjectContentHash,
			persistedAt: timestamp,
			completedAt: timestamp,
			storageSchemaVersion: 1,
			writeVersion: input.expectedWriteVersion,
			reloadVerified: true,
			readbackContentHash: input.expectedProjectContentHash,
		},
		renderer: {
			provider: "opencut-web-renderer",
			pipeline: "editor-native-exact-frame",
			compositor: "opencut-wasm-webgl",
			browser: "test",
			encoder: "browser-canvas-png",
			environment: {
				...renderEnvironment(),
				...(input.capabilitySnapshotHash
					? { capabilitySnapshotHash: input.capabilitySnapshotHash }
					: {}),
				...(input.wasmSha256 ? { wasmSha256: input.wasmSha256 } : {}),
			},
			executionIdentity: input.expectedConnectionIdentity,
		},
		fontReadiness: {
			status: "ready",
			families: [],
			descriptors: [],
			descriptorsSha256: createHash("sha256").update("[]").digest("hex"),
		},
		editorState: {
			unchanged: true,
			playheadTicks: 0,
			isPlaying: false,
			selectionFingerprint: "{}",
			canUndo: false,
			canRedo: false,
		},
		sourceVerification: {
			revisionBefore: input.expectedRevision,
			revisionAfter: input.expectedRevision,
			contentHashBefore: input.expectedProjectContentHash,
			contentHashAfter: input.expectedProjectContentHash,
		},
	};
}

function renderEnvironment() {
	return {
		status: "ready" as const,
		reason: null,
		compositor: "opencut-wasm-webgl" as const,
		backend: "webgpu" as const,
		pinnedBackend: "webgpu" as const,
		backendMatchesPin: true,
		rendererClass: "software" as const,
		adapterMatchesClass: true,
		adapter: {
			vendor: "Google",
			architecture: "swiftshader",
			device: "SwiftShader Device",
			description: "SwiftShader",
			isFallbackAdapter: true,
		},
		surfaceFormat: "bgra8unorm" as const,
		browser: "test",
		wasmPackageVersion: "0.2.10",
	};
}

function requestBody(bytes: Buffer): Uint8Array<ArrayBuffer> {
	const body = new Uint8Array(bytes.byteLength);
	body.set(bytes);
	return body;
}
