import type { EditorBridge } from "./editor-bridge";
import {
	requestLedgeredBrowserStep,
	type McpOperationExecutionContext,
} from "./mcp-ledger-boundary";
import type { SubtitleFiles } from "./subtitle-files";

const BROWSER_STEP = "import-subtitles:browser-mutation";
const SOURCE_CHECKPOINT = "import-subtitles:source";

export type SubtitleImportInput = Record<string, unknown> & {
	path: string;
	operationId: string;
	projectId: string;
};

export class SubtitleImportOperation {
	constructor(
		private readonly bridge: EditorBridge,
		private readonly subtitleFiles: Pick<SubtitleFiles, "read">,
	) {}

	async execute(
		input: SubtitleImportInput,
		context: McpOperationExecutionContext,
	): Promise<unknown> {
		const source = await this.subtitleFiles.read(input.path);
		await context.checkpoint({
			checkpoint: {
				checkpointId: checkpointId(input.operationId),
				kind: "filesystem",
				state: "verified",
				recordedAt: new Date().toISOString(),
				metadata: {
					sourcePath: input.path,
					fileName: source.fileName,
					sourceBytes: source.bytesRead,
					sourceSha256: source.contentHash,
				},
			},
		});
		const { path: _path, ...params } = input;
		const mutation = await requestLedgeredBrowserStep(
			context,
			this.bridge,
			"import_subtitles",
			{
				...params,
				fileName: source.fileName,
				input: source.input,
				contentHash: source.contentHash,
			},
			BROWSER_STEP,
		);
		return finalize(mutation, sourceMetadata(context, input.operationId));
	}

	async recover(
		input: SubtitleImportInput,
		context: McpOperationExecutionContext,
	): Promise<unknown | null> {
		const source = sourceMetadata(context, input.operationId);
		if (!source || source.sourcePath !== input.path) return null;
		const mutation = await context.recoverBrowserStep(BROWSER_STEP);
		return mutation === null ? null : finalize(mutation, source);
	}
}

function checkpointId(operationId: string): string {
	return `${operationId}:${SOURCE_CHECKPOINT}`;
}

function sourceMetadata(
	context: McpOperationExecutionContext,
	operationId: string,
): SourceMetadata | null {
	const metadata = context
		.record()
		.checkpoints.find(
			(candidate) => candidate.checkpointId === checkpointId(operationId),
		)?.metadata;
	if (!metadata) return null;
	if (
		typeof metadata.sourcePath !== "string" ||
		typeof metadata.fileName !== "string" ||
		typeof metadata.sourceBytes !== "number" ||
		!Number.isSafeInteger(metadata.sourceBytes) ||
		metadata.sourceBytes <= 0 ||
		typeof metadata.sourceSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(metadata.sourceSha256)
	) {
		return null;
	}
	return {
		sourcePath: metadata.sourcePath,
		fileName: metadata.fileName,
		sourceBytes: metadata.sourceBytes,
		sourceSha256: metadata.sourceSha256,
	};
}

function finalize(mutation: unknown, source: SourceMetadata | null): unknown {
	if (!source || !isRecord(mutation)) return mutation;
	return {
		...mutation,
		sourcePath: source.sourcePath,
		sourceBytes: source.sourceBytes,
		sourceSha256: source.sourceSha256,
	};
}

interface SourceMetadata {
	sourcePath: string;
	fileName: string;
	sourceBytes: number;
	sourceSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
