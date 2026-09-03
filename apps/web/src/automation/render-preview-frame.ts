import type { EditorCore } from "@/core";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { storageService } from "@/services/storage/service";
import { calculateTotalDuration } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import type { ProjectContentHashResult } from "./project-content-hash";
import { parsePersistedSaveProjectResult } from "./save-project-receipt";
import type {
	AutomationRenderPreviewFrameRequest,
	AutomationRenderPreviewFrameResult,
} from "./types";
import { resolvePreviewFrameTime } from "./preview-frame-time";
import { waitForFonts } from "./preview-font-readiness";
import {
	canvasPng,
	editorState,
	loadVerifiedDurableSource,
	saveReceiptMatches,
	sha256Bytes,
} from "./preview-render-common";

export async function renderAutomationPreviewFrame({
	editor,
	request,
	revision,
	contentHash,
	verifyCurrentSource,
}: {
	editor: EditorCore;
	request: AutomationRenderPreviewFrameRequest;
	revision: number;
	contentHash: string;
	verifyCurrentSource: () => Promise<{
		revision: number;
		contentIdentity: ProjectContentHashResult;
	}>;
}): Promise<AutomationRenderPreviewFrameResult> {
	try {
		const project = editor.project.getActive();
		if (
			!project ||
			project.metadata.id !== request.projectId ||
			revision !== request.expectedRevision ||
			contentHash !== request.expectedProjectContentHash
		) {
			return rejected({
				request,
				code: "SOURCE_CONFLICT",
				reason: "active source binding changed before render",
			});
		}

		const saveEnvelope = await storageService.loadSaveReceipt({
			operationId: request.saveReceiptOperationId,
			parseResult: parsePersistedSaveProjectResult,
		});
		const saveReceipt = saveEnvelope?.result;
		if (
			!saveReceipt ||
			!saveReceiptMatches({ request, receipt: saveReceipt })
		) {
			return rejected({
				request,
				code: "SAVE_RECEIPT_CONFLICT",
				reason:
					"verified save receipt binding does not match the render request",
			});
		}
		const durable = await loadVerifiedDurableSource(request);
		if (!durable) {
			return rejected({
				request,
				code: "SAVE_RECEIPT_CONFLICT",
				reason:
					"fresh persisted project readback does not match the render request",
			});
		}

		const persistedScene = durable.project.scenes.find(
			(scene) => scene.id === request.sceneId,
		)!;
		const fps = durable.project.settings.fps;
		const timing = resolvePreviewFrameTime({ time: request.time, fps });
		if (timing.status === "error")
			return rejected({ request, code: timing.code, reason: timing.reason });
		const duration = calculateTotalDuration({ tracks: persistedScene.tracks });
		if (duration <= 0 || timing.resolvedTicks >= duration) {
			return rejected({
				request,
				code: "TIME_OUT_OF_BOUNDS",
				reason: "resolved frame is outside the non-empty scene duration",
			});
		}

		const stateBefore = editorState(editor);
		const fonts = await waitForFonts(persistedScene.tracks);
		const { readRenderEnvironment } =
			await import("@/services/renderer/render-environment");
		const renderEnvironment = await readRenderEnvironment();
		if (renderEnvironment.status !== "ready") {
			throw new Error(
				`renderer unavailable: ${renderEnvironment.reason ?? renderEnvironment.status}`,
			);
		}
		const objectUrls: string[] = [];
		const mediaAssets: MediaAsset[] = durable.mediaAssets.map((asset) => {
			const url = URL.createObjectURL(asset.file);
			objectUrls.push(url);
			return { ...asset, url };
		});
		const sceneNode = buildScene({
			tracks: persistedScene.tracks,
			mediaAssets,
			duration,
			canvasSize: request.canvasSize,
			background: durable.project.settings.background,
			isPreview: false,
		});
		const canvas = document.createElement("canvas");
		canvas.width = request.canvasSize.width;
		canvas.height = request.canvasSize.height;
		const renderer = new CanvasRenderer({
			...request.canvasSize,
			fps,
		});
		try {
			await renderer.renderToCanvas({
				node: sceneNode,
				time: timing.resolvedTicks,
				targetCanvas: canvas,
			});
		} finally {
			for (const url of objectUrls) URL.revokeObjectURL(url);
		}
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context)
			throw new Error("renderer did not expose a 2D evidence surface");
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		const pixelRgbaSha256 = await sha256Bytes(pixels);
		const blob = await canvasPng(canvas);
		const stateAfter = editorState(editor);
		const afterSource = await verifyCurrentSource();
		if (
			stateBefore.fingerprint !== stateAfter.fingerprint ||
			afterSource.revision !== revision ||
			afterSource.contentIdentity.status !== "hashed" ||
			afterSource.contentIdentity.hash.digest !== contentHash ||
			!(await loadVerifiedDurableSource(request))
		) {
			return rejected({
				request,
				code: "SOURCE_CONFLICT",
				reason: "source or editor interaction state changed while rendering",
			});
		}
		const upload = await fetch(request.url, {
			method: "PUT",
			headers: { "Content-Type": "image/png" },
			body: blob,
		});
		if (!upload.ok)
			throw new Error(`preview upload failed with HTTP ${upload.status}`);
		const artifact = parsePreviewUpload(await upload.json());

		const { status: _timingStatus, ...resolvedTiming } = timing;
		return {
			status: "rendered",
			contractVersion: 2,
			operationId: request.operationId,
			projectId: request.projectId,
			sceneId: request.sceneId,
			revision,
			contentIdentity: afterSource.contentIdentity,
			writeVersion: request.expectedWriteVersion,
			saveReceiptId: request.expectedSaveReceiptId,
			saveReceiptOperationId: request.saveReceiptOperationId,
			saveReceipt,
			requestedTime: request.time,
			...resolvedTiming,
			width: canvas.width,
			height: canvas.height,
			mimeType: "image/png",
			bytesWritten: artifact.bytesWritten,
			sha256: artifact.sha256,
			pixelRgbaSha256,
			colorSpace: "srgb",
			alphaMode: "straight",
			fontReadiness: fonts,
			sourceVerification: {
				revisionBefore: revision,
				revisionAfter: afterSource.revision,
				contentHashBefore: contentHash,
				contentHashAfter: afterSource.contentIdentity.hash.digest,
			},
			renderer: {
				provider: "opencut-web-renderer",
				pipeline: "editor-native-exact-frame",
				compositor: "opencut-wasm-webgl",
				browser: navigator.userAgent,
				encoder: "browser-canvas-png",
				environment: {
					...renderEnvironment,
					...(request.capabilitySnapshotHash
						? { capabilitySnapshotHash: request.capabilitySnapshotHash }
						: {}),
					...(request.wasmSha256 ? { wasmSha256: request.wasmSha256 } : {}),
				},
				executionIdentity: request.expectedConnectionIdentity,
			},
			editorState: {
				unchanged: true,
				playheadTicks: stateAfter.playheadTicks,
				isPlaying: stateAfter.isPlaying,
				selectionFingerprint: stateAfter.selectionFingerprint,
				canUndo: stateAfter.canUndo,
				canRedo: stateAfter.canRedo,
			},
		};
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "exact-frame renderer failed";
		return rejected({
			request,
			code: message.includes("font")
				? "FONT_READINESS_FAILED"
				: "RENDERER_FAILED",
			reason: message,
		});
	}
}

function parsePreviewUpload(value: unknown): {
	bytesWritten: number;
	sha256: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("preview upload receipt is not an object");
	}
	const bytesWritten = Reflect.get(value, "bytesWritten");
	const sha256 = Reflect.get(value, "sha256");
	if (!Number.isSafeInteger(bytesWritten) || Number(bytesWritten) <= 0) {
		throw new Error("preview upload receipt byte count is invalid");
	}
	if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
		throw new Error("preview upload receipt SHA-256 is invalid");
	}
	return { bytesWritten: Number(bytesWritten), sha256 };
}

function rejected({
	request,
	code,
	reason,
}: {
	request: AutomationRenderPreviewFrameRequest;
	code: Extract<
		AutomationRenderPreviewFrameResult,
		{ status: "rejected" | "conflict" }
	>["code"];
	reason: string;
}): AutomationRenderPreviewFrameResult {
	return {
		status: code === "SOURCE_CONFLICT" ? "conflict" : "rejected",
		operationId: request.operationId,
		code,
		reason,
	};
}
