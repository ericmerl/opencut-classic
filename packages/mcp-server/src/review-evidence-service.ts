import type { ExportReceiptStore } from "./export-receipts";
import type { PreviewEvidenceStore } from "./preview-evidence-store";
import type { RangePreviewEvidenceStore } from "./range-preview-evidence-store";
import {
	evaluateExportSignoff,
	validateReviewAnnotation,
} from "./native-review-evidence";
import {
	ReviewEvidenceStore,
	type ReviewAnnotationRecord,
	type WatermarkInspectionRecord,
	type ExportReviewSignoffRecord,
} from "./review-evidence-store";

export interface CreateReviewAnnotationInput {
	operationId: string;
	annotationId: string;
	projectId: string;
	sceneId: string;
	projectContentHash: string;
	target: {
		kind: "preview-frame" | "preview-range" | "export";
		evidenceOperationId: string;
		evidenceReceiptId: string;
		artifactSha256: string;
	};
	location:
		| { kind: "time"; ticks: number }
		| { kind: "range"; startTicks: number; endTicksExclusive: number };
	region: { x: number; y: number; width: number; height: number };
	category: string;
	severity: "info" | "warning" | "blocking";
	finding:
		| { kind: "human" }
		| {
				kind: "automated";
				detector: {
					provider: string;
					modelId: string;
					modelVersion: string;
					optionsFingerprint?: string;
				};
		  };
	reviewer: string;
	notes: string;
	bookmarkId?: string;
}

export interface UpdateReviewAnnotationStatusInput {
	operationId: string;
	annotationId: string;
	expectedVersionId: string;
	projectId: string;
	sceneId: string;
	projectContentHash: string;
	status: "open" | "resolved" | "dismissed";
	reviewer: string;
	notes: string;
	resolutionOperationId?: string;
	replacementEvidence?: CreateReviewAnnotationInput["target"];
	bookmarkId?: string | null;
}

type WatermarkOutcome = "clean" | "watermark-found" | "unable-to-determine";

export interface RecordWatermarkInspectionInput {
	operationId: string;
	inspectionId: string;
	projectId: string;
	sceneId: string;
	projectContentHash: string;
	exportEvidence: Omit<CreateReviewAnnotationInput["target"], "kind">;
	renderEvidence: CreateReviewAnnotationInput["target"][];
	policy: WatermarkInspectionRecord["policy"];
	review: WatermarkInspectionRecord["review"];
	samples: Array<{
		position: "opening" | "middle" | "ending";
		fullFrame: WatermarkOutcome;
		corners: {
			"top-left": WatermarkOutcome;
			"top-right": WatermarkOutcome;
			"bottom-left": WatermarkOutcome;
			"bottom-right": WatermarkOutcome;
		};
	}>;
	finalExportBytes: { status: WatermarkOutcome };
	notes: string;
}

export interface SignOffExportReviewInput {
	operationId: string;
	signoffId: string;
	inspectionId: string;
	exportOperationId: string;
	outputSha256: string;
	projectId: string;
	sceneId: string;
	projectContentHash: string;
	reviewer: string;
	notes: string;
}

export class ReviewEvidenceService {
	constructor(
		private readonly store: ReviewEvidenceStore,
		private readonly exportReceipts: ExportReceiptStore,
		private readonly now: () => Date = () => new Date(),
		private readonly previewEvidence?: PreviewEvidenceStore,
		private readonly rangePreviewEvidence?: RangePreviewEvidenceStore,
	) {}

	async createAnnotation(input: CreateReviewAnnotationInput) {
		const validation = validateReviewAnnotation({
			location: input.location,
			region: input.region,
			finding: input.finding,
		});
		if (validation.status === "rejected") {
			throw new Error(`${validation.code}: ${validation.reason}`);
		}
		if (input.target.kind === "preview-frame") {
			const receipt = await this.previewEvidence?.get(
				input.target.evidenceReceiptId,
			);
			if (
				!receipt ||
				receipt.operationId !== input.target.evidenceOperationId ||
				receipt.artifact.sha256 !== input.target.artifactSha256 ||
				receipt.projectId !== input.projectId ||
				receipt.sceneId !== input.sceneId ||
				receipt.contentHash !== input.projectContentHash
			) {
				throw new Error("review target does not match its hash-locked source");
			}
		} else if (input.target.kind === "preview-range") {
			const receipt = await this.rangePreviewEvidence?.get(
				input.target.evidenceReceiptId,
			);
			if (
				!receipt ||
				receipt.operationId !== input.target.evidenceOperationId ||
				receipt.checksum !== input.target.artifactSha256 ||
				receipt.execution.status !== "succeeded" ||
				receipt.projectId !== input.projectId ||
				receipt.sceneId !== input.sceneId ||
				receipt.contentHash !== input.projectContentHash
			) {
				throw new Error("review target does not match its hash-locked source");
			}
		} else {
			const receipt = await this.exportReceipts.verifyForReview(
				input.target.evidenceOperationId,
				input.target.artifactSha256,
			);
			const result = receipt.result;
			if (
				input.target.evidenceReceiptId !== receipt.operationId ||
				result.projectId !== input.projectId ||
				result.sceneId !== input.sceneId ||
				result.savedContentHash !== input.projectContentHash
			) {
				throw new Error("review target does not match its hash-locked source");
			}
		}
		const annotation: ReviewAnnotationRecord = {
			schemaVersion: "opencut.review-annotation.v1",
			annotationId: input.annotationId,
			versionId: `${input.annotationId}:1`,
			version: 1,
			previousVersionId: null,
			operationId: input.operationId,
			projectId: input.projectId,
			sceneId: input.sceneId,
			createdAt: this.now().toISOString(),
			target: { ...input.target, projectContentHash: input.projectContentHash },
			location: input.location,
			region: input.region,
			category: input.category,
			severity: input.severity,
			status: "open",
			finding: input.finding,
			reviewer: input.reviewer,
			notes: input.notes,
			resolutionOperationId: null,
			replacementEvidence: null,
			bookmarkId: input.bookmarkId ?? null,
		};
		await this.store.appendAnnotation(annotation);
		return { status: "annotation-created" as const, annotation };
	}

	async getAnnotation(annotationId: string, version?: number) {
		return this.store.getAnnotation(annotationId, version);
	}

	async updateAnnotationStatus(input: UpdateReviewAnnotationStatusInput) {
		const current = await this.store.getAnnotation(input.annotationId);
		if (!current)
			throw new Error(`review annotation not found: ${input.annotationId}`);
		if (current.versionId !== input.expectedVersionId) {
			throw new Error("review annotation version changed before status update");
		}
		if (
			current.projectId !== input.projectId ||
			current.sceneId !== input.sceneId ||
			current.target.projectContentHash !== input.projectContentHash
		) {
			throw new Error("review annotation source binding changed");
		}
		const replacementEvidence = input.replacementEvidence
			? await this.resolveReplacement(input.replacementEvidence, current)
			: current.replacementEvidence;
		const annotation: ReviewAnnotationRecord = {
			...current,
			versionId: `${current.annotationId}:${current.version + 1}`,
			version: current.version + 1,
			previousVersionId: current.versionId,
			operationId: input.operationId,
			createdAt: this.now().toISOString(),
			status: input.status,
			reviewer: input.reviewer,
			notes: input.notes,
			resolutionOperationId: input.resolutionOperationId ?? null,
			replacementEvidence,
			bookmarkId:
				input.bookmarkId === undefined ? current.bookmarkId : input.bookmarkId,
		};
		await this.store.appendAnnotation(annotation);
		return { status: "annotation-status-updated" as const, annotation };
	}

	async listAnnotations(input: {
		limit: number;
		cursor?: string;
		projectId?: string;
		sceneId?: string;
	}) {
		return this.store.listAnnotations(input);
	}

	async recordWatermarkInspection(input: RecordWatermarkInspectionInput) {
		const receipt = await this.exportReceipts.verifyForReview(
			input.exportEvidence.evidenceOperationId,
			input.exportEvidence.artifactSha256,
		);
		if (
			input.exportEvidence.evidenceReceiptId !== receipt.operationId ||
			receipt.result.projectId !== input.projectId ||
			receipt.result.sceneId !== input.sceneId ||
			receipt.result.savedContentHash !== input.projectContentHash
		) {
			throw new Error("watermark inspection does not match its export source");
		}
		const renderEvidence = [];
		for (const target of input.renderEvidence) {
			renderEvidence.push(
				await this.verifyRenderTarget(target, {
					projectId: input.projectId,
					sceneId: input.sceneId,
					projectContentHash: input.projectContentHash,
				}),
			);
		}
		const validation = recordField(receipt.result, "validation");
		const frameSamples = Array.isArray(validation.frameSamples)
			? validation.frameSamples.filter(isRecord)
			: [];
		const samples = input.samples.map((sample) => {
			const evidence = frameSamples.find(
				(candidate) => candidate.position === sample.position,
			);
			if (!evidence || typeof evidence.sha256 !== "string") {
				throw new Error(`${sample.position} export frame sample is missing`);
			}
			return { ...sample, artifactSha256: evidence.sha256 };
		});
		const outcomes = [
			...samples.flatMap((sample) => [
				sample.fullFrame,
				...Object.values(sample.corners),
			]),
			input.finalExportBytes.status,
		];
		const status = outcomes.includes("watermark-found")
			? "rejected"
			: outcomes.includes("unable-to-determine")
				? "inconclusive"
				: "verified-clean";
		const inspection: WatermarkInspectionRecord = {
			schemaVersion: "opencut.watermark-inspection.v1",
			inspectionId: input.inspectionId,
			operationId: input.operationId,
			projectId: input.projectId,
			sceneId: input.sceneId,
			projectContentHash: input.projectContentHash,
			createdAt: this.now().toISOString(),
			exportEvidence: {
				kind: "export",
				...input.exportEvidence,
				projectContentHash: input.projectContentHash,
			},
			renderEvidence,
			policy: input.policy,
			review: input.review,
			samples,
			finalExportBytes: {
				artifactSha256: input.exportEvidence.artifactSha256,
				status: input.finalExportBytes.status,
			},
			status,
			notes: input.notes,
		};
		await this.store.appendWatermarkInspection(inspection);
		return { status: "watermark-inspection-recorded" as const, inspection };
	}

	async getWatermarkInspection(inspectionId: string) {
		return this.store.getWatermarkInspection(inspectionId);
	}

	async signOffExportReview(input: SignOffExportReviewInput) {
		const existing = await this.store.getExportReviewSignoff(input.signoffId);
		if (existing) {
			if (
				existing.operationId !== input.operationId ||
				existing.inspectionId !== input.inspectionId ||
				existing.exportOperationId !== input.exportOperationId ||
				existing.outputSha256 !== input.outputSha256 ||
				existing.projectId !== input.projectId ||
				existing.sceneId !== input.sceneId ||
				existing.projectContentHash !== input.projectContentHash ||
				existing.reviewer !== input.reviewer ||
				existing.notes !== input.notes
			) {
				throw new Error(
					"sign-off identity was already used with changed input",
				);
			}
			return { status: "export-review-signed-off" as const, signoff: existing };
		}
		const inspection = await this.store.getWatermarkInspection(
			input.inspectionId,
		);
		if (!inspection) {
			return {
				status: "rejected" as const,
				code: "WATERMARK_INSPECTION_NOT_FOUND",
				reason: "watermark inspection was not found",
			};
		}
		if (
			inspection.exportEvidence.evidenceOperationId !==
				input.exportOperationId ||
			inspection.exportEvidence.artifactSha256 !== input.outputSha256 ||
			inspection.projectId !== input.projectId ||
			inspection.sceneId !== input.sceneId ||
			inspection.projectContentHash !== input.projectContentHash
		) {
			return {
				status: "rejected" as const,
				code: "SIGNOFF_SOURCE_MISMATCH",
				reason: "sign-off source does not match the watermark inspection",
			};
		}
		const receipt = await this.exportReceipts.verifyForReview(
			input.exportOperationId,
			input.outputSha256,
		);
		const validation = recordField(receipt.result, "validation");
		const frameSamples = Array.isArray(validation.frameSamples)
			? validation.frameSamples.filter(isRecord)
			: [];
		for (const sample of inspection.samples) {
			const evidence = frameSamples.find(
				(candidate) => candidate.position === sample.position,
			);
			if (evidence?.sha256 !== sample.artifactSha256) {
				throw new Error(
					"watermark sample hash differs from the export receipt",
				);
			}
		}
		const latestAnnotations = await this.store.listLatestAnnotations({
			projectId: input.projectId,
			sceneId: input.sceneId,
			limit: 10_001,
		});
		if (latestAnnotations.length > 10_000) {
			throw new Error("review annotation bound exceeded during sign-off");
		}
		const unresolvedBlockingFindings = latestAnnotations.filter(
			(annotation) =>
				annotation.severity === "blocking" &&
				annotation.status === "open" &&
				(annotation.target.evidenceOperationId === input.exportOperationId ||
					annotation.replacementEvidence?.evidenceOperationId ===
						input.exportOperationId),
		).length;
		const evaluated = evaluateExportSignoff({
			reviewKind: inspection.review.kind,
			fullFrameSamples: inspection.samples
				.filter((sample) => sample.fullFrame === "clean")
				.map((sample) => sample.position),
			inspectedCorners: inspection.policy.corners.filter((corner) =>
				inspection.samples.every(
					(sample) => sample.corners[corner] === "clean",
				),
			),
			finalExportBytesInspected:
				inspection.policy.requireFinalExportBytesInspection,
			finalExportBytesClean: inspection.finalExportBytes.status === "clean",
			unresolvedBlockingFindings,
		});
		if (evaluated.status === "rejected") return evaluated;
		const signoff: ExportReviewSignoffRecord = {
			schemaVersion: "opencut.export-review-signoff.v1",
			signoffId: input.signoffId,
			operationId: input.operationId,
			inspectionId: input.inspectionId,
			exportOperationId: input.exportOperationId,
			outputSha256: input.outputSha256,
			projectId: input.projectId,
			sceneId: input.sceneId,
			projectContentHash: input.projectContentHash,
			reviewer: input.reviewer,
			notes: input.notes,
			createdAt: this.now().toISOString(),
			status: "signed-off",
			humanReview: true,
			unresolvedBlockingFindings: 0,
		};
		await this.store.appendExportReviewSignoff(signoff);
		return { status: "export-review-signed-off" as const, signoff };
	}

	private async resolveReplacement(
		target: CreateReviewAnnotationInput["target"],
		current: ReviewAnnotationRecord,
	) {
		if (target.kind !== "export") {
			throw new Error(`unsupported replacement review target: ${target.kind}`);
		}
		const receipt = await this.exportReceipts.verifyForReview(
			target.evidenceOperationId,
			target.artifactSha256,
		);
		if (
			target.evidenceReceiptId !== receipt.operationId ||
			receipt.result.projectId !== current.projectId ||
			receipt.result.sceneId !== current.sceneId
		) {
			throw new Error(
				"replacement evidence does not match the annotation project",
			);
		}
		return {
			...target,
			projectContentHash: String(receipt.result.savedContentHash),
		};
	}

	private async verifyRenderTarget(
		target: CreateReviewAnnotationInput["target"],
		source: {
			projectId: string;
			sceneId: string;
			projectContentHash: string;
		},
	) {
		if (target.kind === "preview-frame") {
			const receipt = await this.previewEvidence?.get(target.evidenceReceiptId);
			if (
				!receipt ||
				receipt.operationId !== target.evidenceOperationId ||
				receipt.artifact.sha256 !== target.artifactSha256 ||
				receipt.projectId !== source.projectId ||
				receipt.sceneId !== source.sceneId ||
				receipt.contentHash !== source.projectContentHash
			) {
				throw new Error(
					"render evidence does not match its hash-locked source",
				);
			}
		} else if (target.kind === "preview-range") {
			const receipt = await this.rangePreviewEvidence?.get(
				target.evidenceReceiptId,
			);
			if (
				!receipt ||
				receipt.operationId !== target.evidenceOperationId ||
				receipt.checksum !== target.artifactSha256 ||
				receipt.execution.status !== "succeeded" ||
				receipt.projectId !== source.projectId ||
				receipt.sceneId !== source.sceneId ||
				receipt.contentHash !== source.projectContentHash
			) {
				throw new Error(
					"render evidence does not match its hash-locked source",
				);
			}
		} else {
			throw new Error(
				"render evidence must reference a preview frame or range",
			);
		}
		return { ...target, projectContentHash: source.projectContentHash };
	}
}

function recordField(
	value: Record<string, unknown>,
	field: string,
): Record<string, unknown> {
	const result = value[field];
	if (!isRecord(result)) throw new Error(`${field} evidence is missing`);
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
