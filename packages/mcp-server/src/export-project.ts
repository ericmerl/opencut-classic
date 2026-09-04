import { createHash } from "node:crypto";
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
	videoCodec?: "avc" | "vp9";
	quality: "low" | "medium" | "high" | "very_high";
	fps?: { numerator: number; denominator: number };
	includeAudio: boolean;
	canvasSize?: { width: number; height: number };
	renderOverlay?: ExportRenderOverlay;
	expectedProjectContentHash?: string;
	queuedProjectPersistence?: QueuedProjectPersistence;
	capabilitySnapshotHash?: string;
}

export interface ExportRenderOverlay {
	version: 1;
	canvasSize?: { width: number; height: number };
	safeZones?: Array<{
		id: string;
		x: number;
		y: number;
		width: number;
		height: number;
	}>;
	tracks?: { include?: string[]; exclude?: string[] };
	elements?: Array<{
		elementId: string;
		layout?: {
			positionX?: number;
			positionY?: number;
			scaleX?: number;
			scaleY?: number;
			rotate?: number;
			targetSafeZoneId?: string;
		};
		reframe?: {
			mode?: "contain" | "cover" | "stretch";
			crop?: NormalizedRect;
			focalPoint?: NormalizedPoint;
			targetRect?: NormalizedRect;
		};
		subjectSafeFocalPolicy?:
			| { kind: "preserve" }
			| { kind: "fixed"; focalPoint: NormalizedPoint }
			| { kind: "safe-zone-center"; safeZoneId: string };
	}>;
	captions?: {
		mode: "preserve" | "on" | "off";
		trackIds?: string[];
		elementIds?: string[];
		style?: {
			fontFamily?: string;
			fontSize?: number;
			fontWeight?: "normal" | "bold";
			fontStyle?: "normal" | "italic";
			color?: string;
			textAlign?: "left" | "center" | "right";
			backgroundEnabled?: boolean;
			backgroundColor?: string;
			backgroundPerLine?: boolean;
			highlightEnabled?: boolean;
			highlightColor?: string;
		};
		position?: { x: number; y: number };
		positionSafeZoneId?: string;
	};
	coverFrame?:
		| { kind: "frame-index"; frameIndex: number }
		| {
				kind: "media-time";
				ticks: number;
				rounding: "exact" | "floor" | "nearest" | "ceil";
		  };
}

interface NormalizedPoint {
	x: number;
	y: number;
}

interface NormalizedRect extends NormalizedPoint {
	width: number;
	height: number;
}

export interface QueuedProjectPersistence {
	contentHash: string;
	contentHashProjectionVersion: 1 | 2 | 3;
	writeVersion: number;
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
			options?: { cancellationRequested?: () => boolean },
		): Promise<{ url: string; outputPath: string }>;
	};
}

export class ExportProjectService {
	constructor(
		private bridge: ExportProjectBridge,
		private receipts: ExportReceiptStore,
		private validator: ExportValidator,
		private capabilitySnapshot?: () => Promise<unknown>,
	) {}

	async export(
		input: ExportProjectInput,
		options: {
			cancellationRequested?: () => boolean;
			onPhase?: (phase: string) => void;
		} = {},
	): Promise<Record<string, unknown>> {
		const expectedIdentity = expectedV2Identity(input);
		const requestIdentity =
			input.requestConnectionIdentity ?? expectedIdentity ?? null;
		const {
			capabilitySnapshotHash: _capabilitySnapshotHash,
			...fingerprintedInput
		} = input;
		const fingerprint = stableSerialize({
			...fingerprintedInput,
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
		const renderCapabilitySnapshot = await this.capabilitySnapshot?.();
		const capabilitySnapshotHash =
			input.capabilitySnapshotHash ??
			readCapabilitySnapshotHash(renderCapabilitySnapshot);
		const renderWasmSha256 = readCapabilityWasmSha256(renderCapabilitySnapshot);

		const snapshot = readProjectSnapshot(
			await this.bridge.request(
				"read_project",
				{},
				undefined,
				expectedIdentity,
			),
			input.bridgeProtocolVersion !== 2,
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
		if (
			input.bridgeProtocolVersion === 2 &&
			snapshot.contentIdentity.status !== "hashed"
		) {
			return {
				status: "content-identity-blocked",
				operationId: input.operationId,
				projectId: input.projectId,
				sceneId: snapshot.sceneId,
				contentIdentity: snapshot.contentIdentity,
				reason:
					"Production protocol v2 requires immutable identity for every project media source",
			};
		}
		const snapshotHash =
			snapshot.contentIdentity.status === "hashed"
				? snapshot.contentIdentity.hash.digest
				: null;
		if (
			input.expectedProjectContentHash &&
			input.expectedProjectContentHash !== snapshotHash
		) {
			return {
				status: "content-hash-conflict",
				operationId: input.operationId,
				projectId: input.projectId,
				expectedProjectContentHash: input.expectedProjectContentHash,
				actualProjectContentHash: snapshotHash,
			};
		}
		const saveBarrierValue = await this.bridge.request(
			"save_project",
			{
				projectId: input.projectId,
				sceneId: snapshot.sceneId,
				operationId: `${input.operationId}:save-barrier`,
				expectedRevision: input.expectedRevision,
				...(snapshotHash ? { expectedContentHash: snapshotHash } : {}),
				...(input.bridgeProtocolVersion
					? { bridgeProtocolVersion: input.bridgeProtocolVersion }
					: {}),
				...(requestIdentity
					? { expectedConnectionIdentity: requestIdentity }
					: {}),
			},
			5 * 60_000,
			expectedIdentity,
		);
		if (!isRecord(saveBarrierValue)) {
			throw new Error("editor returned an invalid save barrier result");
		}
		const saveBarrier = saveBarrierValue;
		if (saveBarrier.status !== "saved" && saveBarrier.status !== "replayed") {
			return saveBarrier;
		}
		if (
			typeof saveBarrier.contentHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(saveBarrier.contentHash) ||
			(snapshotHash !== null && saveBarrier.contentHash !== snapshotHash) ||
			saveBarrier.reloadVerified !== true
		) {
			return {
				status: "verification-failed",
				operationId: input.operationId,
				projectId: input.projectId,
				reason: "verified save receipt did not match the export snapshot",
			};
		}
		const pinnedContentHash = saveBarrier.contentHash;
		await this.validator.preflight();

		const ticket = await this.bridge.exportTickets.create(
			input.outputPath,
			input.format,
			{ cancellationRequested: options.cancellationRequested },
		);
		const editorResult = readCompletedExport(
			await this.bridge.request(
				"export_project",
				{
					projectId: input.projectId,
					operationId: input.operationId,
					expectedRevision: input.expectedRevision,
					format: input.format,
					...(input.videoCodec ? { videoCodec: input.videoCodec } : {}),
					quality: input.quality,
					...(input.fps ? { fps: input.fps } : {}),
					includeAudio: input.includeAudio,
					...(input.canvasSize ? { canvasSize: input.canvasSize } : {}),
					...(input.renderOverlay
						? { renderOverlay: input.renderOverlay }
						: {}),
					outputPath: ticket.outputPath,
					url: ticket.url,
					expectedProjectContentHash: pinnedContentHash,
					...(capabilitySnapshotHash ? { capabilitySnapshotHash } : {}),
					...(renderWasmSha256 ? { wasmSha256: renderWasmSha256 } : {}),
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
		const renderedContentIdentity = readContentIdentity(
			editorResult.contentIdentity,
			input.bridgeProtocolVersion !== 2,
		);
		const renderedHash =
			renderedContentIdentity.status === "hashed"
				? renderedContentIdentity.hash.digest
				: null;
		if (renderedHash !== pinnedContentHash) {
			return {
				status: "content-hash-conflict",
				operationId: input.operationId,
				projectId: input.projectId,
				expectedProjectContentHash: pinnedContentHash,
				actualProjectContentHash: renderedHash,
				reason: "project content changed while the export was rendering",
			};
		}

		const outputIdentity = readOutputIdentity(editorResult);
		const resolvedRenderSpecification = readRecordField(
			editorResult,
			"resolvedRenderSpecification",
		);
		const sourceReadback = readRecordField(editorResult, "sourceReadback");
		if (!resolvedRenderSpecification || !sourceReadback) {
			throw new Error(
				"editor export did not report its resolved render specification and persisted readback",
			);
		}
		let validation: ExportMediaValidation | { status: "failed"; error: string };
		try {
			options.onPhase?.("validating");
			await this.validator.verifyOutput(outputIdentity);
			validation = await this.validator.validate({
				operationId: input.operationId,
				outputPath: outputIdentity.outputPath,
				format: input.format,
				expectedWidth:
					input.renderOverlay?.canvasSize?.width ??
					input.canvasSize?.width ??
					snapshot.width,
				expectedHeight:
					input.renderOverlay?.canvasSize?.height ??
					input.canvasSize?.height ??
					snapshot.height,
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

		const browserRenderEnvironment = readRecordField(
			editorResult,
			"renderEnvironment",
		);
		const renderEnvironment = browserRenderEnvironment
			? {
					...browserRenderEnvironment,
					wasmSha256:
						readStringField(browserRenderEnvironment, "wasmSha256") ??
						renderWasmSha256,
				}
			: null;
		const result: Record<string, unknown> = {
			...editorResult,
			projectId: snapshot.projectId,
			sceneId: snapshot.sceneId,
			projectContentIdentity: snapshot.contentIdentity,
			saveReceiptId: saveBarrier.receiptId,
			savedContentHash: saveBarrier.contentHash,
			requestedRenderOverlay: input.renderOverlay ?? null,
			resolvedRenderSpecification,
			sourceReadback,
			requestConnectionIdentity: requestIdentity,
			bridgeProtocolVersion: editorResult.bridgeProtocolVersion,
			status:
				validation.status === "validated" ? "exported" : "validation-failed",
			validation,
			receiptPath: this.receipts.receiptPath(input.operationId),
			exportReceiptId: input.operationId,
			container: input.format,
			...(capabilitySnapshotHash ? { capabilitySnapshotHash } : {}),
			renderer: {
				provider: "opencut-web-renderer",
				pipeline: "editor-native-export",
				protocolVersion: input.bridgeProtocolVersion ?? 1,
				...(renderEnvironment
					? {
							environment: {
								...renderEnvironment,
								fingerprint: sha256(stableSerialize(renderEnvironment)),
							},
						}
					: {}),
			},
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

function readCapabilitySnapshotHash(value: unknown): string | undefined {
	return isRecord(value) && typeof value.snapshotHash === "string"
		? value.snapshotHash
		: typeof value === "string"
			? value
			: undefined;
}

function readCapabilityWasmSha256(value: unknown): string | null {
	if (!isRecord(value) || !isRecord(value.renderer)) return null;
	const wasm = value.renderer.wasm;
	return isRecord(wasm) && typeof wasm.sha256 === "string" ? wasm.sha256 : null;
}

function readRecordField(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | null {
	return isRecord(value[key]) ? value[key] : null;
}

function readStringField(
	value: Record<string, unknown>,
	key: string,
): string | null {
	return typeof value[key] === "string" ? value[key] : null;
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

function readProjectSnapshot(
	value: unknown,
	allowLegacyMissingContentIdentity: boolean,
): {
	projectId: string;
	sceneId: string;
	revision: number;
	width: number;
	height: number;
	fps: { numerator: number; denominator: number };
	bridgeProtocolVersion: unknown;
	connectionIdentity: unknown;
	requestConnectionIdentity: unknown;
	contentIdentity: ProjectContentIdentity;
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
		contentIdentity: readContentIdentity(
			value.contentIdentity,
			allowLegacyMissingContentIdentity,
		),
	};
}

type ProjectContentIdentity =
	| {
			status: "hashed";
			hash: {
				algorithm: "SHA-256";
				projection: string;
				projectionVersion: number;
				digest: string;
			};
	  }
	| { status: "blocked"; blockers: unknown[] };

function readContentIdentity(
	value: unknown,
	allowLegacyMissing: boolean,
): ProjectContentIdentity {
	if (!isRecord(value)) {
		if (allowLegacyMissing) {
			return {
				status: "blocked",
				blockers: [{ code: "legacy-editor-content-identity-missing" }],
			};
		}
		throw new Error("editor project content identity is missing");
	}
	if (value.status === "blocked" && Array.isArray(value.blockers)) {
		return { status: "blocked", blockers: value.blockers };
	}
	if (
		value.status !== "hashed" ||
		!isRecord(value.hash) ||
		value.hash.algorithm !== "SHA-256" ||
		value.hash.projection !== "opencut-project-content" ||
		(value.hash.projectionVersion !== 1 &&
			value.hash.projectionVersion !== 2 &&
			value.hash.projectionVersion !== 3) ||
		typeof value.hash.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.hash.digest)
	) {
		throw new Error("editor project content identity is invalid");
	}
	return {
		status: "hashed",
		hash: {
			algorithm: "SHA-256",
			projection: value.hash.projection,
			projectionVersion: value.hash.projectionVersion,
			digest: value.hash.digest,
		},
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

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
