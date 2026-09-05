import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wasm = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	mediaCapabilityCatalog(input: {
		taskIds?: string[];
	}):
		| ({ status: "catalog" } & Record<string, unknown>)
		| { status: "rejected"; code: string; reason: string };
	validateMediaAnalysis(input: {
		operationId: string;
		createdAt: string;
		analysis: unknown;
	}): MediaAnalysisValidation;
	verifyMediaAnalysis(input: { analysis: unknown }): MediaAnalysisValidation;
	planAudioPost(input: unknown):
		| {
				status: "planned";
				providerExecution: "forbidden";
				plan: Record<string, unknown>;
		  }
		| { status: "rejected"; code: string; reason: string };
};

export type MediaAnalysisValidation =
	| { status: "validated"; analysis: Record<string, unknown> }
	| { status: "rejected"; code: string; reason: string };

export function getMediaCapabilityCatalog(input: {
	taskIds?: string[];
}): Record<string, unknown> {
	return plainJson(wasm.mediaCapabilityCatalog(input)) as Record<
		string,
		unknown
	>;
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
