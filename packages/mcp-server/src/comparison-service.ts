import { createHash } from "node:crypto";
import type { BridgeConnectionIdentity, EditorBridge } from "./editor-bridge";
import type { McpOperationExecutionContext } from "./mcp-ledger-boundary";
import { requestLedgeredBrowserStep } from "./mcp-ledger-boundary";
import { stableSerialize } from "./matte-generation-data";
import {
	type ComparisonRecord,
	type ComparisonSourceBinding,
	ComparisonEvidenceStore,
} from "./comparison-evidence-store";
import type { PreviewRangeLimits } from "./range-preview-config";
import { planComparison } from "./native-comparison";

export interface CompareProjectStatesInput {
	contractVersion: 1;
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: BridgeConnectionIdentity;
	operationId: string;
	projectId: string;
	sceneId: string;
	before: ComparisonSourceBinding;
	after: ComparisonSourceBinding;
	range:
		| { kind: "media-time"; startTicks: number; endTicksExclusive: number }
		| {
				kind: "frame-index";
				startFrameIndex: number;
				endFrameIndexExclusive: number;
		  };
	canvasSize: { width: number; height: number };
	normalization: ComparisonRecord["normalization"];
	output: ComparisonRecord["output"];
	pixelTolerance: number;
	audioSampleTolerance: number;
}

export class ComparisonService {
	constructor(
		private bridge: EditorBridge,
		private store: ComparisonEvidenceStore,
		private limits: PreviewRangeLimits,
		private capabilitySnapshot: () => Promise<unknown>,
	) {}

	async compare(
		input: CompareProjectStatesInput,
		context: McpOperationExecutionContext,
	): Promise<Record<string, unknown>> {
		const prior = await this.store.getByOperation(input.operationId);
		if (prior?.execution.status === "succeeded")
			return response(prior, "replayed");
		if (prior?.execution.status === "cancelled")
			return response(prior, "cancelled");

		const capability = prior ? null : await this.capabilitySnapshot();
		const capabilitySnapshotHash =
			prior?.capabilitySnapshotHash ?? stringField(capability, "snapshotHash");
		if (!capabilitySnapshotHash)
			throw new Error("capability snapshot is not hash-bound");
		const requiredWasmSha256 =
			prior?.rendererPolicy.requiredWasmSha256 ??
			stringField(
				recordField(recordField(capability, "renderer"), "wasm"),
				"sha256",
			);
		const session = await this.store.createSession({
			operationId: input.operationId,
			inputFingerprint: sha256(stableSerialize(input)),
			semanticInputHash: semanticComparisonInputHash(input),
			capabilitySnapshotHash,
			requiredWasmSha256,
			projectId: input.projectId,
			sceneId: input.sceneId,
			before: input.before,
			after: input.after,
			range: input.range,
			canvasSize: input.canvasSize,
			normalization: input.normalization,
			output: input.output,
			pixelTolerance: input.pixelTolerance,
			audioSampleTolerance: input.audioSampleTolerance,
		});
		await context.checkpoint({
			phase: "saving",
			checkpoint: checkpoint(input.operationId, "prepared", {
				receiptId: session.record.receiptId,
			}),
		});
		try {
			const browserResult = await requestLedgeredBrowserStep(
				context,
				this.bridge,
				"compare_project_states",
				{
					...input,
					beforeBaseUrl: session.beforeBaseUrl,
					afterBaseUrl: session.afterBaseUrl,
					limits: {
						maxDurationTicks: this.limits.maxDurationTicks,
						maxFrames: this.limits.maxFrames,
					},
					capabilitySnapshotHash,
					wasmSha256: requiredWasmSha256,
				},
				"comparison-render",
				10 * 60_000,
			);
			return await this.finalize(input, browserResult, capabilitySnapshotHash);
		} catch (error) {
			await this.store.fail(
				input.operationId,
				error instanceof Error ? error.message : "comparison failed",
			);
			throw error;
		}
	}

	async recover(
		input: CompareProjectStatesInput,
		context: McpOperationExecutionContext,
	): Promise<Record<string, unknown> | null> {
		const prior = await this.store.getByOperation(input.operationId);
		if (prior?.execution.status === "succeeded")
			return response(prior, "replayed");
		if (prior?.execution.status === "cancelled")
			return response(prior, "cancelled");
		const recovered = await context.recoverBrowserStep("comparison-render");
		if (!recovered || !prior?.capabilitySnapshotHash) return null;
		return this.finalize(input, recovered, prior.capabilitySnapshotHash);
	}

	async cancel(targetOperationId: string) {
		const record = await this.store.cancel(targetOperationId);
		return record
			? {
					status:
						record.execution.status === "cancelled"
							? "cancelled"
							: record.execution.status === "succeeded"
								? "already-succeeded"
								: record.execution.status === "failed"
									? "already-failed"
									: "cancellation-requested",
					targetOperationId,
					receiptId: record.receiptId,
					execution: record.execution,
				}
			: { status: "not-found", targetOperationId };
	}

	async get(receiptId: string) {
		const receipt = await this.store.get(receiptId);
		return receipt
			? { status: "found", receipt }
			: { status: "not-found", receiptId };
	}

	list(input: { projectId?: string; sceneId?: string; limit: number }) {
		return this.store.list(input);
	}

	verifyOperationReceipt(operationId: string) {
		return this.store.getByOperation(operationId);
	}

	private async finalize(
		input: CompareProjectStatesInput,
		value: unknown,
		capabilitySnapshotHash: string,
	): Promise<Record<string, unknown>> {
		if (
			isRecord(value) &&
			(value.status === "rejected" || value.status === "conflict") &&
			value.operationId === input.operationId &&
			typeof value.code === "string" &&
			typeof value.reason === "string"
		) {
			await this.store.fail(
				input.operationId,
				`${value.code}: ${value.reason}`,
			);
			return value;
		}
		const session = await this.store.getByOperation(input.operationId);
		if (!session)
			throw new Error("comparison session disappeared before finalization");
		const evidence = validateBrowserResult(
			value,
			input,
			capabilitySnapshotHash,
			this.limits,
			session.rendererPolicy.requiredWasmSha256,
		);
		const receipt = await this.store.finalize(
			input.operationId,
			evidence.status,
			evidence,
		);
		return response(
			receipt,
			receipt.execution.status === "cancelled" ? "cancelled" : evidence.status,
		);
	}
}

function validateBrowserResult(
	value: unknown,
	input: CompareProjectStatesInput,
	capabilitySnapshotHash: string,
	limits: PreviewRangeLimits,
	requiredWasmSha256: string | null,
): Record<string, unknown> & { status: "rendered" | "cancelled" } {
	if (!isRecord(value))
		throw new Error("editor returned an invalid comparison result");
	const before = requireRecord(value.before, "before");
	const after = requireRecord(value.after, "after");
	const renderer = requireRecord(value.renderer, "renderer");
	const environment = requireRecord(
		renderer.environment,
		"renderer.environment",
	);
	const editorState = requireRecord(value.editorState, "editorState");
	const normalization = requireRecord(value.normalization, "normalization");
	if (
		(value.status !== "rendered" && value.status !== "cancelled") ||
		value.contractVersion !== 1 ||
		value.operationId !== input.operationId ||
		value.projectId !== input.projectId ||
		value.sceneId !== input.sceneId ||
		value.capabilitySnapshotHash !== capabilitySnapshotHash ||
		stableSerialize(value.schedule) !== stableSerialize(before.schedule) ||
		stableSerialize(value.schedule) !== stableSerialize(after.schedule) ||
		stableSerialize(normalization) !== stableSerialize(input.normalization) ||
		editorState.unchanged !== true ||
		environment.status !== "ready" ||
		environment.capabilitySnapshotHash !== capabilitySnapshotHash ||
		stableSerialize(renderer.executionIdentity) !==
			stableSerialize(input.expectedConnectionIdentity)
	)
		throw new Error(
			"editor comparison evidence is incomplete or source-mismatched",
		);
	if (
		renderer.provider !== "opencut-web-renderer" ||
		renderer.pipeline !== "editor-native-before-after-comparison" ||
		renderer.compositor !== "opencut-wasm-webgl" ||
		renderer.encoder !== "browser-canvas-png-sequence" ||
		(requiredWasmSha256 !== null &&
			environment.wasmSha256 !== requiredWasmSha256)
	) {
		throw new Error("editor comparison renderer provenance is not pinned");
	}
	validateSide(before, input.before, input);
	validateSide(after, input.after, input);
	const beforeFonts = requireRecord(
		before.fontReadiness,
		"before.fontReadiness",
	);
	const afterFonts = requireRecord(after.fontReadiness, "after.fontReadiness");
	if (
		beforeFonts.status !== "ready" ||
		afterFonts.status !== "ready" ||
		beforeFonts.substituted !== false ||
		afterFonts.substituted !== false
	)
		throw new Error("editor comparison font readiness is invalid");
	const beforeRenderSource = validateRenderSource(
		before.renderSource,
		"before.renderSource",
	);
	const afterRenderSource = validateRenderSource(
		after.renderSource,
		"after.renderSource",
	);
	if (
		environment.rendererSettingsDigest !==
			beforeRenderSource.rendererSettingsDigest ||
		environment.rendererSettingsDigest !==
			afterRenderSource.rendererSettingsDigest
	)
		throw new Error("editor comparison renderer settings digest is invalid");
	const planned = planComparison({
		before: beforeRenderSource,
		after: afterRenderSource,
		range: input.range,
		limits: {
			maxDurationTicks: limits.maxDurationTicks,
			maxFrames: limits.maxFrames,
		},
	});
	if (
		planned.status !== "planned" ||
		stableSerialize(planned.plan.schedule) !== stableSerialize(value.schedule)
	)
		throw new Error(
			"editor comparison schedule does not equal the Rust-recomputed plan",
		);
	return value as Record<string, unknown> & {
		status: "rendered" | "cancelled";
	};
}

function validateRenderSource(value: unknown, name: string) {
	const source = requireRecord(value, name);
	const canvas = requireRecord(source.canvas, `${name}.canvas`);
	const rate = requireRecord(source.rate, `${name}.rate`);
	if (
		!Number.isSafeInteger(canvas.width) ||
		!Number.isSafeInteger(canvas.height) ||
		!Number.isSafeInteger(rate.numerator) ||
		!Number.isSafeInteger(rate.denominator) ||
		!Number.isSafeInteger(source.sceneDurationTicks) ||
		typeof source.rendererSettingsDigest !== "string"
	)
		throw new Error(`editor comparison ${name} is invalid`);
	return {
		canvas: { width: Number(canvas.width), height: Number(canvas.height) },
		rate: {
			numerator: Number(rate.numerator),
			denominator: Number(rate.denominator),
		},
		sceneDurationTicks: Number(source.sceneDurationTicks),
		rendererSettingsDigest: source.rendererSettingsDigest,
	};
}

function validateSide(
	value: Record<string, unknown>,
	binding: ComparisonSourceBinding,
	input: CompareProjectStatesInput,
) {
	const actualBinding = requireRecord(value.binding, "binding");
	const receipt = requireRecord(value.saveReceipt, "saveReceipt");
	if (
		stableSerialize(actualBinding) !== stableSerialize(binding) ||
		value.projectId !== input.projectId ||
		value.sceneId !== input.sceneId ||
		receipt.receiptId !== binding.saveReceiptId ||
		receipt.operationId !== binding.saveReceiptOperationId ||
		receipt.projectId !== input.projectId ||
		receipt.sceneId !== input.sceneId ||
		receipt.revision !== binding.revision ||
		receipt.contentHash !== binding.projectContentHash ||
		receipt.readbackContentHash !== binding.projectContentHash ||
		receipt.writeVersion !== binding.writeVersion ||
		receipt.reloadVerified !== true
	)
		throw new Error("editor comparison immutable source binding is invalid");
}

export function semanticComparisonInputHash(input: CompareProjectStatesInput) {
	return sha256(
		stableSerialize({
			projectId: input.projectId,
			sceneId: input.sceneId,
			before: input.before,
			after: input.after,
			range: input.range,
			canvasSize: input.canvasSize,
			normalization: input.normalization,
			output: input.output,
			pixelTolerance: input.pixelTolerance,
			audioSampleTolerance: input.audioSampleTolerance,
		}),
	);
}

function response(
	receipt: ComparisonRecord,
	status: "rendered" | "replayed" | "cancelled",
) {
	return { status, contractVersion: 1, ...receipt };
}

function checkpoint(
	operationId: string,
	state: "prepared" | "verified",
	metadata: Record<string, string | number | null>,
) {
	return {
		checkpointId: `${operationId}:comparison`,
		kind: "job" as const,
		state,
		recordedAt: new Date().toISOString(),
		metadata,
	};
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`editor comparison ${name} is invalid`);
	return value;
}

function recordField(
	value: unknown,
	field: string,
): Record<string, unknown> | null {
	return isRecord(value) && isRecord(value[field]) ? value[field] : null;
}

function stringField(value: unknown, field: string): string | null {
	return isRecord(value) && typeof value[field] === "string"
		? value[field]
		: null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
