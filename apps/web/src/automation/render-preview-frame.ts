import type { EditorCore } from "@/core";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { storageService } from "@/services/storage/service";
import { calculateTotalDuration, type SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { buildEditorProjectContentInput } from "./project-content-identity";
import { hashProjectContent } from "./project-content-hash";
import type { ProjectContentHashResult } from "./project-content-hash";
import { parsePersistedSaveProjectResult } from "./save-project-receipt";
import type {
	AutomationRenderPreviewFrameRequest,
	AutomationRenderPreviewFrameResult,
	AutomationSaveReceipt,
} from "./types";
import { resolvePreviewFrameTime } from "./preview-frame-time";

const FONT_READY_TIMEOUT_MS = 30_000;

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

async function loadVerifiedDurableSource(
	request: AutomationRenderPreviewFrameRequest,
): Promise<Awaited<ReturnType<typeof storageService.loadProjectFresh>> | null> {
	const readback = await storageService.loadProjectFresh({
		id: request.projectId,
	});
	if (
		!readback ||
		!readback.project.scenes.some((scene) => scene.id === request.sceneId) ||
		readback.persistence.writeVersion !== request.expectedWriteVersion
	)
		return null;
	const identity = await hashProjectContent(
		buildEditorProjectContentInput({
			project: readback.project,
			mediaAssets: readback.mediaAssets,
		}),
	);
	return identity.status === "hashed" &&
		identity.hash.digest === request.expectedProjectContentHash
		? readback
		: null;
}

function saveReceiptMatches({
	request,
	receipt,
}: {
	request: AutomationRenderPreviewFrameRequest;
	receipt: AutomationSaveReceipt | undefined;
}): boolean {
	return Boolean(
		receipt &&
		receipt.receiptId === request.expectedSaveReceiptId &&
		receipt.operationId === request.saveReceiptOperationId &&
		receipt.projectId === request.projectId &&
		receipt.contentHash === request.expectedProjectContentHash &&
		receipt.readbackContentHash === request.expectedProjectContentHash &&
		receipt.writeVersion === request.expectedWriteVersion &&
		receipt.reloadVerified === true,
	);
}

function editorState(editor: EditorCore) {
	const selectionFingerprint = JSON.stringify(editor.selection.getSnapshot());
	const state = {
		playheadTicks: editor.playback.getCurrentTime(),
		isPlaying: editor.playback.getIsPlaying(),
		selectionFingerprint,
		canUndo: editor.command.canUndo(),
		canRedo: editor.command.canRedo(),
	};
	return { ...state, fingerprint: JSON.stringify(state) };
}

async function waitForFonts(tracks: SceneTracks): Promise<{
	status: "ready";
	families: string[];
	descriptors: Array<{
		family: string;
		style: string;
		weight: string;
		stretch: string;
		css: string;
		identitySha256: string;
		matchedFaceIdentities: string[];
		matchedFaces: Array<{
			provenance: "font-face-set" | "system-local-font-face";
			family: string;
			style: string;
			weight: string;
			stretch: string;
			unicodeRange: string;
			featureSettings: string;
			display: string;
			identitySha256: string;
		}>;
	}>;
	descriptorsSha256: string;
}> {
	if (!document.fonts) throw new Error("font readiness API is unavailable");
	const requested = collectFontDescriptors(tracks);
	const loadedByDescriptor = await Promise.race([
		Promise.all([
			document.fonts.ready.then(() => [] as FontFace[]),
			...requested.map((descriptor) => document.fonts.load(descriptor.css)),
		]),
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("font readiness timed out")),
				FONT_READY_TIMEOUT_MS,
			),
		),
	]);
	const descriptors = [];
	for (const [index, descriptor] of requested.entries()) {
		if (!document.fonts.check(descriptor.css)) {
			throw new Error(`font failed readiness verification: ${descriptor.css}`);
		}
		const loadedForDescriptor = loadedByDescriptor[index + 1] ?? [];
		let matchingFaces = exactFontFaces({
			faces: [...loadedForDescriptor, ...document.fonts],
			descriptor,
			provenance: "font-face-set",
		});
		if (matchingFaces.length === 0) {
			const localFace = new FontFace(
				descriptor.family,
				`local(${JSON.stringify(descriptor.family)})`,
				{
					style: descriptor.style,
					weight: descriptor.weight,
					stretch: descriptor.stretch,
				},
			);
			await localFace.load();
			document.fonts.add(localFace);
			matchingFaces = exactFontFaces({
				faces: [localFace],
				descriptor,
				provenance: "system-local-font-face",
			});
		}
		if (matchingFaces.length === 0) {
			throw new Error(
				`no exact loaded face matches persisted font descriptor: ${descriptor.css}`,
			);
		}
		const matchedFaces = await Promise.all(
			matchingFaces.map(async (face) => ({
				...face,
				identitySha256: await sha256Bytes(
					new TextEncoder().encode(JSON.stringify(face)),
				),
			})),
		);
		matchedFaces.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
		const matchedFaceIdentities = matchedFaces
			.map(({ identitySha256 }) => identitySha256)
			.sort((left, right) => left.localeCompare(right));
		const identitySha256 = await sha256Bytes(
			new TextEncoder().encode(JSON.stringify(descriptor)),
		);
		descriptors.push({
			...descriptor,
			identitySha256,
			matchedFaceIdentities,
			matchedFaces,
		});
	}
	return {
		status: "ready",
		families: [...new Set(requested.map(({ family }) => family))].sort(),
		descriptors,
		descriptorsSha256: await sha256Bytes(
			new TextEncoder().encode(JSON.stringify(descriptors)),
		),
	};
}

function collectFontDescriptors(tracks: SceneTracks): Array<{
	family: string;
	style: string;
	weight: string;
	stretch: string;
	css: string;
}> {
	const values = new Map<
		string,
		{
			family: string;
			style: string;
			weight: string;
			stretch: string;
			css: string;
		}
	>();
	const add = (params: {
		fontFamily?: unknown;
		fontStyle?: unknown;
		fontWeight?: unknown;
		fontStretch?: unknown;
	}) => {
		const family =
			typeof params.fontFamily === "string" && params.fontFamily
				? params.fontFamily
				: "Arial";
		const style =
			typeof params.fontStyle === "string" ? params.fontStyle : "normal";
		const weight =
			typeof params.fontWeight === "string" ||
			typeof params.fontWeight === "number"
				? String(params.fontWeight)
				: "normal";
		const stretch =
			typeof params.fontStretch === "string" ? params.fontStretch : "normal";
		const escapedFamily = family.replaceAll('"', '\\"');
		const css = `${style} ${weight} ${stretch === "normal" ? "" : `${stretch} `}16px "${escapedFamily}"`;
		const descriptor = { family, style, weight, stretch, css };
		values.set(JSON.stringify(descriptor), descriptor);
	};
	const visit = (sceneTracks: SceneTracks) => {
		for (const track of [
			sceneTracks.main,
			...sceneTracks.overlay,
			...sceneTracks.audio,
		]) {
			for (const element of track.elements) {
				if (element.type === "text") add(element.params);
				if ("masks" in element) {
					for (const mask of element.masks ?? []) {
						if (mask.type === "text") add(mask.params);
					}
				}
				if (element.type === "compound") visit(element.tracks);
			}
		}
	};
	visit(tracks);
	return [...values.values()].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function normalizeFontFamily(value: string): string {
	return value.trim().replace(/^['"]|['"]$/g, "");
}

function exactFontFaces({
	faces,
	descriptor,
	provenance,
}: {
	faces: FontFace[];
	descriptor: {
		family: string;
		style: string;
		weight: string;
		stretch: string;
	};
	provenance: "font-face-set" | "system-local-font-face";
}) {
	const unique = new Map<string, Omit<FontFaceEvidence, "identitySha256">>();
	for (const face of faces) {
		if (
			face.status !== "loaded" ||
			normalizeFontFamily(face.family).toLocaleLowerCase() !==
				normalizeFontFamily(descriptor.family).toLocaleLowerCase() ||
			normalizeFontStyle(face.style) !== normalizeFontStyle(descriptor.style) ||
			normalizeFontWeight(face.weight) !==
				normalizeFontWeight(descriptor.weight) ||
			normalizeFontStretch(face.stretch) !==
				normalizeFontStretch(descriptor.stretch)
		) {
			continue;
		}
		const evidence = {
			provenance,
			family: normalizeFontFamily(face.family),
			style: normalizeFontStyle(face.style),
			weight: normalizeFontWeight(face.weight),
			stretch: normalizeFontStretch(face.stretch),
			unicodeRange: face.unicodeRange,
			featureSettings: face.featureSettings,
			display: face.display,
		};
		unique.set(JSON.stringify(evidence), evidence);
	}
	return [...unique.values()];
}

type FontFaceEvidence = {
	provenance: "font-face-set" | "system-local-font-face";
	family: string;
	style: string;
	weight: string;
	stretch: string;
	unicodeRange: string;
	featureSettings: string;
	display: string;
	identitySha256: string;
};

function normalizeFontStyle(value: string): string {
	return value.trim().toLocaleLowerCase() || "normal";
}

function normalizeFontWeight(value: string): string {
	const normalized = value.trim().toLocaleLowerCase();
	if (normalized === "normal") return "400";
	if (normalized === "bold") return "700";
	return normalized;
}

function normalizeFontStretch(value: string): string {
	const normalized = value.trim().toLocaleLowerCase();
	const named: Record<string, string> = {
		"ultra-condensed": "50%",
		"extra-condensed": "62.5%",
		condensed: "75%",
		"semi-condensed": "87.5%",
		normal: "100%",
		"semi-expanded": "112.5%",
		expanded: "125%",
		"extra-expanded": "150%",
		"ultra-expanded": "200%",
	};
	return named[normalized] ?? normalized;
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) =>
				blob
					? resolve(blob)
					: reject(new Error("PNG encoder returned no bytes")),
			"image/png",
		);
	});
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

async function sha256Bytes(
	bytes: Uint8Array | Uint8ClampedArray,
): Promise<string> {
	const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const copied = new Uint8Array(view.byteLength);
	copied.set(view);
	const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
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
