import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	ReviewEvidenceStore,
	type ReviewAnnotationRecord,
	type WatermarkInspectionRecord,
} from "./review-evidence-store";

let directory: string | null = null;

afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = null;
});

describe("review evidence store", () => {
	test("persists an immutable human annotation across restart", async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-review-evidence-"));
		const first = new ReviewEvidenceStore(directory);
		await first.readiness();
		await first.appendAnnotation(annotation());
		first.close();

		const restarted = new ReviewEvidenceStore(directory);
		await restarted.readiness();
		expect(await restarted.getAnnotation("annotation-1")).toEqual(annotation());
		restarted.close();
	});

	test("appends status versions only onto the exact immutable predecessor", async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-review-evidence-"));
		const store = new ReviewEvidenceStore(directory);
		await store.readiness();
		const first = annotation();
		await store.appendAnnotation(first);
		const resolved: ReviewAnnotationRecord = {
			...first,
			versionId: "annotation-1:2",
			version: 2,
			previousVersionId: first.versionId,
			operationId: "resolve-annotation-1",
			createdAt: "2026-09-04T12:05:00.000Z",
			status: "resolved",
			resolutionOperationId: "repair-operation-1",
		};
		await store.appendAnnotation(resolved);

		expect(await store.getAnnotation("annotation-1", 1)).toEqual(first);
		expect(await store.getAnnotation("annotation-1")).toEqual(resolved);
		await expect(
			store.appendAnnotation({
				...resolved,
				versionId: "annotation-1:3",
				version: 3,
				previousVersionId: first.versionId,
				operationId: "invalid-version-3",
				createdAt: "2026-09-04T12:06:00.000Z",
			}),
		).rejects.toThrow("exact previous version");
		store.close();
	});

	test("rejects mutation and fails closed when stored annotation bytes are tampered", async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-review-evidence-"));
		const store = new ReviewEvidenceStore(directory);
		await store.readiness();
		await store.appendAnnotation(annotation());
		const attacker = new Database(store.databasePath);
		try {
			expect(() =>
				attacker
					.query(
						"UPDATE review_annotations SET record_json='{}' WHERE version_id='annotation-1:1'",
					)
					.run(),
			).toThrow("immutable");
			expect(() =>
				attacker
					.query(
						"DELETE FROM review_annotations WHERE version_id='annotation-1:1'",
					)
					.run(),
			).toThrow("immutable");
			attacker.exec("DROP TRIGGER review_annotations_no_update");
			attacker
				.query(
					"UPDATE review_annotations SET record_json='{}' WHERE version_id='annotation-1:1'",
				)
				.run();
			await expect(store.getAnnotation("annotation-1")).rejects.toThrow(
				"checksum mismatch",
			);
		} finally {
			attacker.close(false);
			store.close();
		}
	});

	test("persists the declared watermark sampling policy and export-byte evidence", async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-review-evidence-"));
		const first = new ReviewEvidenceStore(directory);
		await first.readiness();
		await first.appendWatermarkInspection(watermarkInspection());
		first.close();

		const restarted = new ReviewEvidenceStore(directory);
		await restarted.readiness();
		expect(await restarted.getWatermarkInspection("inspection-1")).toEqual(
			watermarkInspection(),
		);
		restarted.close();
	});
});

function annotation(): ReviewAnnotationRecord {
	return {
		schemaVersion: "opencut.review-annotation.v1",
		annotationId: "annotation-1",
		versionId: "annotation-1:1",
		version: 1,
		previousVersionId: null,
		operationId: "create-annotation-1",
		projectId: "project-1",
		sceneId: "scene-1",
		createdAt: "2026-09-04T12:00:00.000Z",
		target: {
			kind: "preview-frame",
			evidenceOperationId: "preview-frame-1",
			evidenceReceiptId: "preview:frame:1",
			artifactSha256: "a".repeat(64),
			projectContentHash: "b".repeat(64),
		},
		location: { kind: "time", ticks: 120_000 },
		region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
		category: "watermark",
		severity: "blocking",
		status: "open",
		finding: { kind: "human" },
		reviewer: "reviewer-1",
		notes: "Logo visible in lower corner",
		resolutionOperationId: null,
		replacementEvidence: null,
		bookmarkId: null,
	};
}

function watermarkInspection(): WatermarkInspectionRecord {
	const corners = {
		"top-left": "clean",
		"top-right": "clean",
		"bottom-left": "clean",
		"bottom-right": "clean",
	} as const;
	return {
		schemaVersion: "opencut.watermark-inspection.v1",
		inspectionId: "inspection-1",
		operationId: "record-inspection-1",
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		createdAt: "2026-09-04T12:10:00.000Z",
		exportEvidence: {
			kind: "export",
			evidenceOperationId: "export-1",
			evidenceReceiptId: "export-1",
			artifactSha256: "a".repeat(64),
			projectContentHash: "b".repeat(64),
		},
		renderEvidence: [],
		policy: {
			schemaVersion: "opencut.watermark-sampling-policy.v1",
			fullFrameSamples: ["opening", "middle", "ending"],
			corners: ["top-left", "top-right", "bottom-left", "bottom-right"],
			requireFinalExportBytesInspection: true,
			requireHumanReview: true,
		},
		review: { kind: "human", reviewer: "reviewer-1" },
		samples: [
			{
				position: "opening",
				artifactSha256: "c".repeat(64),
				fullFrame: "clean",
				corners,
			},
			{
				position: "middle",
				artifactSha256: "d".repeat(64),
				fullFrame: "clean",
				corners,
			},
			{
				position: "ending",
				artifactSha256: "e".repeat(64),
				fullFrame: "clean",
				corners,
			},
		],
		finalExportBytes: { artifactSha256: "a".repeat(64), status: "clean" },
		status: "verified-clean",
		notes: "No watermark found in the final export",
	};
}
