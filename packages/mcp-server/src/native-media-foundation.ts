import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wasm = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	approvedModelCatalog(): ApprovedModelCatalog;
	validateApprovedModelReadiness(
		input: ApprovedModelReadinessInput,
	):
		| { status: "readiness"; readiness: ApprovedModelReadiness }
		| { status: "rejected"; code: string; reason: string };
	mediaCapabilityCatalog(input: {
		taskIds?: string[];
	}):
		| ({ status: "catalog" } & Record<string, unknown>)
		| { status: "rejected"; code: string; reason: string };
	mediaExecutionBlocker(input: { taskId: string }): {
		status: "rejected";
		code: "MODEL_SELECTION_REQUIRED" | "UNKNOWN_MEDIA_TASK_ID";
		reason: string;
		taskId: string;
		providerExecution: "forbidden";
	};
	validateMediaAnalysis(input: {
		operationId: string;
		createdAt: string;
		analysis: unknown;
	}): MediaAnalysisValidation;
	resolveMediaAnalysisCreate(input: {
		operationId: string;
		createdAt: string;
		analysis: unknown;
		existingAnalysis: Record<string, unknown> | null;
	}): MediaAnalysisCreateResolution;
	verifyMediaAnalysis(input: { analysis: unknown }): MediaAnalysisValidation;
	planAudioPost(input: unknown):
		| {
				status: "planned";
				providerExecution: "forbidden";
				plan: Record<string, unknown>;
		  }
		| { status: "rejected"; code: string; reason: string };
};

export interface ApprovedModelCatalog {
	schemaVersion: "opencut.approved-models.v1";
	models: ApprovedModel[];
}

export interface ApprovedModel {
	taskId: string;
	providerId: string;
	modelId: string;
	modelVersion: string;
	artifact: {
		filename: string;
		sourceUrl: string;
		sha256: string;
		bytes: number;
		cacheKey: string;
	};
	code: { repository: string; revision: string } | null;
	runtime: {
		runtimeId: string;
		repository: string;
		revision: string | null;
		release: string | null;
	};
	license: {
		spdx: "Apache-2.0" | "MIT";
		modelNotice: string;
		bundledLicensePath: string;
		bundledNoticePath: string;
	};
	executionPolicy: {
		canonicalDevice: "cpu";
		canonicalThreads: number | null;
		cpuFallback: string;
		cuda: string;
		windowsCuda: string;
		conformanceRequired: true;
	};
	outputPolicy: string;
}

export interface ApprovedRuntimeProbeInput {
	runtimeId: string;
	runtimeVersion: string;
	device: "cpu" | "cuda";
	hostOs: string;
	environment: "native" | "wsl2-ubuntu";
	threads?: number;
	deterministicConformance: boolean;
}

export interface ApprovedModelReadinessInput {
	taskId: string;
	artifact?: { sha256: string; bytes: number };
	runtime?: ApprovedRuntimeProbeInput;
}

export interface ApprovedModelReadiness {
	status: "ready" | "degraded" | "unavailable";
	canExecute: boolean;
	reason: string;
	artifactStatus: "ready" | "missing";
	device: string | null;
}

export function getApprovedModelCatalog(): ApprovedModelCatalog {
	return plainJson(wasm.approvedModelCatalog()) as ApprovedModelCatalog;
}

export function validateApprovedModelReadiness(
	input: ApprovedModelReadinessInput,
) {
	return plainJson(wasm.validateApprovedModelReadiness(input)) as
		| { status: "readiness"; readiness: ApprovedModelReadiness }
		| { status: "rejected"; code: string; reason: string };
}

export type MediaAnalysisValidation =
	| { status: "validated"; analysis: Record<string, unknown> }
	| { status: "rejected"; code: string; reason: string };

export type MediaAnalysisCreateResolution =
	| {
			status: "created" | "replayed";
			analysis: Record<string, unknown>;
	  }
	| { status: "rejected"; code: string; reason: string };

export function getMediaCapabilityCatalog(input: {
	taskIds?: string[];
}): Record<string, unknown> {
	return plainJson(wasm.mediaCapabilityCatalog(input)) as Record<
		string,
		unknown
	>;
}

export function getMediaExecutionBlocker(taskId: string) {
	return plainJson(wasm.mediaExecutionBlocker({ taskId })) as {
		status: "rejected";
		code: "MODEL_SELECTION_REQUIRED" | "UNKNOWN_MEDIA_TASK_ID";
		reason: string;
		taskId: string;
		providerExecution: "forbidden";
	};
}

export function getMediaProviderReadiness(taskId: string) {
	const blocker = getMediaExecutionBlocker(taskId);
	return {
		status:
			blocker.code === "MODEL_SELECTION_REQUIRED"
				? "model-selection-required"
				: "unavailable",
		canExecute: false,
		reason: blocker.reason,
		command: null,
		version: null,
		model: {
			status:
				blocker.code === "MODEL_SELECTION_REQUIRED"
					? "model-selection-required"
					: "unavailable",
			id: null,
			version: null,
		},
	};
}

export function validateMediaAnalysis(input: {
	operationId: string;
	createdAt: string;
	analysis: unknown;
}) {
	return plainJson(
		wasm.validateMediaAnalysis(input),
	) as MediaAnalysisValidation;
}

export function verifyMediaAnalysis(analysis: unknown) {
	return plainJson(
		wasm.verifyMediaAnalysis({ analysis }),
	) as MediaAnalysisValidation;
}

export function resolveMediaAnalysisCreate(input: {
	operationId: string;
	createdAt: string;
	analysis: unknown;
	existingAnalysis: Record<string, unknown> | null;
}) {
	return plainJson(
		wasm.resolveMediaAnalysisCreate(input),
	) as MediaAnalysisCreateResolution;
}

export function planAudioPost(input: unknown) {
	return plainJson(wasm.planAudioPost(input)) as
		| {
				status: "planned";
				providerExecution: "forbidden";
				plan: Record<string, unknown>;
		  }
		| { status: "rejected"; code: string; reason: string };
}

function plainJson(value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(
			[...value.entries()]
				.map(([key, child]) => [String(key), plainJson(child)] as const)
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}
	if (Array.isArray(value)) return value.map(plainJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.map(([key, child]) => [key, plainJson(child)]),
		);
	}
	return value;
}
