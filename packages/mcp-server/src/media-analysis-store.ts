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
	resolveMediaAnalysisCreate,
	type MediaAnalysisCreateResolution,
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
		const resolution = resolveMediaAnalysisCreate({
			operationId,
			createdAt: now,
			analysis,
			existingAnalysis: existing,
		});
		if (resolution.status !== "created") return result(resolution);
		try {
			await this.write(resolution.analysis);
			return result(resolution);
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			const concurrent = await this.get(analysisId);
			if (!concurrent) throw error;
			return result(
				resolveMediaAnalysisCreate({
					operationId,
					createdAt: now,
					analysis,
					existingAnalysis: concurrent,
				}),
			);
		}
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

function result(resolution: MediaAnalysisCreateResolution) {
	if (resolution.status === "rejected") {
		return { ...resolution, affectedObjects: [] as [] };
	}
	return {
		status: resolution.status,
		analysis: resolution.analysis,
		affectedObjects: [
			{
				objectType: "media-analysis" as const,
				objectId: String(resolution.analysis.analysisId),
				action: "created" as const,
			},
		],
	};
}

function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "EEXIST"
	);
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
