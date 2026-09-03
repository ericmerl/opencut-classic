import { createHash } from "node:crypto";
import type { BridgeConnectionIdentity, EditorBridge } from "./editor-bridge";
import type { McpOperationExecutionContext } from "./mcp-ledger-boundary";
import { requestLedgeredBrowserStep } from "./mcp-ledger-boundary";
import type { InlineJobMirror } from "./inline-jobs";
import type { JsonValue } from "./job-store";
import { stableSerialize } from "./matte-generation-data";
import type {
	PreviewRangeRecord,
	RangePreviewEvidenceStore,
} from "./range-preview-evidence-store";
import type { PreviewRangeLimits } from "./range-preview-config";

export interface RenderPreviewRangeInput {
	contractVersion: 1;
	bridgeProtocolVersion: 2;
	expectedConnectionIdentity: BridgeConnectionIdentity;
	operationId: string;
	projectId: string;
	sceneId: string;
	expectedRevision: number;
	expectedProjectContentHash: string;
	expectedWriteVersion: number;
	saveReceiptOperationId: string;
	expectedSaveReceiptId: string;
	range:
		| { kind: "media-time"; startTicks: number; endTicksExclusive: number }
		| {
				kind: "frame-index";
				startFrameIndex: number;
				endFrameIndexExclusive: number;
		  };
	canvasSize: { width: number; height: number };
	output: { kind: "frame-sequence"; frameFormat: "png"; includeAudio: boolean };
}

export class RangePreviewService {
	constructor(
		private bridge: EditorBridge,
		private store: RangePreviewEvidenceStore,
		private limits: PreviewRangeLimits,
		private capabilitySnapshot: () => Promise<unknown>,
		private mirror?: InlineJobMirror,
	) {}

	async render(
		input: RenderPreviewRangeInput,
		context: McpOperationExecutionContext,
	): Promise<Record<string, unknown>> {
		const prior = await this.store.getByOperation(input.operationId);
		if (prior?.execution.status === "succeeded")
			return response(prior, "replayed");
		if (prior?.execution.status === "cancelled")
			return response(prior, "cancelled");

		const capabilitySnapshot = prior ? null : await this.capabilitySnapshot();
		const capabilitySnapshotHash =
			prior?.capabilitySnapshotHash ??
			stringField(capabilitySnapshot, "snapshotHash");
		if (!capabilitySnapshotHash)
			throw new Error("capability snapshot is not hash-bound");
		const renderer = recordField(capabilitySnapshot, "renderer");
		const wasm = recordField(renderer, "wasm");
		const wasmSha256 =
			prior?.rendererPolicy.requiredWasmSha256 ?? stringField(wasm, "sha256");
		const inputFingerprint = sha256(stableSerialize(input));
		const semanticInputHash = semanticPreviewRangeInputHash(input);
		const session = await this.store.createSession({
			operationId: input.operationId,
			inputFingerprint,
			semanticInputHash,
			projectId: input.projectId,
			sceneId: input.sceneId,
			revision: input.expectedRevision,
			contentHash: input.expectedProjectContentHash,
			writeVersion: input.expectedWriteVersion,
			saveReceiptId: input.expectedSaveReceiptId,
			includeAudio: input.output.includeAudio,
			canvasSize: input.canvasSize,
			capabilitySnapshotHash,
			requiredWasmSha256: wasmSha256,
		});
		await context.checkpoint({
			phase: "saving",
			checkpoint: checkpoint(input.operationId, "prepared", {
				receiptId: session.record.receiptId,
				completed: session.record.execution.completed,
				total: session.record.execution.total,
			}),
		});
		await this.mirror?.start({
			jobId: session.record.jobId,
			jobType: "preview-range",
			operationId: input.operationId,
			semanticInputHash,
			capabilitySnapshotHash,
			preconditions: {
				projectId: input.projectId,
				sceneId: input.sceneId,
				revision: input.expectedRevision,
				contentHash: input.expectedProjectContentHash,
				writeVersion: input.expectedWriteVersion,
				saveReceiptId: input.expectedSaveReceiptId,
			},
			input: {
				range: input.range,
				canvasSize: input.canvasSize,
				output: input.output,
			} as unknown as JsonValue,
			progressUnits: "frames",
			total: session.record.execution.total,
			phase: "rendering",
		});
		this.mirror?.track(session.record.jobId, async () => {
			const current = await this.store.getByOperation(input.operationId);
			return current
				? {
						phase: current.execution.phase,
						completed: current.execution.completed,
						total: current.execution.total,
					}
				: null;
		});
		try {
			const browserResult = await requestLedgeredBrowserStep(
				context,
				this.bridge,
				"render_preview_range",
				{
					...input,
					baseUrl: session.baseUrl,
					limits: {
						maxDurationTicks: this.limits.maxDurationTicks,
						maxFrames: this.limits.maxFrames,
					},
					capabilitySnapshotHash,
					wasmSha256,
				},
				"preview-range-render",
				10 * 60_000,
			);
			return await this.finalize(input, browserResult, capabilitySnapshotHash);
		} catch (error) {
			await this.store.fail(
				input.operationId,
				error instanceof Error ? error.message : "preview range failed",
			);
			await this.mirror?.fail(
				session.record.jobId,
				error instanceof Error ? error.message : "preview range failed",
			);
			throw error;
		}
	}

	async recover(
		input: RenderPreviewRangeInput,
		context: McpOperationExecutionContext,
	): Promise<Record<string, unknown> | null> {
		const prior = await this.store.getByOperation(input.operationId);
		if (prior?.execution.status === "succeeded")
			return response(prior, "replayed");
		if (prior?.execution.status === "cancelled")
			return response(prior, "cancelled");
		const recovered = await context.recoverBrowserStep("preview-range-render");
		if (!recovered) return null;
		if (!prior?.capabilitySnapshotHash) return null;
		return this.finalize(input, recovered, prior.capabilitySnapshotHash);
	}

	async cancel(targetOperationId: string) {
		const record = await this.store.cancel(targetOperationId);
		if (record) {
			await this.mirror?.cancelRequest(
				record.jobId,
				"cancellation requested through MCP",
			);
		}
		return record
			? {
					status: cancellationStatus(record.execution.status),
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
		input: RenderPreviewRangeInput,
		bridgeValue: unknown,
		capabilitySnapshotHash: string,
	): Promise<Record<string, unknown>> {
		if (!isRecord(bridgeValue))
			throw new Error("editor returned an invalid preview-range result");
		// The live bridge stamps every response with the connection identity it
		// was dispatched to. Those fields are transport evidence, not part of the
		// editor result contract, so strip them before the exact-shape check.
		const {
			bridgeProtocolVersion: _bridgeProtocolVersion,
			connectionIdentity,
			requestConnectionIdentity: _requestConnectionIdentity,
			...value
		} = bridgeValue;
		if (
			connectionIdentity !== undefined &&
			stableSerialize(connectionIdentity) !==
				stableSerialize(input.expectedConnectionIdentity)
		)
			throw new Error(
				"editor preview-range response identity does not match the request",
			);
		if (value.status !== "rendered" && value.status !== "cancelled") {
			await this.store.fail(
				input.operationId,
				typeof value.reason === "string"
					? value.reason
					: "editor rejected preview range",
			);
			await this.mirror?.fail(
				`preview-range:${input.operationId}`,
				typeof value.reason === "string"
					? value.reason
					: "editor rejected preview range",
				"editor-rejected",
			);
			return value;
		}
		const record = await this.store.getByOperation(input.operationId);
		if (!record)
			throw new Error("preview-range receipt disappeared before finalization");
		const completed = validateCompletedBrowserResult({
			value,
			input,
			capabilitySnapshotHash,
			requiredWasmSha256: record.rendererPolicy.requiredWasmSha256,
		});
		if (
			!record.scheduleSha256 ||
			sha256(stableSerialize(completed.schedule)) !== record.scheduleSha256 ||
			stableSerialize(completed.schedule.requestedRange) !==
				stableSerialize(input.range)
		)
			throw new Error(
				"browser preview-range schedule does not match the uploaded manifest",
			);
		const finalized = await this.store.finalize(
			input.operationId,
			completed.status,
			{
				contentIdentity: completed.contentIdentity,
				saveReceipt: completed.saveReceipt,
				renderer: completed.renderer,
				fontReadiness: completed.fontReadiness,
				editorState: completed.editorState,
				sourceVerification: completed.sourceVerification,
				capabilitySnapshotHash,
			},
		);
		if (finalized.execution.status === "cancelled") {
			await this.mirror?.cancelled(
				finalized.jobId,
				"renderer stopped after observing the cancellation request",
			);
		} else {
			await this.mirror?.succeed(finalized.jobId, {
				receiptId: finalized.receiptId,
				status: finalized.execution.status,
				completed: finalized.execution.completed,
				total: finalized.execution.total,
			});
		}
		return response(
			finalized,
			finalized.execution.status === "cancelled"
				? "cancelled"
				: completed.status,
		);
	}
}

function validateCompletedBrowserResult({
	value,
	input,
	capabilitySnapshotHash,
	requiredWasmSha256,
}: {
	value: Record<string, unknown>;
	input: RenderPreviewRangeInput;
	capabilitySnapshotHash: string;
	requiredWasmSha256: string | null;
}): Record<string, unknown> & {
	status: "rendered" | "cancelled";
	schedule: Record<string, unknown>;
} {
	requireExactKeys(value, [
		"status",
		"contractVersion",
		"operationId",
		"projectId",
		"sceneId",
		"revision",
		"contentIdentity",
		"writeVersion",
		"saveReceiptId",
		"saveReceiptOperationId",
		"saveReceipt",
		"capabilitySnapshotHash",
		"schedule",
		"fontReadiness",
		"sourceVerification",
		"renderer",
		"editorState",
	]);
	const contentIdentity = requireRecord(
		value.contentIdentity,
		"contentIdentity",
	);
	const contentHash = requireRecord(
		contentIdentity.hash,
		"contentIdentity.hash",
	);
	const saveReceipt = requireRecord(value.saveReceipt, "saveReceipt");
	const source = requireRecord(value.sourceVerification, "sourceVerification");
	const renderer = requireRecord(value.renderer, "renderer");
	const environment = requireRecord(
		renderer.environment,
		"renderer.environment",
	);
	const editorState = requireRecord(value.editorState, "editorState");
	const fontReadiness = requireRecord(value.fontReadiness, "fontReadiness");
	const schedule = requireRecord(value.schedule, "schedule");
	validateRendererEvidence({
		renderer,
		environment,
		capabilitySnapshotHash,
		requiredWasmSha256,
	});
	validateFontReadiness(fontReadiness);
	if (
		value.contractVersion !== 1 ||
		(value.status !== "rendered" && value.status !== "cancelled") ||
		value.operationId !== input.operationId ||
		value.projectId !== input.projectId ||
		value.sceneId !== input.sceneId ||
		value.revision !== input.expectedRevision ||
		value.writeVersion !== input.expectedWriteVersion ||
		value.saveReceiptId !== input.expectedSaveReceiptId ||
		value.saveReceiptOperationId !== input.saveReceiptOperationId ||
		value.capabilitySnapshotHash !== capabilitySnapshotHash ||
		contentIdentity.status !== "hashed" ||
		contentHash.digest !== input.expectedProjectContentHash ||
		// The receipt revision is session-local to the editor that saved it, so it
		// is deliberately not compared with the live revision: the receipt id,
		// content hash, and write version already bind the retained source.
		saveReceipt.receiptId !== input.expectedSaveReceiptId ||
		saveReceipt.operationId !== input.saveReceiptOperationId ||
		saveReceipt.projectId !== input.projectId ||
		saveReceipt.sceneId !== input.sceneId ||
		saveReceipt.contentHash !== input.expectedProjectContentHash ||
		saveReceipt.readbackContentHash !== input.expectedProjectContentHash ||
		saveReceipt.writeVersion !== input.expectedWriteVersion ||
		saveReceipt.reloadVerified !== true ||
		source.revisionBefore !== input.expectedRevision ||
		source.revisionAfter !== input.expectedRevision ||
		source.contentHashBefore !== input.expectedProjectContentHash ||
		source.contentHashAfter !== input.expectedProjectContentHash ||
		editorState.unchanged !== true ||
		renderer.provider !== "opencut-web-renderer" ||
		renderer.pipeline !== "editor-native-exact-frame-sequence" ||
		renderer.compositor !== "opencut-wasm-webgl" ||
		renderer.encoder !== "browser-canvas-png-sequence" ||
		environment.capabilitySnapshotHash !== capabilitySnapshotHash ||
		(requiredWasmSha256 !== null &&
			environment.wasmSha256 !== requiredWasmSha256) ||
		stableSerialize(renderer.executionIdentity) !==
			stableSerialize(input.expectedConnectionIdentity)
	)
		throw new Error(
			`editor preview-range evidence is incomplete or source-mismatched: ${JSON.stringify(
				{
					expected: {
						operationId: input.operationId,
						projectId: input.projectId,
						sceneId: input.sceneId,
						revision: input.expectedRevision,
						writeVersion: input.expectedWriteVersion,
						saveReceiptId: input.expectedSaveReceiptId,
						saveReceiptOperationId: input.saveReceiptOperationId,
						contentHash: input.expectedProjectContentHash,
						capabilitySnapshotHash,
						requiredWasmSha256,
						connectionIdentity: input.expectedConnectionIdentity,
					},
					actual: {
						contractVersion: value.contractVersion,
						status: value.status,
						operationId: value.operationId,
						projectId: value.projectId,
						sceneId: value.sceneId,
						revision: value.revision,
						writeVersion: value.writeVersion,
						saveReceiptId: value.saveReceiptId,
						saveReceiptOperationId: value.saveReceiptOperationId,
						capabilitySnapshotHash: value.capabilitySnapshotHash,
						contentIdentity,
						saveReceipt,
						sourceVerification: source,
						editorStateUnchanged: editorState.unchanged,
						renderer: { ...renderer, environment: undefined },
						environmentCapabilitySnapshotHash: environment.capabilitySnapshotHash,
						environmentWasmSha256: environment.wasmSha256,
					},
				},
			)}`,
		);
	return value as Record<string, unknown> & {
		status: "rendered" | "cancelled";
		schedule: Record<string, unknown>;
	};
}

function validateRendererEvidence({
	renderer,
	environment,
	capabilitySnapshotHash,
	requiredWasmSha256,
}: {
	renderer: Record<string, unknown>;
	environment: Record<string, unknown>;
	capabilitySnapshotHash: string;
	requiredWasmSha256: string | null;
}): void {
	requireExactNestedKeys(renderer, "renderer", [
		"provider",
		"pipeline",
		"compositor",
		"browser",
		"encoder",
		"environment",
		"executionIdentity",
	]);
	requireExactNestedKeys(environment, "renderer.environment", [
		"status",
		"reason",
		"compositor",
		"backend",
		"pinnedBackend",
		"backendMatchesPin",
		"rendererClass",
		"adapterMatchesClass",
		"adapter",
		"surfaceFormat",
		"browser",
		"wasmPackageVersion",
		"capabilitySnapshotHash",
		...(requiredWasmSha256 === null ? [] : ["wasmSha256"]),
	]);
	const adapter = requireRecord(
		environment.adapter,
		"renderer.environment.adapter",
	);
	requireExactNestedKeys(adapter, "renderer.environment.adapter", [
		"vendor",
		"architecture",
		"device",
		"description",
		"isFallbackAdapter",
	]);
	const rendererClass = environment.rendererClass;
	if (
		typeof renderer.browser !== "string" ||
		renderer.browser.length === 0 ||
		environment.status !== "ready" ||
		environment.reason !== null ||
		environment.compositor !== "opencut-wasm-webgl" ||
		environment.backend !== "webgpu" ||
		environment.pinnedBackend !== "webgpu" ||
		environment.backendMatchesPin !== true ||
		(rendererClass !== "software" &&
			rendererClass !== "hardware" &&
			rendererClass !== "unknown") ||
		(rendererClass === "unknown"
			? environment.adapterMatchesClass !== null
			: environment.adapterMatchesClass !== true) ||
		(environment.surfaceFormat !== "bgra8unorm" &&
			environment.surfaceFormat !== "rgba8unorm") ||
		environment.browser !== renderer.browser ||
		typeof environment.wasmPackageVersion !== "string" ||
		environment.wasmPackageVersion.length === 0 ||
		environment.capabilitySnapshotHash !== capabilitySnapshotHash ||
		(requiredWasmSha256 !== null &&
			environment.wasmSha256 !== requiredWasmSha256) ||
		// Real WebGPU adapters routinely report empty architecture, device, or
		// description strings, so only their presence as strings is required.
		!["vendor", "architecture", "device", "description"].every(
			(key) => typeof adapter[key] === "string",
		) ||
		(typeof adapter.isFallbackAdapter !== "boolean" &&
			adapter.isFallbackAdapter !== null)
	)
		throw new Error(
			`editor preview-range renderer provenance is invalid: ${JSON.stringify({ browser: renderer.browser, environment, requiredWasmSha256, capabilitySnapshotHash })}`,
		);
}

function validateFontReadiness(fonts: Record<string, unknown>): void {
	requireExactNestedKeys(fonts, "fontReadiness", [
		"status",
		"families",
		"descriptors",
		"descriptorsSha256",
	]);
	if (
		fonts.status !== "ready" ||
		!Array.isArray(fonts.families) ||
		!fonts.families.every((family) => typeof family === "string") ||
		!Array.isArray(fonts.descriptors) ||
		typeof fonts.descriptorsSha256 !== "string"
	)
		throw new Error("editor preview-range font provenance is invalid");
	const descriptors = fonts.descriptors.map((value, index) => {
		const descriptor = requireRecord(
			value,
			`fontReadiness.descriptors[${index}]`,
		);
		requireExactNestedKeys(descriptor, `fontReadiness.descriptors[${index}]`, [
			"family",
			"style",
			"weight",
			"stretch",
			"css",
			"identitySha256",
			"matchedFaceIdentities",
			"matchedFaces",
		]);
		const base = {
			family: descriptor.family,
			style: descriptor.style,
			weight: descriptor.weight,
			stretch: descriptor.stretch,
			css: descriptor.css,
		};
		if (
			!Object.values(base).every((item) => typeof item === "string") ||
			descriptor.identitySha256 !== sha256(JSON.stringify(base)) ||
			!Array.isArray(descriptor.matchedFaceIdentities) ||
			!Array.isArray(descriptor.matchedFaces)
		)
			throw new Error("editor preview-range font descriptor is invalid");
		const faceIds = descriptor.matchedFaces.map((value, faceIndex) => {
			const face = requireRecord(
				value,
				`fontReadiness.descriptors[${index}].matchedFaces[${faceIndex}]`,
			);
			requireExactNestedKeys(face, "fontReadiness.matchedFace", [
				"provenance",
				"family",
				"style",
				"weight",
				"stretch",
				"unicodeRange",
				"featureSettings",
				"display",
				"identitySha256",
			]);
			const identity = { ...face };
			delete identity.identitySha256;
			if (
				(face.provenance !== "font-face-set" &&
					face.provenance !== "system-local-font-face") ||
				![
					"family",
					"style",
					"weight",
					"stretch",
					"unicodeRange",
					"featureSettings",
					"display",
				].every((key) => typeof face[key] === "string") ||
				face.identitySha256 !== sha256(JSON.stringify(identity))
			)
				throw new Error("editor preview-range matched font face is invalid");
			return face.identitySha256 as string;
		});
		const declaredIds = descriptor.matchedFaceIdentities;
		if (
			faceIds.length === 0 ||
			!declaredIds.every((id) => typeof id === "string") ||
			stableSerialize([...faceIds].sort()) !==
				stableSerialize([...declaredIds].sort())
		)
			throw new Error("editor preview-range font face identities are invalid");
		return descriptor;
	});
	const expectedFamilies = [
		...new Set(descriptors.map((descriptor) => descriptor.family as string)),
	].sort();
	if (
		stableSerialize(fonts.families) !== stableSerialize(expectedFamilies) ||
		fonts.descriptorsSha256 !== sha256(JSON.stringify(descriptors))
	)
		throw new Error("editor preview-range font digest is invalid");
}

function requireExactNestedKeys(
	value: Record<string, unknown>,
	name: string,
	keys: readonly string[],
): void {
	const expected = new Set(keys);
	if (
		Object.keys(value).length !== expected.size ||
		Object.keys(value).some((key) => !expected.has(key))
	)
		throw new Error(`editor preview-range ${name} shape is invalid`);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value))
		throw new Error(`editor preview-range ${name} is invalid`);
	return value;
}

function requireExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): void {
	const expected = new Set(keys);
	if (
		Object.keys(value).length !== expected.size ||
		Object.keys(value).some((key) => !expected.has(key))
	)
		throw new Error("editor returned an invalid preview-range result shape");
}

export function semanticPreviewRangeInputHash(
	input: RenderPreviewRangeInput,
): string {
	return sha256(
		stableSerialize({
			projectId: input.projectId,
			sceneId: input.sceneId,
			revision: input.expectedRevision,
			contentHash: input.expectedProjectContentHash,
			writeVersion: input.expectedWriteVersion,
			saveReceiptOperationId: input.saveReceiptOperationId,
			saveReceiptId: input.expectedSaveReceiptId,
			range: input.range,
			canvasSize: input.canvasSize,
			output: input.output,
		}),
	);
}

function cancellationStatus(status: PreviewRangeRecord["execution"]["status"]) {
	if (status === "cancelled") return "cancelled";
	if (status === "succeeded") return "already-succeeded";
	if (status === "failed") return "already-failed";
	return "cancellation-requested";
}

function response(
	receipt: PreviewRangeRecord,
	status: "rendered" | "replayed" | "cancelled",
) {
	return {
		status,
		contractVersion: 1,
		...receipt,
	};
}

function checkpoint(
	operationId: string,
	state: "prepared" | "verified",
	metadata: Record<string, string | number | null>,
) {
	return {
		checkpointId: `${operationId}:preview-range`,
		kind: "job" as const,
		state,
		recordedAt: new Date().toISOString(),
		metadata,
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
