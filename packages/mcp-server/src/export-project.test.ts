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
						revision: 2,
						settings: {
							canvasSize: { width: 1080, height: 1920 },
							fps: { numerator: 30, denominator: 1 },
						},
					};
				}
				if (method === "export_project") {
					exportRequest = params;
					return {
						status: "exported",
						operationId: "export-1",
						revision: 2,
						outputPath: join(directory, "video.mp4"),
						bytesWritten: 123,
						sha256: "a".repeat(64),
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
		expect(requestCount).toBe(2);
		expect(verifyCount).toBe(2);
		expect(exportRequest).toMatchObject({
			canvasSize: { width: 1080, height: 1080 },
		});
		expect(validationRequest).toMatchObject({
			expectedWidth: 1080,
			expectedHeight: 1080,
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
