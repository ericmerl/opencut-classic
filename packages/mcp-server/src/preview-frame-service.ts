import { createHash } from "node:crypto";
import type { BridgeConnectionIdentity, EditorBridge } from "./editor-bridge";
import type { McpOperationExecutionContext } from "./mcp-ledger-boundary";
import { requestLedgeredBrowserStep } from "./mcp-ledger-boundary";
import { stableSerialize } from "./matte-generation-data";
import { readPersistedProjectContentProjectionVersion } from "./project-content-version";
import type {
	PreviewEvidenceStore,
	PreviewFrameReceipt,
} from "./preview-evidence-store";

export interface RenderPreviewFrameInput {
	contractVersion: 2;
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
	time:
		| { kind: "frame-index"; frameIndex: number }
		| {
				kind: "media-time";
				ticks: number;
				rounding: "exact" | "floor" | "nearest" | "ceil";
		  };
	canvasSize: { width: number; height: number };
	format: "png";
}

export class PreviewFrameService {
	constructor(
		private bridge: EditorBridge,
		private store: PreviewEvidenceStore,
	) {}

	async render(
		input: RenderPreviewFrameInput,
		context: McpOperationExecutionContext,
	): Promise<Record<string, unknown>> {
		const prior = await this.store.getByOperation(input.operationId);
		if (prior) return response(prior, "replayed");
		const ticket = this.store.createTicket(
			input.operationId,
			input.canvasSize.width,
			input.canvasSize.height,
		);
		const browserResult = await requestLedgeredBrowserStep(
			context,
			this.bridge,
			"render_preview_frame",
			{ ...input, url: ticket.url },
			"exact-frame-render",
			5 * 60_000,
		);
		return this.finalize(input, browserResult);
	}

	async recover(
		input: RenderPreviewFrameInput,
		context: McpOperationExecutionContext,
	): Promise<Record<string, unknown> | null> {
		const prior = await this.store.getByOperation(input.operationId);
		if (prior) return response(prior, "replayed");
		const recovered = await context.recoverBrowserStep("exact-frame-render");
		return recovered ? this.finalize(input, recovered) : null;
	}

	async get(receiptId: string) {
		const receipt = await this.store.get(receiptId);
		return receipt
			? { status: "found", receipt }
			: { status: "not-found", receiptId };
	}

	verifyOperationReceipt(operationId: string) {
		return this.store.getByOperation(operationId);
	}

	list(input: {
		projectId?: string;
		sceneId?: string;
		limit: number;
		cursor?: string;
	}) {
		return this.store.list(input);
	}

	private async finalize(
		input: RenderPreviewFrameInput,
		value: unknown,
	): Promise<Record<string, unknown>> {
		if (!isRecord(value))
			throw new Error("editor returned an invalid exact-frame result");
		if (value.status !== "rendered" && value.status !== "replayed")
			return value;
		const result = requireRenderedResult(value, input);
		const upload = await this.store.uploadIdentity(input.operationId);
		if (
			!upload ||
			upload.sha256 !== result.sha256 ||
			upload.pixel_rgba_sha256 !== result.pixelRgbaSha256 ||
			upload.bytes !== result.bytesWritten ||
			upload.width !== result.width ||
			upload.height !== result.height
		) {
			throw new Error(
				"browser render result does not match the durable PNG upload",
			);
		}
		const inputFingerprint = sha256(stableSerialize(input));
		const renderSpecFingerprint = sha256(
			stableSerialize({
				projectId: input.projectId,
				sceneId: input.sceneId,
				contentHash: input.expectedProjectContentHash,
				writeVersion: input.expectedWriteVersion,
				time: input.time,
				canvasSize: input.canvasSize,
				format: input.format,
			}),
		);
		const capabilityHash = sha256(
			stableSerialize({
				contractVersion: 2,
				timebase: 120_000,
				format: "png",
				maxWidth: 4096,
				maxHeight: 4096,
				maxPixels: 16_777_216,
			}),
		);
		const receiptId = `preview:${input.operationId}`;
		const receipt: PreviewFrameReceipt = {
			schemaVersion: 2,
			receiptId,
			operationId: input.operationId,
			inputFingerprint,
			createdAt: new Date().toISOString(),
			projectId: input.projectId,
			sceneId: input.sceneId,
			revision: input.expectedRevision,
			contentHash: input.expectedProjectContentHash,
			writeVersion: input.expectedWriteVersion,
			saveReceiptId: input.expectedSaveReceiptId,
			saveReceiptOperationId: input.saveReceiptOperationId,
			connectionIdentity: { ...input.expectedConnectionIdentity },
			requestedTime: input.time,
			requestedTicks: result.requestedTicks,
			resolvedTicks: result.resolvedTicks,
			frameIndex: result.frameIndex,
			fps: result.fps,
			ticksPerFrame: result.ticksPerFrame,
			rounding: result.rounding,
			artifact: {
				artifactId: upload.sha256,
				path: upload.path,
				mimeType: "image/png",
				bytes: upload.bytes,
				sha256: upload.sha256,
				width: upload.width,
				height: upload.height,
				pixelRgbaSha256: result.pixelRgbaSha256,
				colorSpace: "srgb",
				alphaMode: "straight",
			},
			saveReceipt: result.saveReceipt as PreviewFrameReceipt["saveReceipt"],
			renderer: {
				provider: "opencut-web-renderer",
				pipeline: "editor-native-exact-frame",
				compositor: "opencut-wasm-webgl",
				browser: String(result.renderer.browser),
				encoder: "browser-canvas-png",
				bridgeProtocolVersion: 2,
				mcpBuild: process.env.OPENCUT_BUILD_COMMIT ?? "development",
				wasmPackageVersion: "0.2.10",
				renderSpecFingerprint,
				capabilityHash,
				executionIdentity: result.renderer
					.executionIdentity as PreviewFrameReceipt["renderer"]["executionIdentity"],
			},
			fontReadiness:
				result.fontReadiness as PreviewFrameReceipt["fontReadiness"],
			editorState: result.editorState as PreviewFrameReceipt["editorState"],
			sourceVerification:
				result.sourceVerification as PreviewFrameReceipt["sourceVerification"],
			operationLedgerId: input.operationId,
		};
		return response(await this.store.write(receipt), "rendered");
	}
}

function requireRenderedResult(value: unknown, input: RenderPreviewFrameInput) {
	if (!isRecord(value))
		throw new Error("editor returned an invalid exact-frame result");
	if (
		value.operationId !== input.operationId ||
		value.projectId !== input.projectId ||
		value.sceneId !== input.sceneId ||
		value.revision !== input.expectedRevision ||
		value.writeVersion !== input.expectedWriteVersion ||
		value.saveReceiptId !== input.expectedSaveReceiptId ||
		value.saveReceiptOperationId !== input.saveReceiptOperationId ||
		!isRecord(value.saveReceipt) ||
		value.saveReceipt.operationId !== input.saveReceiptOperationId ||
		typeof value.sha256 !== "string" ||
		typeof value.pixelRgbaSha256 !== "string" ||
		typeof value.bytesWritten !== "number" ||
		typeof value.width !== "number" ||
		typeof value.height !== "number" ||
		typeof value.requestedTicks !== "number" ||
		typeof value.resolvedTicks !== "number" ||
		typeof value.frameIndex !== "number" ||
		typeof value.ticksPerFrame !== "number" ||
		!isRecord(value.fps) ||
		typeof value.fps.numerator !== "number" ||
		typeof value.fps.denominator !== "number" ||
		!isRecord(value.renderer) ||
		value.renderer.provider !== "opencut-web-renderer" ||
		value.renderer.pipeline !== "editor-native-exact-frame" ||
		value.renderer.compositor !== "opencut-wasm-webgl" ||
		value.renderer.encoder !== "browser-canvas-png" ||
		typeof value.renderer.browser !== "string" ||
		!isRecord(value.renderer.executionIdentity) ||
		!isRecord(value.fontReadiness) ||
		!isRecord(value.editorState) ||
		!isRecord(value.sourceVerification)
	)
		throw new Error(
			"editor exact-frame evidence is incomplete or source-mismatched",
		);
	return value as Record<string, unknown> & {
		sha256: string;
		pixelRgbaSha256: string;
		bytesWritten: number;
		width: number;
		height: number;
		requestedTicks: number;
		resolvedTicks: number;
		frameIndex: number;
		ticksPerFrame: number;
		fps: { numerator: number; denominator: number };
		rounding: "exact" | "floor" | "nearest" | "ceil";
		saveReceipt: Record<string, unknown>;
		renderer: Record<string, unknown>;
		fontReadiness: Record<string, unknown>;
		editorState: Record<string, unknown>;
		sourceVerification: Record<string, unknown>;
	};
}

function response(
	receipt: PreviewFrameReceipt,
	status: "rendered" | "replayed",
) {
	return {
		status,
		contractVersion: 2,
		receiptId: receipt.receiptId,
		operationId: receipt.operationId,
		projectId: receipt.projectId,
		sceneId: receipt.sceneId,
		revision: receipt.revision,
		contentIdentity: {
			status: "hashed",
			hash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion:
					readPersistedProjectContentProjectionVersion(
						receipt.saveReceipt.contentHashProjectionVersion,
					) ?? 1,
				digest: receipt.contentHash,
			},
		},
		writeVersion: receipt.writeVersion,
		saveReceiptId: receipt.saveReceiptId,
		saveReceiptOperationId: receipt.saveReceiptOperationId,
		saveReceipt: receipt.saveReceipt,
		requestedTime: receipt.requestedTime,
		requestedTicks: receipt.requestedTicks,
		resolvedTicks: receipt.resolvedTicks,
		frameIndex: receipt.frameIndex,
		fps: receipt.fps,
		ticksPerFrame: receipt.ticksPerFrame,
		rounding: receipt.rounding,
		artifact: receipt.artifact,
		mimeType: "image/png",
		outputPath: receipt.artifact.path,
		bytesWritten: receipt.artifact.bytes,
		sha256: receipt.artifact.sha256,
		pixelRgbaSha256: receipt.artifact.pixelRgbaSha256,
		renderer: receipt.renderer,
		fontReadiness: receipt.fontReadiness,
		editorState: receipt.editorState,
		sourceVerification: receipt.sourceVerification,
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
