import {
	calculateNormalizationGain,
	type NormalizationLimit,
} from "./audio-normalization";
import type { BridgeConnectionIdentity, EditorBridge } from "./editor-bridge";
import {
	requestLedgeredBrowserStep,
	type McpOperationExecutionContext,
} from "./mcp-ledger-boundary";
import { parseJsonValue } from "./operation-ledger-schema";

export interface NormalizeAudioInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	projectId: string;
	operationId: string;
	expectedRevision: number;
	targetLufs: number;
	maxTruePeakDbtp: number;
	maxGainDb: number;
}

const BROWSER_STEP = "normalize-audio:apply-gain";
const PLAN_CHECKPOINT = "normalize-audio:plan";

export class NormalizeAudioOperation {
	private completed = new Map<
		string,
		{ fingerprint: string; result: Record<string, unknown> }
	>();

	constructor(private bridge: EditorBridge) {}

	async execute(
		input: NormalizeAudioInput,
		context: McpOperationExecutionContext,
	): Promise<unknown> {
		const expectedIdentity = expectedV2Identity(input);
		const fingerprint = JSON.stringify(input);
		const prior = this.completed.get(input.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for a different audio normalization",
				);
			}
			return { ...prior.result, status: "replayed" };
		}
		const beforeResult = await this.analyze(input, input.expectedRevision);
		if (!isAnalyzedAudio(beforeResult)) return beforeResult;
		const before = beforeResult.analysis;
		if (before.integratedLufs === null || before.estimatedTruePeakDbtp === null) {
			return rejectedSilent(input, beforeResult, expectedIdentity);
		}
		const { appliedGainDb, limitedBy } = calculateNormalizationGain({
			integratedLufs: before.integratedLufs,
			estimatedTruePeakDbtp: before.estimatedTruePeakDbtp,
			targetLufs: input.targetLufs,
			maxTruePeakDbtp: input.maxTruePeakDbtp,
			maxGainDb: input.maxGainDb,
			minimumGainDb: before.minimumGainDb,
			maximumGainDb: before.maximumGainDb,
		});
		await context.checkpoint({
			checkpoint: {
				checkpointId: `${input.operationId}:${PLAN_CHECKPOINT}`,
				kind: "editor",
				state: "prepared",
				recordedAt: new Date().toISOString(),
				metadata: {
					beforeResult: parseJsonValue(beforeResult),
					appliedGainDb,
					limitedBy,
				},
			},
		});
		const mutation = await requestLedgeredBrowserStep(
			context,
			this.bridge,
			"apply_edit_plan",
			editRequest(input, appliedGainDb),
			BROWSER_STEP,
			5 * 60_000,
		);
		if (!isAppliedMutation(mutation)) return mutation;
		const afterResult = await this.analyze(input, mutation.revision);
		const result = buildResult({
			input,
			beforeResult,
			appliedGainDb,
			limitedBy,
			mutation,
			afterResult,
		});
		this.completed.set(input.operationId, { fingerprint, result });
		return result;
	}

	async recover(
		input: NormalizeAudioInput,
		context: McpOperationExecutionContext,
	): Promise<unknown | null> {
		const checkpoint = context
			.record()
			.checkpoints.find(
				(candidate) =>
					candidate.checkpointId === `${input.operationId}:${PLAN_CHECKPOINT}`,
			);
		const beforeResult = checkpoint?.metadata.beforeResult;
		const appliedGainDb = checkpoint?.metadata.appliedGainDb;
		const limitedBy = checkpoint?.metadata.limitedBy;
		if (
			!isAnalyzedAudio(beforeResult) ||
			typeof appliedGainDb !== "number" ||
			!isNormalizationLimit(limitedBy)
		) {
			return null;
		}
		const mutation = await context.recoverBrowserStep(BROWSER_STEP);
		if (!isAppliedMutation(mutation)) return null;
		const afterResult = await this.analyze(input, mutation.revision);
		return buildResult({
			input,
			beforeResult,
			appliedGainDb,
			limitedBy,
			mutation,
			afterResult,
		});
	}

	private analyze(input: NormalizeAudioInput, expectedRevision: number) {
		return this.bridge.request(
			"analyze_audio",
			{
				...protocolContext(input),
				projectId: input.projectId,
				expectedRevision,
			},
			5 * 60_000,
			expectedV2Identity(input),
		);
	}
}

function editRequest(input: NormalizeAudioInput, appliedGainDb: number) {
	return {
		...protocolContext(input),
		projectId: input.projectId,
		operationId: input.operationId,
		expectedRevision: input.expectedRevision,
		description: `Normalize timeline audio to ${input.targetLufs} LUFS`,
		operations: [{ kind: "adjust_mix_gain", gainDb: appliedGainDb }],
	};
}

function buildResult({
	input,
	beforeResult,
	appliedGainDb,
	limitedBy,
	mutation,
	afterResult,
}: {
	input: NormalizeAudioInput;
	beforeResult: AnalyzedAudio;
	appliedGainDb: number;
	limitedBy: NormalizationLimit;
	mutation: AppliedMutation;
	afterResult: unknown;
}): Record<string, unknown> {
	const snapshot = isRecord(mutation.snapshot) ? mutation.snapshot : null;
	return {
		status: "normalized",
		operationId: input.operationId,
		projectId: input.projectId,
		sceneId: snapshot && typeof snapshot.sceneId === "string" ? snapshot.sceneId : null,
		revision: mutation.revision,
		bridgeProtocolVersion: mutation.bridgeProtocolVersion ?? null,
		connectionIdentity: mutation.connectionIdentity ?? null,
		requestConnectionIdentity: expectedV2Identity(input) ?? null,
		contentIdentity:
			(snapshot?.contentIdentity as unknown) ??
			(isAnalyzedAudio(afterResult) ? afterResult.contentIdentity : null) ??
			beforeResult.contentIdentity,
		targetLufs: input.targetLufs,
		maxTruePeakDbtp: input.maxTruePeakDbtp,
		appliedGainDb,
		limitedBy,
		before: beforeResult.analysis,
		after: isAnalyzedAudio(afterResult) ? afterResult.analysis : afterResult,
		mutation,
	};
}

function rejectedSilent(
	input: NormalizeAudioInput,
	beforeResult: AnalyzedAudio,
	expectedIdentity: BridgeConnectionIdentity | undefined,
) {
	return {
		status: "rejected",
		projectId: input.projectId,
		sceneId: typeof beforeResult.sceneId === "string" ? beforeResult.sceneId : null,
		bridgeProtocolVersion: beforeResult.bridgeProtocolVersion ?? null,
		connectionIdentity: beforeResult.connectionIdentity ?? null,
		requestConnectionIdentity: expectedIdentity ?? null,
		reason: "audible timeline mix is silent or below the loudness gate",
		analysis: beforeResult.analysis,
	};
}

function expectedV2Identity(input: NormalizeAudioInput) {
	if (input.bridgeProtocolVersion !== 2) return undefined;
	if (!input.expectedConnectionIdentity) {
		throw new Error("bridge protocol v2 requires expectedConnectionIdentity");
	}
	return input.expectedConnectionIdentity;
}

function protocolContext(input: NormalizeAudioInput) {
	return {
		...(input.bridgeProtocolVersion !== undefined
			? { bridgeProtocolVersion: input.bridgeProtocolVersion }
			: {}),
		...(input.expectedConnectionIdentity
			? { expectedConnectionIdentity: input.expectedConnectionIdentity }
			: {}),
	};
}

interface AudioAnalysis {
	integratedLufs: number | null;
	estimatedTruePeakDbtp: number | null;
	minimumGainDb: number;
	maximumGainDb: number;
	[key: string]: unknown;
}

type AnalyzedAudio = Record<string, unknown> & {
	status: "analyzed";
	analysis: AudioAnalysis;
};
type AppliedMutation = Record<string, unknown> & {
	status: "applied" | "replayed";
	revision: number;
};

function isAnalyzedAudio(value: unknown): value is AnalyzedAudio {
	if (!isRecord(value) || value.status !== "analyzed" || !isRecord(value.analysis)) {
		return false;
	}
	return (
		(value.analysis.integratedLufs === null ||
			typeof value.analysis.integratedLufs === "number") &&
		(value.analysis.estimatedTruePeakDbtp === null ||
			typeof value.analysis.estimatedTruePeakDbtp === "number") &&
		typeof value.analysis.minimumGainDb === "number" &&
		typeof value.analysis.maximumGainDb === "number"
	);
}

function isAppliedMutation(value: unknown): value is AppliedMutation {
	return (
		isRecord(value) &&
		(value.status === "applied" || value.status === "replayed") &&
		typeof value.revision === "number"
	);
}

function isNormalizationLimit(value: unknown): value is NormalizationLimit {
	return new Set([
		"target_loudness",
		"true_peak_ceiling",
		"max_gain",
		"volume_bounds",
	]).has(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
