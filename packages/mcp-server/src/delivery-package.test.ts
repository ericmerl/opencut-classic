import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryPackageService } from "./delivery-package";
import { ExportQcService } from "./export-qc";
import { ExportReceiptStore } from "./export-receipts";
import { removeTestDirectory } from "./test-filesystem";

describe("durable delivery packages", () => {
	let directory: string;
	let receipts: ExportReceiptStore;
	let qc: ExportQcService;
	let service: DeliveryPackageService;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-package-test-"));
		receipts = new ExportReceiptStore(join(directory, "receipts"));
		qc = new ExportQcService(receipts);
		service = new DeliveryPackageService(receipts, qc);
		for (const id of ["master", "clean", "burned"] as const) {
			await createExport(id);
			await qc.evaluate({
				operationId: `qc-${id}`,
				exportOperationId: `export-${id}`,
				policy: {
					version: 1,
					checks: { "watermark-inspection": { enabled: false } },
				},
			});
		}
	});

	afterEach(async () => {
		await removeTestDirectory(directory);
	});

	test("packages master, clean/burned variants, sidecars, covers, evidence, QC, and provenance", async () => {
		const sidecar = join(directory, "captions.vtt");
		await writeFile(sidecar, "WEBVTT\n");
		const input = {
			operationId: "package-1",
			packageName: "Course Delivery",
			outputDirectory: join(directory, "deliveries"),
			batchId: "batch-1",
			allowQcWarnings: false,
			includeEvidence: true,
			master: {
				exportOperationId: "export-master",
				qcOperationId: "qc-master",
			},
			variants: [
				{
					variantId: "square-clean",
					captionMode: "clean" as const,
					exportOperationId: "export-clean",
					qcOperationId: "qc-clean",
				},
				{
					variantId: "square-burned",
					captionMode: "burned-in" as const,
					exportOperationId: "export-burned",
					qcOperationId: "qc-burned",
				},
			],
			sidecars: [{ name: "English captions", sourcePath: sidecar }],
		};

		const created = await service.create(input);
		expect(created.status).toBe("packaged");
		expect(created.manifest.schemaVersion).toBe(1);
		expect(created.manifest.projectId).toBe("project-1");
		expect(created.manifest.sources).toHaveLength(3);
		expect(created.manifest.files).toHaveLength(22);
		expect(created.manifest.files.map((file) => file.role)).toContain("cover");
		expect(created.manifest.files.map((file) => file.role)).toContain(
			"sidecar",
		);
		expect((await stat(created.manifestPath)).isFile()).toBe(true);

		const restarted = new DeliveryPackageService(
			new ExportReceiptStore(join(directory, "receipts")),
			new ExportQcService(new ExportReceiptStore(join(directory, "receipts"))),
		);
		const verified = await restarted.verify("package-1");
		expect(verified.status).toBe("verified");
		const replay = await restarted.create(input);
		expect(replay.status).toBe("replayed");

		const variant = created.manifest.files.find(
			(file) => file.role === "variant",
		)!;
		await writeFile(
			join(created.packageDirectory, variant.relativePath),
			"tampered",
		);
		await expect(restarted.verify("package-1")).rejects.toThrow(
			"delivery package file changed or is missing",
		);
	});

	async function createExport(id: "master" | "clean" | "burned") {
		const root = join(directory, id);
		await mkdir(root);
		const output = join(root, `${id}.mp4`);
		const cover = join(root, "cover.png");
		const samples = ["opening", "middle", "ending"].map((position) => ({
			position,
			path: join(root, `${position}.png`),
		}));
		await Bun.write(output, `video-${id}`);
		await Bun.write(cover, `cover-${id}`);
		for (const sample of samples)
			await Bun.write(sample.path, `${sample.position}-${id}`);
		const outputIdentity = await identity(output);
		const coverIdentity = await identity(cover);
		const sampleIdentities = await Promise.all(
			samples.map(async (sample, index) => ({
				...sample,
				...(await identity(sample.path)),
				frameIndex: index * 15,
				timeSeconds: index * 0.5,
			})),
		);
		await receipts.write({
			schemaVersion: 1,
			operationId: `export-${id}`,
			fingerprint: `fingerprint-${id}`,
			createdAt: "2026-09-04T00:00:00.000Z",
			inspection: {
				status: "pending",
				outputSha256: outputIdentity.sha256,
				reviewer: null,
				notes: null,
				inspectedAt: null,
			},
			result: {
				status: "exported",
				container: "mp4",
				projectId: "project-1",
				saveReceiptId: "save-1",
				projectContentIdentity: {
					hash: { digest: "a".repeat(64) },
				},
				renderer: { environment: { fingerprint: "b".repeat(64) } },
				outputPath: output,
				bytesWritten: outputIdentity.bytes,
				sha256: outputIdentity.sha256,
				resolvedRenderSpecification: {
					canvasSize: { width: 720, height: 720 },
					output: {
						videoCodec: "avc",
						fps: { numerator: 30, denominator: 1 },
						includeAudio: false,
					},
					frameSchedule: { durationTicks: 120_000 },
					captions: {
						mode: id === "clean" ? "off" : "on",
						elementIds: id === "clean" ? [] : ["caption-1"],
						geometry:
							id === "clean"
								? []
								: [
										{
											elementId: "caption-1",
											startTicks: 0,
											safeZoneId: "captions",
											geometry: {
												clipped: false,
												overflow: {
													left: 0,
													top: 0,
													right: 0,
													bottom: 0,
												},
												safeZone: { inside: true },
												visual: {
													left: 100,
													top: 600,
													width: 520,
													height: 80,
												},
											},
										},
									],
					},
				},
				validation: {
					status: "validated",
					fullDecode: true,
					formatName: "mov,mp4",
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
					frameSamples: sampleIdentities,
					coverFrame: {
						position: "cover",
						frameIndex: 10,
						timeSeconds: 1 / 3,
						...coverIdentity,
					},
				},
			},
		});
	}
});

async function identity(path: string) {
	const bytes = await readFile(path);
	return {
		path,
		bytes: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}
