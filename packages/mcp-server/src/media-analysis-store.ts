import { createHash, randomBytes } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	validateMediaAnalysis,
	verifyMediaAnalysis,
} from "./native-media-foundation";

export class MediaAnalysisStore {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = resolve(directory);
	}

	async readiness(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
	}

	async create(
		operationId: string,
		analysis: Record<string, unknown>,
		now = new Date().toISOString(),
	): Promise<
		| {
				status: "created" | "replayed";
				analysis: Record<string, unknown>;
				affectedObjects: Array<{
					objectType: "media-analysis";
					objectId: string;
					action: "created";
				}>;
		  }
		| {
				status: "rejected";
				code: string;
				reason: string;
				affectedObjects: [];
		  }
	> {
		const analysisId = stringField(analysis, "analysisId");
		if (!analysisId) throw new Error("analysisId is required");
		const existing = await this.get(analysisId);
		const validation = validateMediaAnalysis({
			operationId,
			createdAt: existing ? String(existing.createdAt) : now,
			analysis,
		});
		if (validation.status === "rejected") {
			return { ...validation, affectedObjects: [] };
		}
		if (existing) {
			if (
				existing.operationId !== operationId ||
				existing.contentHash !== validation.analysis.contentHash
			) {
				return {
					status: "rejected",
					code: "MEDIA_ANALYSIS_ID_REUSED",
					reason:
						"analysisId was already used for a different operation or semantic input",
					affectedObjects: [],
				};
			}
			return result("replayed", existing);
		}
		await this.write(validation.analysis);
		return result("created", validation.analysis);
	}

	async get(analysisId: string): Promise<Record<string, unknown> | null> {
		const path = this.path(analysisId);
		if (!(await stat(path).catch(() => null))) return null;
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new Error(`durable media analysis is invalid: ${path}`);
		}
		const validation = verifyMediaAnalysis(raw);
		if (validation.status === "rejected") {
			throw new Error(
				`durable media analysis failed Rust verification (${validation.code}): ${validation.reason}`,
			);
		}
		if (validation.analysis.analysisId !== analysisId) {
			throw new Error(
				"durable media analysis identity does not match its path",
			);
		}
		return validation.analysis;
	}

	private path(analysisId: string): string {
		return join(this.directory, `${sha256(analysisId)}.json`);
	}

	private async write(analysis: Record<string, unknown>): Promise<void> {
		await this.readiness();
		const analysisId = stringField(analysis, "analysisId");
		if (!analysisId) throw new Error("validated analysis omitted analysisId");
		const path = this.path(analysisId);
		const temporary = join(
			this.directory,
			`.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
		);
		try {
			await writeFile(temporary, `${JSON.stringify(analysis, null, 2)}\n`, {
				flag: "wx",
			});
			await link(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}

function result(
	status: "created" | "replayed",
	analysis: Record<string, unknown>,
) {
	return {
		status,
		analysis,
		affectedObjects: [
			{
				objectType: "media-analysis" as const,
				objectId: String(analysis.analysisId),
				action: "created" as const,
			},
		],
	};
}

function stringField(
	value: Record<string, unknown>,
	field: string,
): string | null {
	return typeof value[field] === "string" && value[field].length > 0
		? value[field]
		: null;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
