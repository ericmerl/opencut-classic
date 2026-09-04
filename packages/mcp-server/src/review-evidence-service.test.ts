import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportReceiptStore } from "./export-receipts";
import type { PreviewEvidenceStore } from "./preview-evidence-store";
import type { RangePreviewEvidenceStore } from "./range-preview-evidence-store";
import { ReviewEvidenceService } from "./review-evidence-service";
import { ReviewEvidenceStore } from "./review-evidence-store";

let directory: string;
let store: ReviewEvidenceStore;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-review-service-"));
	store = new ReviewEvidenceStore(directory);
	await store.readiness();
});

afterEach(async () => {
	store.close();
	await rm(directory, { recursive: true, force: true });
});

test("creates an annotation tied to a verified preview frame", async () => {
	const digest = "a".repeat(64);
	const previewEvidence = {
		get: async (receiptId: string) => ({
			receiptId,
			operationId: "preview-operation-1",
			projectId: "project-1",
			sceneId: "scene-1",
			contentHash: "b".repeat(64),
			artifact: { sha256: digest },
		}),
	} as unknown as PreviewEvidenceStore;
	const service = new ReviewEvidenceService(
		store,
		{} as ExportReceiptStore,
		() => new Date("2026-09-04T12:00:00.000Z"),
		previewEvidence,
	);

	const created = await service.createAnnotation({
		operationId: "create-preview-annotation-1",
		annotationId: "preview-annotation-1",
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		target: {
			kind: "preview-frame",
			evidenceOperationId: "preview-operation-1",
			evidenceReceiptId: "preview-receipt-1",
			artifactSha256: digest,
		},
		location: { kind: "time", ticks: 120_000 },
		region: { x: 0, y: 0, width: 1, height: 1 },
		category: "visual",
		severity: "warning",
		finding: { kind: "human" },
		reviewer: "reviewer-1",
		notes: "Inspect this frame.",
	});

	expect(created.annotation.target).toEqual({
		kind: "preview-frame",
		evidenceOperationId: "preview-operation-1",
		evidenceReceiptId: "preview-receipt-1",
		artifactSha256: digest,
		projectContentHash: "b".repeat(64),
	});
});

test("creates an annotation tied to a verified half-open preview range", async () => {
	const digest = "c".repeat(64);
	const rangePreviewEvidence = {
		get: async (receiptId: string) => ({
			receiptId,
			operationId: "preview-range-operation-1",
			projectId: "project-1",
			sceneId: "scene-1",
			contentHash: "b".repeat(64),
			checksum: digest,
			execution: { status: "succeeded" },
		}),
	} as unknown as RangePreviewEvidenceStore;
	const service = new ReviewEvidenceService(
		store,
		{} as ExportReceiptStore,
		() => new Date("2026-09-04T12:00:00.000Z"),
		undefined,
		rangePreviewEvidence,
	);

	const created = await service.createAnnotation({
		operationId: "create-range-annotation-1",
		annotationId: "range-annotation-1",
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		target: {
			kind: "preview-range",
			evidenceOperationId: "preview-range-operation-1",
			evidenceReceiptId: "preview-range:preview-range-operation-1",
			artifactSha256: digest,
		},
		location: {
			kind: "range",
			startTicks: 120_000,
			endTicksExclusive: 240_000,
		},
		region: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
		category: "continuity",
		severity: "blocking",
		finding: {
			kind: "automated",
			detector: {
				provider: "local-detector",
				modelId: "continuity-model",
				modelVersion: "1.0.0",
			},
		},
		reviewer: "detector-service",
		notes: "Continuity changed within the range.",
	});

	expect(created.annotation).toMatchObject({
		target: {
			kind: "preview-range",
			artifactSha256: digest,
		},
		location: {
			kind: "range",
			startTicks: 120_000,
			endTicksExclusive: 240_000,
		},
		finding: {
			kind: "automated",
			detector: { modelId: "continuity-model", modelVersion: "1.0.0" },
		},
	});
});

test("records verified preview-frame and preview-range provenance with watermark evidence", async () => {
	const exportDigest = "d".repeat(64);
	const frameDigest = "e".repeat(64);
	const rangeDigest = "f".repeat(64);
	const exportReceipts = {
		verifyForReview: async () => ({
			operationId: "export-operation-1",
			result: {
				projectId: "project-1",
				sceneId: "scene-1",
				savedContentHash: "b".repeat(64),
				validation: {
					frameSamples: ["opening", "middle", "ending"].map(
						(position, index) => ({
							position,
							sha256: String(index + 1).repeat(64),
						}),
					),
				},
			},
		}),
	} as unknown as ExportReceiptStore;
	const previewEvidence = {
		get: async () => ({
			receiptId: "preview-receipt-1",
			operationId: "preview-operation-1",
			projectId: "project-1",
			sceneId: "scene-1",
			contentHash: "b".repeat(64),
			artifact: { sha256: frameDigest },
		}),
	} as unknown as PreviewEvidenceStore;
	const rangePreviewEvidence = {
		get: async () => ({
			receiptId: "preview-range:range-operation-1",
			operationId: "range-operation-1",
			projectId: "project-1",
			sceneId: "scene-1",
			contentHash: "b".repeat(64),
			checksum: rangeDigest,
			execution: { status: "succeeded" },
		}),
	} as unknown as RangePreviewEvidenceStore;
	const service = new ReviewEvidenceService(
		store,
		exportReceipts,
		() => new Date("2026-09-04T12:00:00.000Z"),
		previewEvidence,
		rangePreviewEvidence,
	);
	const cleanCorners = {
		"top-left": "clean" as const,
		"top-right": "clean" as const,
		"bottom-left": "clean" as const,
		"bottom-right": "clean" as const,
	};

	const recorded = await service.recordWatermarkInspection({
		operationId: "record-inspection-1",
		inspectionId: "inspection-1",
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		exportEvidence: {
			evidenceOperationId: "export-operation-1",
			evidenceReceiptId: "export-operation-1",
			artifactSha256: exportDigest,
		},
		renderEvidence: [
			{
				kind: "preview-frame",
				evidenceOperationId: "preview-operation-1",
				evidenceReceiptId: "preview-receipt-1",
				artifactSha256: frameDigest,
			},
			{
				kind: "preview-range",
				evidenceOperationId: "range-operation-1",
				evidenceReceiptId: "preview-range:range-operation-1",
				artifactSha256: rangeDigest,
			},
		],
		policy: {
			schemaVersion: "opencut.watermark-sampling-policy.v1",
			fullFrameSamples: ["opening", "middle", "ending"],
			corners: ["top-left", "top-right", "bottom-left", "bottom-right"],
			requireFinalExportBytesInspection: true,
			requireHumanReview: true,
		},
		review: { kind: "human", reviewer: "reviewer-1" },
		samples: (["opening", "middle", "ending"] as const).map((position) => ({
			position,
			fullFrame: "clean" as const,
			corners: cleanCorners,
		})),
		finalExportBytes: { status: "clean" },
		notes: "Reviewed renderer evidence and exported bytes independently.",
	});

	expect(recorded.inspection.renderEvidence).toEqual([
		{
			kind: "preview-frame",
			evidenceOperationId: "preview-operation-1",
			evidenceReceiptId: "preview-receipt-1",
			artifactSha256: frameDigest,
			projectContentHash: "b".repeat(64),
		},
		{
			kind: "preview-range",
			evidenceOperationId: "range-operation-1",
			evidenceReceiptId: "preview-range:range-operation-1",
			artifactSha256: rangeDigest,
			projectContentHash: "b".repeat(64),
		},
	]);
});
