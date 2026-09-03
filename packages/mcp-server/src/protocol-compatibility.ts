import {
	MUTATING_TOOL_MANIFEST,
	type MutatingToolName,
} from "./mutating-tool-manifest";

export const LEGACY_V1_MUTATION_FLAG =
	"OPENCUT_ENABLE_PROTOCOL_V1_MUTATION" as const;

const protocolV1MutationExemptTools = Object.entries(MUTATING_TOOL_MANIFEST)
	.filter(
		([, definition]) =>
			definition.protocolMutationPolicy === "bootstrap-control",
	)
	.map(([toolName]) => toolName as MutatingToolName)
	.sort();

export interface ProtocolCompatibilityStatus {
	status: "ready" | "degraded";
	protocolV1Mutation: {
		enabled: boolean;
		configurationFlag: typeof LEGACY_V1_MUTATION_FLAG;
		scope: "protocol-bearing-mutations";
		exemptTools: readonly MutatingToolName[];
		reason: string;
	};
}

export interface ProtocolCompatibilityRejection {
	status: "rejected";
	code: "PROTOCOL_V1_MUTATION_DISABLED";
	retryable: false;
	operationId: string;
	reason: string;
	details: {
		configurationFlag: typeof LEGACY_V1_MUTATION_FLAG;
		nextAction: string;
	};
}

export function readProtocolCompatibility(
	environment: Record<string, string | undefined> = process.env,
): ProtocolCompatibilityStatus {
	const configured = environment[LEGACY_V1_MUTATION_FLAG];
	if (configured !== undefined && configured !== "1") {
		throw new Error(`${LEGACY_V1_MUTATION_FLAG} must be 1 when set`);
	}
	const enabled = configured === "1";
	return {
		status: enabled ? "degraded" : "ready",
		protocolV1Mutation: {
			enabled,
			configurationFlag: LEGACY_V1_MUTATION_FLAG,
			scope: "protocol-bearing-mutations",
			exemptTools: [...protocolV1MutationExemptTools],
			reason: enabled
				? "Protocol v1 mutation is explicitly enabled without v2 safety guarantees"
				: "Protocol v1 mutation is disabled; use protocol v2",
		},
	};
}

export function protocolMutationRejection({
	input,
	operationId,
	allowProtocolV1Mutation,
	protocolMutationPolicy,
}: {
	input: Record<string, unknown>;
	operationId: string;
	allowProtocolV1Mutation: boolean;
	protocolMutationPolicy: "v2-required" | "bootstrap-control";
}): ProtocolCompatibilityRejection | null {
	if (
		protocolMutationPolicy === "bootstrap-control" ||
		input.bridgeProtocolVersion === 2 ||
		allowProtocolV1Mutation
	)
		return null;
	return {
		status: "rejected",
		code: "PROTOCOL_V1_MUTATION_DISABLED",
		retryable: false,
		operationId,
		reason: "Protocol v1 mutation is disabled; use protocol v2",
		details: {
			configurationFlag: LEGACY_V1_MUTATION_FLAG,
			nextAction:
				"Retry with bridgeProtocolVersion 2 and its required operation and connection identity",
		},
	};
}
