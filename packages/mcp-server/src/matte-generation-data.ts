import { basename } from "node:path";
import type { GenerateMatteInput } from "./generate-matte";

interface ProjectSnapshot extends Record<string, unknown> {
	projectId: string;
	revision: number;
	elements: unknown[];
	mediaAssets: unknown[];
}

export function asProjectSnapshot(value: unknown): ProjectSnapshot {
	if (!isRecord(value))
		throw new Error("Editor returned an invalid project snapshot");
	if (
		typeof value.projectId !== "string" ||
		typeof value.revision !== "number" ||
		!Array.isArray(value.elements) ||
		!Array.isArray(value.mediaAssets)
	) {
		throw new Error("Editor returned an incomplete project snapshot");
	}
	return value as ProjectSnapshot;
}

export function findProjectClip({
	snapshot,
	input,
}: {
	snapshot: ProjectSnapshot;
	input: GenerateMatteInput;
}): {
	mediaId: string;
	name: string;
	width: number;
	height: number;
	duration: number;
	fps: number | null;
} {
	const element = snapshot.elements.find(
		(value) =>
			isRecord(value) &&
			value.trackId === input.trackId &&
			value.elementId === input.elementId,
	);
	if (!isRecord(element))
		throw new Error(`element not found: ${input.elementId}`);
	if (element.type !== "video" || typeof element.mediaId !== "string") {
		throw new Error(
			"background mattes can only be generated for video elements",
		);
	}
	const asset = snapshot.mediaAssets.find(
		(value) => isRecord(value) && value.assetId === element.mediaId,
	);
	if (!isRecord(asset))
		throw new Error(`source media not found: ${element.mediaId}`);
	if (
		typeof asset.name !== "string" ||
		typeof asset.width !== "number" ||
		typeof asset.height !== "number" ||
		typeof asset.duration !== "number"
	) {
		throw new Error("source media metadata is incomplete");
	}
	return {
		mediaId: element.mediaId,
		name: asset.name,
		width: asset.width,
		height: asset.height,
		duration: asset.duration,
		fps: typeof asset.fps === "number" ? asset.fps : null,
	};
}

export function asTransferResult(value: unknown): Record<string, unknown> & {
	status: string;
	mediaId: string;
	name: string;
	mimeType: string;
	bytesTransferred: number;
	sourceFingerprint: string | null;
} {
	if (!isRecord(value) || typeof value.status !== "string") {
		throw new Error("Editor returned an invalid source transfer result");
	}
	return value as ReturnType<typeof asTransferResult>;
}

export function asAttachmentResult(
	value: unknown,
): Record<string, unknown> & { status: string } {
	if (!isRecord(value) || typeof value.status !== "string") {
		throw new Error("Editor returned an invalid matte attachment result");
	}
	return value as ReturnType<typeof asAttachmentResult>;
}

export function sanitizeFileName(value: string): string {
	return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_") || "source.bin";
}

export function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
