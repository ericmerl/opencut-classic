import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportQcService } from "./export-qc";
import { ExportReceiptStore } from "./export-receipts";

describe("structured export QC", () => {
	let directory: string;
	let receipts: ExportReceiptStore;
	let outputPath: string;
	let samplePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-qc-test-"));
		receipts = new ExportReceiptStore(join(directory, "receipts"));
		outputPath = join(directory, "master.mp4");
		samplePath = join(directory, "sample.png");
		await writeFile(outputPath, "rendered-video");
		await writeFile(samplePath, "frame-evidence");
		await receipts.write(receipt());
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("emits a complete versioned report with policy-controlled outcomes", async () => {
		const service = new ExportQcService(receipts);
		const result = await service.evaluate({
			operationId: "qc-1",
			exportOperationId: "export-1",
			policy: {
				version: 1,
				checks: {
					"caption-clipping": { severity: "fail" },
					"watermark-inspection": { enabled: false },
				},
				platform: { name: "square", aspectRatio: 1, maxBytes: 1_000 },
			},
		});

		expect(result.status).toBe("evaluated");
		expect(result.report.schemaVersion).toBe(1);
		expect(result.report.checks).toHaveLength(22);
		expect(result.report.overall).toBe("fail");
		expect(
			result.report.checks.find((check) => check.checkId === "caption-clipping")
				?.status,
		).toBe("fail");
		expect(
			result.report.findings.find(
				(finding) => finding.checkId === "caption-clipping",
			),
		).toMatchObject({
			timestampSeconds: 1,
			region: { left: -5, top: 600, width: 730, height: 100 },
			measured: { clippedCount: 1, maximumOverflowPixels: 5 },
		});
		expect((await stat(result.reportPath)).isFile()).toBe(true);

		const replay = await service.evaluate({
			operationId: "qc-1",
			exportOperationId: "export-1",
			policy: {
				version: 1,
				checks: {
					"caption-clipping": { severity: "fail" },
					"watermark-inspection": { enabled: false },
				},
				platform: { name: "square", aspectRatio: 1, maxBytes: 1_000 },
			},
		});
		expect(replay.status).toBe("replayed");
	});

	test("fails replay when hash-locked evidence changes", async () => {
		const service = new ExportQcService(receipts);
		const input = {
			operationId: "qc-tamper",
			exportOperationId: "export-1",
			policy: { version: 1 as const },
		};
		await service.evaluate(input);
		await writeFile(samplePath, "changed-frame");
		await expect(service.evaluate(input)).rejects.toThrow(
			"QC evidence changed or is missing",
		);
	});

	test("fails closed when a legacy receipt omits signal and caption geometry evidence", async () => {
		const legacy = receipt();
		legacy.operationId = "export-legacy";
		legacy.result.resolvedRenderSpecification.captions.geometry = [];
		Reflect.deleteProperty(legacy.result.validation.video, "blackSegments");
		Reflect.deleteProperty(legacy.result.validation.video, "frozenSegments");
		await receipts.write(legacy);
		const result = await new ExportQcService(receipts).evaluate({
			operationId: "qc-legacy",
			exportOperationId: "export-legacy",
			policy: {
				version: 1,
				checks: {
					"black-frames": { severity: "fail" },
					"frozen-frames": { severity: "fail" },
					"caption-clipping": { severity: "fail" },
					"watermark-inspection": { enabled: false },
				},
			},
		});
		expect(result.report.overall).toBe("fail");
		for (const checkId of [
			"black-frames",
			"frozen-frames",
			"caption-clipping",
		]) {
			expect(
				result.report.checks.find((check) => check.checkId === checkId)?.status,
			).toBe("fail");
		}
	});

	function receipt() {
		const output = identity(outputPath, "rendered-video");
		const sample = identity(samplePath, "frame-evidence");
		return {
			schemaVersion: 1 as const,
			operationId: "export-1",
			fingerprint: "receipt-fingerprint",
			createdAt: "2026-09-04T00:00:00.000Z",
			inspection: {
				status: "pending" as const,
				outputSha256: output.sha256,
				reviewer: null,
				notes: null,
				inspectedAt: null,
			},
			result: {
				status: "exported",
				container: "mp4",
				outputPath,
				bytesWritten: output.bytes,
				sha256: output.sha256,
				resolvedRenderSpecification: {
					canvasSize: { width: 720, height: 720 },
					output: {
						format: "mp4",
						videoCodec: "avc",
						fps: { numerator: 30, denominator: 1 },
						includeAudio: false,
					},
					frameSchedule: { durationTicks: 120_000 },
					captions: {
						mode: "on",
						elementIds: ["caption-1"],
						geometry: [
							{
								elementId: "caption-1",
								startTicks: 120_000,
								safeZoneId: "caption-safe",
								geometry: {
									clipped: true,
									visual: {
										left: -5,
										top: 600,
										width: 730,
										height: 100,
									},
									overflow: { left: 5, top: 0, right: 5, bottom: 0 },
									safeZone: { inside: false },
								},
							},
						],
					},
				},
				validation: {
					status: "validated",
					fullDecode: true,
					formatName: "mov,mp4,m4a,3gp,3g2,mj2",
					durationSeconds: 1,
					video: {
						codec: "h264",
						width: 720,
						height: 720,
						fps: 30,
						colorPrimaries: "bt709",
						colorTransfer: "bt709",
						colorMatrix: "bt709",
						colorRange: "tv",
						pixelFormat: "yuv420p",
						blackSegments: [],
						frozenSegments: [],
					},
					audio: { present: false, measurements: null },
					frameSamples: [
						{ position: "middle", frameIndex: 15, timeSeconds: 0.5, ...sample },
					],
					coverFrame: null,
				},
			},
		};
	}
});

function identity(path: string, content: string) {
	return {
		path,
		bytes: Buffer.byteLength(content),
		sha256: createHash("sha256").update(content).digest("hex"),
	};
}
