import type { ExportReceiptStore } from "./export-receipts";
import type {
	ExportMediaValidation,
	ExportValidator,
} from "./export-validator";
import { stableSerialize } from "./matte-generation-data";
import type { BridgeConnectionIdentity } from "./editor-bridge";

export interface ExportProjectInput {
	bridgeProtocolVersion?: 1 | 2;
	expectedConnectionIdentity?: BridgeConnectionIdentity;
	requestConnectionIdentity?: BridgeConnectionIdentity;
	projectId: string;
	operationId: string;
	expectedRevision: number;
	outputPath: string;
	format: "mp4" | "webm";
	quality: "low" | "medium" | "high" | "very_high";
	fps?: { numerator: number; denominator: number };
	includeAudio: boolean;
	canvasSize?: { width: number; height: number };
}

export interface ExportProjectBridge {
	request(
		method: string,
		params: unknown,
		timeoutMs?: number,
		expectedIdentity?: BridgeConnectionIdentity,
	): Promise<unknown>;
	exportTickets: {
		create(
			path: string,
			format: "mp4" | "webm",
		): Promise<{ url: string; outputPath: string }>;
	};
}

export class ExportProjectService {
	constructor(
		private bridge: ExportProjectBridge,
		private receipts: ExportReceiptStore,
		private validator: ExportValidator,
	) {}

	async export(input: ExportProjectInput): Promise<Record<string, unknown>> {
		const expectedIdentity = expectedV2Identity(input);
		const requestIdentity =
			input.requestConnectionIdentity ?? expectedIdentity ?? null;
		const fingerprint = stableSerialize({
			...input,
			expectedConnectionIdentity: requestIdentity,
			requestConnectionIdentity: undefined,
		});
		const prior = await this.receipts.get(input.operationId);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for a different durable export",
				);
			}
			const identity = readOutputIdentity(prior.result);
			await this.validator.verifyOutput(identity);
			return {
				...prior.result,
				status:
					prior.result.status === "validation-failed"
						? "validation-failed"
						: "replayed",
				replayed: true,
				inspection: prior.inspection,
				receiptPath: this.receipts.receiptPath(input.operationId),
			};
		}

		const snapshot = readProjectSnapshot(
			await this.bridge.request(
				"read_project",
				{},
				undefined,
				expectedIdentity,
			),
		);
		if (snapshot.projectId !== input.projectId) {
			return {
				status: "rejected",
				operationId: input.operationId,
				projectId: input.projectId,
				sceneId: snapshot.sceneId,
				activeProjectId: snapshot.projectId,
				bridgeProtocolVersion: snapshot.bridgeProtocolVersion,
				connectionIdentity: snapshot.connectionIdentity,
				requestConnectionIdentity: requestIdentity,
				reason: `active project is ${snapshot.projectId}`,
			};
		}
		if (snapshot.revision !== input.expectedRevision) {
			return {
				status: "conflict",
				operationId: input.operationId,
				projectId: input.projectId,
				sceneId: snapshot.sceneId,
				bridgeProtocolVersion: snapshot.bridgeProtocolVersion,
				connectionIdentity: snapshot.connectionIdentity,
				requestConnectionIdentity: requestIdentity,
				expectedRevision: input.expectedRevision,
				actualRevision: snapshot.revision,
			};
		}
		await this.validator.preflight();

		const ticket = await this.bridge.exportTickets.create(
			input.outputPath,
			input.format,
		);
		const editorResult = readCompletedExport(
			await this.bridge.request(
				"export_project",
				{
					projectId: input.projectId,
					operationId: input.operationId,
					expectedRevision: input.expectedRevision,
					format: input.format,
					quality: input.quality,
					...(input.fps ? { fps: input.fps } : {}),
					includeAudio: input.includeAudio,
					...(input.canvasSize ? { canvasSize: input.canvasSize } : {}),
					outputPath: ticket.outputPath,
					url: ticket.url,
				},
				30 * 60_000,
				expectedIdentity,
			),
		);
		if (
			editorResult.status !== "exported" &&
			editorResult.status !== "replayed"
		) {
			return editorResult;
		}

		const outputIdentity = readOutputIdentity(editorResult);
		let validation: ExportMediaValidation | { status: "failed"; error: string };
		try {
			await this.validator.verifyOutput(outputIdentity);
			validation = await this.validator.validate({
				operationId: input.operationId,
				outputPath: outputIdentity.outputPath,
				format: input.format,
				expectedWidth: input.canvasSize?.width ?? snapshot.width,
				expectedHeight: input.canvasSize?.height ?? snapshot.height,
				expectedFps: frameRateValue(input.fps ?? snapshot.fps),
				includeAudio: input.includeAudio,
			});
		} catch (error) {
			validation = {
				status: "failed",
				error:
					error instanceof Error ? error.message : "export validation failed",
			};
		}

		const result: Record<string, unknown> = {
			...editorResult,
			projectId: snapshot.projectId,
			sceneId: snapshot.sceneId,
			requestConnectionIdentity: requestIdentity,
			bridgeProtocolVersion: editorResult.bridgeProtocolVersion,
			status:
				validation.status === "validated" ? "exported" : "validation-failed",
			validation,
			receiptPath: this.receipts.receiptPath(input.operationId),
		};
		const inspection = {
			status: "pending" as const,
			outputSha256: outputIdentity.sha256,
			reviewer: null,
			notes: null,
			inspectedAt: null,
		};
		await this.receipts.write({
			schemaVersion: 1,
			operationId: input.operationId,
			fingerprint,
			createdAt: new Date().toISOString(),
			result,
			inspection,
		});
		return { ...result, inspection };
	}
}

function expectedV2Identity(
	input: ExportProjectInput,
): BridgeConnectionIdentity | undefined {
	if (input.bridgeProtocolVersion !== 2) return undefined;
	if (!input.expectedConnectionIdentity) {
		throw new Error("bridge protocol v2 requires expectedConnectionIdentity");
	}
	return input.expectedConnectionIdentity;
}

function readProjectSnapshot(value: unknown): {
	projectId: string;
	sceneId: string;
	revision: number;
	width: number;
	height: number;
	fps: { numerator: number; denominator: number };
	bridgeProtocolVersion: unknown;
	connectionIdentity: unknown;
	requestConnectionIdentity: unknown;
} {
	if (!isRecord(value) || !isRecord(value.settings)) {
		throw new Error("editor returned an invalid project snapshot");
	}
	const canvas = value.settings.canvasSize;
	const fps = value.settings.fps;
	if (
		typeof value.projectId !== "string" ||
		typeof value.sceneId !== "string" ||
		typeof value.revision !== "number" ||
		!isRecord(canvas) ||
		!isRecord(fps) ||
		typeof canvas.width !== "number" ||
		typeof canvas.height !== "number" ||
		typeof fps.numerator !== "number" ||
		typeof fps.denominator !== "number"
	) {
		throw new Error("editor project settings are incomplete");
	}
	return {
		projectId: value.projectId,
		sceneId: value.sceneId,
		revision: value.revision,
		width: canvas.width,
		height: canvas.height,
		fps: { numerator: fps.numerator, denominator: fps.denominator },
		bridgeProtocolVersion: value.bridgeProtocolVersion ?? null,
		connectionIdentity: value.connectionIdentity ?? null,
		requestConnectionIdentity: value.requestConnectionIdentity ?? null,
	};
}

function readCompletedExport(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || typeof value.status !== "string") {
		throw new Error("editor returned an invalid export result");
	}
	return value;
}

function readOutputIdentity(value: Record<string, unknown>): {
	outputPath: string;
	bytesWritten: number;
	sha256: string;
} {
	if (
		typeof value.outputPath !== "string" ||
		typeof value.bytesWritten !== "number" ||
		typeof value.sha256 !== "string"
	) {
		throw new Error("export result does not contain a complete file identity");
	}
	return {
		outputPath: value.outputPath,
		bytesWritten: value.bytesWritten,
		sha256: value.sha256,
	};
}

function frameRateValue(fps: {
	numerator: number;
	denominator: number;
}): number {
	if (!(fps.numerator > 0) || !(fps.denominator > 0)) {
		throw new Error("expected export frame rate is invalid");
	}
	return fps.numerator / fps.denominator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
