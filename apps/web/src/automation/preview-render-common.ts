import type { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import { buildEditorProjectContentInput } from "./project-content-identity";
import { hashProjectContent } from "./project-content-hash";
import type { AutomationSaveReceipt } from "./types";

export interface PreviewSourceBindingRequest {
	projectId: string;
	sceneId: string;
	expectedProjectContentHash: string;
	expectedWriteVersion: number;
	saveReceiptOperationId: string;
	expectedSaveReceiptId: string;
}

export async function loadVerifiedDurableSource(
	request: PreviewSourceBindingRequest,
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

export function saveReceiptMatches({
	request,
	receipt,
}: {
	request: PreviewSourceBindingRequest;
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

export function editorState(editor: EditorCore) {
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

export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
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

export async function sha256Bytes(
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
