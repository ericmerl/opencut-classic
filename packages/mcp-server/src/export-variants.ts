import { extname, isAbsolute, resolve } from "node:path";
import type { ExportProjectInput } from "./export-project";
import type { BridgeConnectionIdentity } from "./editor-bridge";

export const PLATFORM_EXPORT_PRESETS = {
	tiktok_9_16: {
		canvasSize: { width: 1080, height: 1920 },
		fps: { numerator: 30, denominator: 1 },
		format: "mp4",
		quality: "high",
		includeAudio: true,
	},
	instagram_reels_9_16: {
		canvasSize: { width: 1080, height: 1920 },
		fps: { numerator: 30, denominator: 1 },
		format: "mp4",
		quality: "high",
		includeAudio: true,
	},
	youtube_shorts_9_16: {
		canvasSize: { width: 1080, height: 1920 },
		fps: { numerator: 30, denominator: 1 },
		format: "mp4",
		quality: "high",
		includeAudio: true,
	},
	instagram_square_1_1: {
		canvasSize: { width: 1080, height: 1080 },
		fps: { numerator: 30, denominator: 1 },
		format: "mp4",
		quality: "high",
		includeAudio: true,
	},
	youtube_landscape_16_9: {
		canvasSize: { width: 1920, height: 1080 },
		fps: { numerator: 30, denominator: 1 },
		format: "mp4",
		quality: "high",
		includeAudio: true,
	},
} as const;

export type PlatformExportPreset = keyof typeof PLATFORM_EXPORT_PRESETS;

export interface ExportBatchVariantInput {
	variantId: string;
	preset: PlatformExportPreset;
	outputPath: string;
	format?: "mp4" | "webm";
	quality?: "low" | "medium" | "high" | "very_high";
	fps?: { numerator: number; denominator: number };
	includeAudio?: boolean;
	canvasSize?: { width: number; height: number };
}

export interface ExportBatchInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	batchId: string;
	projectId: string;
	expectedRevision: number;
	variants: ExportBatchVariantInput[];
}

export interface ExpandedExportVariant {
	variantId: string;
	preset: PlatformExportPreset;
	jobId: string;
	input: ExportProjectInput;
}

export function expandExportBatch(
	input: ExportBatchInput,
): ExpandedExportVariant[] {
	const variantIds = new Set<string>();
	const outputPaths = new Set<string>();
	return input.variants.map((variant) => {
		if (variantIds.has(variant.variantId)) {
			throw new Error(`duplicate export variant ID: ${variant.variantId}`);
		}
		variantIds.add(variant.variantId);
		if (!isAbsolute(variant.outputPath)) {
			throw new Error(`export path must be absolute: ${variant.outputPath}`);
		}
		const outputPath = resolve(variant.outputPath);
		const outputKey = outputPath.toLowerCase();
		if (outputPaths.has(outputKey)) {
			throw new Error(`duplicate export output path: ${outputPath}`);
		}
		outputPaths.add(outputKey);

		const preset = PLATFORM_EXPORT_PRESETS[variant.preset];
		const format = variant.format ?? preset.format;
		if (extname(outputPath).toLowerCase() !== `.${format}`) {
			throw new Error(
				`export path extension must match ${format}: ${outputPath}`,
			);
		}
		return {
			variantId: variant.variantId,
			preset: variant.preset,
			jobId: `batch:${input.batchId}:${variant.variantId}`,
			input: {
				...(input.bridgeProtocolVersion !== undefined
					? { bridgeProtocolVersion: input.bridgeProtocolVersion }
					: {}),
				...(input.expectedConnectionIdentity
					? { expectedConnectionIdentity: input.expectedConnectionIdentity }
					: {}),
				projectId: input.projectId,
				operationId: `export-batch:${input.batchId}:${variant.variantId}`,
				expectedRevision: input.expectedRevision,
				outputPath,
				format,
				quality: variant.quality ?? preset.quality,
				fps: variant.fps ?? preset.fps,
				includeAudio: variant.includeAudio ?? preset.includeAudio,
				canvasSize: variant.canvasSize ?? preset.canvasSize,
			},
		};
	});
}
