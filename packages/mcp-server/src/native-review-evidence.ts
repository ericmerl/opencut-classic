import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wasm = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	validateReviewAnnotation(
		input: ReviewAnnotationValidationInput,
	): { status: "valid" } | { status: "rejected"; code: string; reason: string };
	evaluateExportSignoff(
		input: ExportSignoffInput,
	):
		| { status: "eligible" }
		| { status: "rejected"; code: string; reason: string };
};

export interface ReviewAnnotationValidationInput {
	location:
		| { kind: "time"; ticks: number }
		| { kind: "range"; startTicks: number; endTicksExclusive: number };
	region: { x: number; y: number; width: number; height: number };
	finding:
		| { kind: "human" }
		| {
				kind: "automated";
				detector?: {
					provider: string;
					modelId: string;
					modelVersion: string;
					optionsFingerprint?: string;
				};
		  };
}

export function validateReviewAnnotation(
	input: ReviewAnnotationValidationInput,
) {
	return wasm.validateReviewAnnotation(input);
}

export interface ExportSignoffInput {
	reviewKind: "human" | "automated";
	fullFrameSamples: string[];
	inspectedCorners: string[];
	finalExportBytesInspected: boolean;
	finalExportBytesClean: boolean;
	unresolvedBlockingFindings: number;
}

export function evaluateExportSignoff(input: ExportSignoffInput) {
	return wasm.evaluateExportSignoff(input);
}
