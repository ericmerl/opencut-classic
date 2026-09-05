import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	getApprovedModelCatalog,
	type ApprovedModel,
	type ApprovedRuntimeProbeInput,
	validateApprovedModelReadiness,
} from "./native-media-foundation";

type ArtifactInspection = { sha256: string; bytes: number };

export interface ApprovedModelCacheOptions {
	fetch?: Fetcher;
	inspectArtifact?: (path: string) => Promise<ArtifactInspection>;
	licenseSourceRoot?: string;
}

export class ApprovedModelCache {
	private readonly root: string;
	private readonly fetch: Fetcher;
	private readonly inspectArtifact: (
		path: string,
	) => Promise<ArtifactInspection>;
	private readonly licenseSourceRoot: string;

	constructor(root: string, options: ApprovedModelCacheOptions = {}) {
		this.root = resolve(root);
		this.fetch = options.fetch ?? globalThis.fetch;
		this.inspectArtifact = options.inspectArtifact ?? inspectArtifact;
		this.licenseSourceRoot = resolve(
			options.licenseSourceRoot ??
				join(
					import.meta.dir,
					"../../../rust/crates/media-foundation/vendor/approved-models",
				),
		);
	}

	models(): ApprovedModel[] {
		return getApprovedModelCatalog().models;
	}

	pathFor(taskId: string): string {
		const model = this.model(taskId);
		const path = resolve(
			this.root,
			"v1",
			model.taskId,
			model.artifact.cacheKey,
			model.artifact.filename,
		);
		if (
			!path.startsWith(`${this.root}\\`) &&
			!path.startsWith(`${this.root}/`)
		) {
			throw new Error("MODEL_CACHE_PATH_ESCAPE");
		}
		return path;
	}

	async readiness(taskId: string, runtime?: ApprovedRuntimeProbeInput) {
		const model = this.model(taskId);
		const cachePath = this.pathFor(taskId);
		let artifact: ArtifactInspection | undefined;
		try {
			const entry = await lstat(cachePath);
			if (!entry.isFile() || entry.isSymbolicLink()) {
				return this.failure(
					model,
					cachePath,
					"MODEL_CACHE_ENTRY_UNSAFE",
					"misconfigured",
				);
			}
			artifact = await this.inspectArtifact(cachePath);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const validation = validateApprovedModelReadiness({
			taskId,
			artifact,
			runtime,
		});
		if (validation.status === "rejected") {
			return this.failure(
				model,
				cachePath,
				validation.code,
				"misconfigured",
				validation.reason,
			);
		}
		if (validation.readiness.artifactStatus === "ready") {
			const licenses = await this.verifyLicenseBundle(
				dirname(cachePath),
				model,
			);
			if (!licenses.ok) {
				return this.failure(
					model,
					cachePath,
					licenses.code,
					"misconfigured",
					licenses.reason,
				);
			}
		}
		return {
			...validation.readiness,
			cachePath,
			artifact: {
				status: validation.readiness.artifactStatus,
				sha256: model.artifact.sha256,
				bytes: model.artifact.bytes,
			},
			model,
		};
	}

	async acquire(taskId: string) {
		const model = this.model(taskId);
		const cachePath = this.pathFor(taskId);
		const existing = await this.readiness(taskId);
		if (existing.artifact.status === "ready") {
			await this.installLicenses(dirname(cachePath), model);
			return { status: "cached" as const, cachePath, model };
		}
		if ("code" in existing && existing.code === "MODEL_LICENSE_MISSING") {
			await this.installLicenses(dirname(cachePath), model);
			return { status: "cached" as const, cachePath, model };
		}
		if (existing.status === "misconfigured") {
			throw new Error(`${existing.code}: ${existing.reason}`);
		}
		const source = new URL(model.artifact.sourceUrl);
		if (
			source.protocol !== "https:" ||
			!APPROVED_DOWNLOAD_HOSTS.has(source.hostname)
		) {
			throw new Error("MODEL_SOURCE_NOT_APPROVED");
		}
		await mkdir(dirname(cachePath), { recursive: true });
		const temporaryPath = `${cachePath}.partial-${process.pid}-${randomUUID()}`;
		try {
			const response = await this.fetch(source, { redirect: "follow" });
			if (!response.ok || !response.body) {
				throw new Error(`MODEL_DOWNLOAD_FAILED: HTTP ${response.status}`);
			}
			await pipeline(
				Readable.fromWeb(response.body as never),
				createWriteStream(temporaryPath, { flags: "wx" }),
			);
			const observed = await inspectArtifact(temporaryPath);
			if (observed.sha256 !== model.artifact.sha256) {
				throw new Error("MODEL_ARTIFACT_HASH_MISMATCH");
			}
			if (observed.bytes !== model.artifact.bytes) {
				throw new Error("MODEL_ARTIFACT_SIZE_MISMATCH");
			}
			await rename(temporaryPath, cachePath);
			await this.installLicenses(dirname(cachePath), model);
			return { status: "downloaded" as const, cachePath, model, observed };
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	async acquireAll() {
		const results = [];
		for (const model of this.models())
			results.push(await this.acquire(model.taskId));
		return results;
	}

	private model(taskId: string) {
		const model = this.models().find(
			(candidate) => candidate.taskId === taskId,
		);
		if (!model) throw new Error(`UNKNOWN_MEDIA_TASK_ID: ${taskId}`);
		return model;
	}

	private async installLicenses(directory: string, model: ApprovedModel) {
		for (const filename of [
			model.license.bundledLicensePath,
			model.license.bundledNoticePath,
		]) {
			const source = resolve(this.licenseSourceRoot, filename);
			const target = resolve(directory, filename);
			if (
				!source.startsWith(`${this.licenseSourceRoot}\\`) &&
				!source.startsWith(`${this.licenseSourceRoot}/`)
			) {
				throw new Error("MODEL_LICENSE_PATH_ESCAPE");
			}
			try {
				await copyFile(source, target, constants.COPYFILE_EXCL);
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				const [expected, actual] = await Promise.all([
					readFile(source),
					readFile(target),
				]);
				if (!expected.equals(actual)) throw new Error("MODEL_LICENSE_MISMATCH");
			}
		}
	}

	private async verifyLicenseBundle(directory: string, model: ApprovedModel) {
		try {
			for (const filename of [
				model.license.bundledLicensePath,
				model.license.bundledNoticePath,
			]) {
				const [expected, actual] = await Promise.all([
					readFile(resolve(this.licenseSourceRoot, filename)),
					readFile(resolve(directory, filename)),
				]);
				if (!expected.equals(actual))
					return {
						ok: false as const,
						code: "MODEL_LICENSE_MISMATCH",
						reason:
							"Cached license/notice bytes differ from the vendored terms.",
					};
			}
			return { ok: true as const };
		} catch (error) {
			if (isMissing(error))
				return {
					ok: false as const,
					code: "MODEL_LICENSE_MISSING",
					reason: "The approved model license/notice bundle is missing.",
				};
			throw error;
		}
	}

	private failure(
		model: ApprovedModel,
		cachePath: string,
		code: string,
		status: "misconfigured",
		reason = code,
	) {
		return {
			status,
			canExecute: false,
			code,
			reason,
			cachePath,
			artifact: {
				status: "invalid",
				sha256: model.artifact.sha256,
				bytes: model.artifact.bytes,
			},
			model,
		};
	}
}

const APPROVED_DOWNLOAD_HOSTS = new Set([
	"huggingface.co",
	"zenodo.org",
	"raw.githubusercontent.com",
]);

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

async function inspectArtifact(path: string): Promise<ArtifactInspection> {
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(path)) {
		const buffer = Buffer.from(chunk);
		bytes += buffer.byteLength;
		hash.update(buffer);
	}
	return { sha256: hash.digest("hex"), bytes };
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "EEXIST"
	);
}
