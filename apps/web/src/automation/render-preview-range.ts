import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { extractTimelineAudioRange } from "@/media/mediabunny";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { VideoCache } from "@/services/video-cache/service";
import { storageService } from "@/services/storage/service";
import { calculateTotalDuration } from "@/timeline";
import { scheduleFrameRange } from "@/services/renderer/frame-schedule";
import type { ProjectContentHashResult } from "./project-content-hash";
import { parsePersistedSaveProjectResult } from "./save-project-receipt";
import {
	canvasPng,
	editorState,
	loadVerifiedDurableSource,
	saveReceiptMatches,
	sha256Bytes,
} from "./preview-render-common";
import { waitForFonts } from "./preview-font-readiness";
import { extractAudioUntilCancelled } from "./range-audio-cancellation";
import type {
	AutomationRenderPreviewRangeRequest,
	AutomationRenderPreviewRangeResult,
} from "./types";

export async function renderAutomationPreviewRange({
	editor,
	request,
	revision,
	contentHash,
	verifyCurrentSource,
}: {
	editor: EditorCore;
	request: AutomationRenderPreviewRangeRequest;
	revision: number;
	contentHash: string;
	verifyCurrentSource: () => Promise<{
		revision: number;
		contentIdentity: ProjectContentHashResult;
	}>;
}): Promise<AutomationRenderPreviewRangeResult> {
	try {
		const project = editor.project.getActive();
		if (
			!project ||
			project.metadata.id !== request.projectId ||
			revision !== request.expectedRevision ||
			contentHash !== request.expectedProjectContentHash
		)
			return rejected(
				request,
				"SOURCE_CONFLICT",
				"active source binding changed before render",
			);

		const saveEnvelope = await storageService.loadSaveReceipt({
			operationId: request.saveReceiptOperationId,
			parseResult: parsePersistedSaveProjectResult,
		});
		const saveReceipt = saveEnvelope?.result;
		if (
			!saveReceipt ||
			!saveReceiptMatches({
				request,
				receipt: saveReceipt,
			})
		)
			return rejected(
				request,
				"SAVE_RECEIPT_CONFLICT",
				"verified save receipt binding does not match the range request",
			);
		const verifiedSaveReceipt = saveReceipt;
		const durable = await loadVerifiedDurableSource(request);
		if (!durable)
			return rejected(
				request,
				"SAVE_RECEIPT_CONFLICT",
				"fresh persisted project readback does not match the range request",
			);

		const persistedScene = durable.project.scenes.find(
			(scene) => scene.id === request.sceneId,
		)!;
		const fps = durable.project.settings.fps;
		const duration = calculateTotalDuration({ tracks: persistedScene.tracks });
		const evaluation = await scheduleFrameRange({
			rate: fps,
			sceneDurationTicks: duration,
			range: request.range,
			limits: request.limits,
		});
		if (evaluation.status === "rejected")
			return rejected(request, evaluation.code, evaluation.reason);
		const schedule = evaluation.schedule;

		const stateBefore = editorState(editor);
		const fonts = await waitForFonts(persistedScene.tracks);
		const { readRenderEnvironment } =
			await import("@/services/renderer/render-environment");
		const renderEnvironment = await readRenderEnvironment();
		if (renderEnvironment.status !== "ready")
			throw new Error(
				`renderer unavailable: ${renderEnvironment.reason ?? renderEnvironment.status}`,
			);

		let progress = await uploadJson(`${request.baseUrl}/manifest`, schedule);
		if (progress.cancellationRequested) return finish("cancelled");

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
		// Exact evidence renders own a private frame cache so the live preview
		// loop cannot hand them a superseded frame from the shared cache.
		const exactVideoCache = new VideoCache({ exact: true });
		const renderer = new CanvasRenderer({
			...request.canvasSize,
			fps,
			videoCache: exactVideoCache,
		});
		try {
			for (const frame of schedule.frames) {
				await renderer.renderToCanvas({
					node: sceneNode,
					time: frame.timelineTicks,
					targetCanvas: canvas,
				});
				const context = canvas.getContext("2d", { willReadFrequently: true });
				if (!context)
					throw new Error("renderer did not expose a 2D evidence surface");
				const pixels = context.getImageData(
					0,
					0,
					canvas.width,
					canvas.height,
				).data;
				const pixelRgbaSha256 = await sha256Bytes(pixels);
				const blob = await canvasPng(canvas);
				progress = await uploadBlob(
					`${request.baseUrl}/frames/${frame.ordinal}`,
					blob,
					{
						"Content-Type": "image/png",
						"X-OpenCut-Pixel-Rgba-Sha256": pixelRgbaSha256,
					},
				);
				if (progress.cancellationRequested) return finish("cancelled");
			}
		} finally {
			for (const url of objectUrls) URL.revokeObjectURL(url);
			exactVideoCache.clearAll();
		}

		if (request.output.includeAudio) {
			const audioStartTicks = schedule.resolvedStartTicks;
			const audioEndTicksExclusive = Math.min(
				schedule.resolvedEndTicksExclusive,
				duration,
			);
			const audioResult = await extractAudioUntilCancelled({
				baseUrl: request.baseUrl,
				extract: () =>
					extractTimelineAudioRange({
						tracks: persistedScene.tracks,
						mediaAssets: durable.mediaAssets,
						startTicks: audioStartTicks,
						// A frame-index range may include the scene's final partial frame.
						// Do not synthesize audio beyond the persisted scene boundary.
						endTicksExclusive: audioEndTicksExclusive,
					}),
			});
			if (audioResult.status === "cancelled") return finish("cancelled");
			progress = await uploadBlob(
				`${request.baseUrl}/audio`,
				audioResult.audio,
				{
					"Content-Type": "audio/wav",
					"X-OpenCut-Audio-Start-Ticks": String(audioStartTicks),
					"X-OpenCut-Audio-End-Ticks-Exclusive": String(audioEndTicksExclusive),
				},
			);
			if (progress.cancellationRequested) return finish("cancelled");
		}
		return finish("rendered");

		async function finish(
			status: "rendered" | "cancelled",
		): Promise<AutomationRenderPreviewRangeResult> {
			const stateAfter = editorState(editor);
			const afterSource = await verifyCurrentSource();
			if (
				stateBefore.fingerprint !== stateAfter.fingerprint ||
				afterSource.revision !== revision ||
				afterSource.contentIdentity.status !== "hashed" ||
				afterSource.contentIdentity.hash.digest !== contentHash ||
				!(await loadVerifiedDurableSource(request))
			)
				return rejected(
					request,
					"SOURCE_CONFLICT",
					"source or editor interaction state changed while rendering",
				);
			return {
				status,
				contractVersion: 1,
				operationId: request.operationId,
				projectId: request.projectId,
				sceneId: request.sceneId,
				revision,
				contentIdentity: afterSource.contentIdentity,
				writeVersion: request.expectedWriteVersion,
				saveReceiptId: request.expectedSaveReceiptId,
				saveReceiptOperationId: request.saveReceiptOperationId,
				saveReceipt: verifiedSaveReceipt,
				capabilitySnapshotHash: request.capabilitySnapshotHash,
				schedule,
				fontReadiness: fonts,
				sourceVerification: {
					revisionBefore: revision,
					revisionAfter: afterSource.revision,
					contentHashBefore: contentHash,
					contentHashAfter: afterSource.contentIdentity.hash.digest,
				},
				renderer: {
					provider: "opencut-web-renderer",
					pipeline: "editor-native-exact-frame-sequence",
					compositor: "opencut-wasm-webgl",
					browser: navigator.userAgent,
					encoder: "browser-canvas-png-sequence",
					environment: {
						...renderEnvironment,
						capabilitySnapshotHash: request.capabilitySnapshotHash,
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
		}
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "preview range renderer failed";
		return rejected(
			request,
			reason.includes("font") ? "FONT_READINESS_FAILED" : "RENDERER_FAILED",
			reason,
		);
	}
}

async function uploadJson(url: string, value: unknown) {
	return uploadBlob(
		url,
		new Blob([JSON.stringify(value)], { type: "application/json" }),
		{
			"Content-Type": "application/json",
		},
	);
}

async function uploadBlob(
	url: string,
	blob: Blob,
	headers: Record<string, string>,
) {
	const response = await fetch(url, { method: "PUT", headers, body: blob });
	if (!response.ok)
		throw new Error(`preview range upload failed with HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("preview range upload returned an invalid receipt");
	return value as { cancellationRequested: boolean };
}

function rejected(
	request: AutomationRenderPreviewRangeRequest,
	code: Extract<
		AutomationRenderPreviewRangeResult,
		{ status: "rejected" | "conflict" }
	>["code"],
	reason: string,
): AutomationRenderPreviewRangeResult {
	return {
		status: code === "SOURCE_CONFLICT" ? "conflict" : "rejected",
		operationId: request.operationId,
		code,
		reason,
	};
}
