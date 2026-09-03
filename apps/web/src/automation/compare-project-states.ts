import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { extractTimelineAudioRange } from "@/media/mediabunny";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import { ComparisonSourceUnavailableError } from "@/services/storage/project-snapshot-storage";
import { calculateTotalDuration } from "@/timeline";
import type { FrameRangeSchedule } from "opencut-wasm";
import { canvasPng, editorState, sha256Bytes } from "./preview-render-common";
import { waitForFonts } from "./preview-font-readiness";
import { extractAudioUntilCancelled } from "./range-audio-cancellation";
import {
	resolveRetainedRenderSource,
	type RetainedRenderSource,
} from "./retained-render-source";
import type {
	AutomationCompareProjectStatesRequest,
	AutomationCompareProjectStatesResult,
	AutomationComparisonSideEvidence,
	AutomationComparisonSourceBinding,
} from "./types";
import type { ProjectContentHashResult } from "./project-content-hash";

export async function compareAutomationProjectStates({
	editor,
	request,
	verifyCurrentSource,
}: {
	editor: EditorCore;
	request: AutomationCompareProjectStatesRequest;
	verifyCurrentSource: () => Promise<{
		revision: number;
		contentIdentity: ProjectContentHashResult;
	}>;
}): Promise<AutomationCompareProjectStatesResult> {
	try {
		const stateBefore = editorState(editor);
		const liveBefore = await verifyCurrentSource();
		if (liveBefore.contentIdentity.status !== "hashed") {
			return rejected({
				request,
				code: "SOURCE_CONFLICT",
				reason: "live project content identity is blocked",
			});
		}
		const liveBeforeHash = liveBefore.contentIdentity.hash;
		const [before, after] = await Promise.all([
			resolveRetainedRenderSource({
				binding: resolverBinding({ request, binding: request.before }),
			}),
			resolveRetainedRenderSource({
				binding: resolverBinding({ request, binding: request.after }),
			}),
		]);
		validateExactSettings({ request, before, after });

		const fonts = await waitForFonts([before.scene.tracks, after.scene.tracks]);
		const { readRenderEnvironment } =
			await import("@/services/renderer/render-environment");
		const renderEnvironment = await readRenderEnvironment();
		if (renderEnvironment.status !== "ready")
			throw new Error(
				`renderer unavailable: ${renderEnvironment.reason ?? renderEnvironment.status}`,
			);
		const rendererSettingsDigest = await sha256Bytes(
			new TextEncoder().encode(
				JSON.stringify({
					provider: "opencut-web-renderer",
					compositor: "opencut-wasm-webgl",
					backend: renderEnvironment.backend,
					surfaceFormat: renderEnvironment.surfaceFormat,
					capabilitySnapshotHash: request.capabilitySnapshotHash,
					wasmSha256: request.wasmSha256 ?? null,
				}),
			),
		);
		const { planComparison } = await import("opencut-wasm");
		const evaluation = planComparison({
			before: renderSource({ source: before, rendererSettingsDigest }),
			after: renderSource({ source: after, rendererSettingsDigest }),
			range: request.range,
			limits: request.limits,
		});
		if (evaluation.status === "rejected")
			return rejected({
				request,
				code: evaluation.code,
				reason: evaluation.reason,
			});
		const schedule = evaluation.plan.schedule;

		let beforeProgress = await uploadJson({
			url: `${request.beforeBaseUrl}/manifest`,
			value: schedule,
		});
		let afterProgress = await uploadJson({
			url: `${request.afterBaseUrl}/manifest`,
			value: schedule,
		});
		if (
			beforeProgress.cancellationRequested ||
			afterProgress.cancellationRequested
		)
			return finish("cancelled");

		const objectUrls: string[] = [];
		const beforeMedia = hydrateMedia({ source: before, objectUrls });
		const afterMedia = hydrateMedia({ source: after, objectUrls });
		const renderer = new CanvasRenderer({
			...request.canvasSize,
			fps: before.settings.fps,
		});
		const canvas = document.createElement("canvas");
		canvas.width = request.canvasSize.width;
		canvas.height = request.canvasSize.height;
		try {
			beforeProgress = await renderFrames({
				source: before,
				mediaAssets: beforeMedia,
				baseUrl: request.beforeBaseUrl,
				schedule,
				renderer,
				canvas,
			});
			if (beforeProgress.cancellationRequested) return finish("cancelled");
			afterProgress = await renderFrames({
				source: after,
				mediaAssets: afterMedia,
				baseUrl: request.afterBaseUrl,
				schedule,
				renderer,
				canvas,
			});
			if (afterProgress.cancellationRequested) return finish("cancelled");

			if (request.output.includeAudio) {
				beforeProgress = await renderAudio({
					source: before,
					baseUrl: request.beforeBaseUrl,
					schedule,
				});
				if (beforeProgress.cancellationRequested) return finish("cancelled");
				afterProgress = await renderAudio({
					source: after,
					baseUrl: request.afterBaseUrl,
					schedule,
				});
				if (afterProgress.cancellationRequested) return finish("cancelled");
			}
			return finish("rendered");
		} finally {
			for (const url of objectUrls) URL.revokeObjectURL(url);
		}

		async function finish(
			status: "rendered" | "cancelled",
		): Promise<AutomationCompareProjectStatesResult> {
			const stateAfter = editorState(editor);
			const liveAfter = await verifyCurrentSource();
			if (
				stateBefore.fingerprint !== stateAfter.fingerprint ||
				liveBefore.revision !== liveAfter.revision ||
				liveAfter.contentIdentity.status !== "hashed"
			)
				return rejected({
					request,
					code: "SOURCE_CONFLICT",
					reason: "live editor state changed during historical comparison",
				});
			if (
				liveBeforeHash.digest !== liveAfter.contentIdentity.hash.digest ||
				liveBeforeHash.projectionVersion !==
					liveAfter.contentIdentity.hash.projectionVersion
			)
				return rejected({
					request,
					code: "SOURCE_CONFLICT",
					reason: "live project content changed during historical comparison",
				});
			const fontReadiness = { ...fonts, substituted: false as const };
			return {
				status,
				contractVersion: 1,
				operationId: request.operationId,
				projectId: request.projectId,
				sceneId: request.sceneId,
				revision: liveAfter.revision,
				contentHash: liveAfter.contentIdentity.hash.digest,
				contentHashProjectionVersion:
					liveAfter.contentIdentity.hash.projectionVersion,
				capabilitySnapshotHash: request.capabilitySnapshotHash,
				normalization: request.normalization,
				schedule,
				before: sideEvidence({
					request,
					binding: request.before,
					source: before,
					schedule,
					fontReadiness,
					rendererSettingsDigest,
				}),
				after: sideEvidence({
					request,
					binding: request.after,
					source: after,
					schedule,
					fontReadiness,
					rendererSettingsDigest,
				}),
				renderer: {
					provider: "opencut-web-renderer",
					pipeline: "editor-native-before-after-comparison",
					compositor: "opencut-wasm-webgl",
					browser: navigator.userAgent,
					encoder: "browser-canvas-png-sequence",
					environment: {
						...renderEnvironment,
						capabilitySnapshotHash: request.capabilitySnapshotHash,
						...(request.wasmSha256 ? { wasmSha256: request.wasmSha256 } : {}),
						rendererSettingsDigest,
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
			error instanceof Error ? error.message : "comparison renderer failed";
		return rejected({
			request,
			code:
				error instanceof ComparisonSourceUnavailableError
					? "COMPARISON_SOURCE_UNAVAILABLE"
					: reason.includes("font")
						? "FONT_READINESS_FAILED"
						: "RENDERER_FAILED",
			reason,
		});
	}
}

function resolverBinding({
	request,
	binding,
}: {
	request: AutomationCompareProjectStatesRequest;
	binding: AutomationComparisonSourceBinding;
}) {
	return {
		projectId: request.projectId,
		sceneId: request.sceneId,
		revision: binding.revision,
		contentHash: {
			algorithm: "SHA-256" as const,
			projection: binding.projectionName,
			projectionVersion: binding.projectionVersion,
			digest: binding.projectContentHash,
		},
		writeVersion: binding.writeVersion,
		saveReceiptOperationId: binding.saveReceiptOperationId,
		saveReceiptId: binding.saveReceiptId,
	};
}

function validateExactSettings({
	request,
	before,
	after,
}: {
	request: AutomationCompareProjectStatesRequest;
	before: RetainedRenderSource;
	after: RetainedRenderSource;
}) {
	const exact = JSON.stringify;
	if (
		exact(request.normalization) !==
			exact({
				canvas: "none",
				color: "none",
				fonts: "exact",
				timing: "shared-schedule",
			}) ||
		exact(before.settings.canvasSize) !== exact(after.settings.canvasSize) ||
		exact(before.settings.canvasSize) !== exact(request.canvasSize) ||
		exact(before.settings.fps) !== exact(after.settings.fps)
	)
		throw new Error(
			"comparison would require forbidden canvas, timing, color, or font normalization",
		);
}

function renderSource({
	source,
	rendererSettingsDigest,
}: {
	source: RetainedRenderSource;
	rendererSettingsDigest: string;
}) {
	return {
		canvas: source.settings.canvasSize,
		rate: source.settings.fps,
		sceneDurationTicks: calculateTotalDuration({ tracks: source.scene.tracks }),
		rendererSettingsDigest,
	};
}

function hydrateMedia({
	source,
	objectUrls,
}: {
	source: RetainedRenderSource;
	objectUrls: string[];
}) {
	return source.mediaAssets.map((asset) => {
		const url = URL.createObjectURL(asset.file);
		objectUrls.push(url);
		return { ...asset, url } as MediaAsset;
	});
}

async function renderFrames({
	source,
	mediaAssets,
	baseUrl,
	schedule,
	renderer,
	canvas,
}: {
	source: RetainedRenderSource;
	mediaAssets: MediaAsset[];
	baseUrl: string;
	schedule: FrameRangeSchedule;
	renderer: CanvasRenderer;
	canvas: HTMLCanvasElement;
}) {
	const duration = calculateTotalDuration({ tracks: source.scene.tracks });
	const node = buildScene({
		tracks: source.scene.tracks,
		mediaAssets,
		duration,
		canvasSize: source.settings.canvasSize,
		background: source.settings.background,
		isPreview: false,
	});
	let progress = { cancellationRequested: false };
	for (const frame of schedule.frames) {
		await renderer.renderToCanvas({
			node,
			time: frame.timelineTicks,
			targetCanvas: canvas,
		});
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context)
			throw new Error("renderer did not expose a 2D comparison surface");
		const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
		progress = await uploadBlob({
			url: `${baseUrl}/frames/${frame.ordinal}`,
			body: await canvasPng(canvas),
			headers: {
				"Content-Type": "image/png",
				"X-OpenCut-Pixel-Rgba-Sha256": await sha256Bytes(rgba),
			},
		});
		if (progress.cancellationRequested) break;
	}
	return progress;
}

async function renderAudio({
	source,
	baseUrl,
	schedule,
}: {
	source: RetainedRenderSource;
	baseUrl: string;
	schedule: FrameRangeSchedule;
}) {
	const duration = calculateTotalDuration({ tracks: source.scene.tracks });
	const startTicks = schedule.resolvedStartTicks;
	const endTicksExclusive = Math.min(
		schedule.resolvedEndTicksExclusive,
		duration,
	);
	const audio = await extractAudioUntilCancelled({
		baseUrl,
		extract: () =>
			extractTimelineAudioRange({
				tracks: source.scene.tracks,
				mediaAssets: source.mediaAssets,
				startTicks,
				endTicksExclusive,
			}),
	});
	if (audio.status === "cancelled") return { cancellationRequested: true };
	return uploadBlob({
		url: `${baseUrl}/audio`,
		body: audio.audio,
		headers: {
			"Content-Type": "audio/wav",
			"X-OpenCut-Audio-Start-Ticks": String(startTicks),
			"X-OpenCut-Audio-End-Ticks-Exclusive": String(endTicksExclusive),
		},
	});
}

function sideEvidence({
	request,
	binding,
	source,
	schedule,
	fontReadiness,
	rendererSettingsDigest,
}: {
	request: AutomationCompareProjectStatesRequest;
	binding: AutomationComparisonSourceBinding;
	source: RetainedRenderSource;
	schedule: FrameRangeSchedule;
	fontReadiness: AutomationComparisonSideEvidence["fontReadiness"];
	rendererSettingsDigest: string;
}): AutomationComparisonSideEvidence {
	return {
		projectId: request.projectId,
		sceneId: request.sceneId,
		binding,
		schedule,
		renderSource: renderSource({ source, rendererSettingsDigest }),
		fontReadiness,
		saveReceipt: source.saveReceipt,
		sourceVerification: {
			retainedSnapshot: true,
			expiresAt: source.retention.expiresAt,
			mediaSha256: source.mediaAssets
				.map((asset) => asset.sourceIdentity.contentHash?.digest)
				.filter((value): value is string => typeof value === "string")
				.sort(),
		},
	};
}

async function uploadJson({ url, value }: { url: string; value: unknown }) {
	return uploadBlob({
		url,
		body: new Blob([JSON.stringify(value)], { type: "application/json" }),
		headers: { "Content-Type": "application/json" },
	});
}

async function uploadBlob({
	url,
	body,
	headers,
}: {
	url: string;
	body: Blob;
	headers: Record<string, string>;
}) {
	const response = await fetch(url, { method: "PUT", headers, body });
	if (!response.ok)
		throw new Error(`comparison upload failed with HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("comparison upload returned an invalid progress receipt");
	if (!("cancellationRequested" in value))
		throw new Error("comparison progress receipt has no cancellation state");
	if (typeof value.cancellationRequested !== "boolean")
		throw new Error("comparison progress cancellation state is invalid");
	return { cancellationRequested: value.cancellationRequested };
}

function rejected({
	request,
	code,
	reason,
}: {
	request: AutomationCompareProjectStatesRequest;
	code: string;
	reason: string;
}): AutomationCompareProjectStatesResult {
	return {
		status: code === "SOURCE_CONFLICT" ? "conflict" : "rejected",
		operationId: request.operationId,
		code,
		reason,
	};
}
