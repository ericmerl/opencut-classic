import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { EditorBridge } from "./editor-bridge";
import type { OperationExecutionContext } from "./execute-ledgered-operation";
import { parseJsonValue, type JsonValue } from "./operation-ledger-schema";
import type { SubtitleFiles } from "./subtitle-files";

export interface SubtitleExportOperationInput extends Record<string, unknown> {
	operationId: string;
	outputPath: string;
	format: "srt" | "vtt" | "ass";
}

export async function executeSubtitleExport(
	bridge: Pick<EditorBridge, "request">,
	files: Pick<SubtitleFiles, "write">,
	input: SubtitleExportOperationInput,
	context: OperationExecutionContext,
): Promise<unknown> {
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "prepared", {
			outputPath: input.outputPath,
		}),
	});
	const { operationId, outputPath, ...request } = input;
	const serialized = await bridge.request("export_subtitles", request);
	if (!isSerializedSubtitles(serialized)) return serialized;
	const bytes = Buffer.from(serialized.content, "utf8");
	const expected = {
		status: "exported",
		operationId,
		projectId: serialized.projectId,
		sceneId: serialized.sceneId,
		revision: serialized.revision,
		format: serialized.format,
		trackIds: serialized.trackIds,
		cueCount: serialized.cueCount,
		lossReport: serialized.lossReport ?? null,
		bridgeProtocolVersion: serialized.bridgeProtocolVersion,
		connectionIdentity: serialized.connectionIdentity,
		requestConnectionIdentity: serialized.requestConnectionIdentity,
		contentIdentity: serialized.contentIdentity,
		outputPath: resolve(outputPath),
		bytesWritten: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "prepared", {
			outputPath: input.outputPath,
			expectedResult: parseJsonValue(expected),
		}),
	});
	const receipt = await files.write({
		path: outputPath,
		format: input.format,
		content: serialized.content,
	});
	if (
		receipt.outputPath !== expected.outputPath ||
		receipt.bytesWritten !== expected.bytesWritten ||
		receipt.sha256 !== expected.sha256
	) {
		throw new Error("subtitle publication differs from its prepared identity");
	}
	const completed = { ...expected, ...receipt };
	await context.checkpoint({
		checkpoint: checkpoint(input.operationId, "committed", {
			result: parseJsonValue(completed),
		}),
		artifacts: [subtitleArtifact(input, receipt)],
	});
	return completed;
}

export async function recoverSubtitleExport(
	bridge: Pick<EditorBridge, "request">,
	files: Pick<SubtitleFiles, "read" | "write">,
	input: SubtitleExportOperationInput,
	context: OperationExecutionContext,
): Promise<unknown | null> {
	const durable = context
		.record()
		.checkpoints.find(
			(candidate) =>
				candidate.checkpointId === input.operationId &&
				candidate.kind === "filesystem",
		);
	if (!durable) return null;
	const candidate =
		durable.state === "prepared"
			? durable.metadata.expectedResult
			: durable.metadata.result;
	if (!isPublishedResult(candidate)) {
		return (await fileExists(input.outputPath))
			? null
			: executeSubtitleExport(bridge, files, input, context);
	}
	const file = await files.read(input.outputPath).catch(() => null);
	if (!file) {
		return (await fileExists(input.outputPath))
			? null
			: executeSubtitleExport(bridge, files, input, context);
	}
	if (
		file.contentHash !== candidate.sha256 ||
		file.bytesRead !== candidate.bytesWritten
	)
		return null;
	return { ...candidate, status: "replayed" };
}

function subtitleArtifact(
	input: SubtitleExportOperationInput,
	receipt: { outputPath: string; bytesWritten: number; sha256: string },
) {
	return {
		artifactId: input.operationId,
		kind: "subtitle" as const,
		state: "verified" as const,
		sha256: receipt.sha256,
		bytes: receipt.bytesWritten,
		path: receipt.outputPath,
		mimeType:
			input.format === "srt"
				? "application/x-subrip"
				: input.format === "ass"
					? "text/x-ssa"
					: "text/vtt",
	};
}

function checkpoint(
	operationId: string,
	state: "prepared" | "committed",
	metadata: Record<string, JsonValue>,
) {
	return {
		checkpointId: operationId,
		kind: "filesystem" as const,
		state,
		recordedAt: new Date().toISOString(),
		metadata,
	};
}

async function fileExists(path: string): Promise<boolean> {
	return Boolean(await stat(path).catch(() => null));
}

function isPublishedResult(
	value: JsonValue | undefined,
): value is Record<string, JsonValue> & {
	sha256: string;
	bytesWritten: number;
} {
	return (
		isRecord(value) &&
		typeof value.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.sha256) &&
		typeof value.bytesWritten === "number" &&
		Number.isInteger(value.bytesWritten) &&
		value.bytesWritten > 0
	);
}

function isSerializedSubtitles(value: unknown): value is {
	projectId: string;
	sceneId: string;
	revision: number;
	format: "srt" | "vtt" | "ass";
	trackIds: string[];
	cueCount: number;
	content: string;
	lossReport?: unknown;
	bridgeProtocolVersion?: 1 | 2;
	connectionIdentity?: unknown;
	requestConnectionIdentity?: unknown;
	contentIdentity?: unknown;
} {
	if (!isRecord(value)) return false;
	return (
		value.status === "serialized" &&
		typeof value.projectId === "string" &&
		typeof value.sceneId === "string" &&
		typeof value.revision === "number" &&
		(value.format === "srt" ||
			value.format === "vtt" ||
			value.format === "ass") &&
		Array.isArray(value.trackIds) &&
		typeof value.cueCount === "number" &&
		typeof value.content === "string"
	);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
