import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ExportProjectService,
	type ExportProjectBridge,
	type ExportProjectInput,
} from "./export-project";
import { ExportReceiptStore } from "./export-receipts";
import type { ExportValidator } from "./export-validator";
import {
	BridgeProtocolError,
	type BridgeConnectionIdentity,
} from "./editor-bridge";

describe("ExportProjectService", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-export-service-test-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("persists validation and replays it across service instances", async () => {
		let requestCount = 0;
		let verifyCount = 0;
		let exportRequest: unknown;
		let validationRequest: unknown;
		const bridge: ExportProjectBridge = {
			exportTickets: {
				async create(path) {
					return { url: "http://127.0.0.1/export/fixture", outputPath: path };
				},
			},
			async request(method, params) {
				requestCount += 1;
				if (method === "read_project") {
					return {
						projectId: "project-1",
						sceneId: "scene-1",
						revision: 2,
						settings: {
							canvasSize: { width: 1080, height: 1920 },
							fps: { numerator: 30, denominator: 1 },
						},
					};
				}
				if (method === "save_project") {
					return verifiedSave("b");
				}
				if (method === "export_project") {
					exportRequest = params;
					return {
						status: "exported",
						operationId: "export-1",
						projectId: "project-1",
						sceneId: "scene-1",
						revision: 2,
						outputPath: join(directory, "video.mp4"),
						bytesWritten: 123,
						sha256: "a".repeat(64),
						contentIdentity: hashedContentIdentity("b"),
					};
				}
				throw new Error(`unexpected method: ${method}`);
			},
		};
		const validator = {
			async preflight() {},
			async validate(input: Parameters<ExportValidator["validate"]>[0]) {
				validationRequest = input;
				return {
					status: "validated" as const,
					validatedAt: "2026-09-01T00:00:00.000Z",
					fullDecode: true as const,
					formatName: "mov,mp4",
					durationSeconds: 1,
					video: { codec: "h264", width: 1080, height: 1080, fps: 30 },
					audio: {
						present: true,
						codec: "aac",
						sampleRate: 48000,
						channels: 2,
						channelLayout: "stereo",
					},
					frameSamples: [],
				};
			},
			async verifyOutput() {
				verifyCount += 1;
			},
		} as unknown as ExportValidator;
		const receipts = new ExportReceiptStore(join(directory, "receipts"));

		const first = await new ExportProjectService(
			bridge,
			receipts,
			validator,
		).export(input(directory));
		const replay = await new ExportProjectService(
			bridge,
			new ExportReceiptStore(join(directory, "receipts")),
			validator,
		).export(input(directory));

		expect(first).toMatchObject({
			status: "exported",
			validation: { status: "validated", fullDecode: true },
			inspection: { status: "pending", outputSha256: "a".repeat(64) },
		});
		expect(replay).toMatchObject({ status: "replayed", replayed: true });
		expect(requestCount).toBe(3);
		expect(verifyCount).toBe(2);
		expect(exportRequest).toMatchObject({
			canvasSize: { width: 1080, height: 1080 },
		});
		expect(validationRequest).toMatchObject({
			expectedWidth: 1080,
			expectedHeight: 1080,
		});
	});

	test("rejects stale v2 affinity before the automatic project read", async () => {
		const expectedIdentity = identity("editor-1");
		const actualIdentity = identity("editor-2");
		let readStarted = false;
		let ticketsCreated = 0;
		const bridge: ExportProjectBridge = {
			exportTickets: {
				async create(path) {
					ticketsCreated += 1;
					return { url: "http://fixture", outputPath: path };
				},
			},
			async request(_method, _params, _timeout, requestIdentity) {
				if (
					requestIdentity?.editorInstanceId !== actualIdentity.editorInstanceId
				) {
					throw new BridgeProtocolError(
						"STALE_CONNECTION",
						"Editor connection identity changed before request dispatch",
					);
				}
				readStarted = true;
				return {};
			},
		};
		const validator = {
			preflight: async () => undefined,
			verifyOutput: async () => undefined,
			validate: async () => {
				throw new Error("validation should not run");
			},
		} as unknown as ExportValidator;
		const service = new ExportProjectService(
			bridge,
			new ExportReceiptStore(join(directory, "stale-receipts")),
			validator,
		);

		await expect(
			service.export({
				...input(directory),
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: expectedIdentity,
			}),
		).rejects.toMatchObject({ code: "STALE_CONNECTION" });
		expect(readStarted).toBe(false);
		expect(ticketsCreated).toBe(0);
	});

	test("blocks v2 export before ticket creation when content identity is incomplete", async () => {
		const connectionIdentity = identity("editor-1");
		let ticketsCreated = 0;
		const bridge: ExportProjectBridge = {
			exportTickets: {
				async create(path) {
					ticketsCreated += 1;
					return { url: "http://fixture", outputPath: path };
				},
			},
			async request() {
				return {
					projectId: "project-1",
					sceneId: "scene-1",
					revision: 2,
					settings: {
						canvasSize: { width: 1080, height: 1920 },
						fps: { numerator: 30, denominator: 1 },
					},
					contentIdentity: {
						status: "blocked",
						blockers: [{ code: "unverified-url-media" }],
					},
				};
			},
		};
		const service = new ExportProjectService(
			bridge,
			new ExportReceiptStore(join(directory, "blocked-receipts")),
			{
				preflight: async () => undefined,
				verifyOutput: async () => undefined,
				validate: async () => {
					throw new Error("validation should not run");
				},
			} as unknown as ExportValidator,
		);
		const result = await service.export({
			...input(directory),
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: connectionIdentity,
		});
		expect(result).toMatchObject({
			status: "content-identity-blocked",
			contentIdentity: { status: "blocked" },
		});
		expect(ticketsCreated).toBe(0);
	});

	test("rejects a project hash change during rendering", async () => {
		const connectionIdentity = identity("editor-1");
		let requestCount = 0;
		const bridge: ExportProjectBridge = {
			exportTickets: {
				async create(path) {
					return { url: "http://fixture", outputPath: path };
				},
			},
			async request(method) {
				requestCount += 1;
				if (method === "read_project") {
					return {
						projectId: "project-1",
						sceneId: "scene-1",
						revision: 2,
						settings: {
							canvasSize: { width: 1080, height: 1920 },
							fps: { numerator: 30, denominator: 1 },
						},
						contentIdentity: hashedContentIdentity("b"),
					};
				}
				if (method === "save_project") return verifiedSave("b");
				return {
					status: "exported",
					outputPath: join(directory, "video.mp4"),
					bytesWritten: 1,
					sha256: "a".repeat(64),
					contentIdentity: hashedContentIdentity("c"),
				};
			},
		};
		const service = new ExportProjectService(
			bridge,
			new ExportReceiptStore(join(directory, "mid-render-receipts")),
			{
				preflight: async () => undefined,
				verifyOutput: async () => undefined,
				validate: async () => {
					throw new Error("validation should not run");
				},
			} as unknown as ExportValidator,
		);
		const result = await service.export({
			...input(directory),
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: connectionIdentity,
		});
		expect(result).toMatchObject({
			status: "content-hash-conflict",
			expectedProjectContentHash: "b".repeat(64),
			actualProjectContentHash: "c".repeat(64),
		});
		expect(requestCount).toBe(3);
	});

	test("preserves the immutable envelope on project mismatch and revision conflict", async () => {
		const connectionIdentity = identity("editor-1");
		const bridge: ExportProjectBridge = {
			exportTickets: {
				async create(path) {
					return { url: "http://fixture", outputPath: path };
				},
			},
			async request() {
				return {
					projectId: "active-project",
					sceneId: "scene-1",
					revision: 4,
					bridgeProtocolVersion: 2,
					connectionIdentity,
					requestConnectionIdentity: connectionIdentity,
					contentIdentity: hashedContentIdentity(),
					settings: {
						canvasSize: { width: 1080, height: 1920 },
						fps: { numerator: 30, denominator: 1 },
					},
				};
			},
		};
		const validator = {
			preflight: async () => undefined,
			verifyOutput: async () => undefined,
			validate: async () => {
				throw new Error("validation should not run");
			},
		} as unknown as ExportValidator;
		const service = new ExportProjectService(
			bridge,
			new ExportReceiptStore(join(directory, "terminal-receipts")),
			validator,
		);
		const mismatch = await service.export({
			...input(directory),
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: connectionIdentity,
		});
		const conflict = await service.export({
			...input(directory),
			projectId: "active-project",
			operationId: "export-conflict",
			expectedRevision: 3,
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: connectionIdentity,
		});

		for (const result of [mismatch, conflict]) {
			expect(result).toMatchObject({
				sceneId: "scene-1",
				bridgeProtocolVersion: 2,
				connectionIdentity,
				requestConnectionIdentity: connectionIdentity,
			});
		}
		expect(mismatch).toMatchObject({
			status: "rejected",
			projectId: "project-1",
			activeProjectId: "active-project",
		});
		expect(conflict).toMatchObject({
			status: "conflict",
			projectId: "active-project",
			expectedRevision: 3,
			actualRevision: 4,
		});
	});
});

function input(directory: string): ExportProjectInput {
	return {
		projectId: "project-1",
		operationId: "export-1",
		expectedRevision: 2,
		outputPath: join(directory, "video.mp4"),
		format: "mp4",
		quality: "high",
		includeAudio: true,
		canvasSize: { width: 1080, height: 1080 },
	};
}

function identity(editorInstanceId: string): BridgeConnectionIdentity {
	return {
		serverInstanceId: "server-1",
		editorInstanceId,
		editorSessionId: "session-1",
		connectionGeneration: 1,
	};
}

function hashedContentIdentity(seed = "b") {
	return {
		status: "hashed" as const,
		hash: {
			algorithm: "SHA-256" as const,
			projection: "opencut-project-content",
			projectionVersion: 1,
			digest: seed.repeat(64),
		},
	};
}

function verifiedSave(seed = "b") {
	return {
		status: "saved",
		receiptId: "save-receipt-1",
		contentHash: seed.repeat(64),
		reloadVerified: true,
	};
}
