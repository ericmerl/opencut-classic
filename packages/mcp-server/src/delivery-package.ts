import { createHash, randomBytes } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
	copyFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import type { ExportQcService } from "./export-qc";
import type {
	ExportReceiptRecord,
	ExportReceiptStore,
} from "./export-receipts";
import { stableSerialize } from "./matte-generation-data";

export interface DeliveryPackageInput {
	operationId: string;
	packageName: string;
	outputDirectory: string;
	batchId?: string;
	allowQcWarnings: boolean;
	includeEvidence: boolean;
	master: { exportOperationId: string; qcOperationId: string };
	variants: Array<{
		variantId: string;
		captionMode: "clean" | "burned-in";
		exportOperationId: string;
		qcOperationId: string;
	}>;
	sidecars: Array<{ name: string; sourcePath: string }>;
}

export interface DeliveryPackageFile {
	role:
		| "master"
		| "variant"
		| "sidecar"
		| "cover"
		| "evidence"
		| "export-receipt"
		| "qc-report";
	logicalName: string;
	relativePath: string;
	bytes: number;
	sha256: string;
	sourcePath: string;
	sourceExportOperationId: string | null;
}

export interface DeliveryPackageManifest {
	schemaVersion: 1;
	packageOperationId: string;
	requestFingerprint: string;
	packageName: string;
	createdAt: string;
	projectId: string;
	batchId: string | null;
	sources: Array<{
		logicalName: string;
		role: "master" | "variant";
		variantId: string | null;
		captionMode: "clean" | "burned-in" | null;
		exportOperationId: string;
		qcOperationId: string;
		qcOutcome: "pass" | "warn";
		projectContentHash: string;
		saveReceiptId: string;
		rendererFingerprint: string | null;
	}>;
	files: DeliveryPackageFile[];
}

export interface DeliveryPackageResult {
	status: "packaged" | "replayed" | "verified";
	packageDirectory: string;
	manifestPath: string;
	manifestSha256: string;
	manifest: DeliveryPackageManifest;
}

interface StoredPackageReceipt {
	schemaVersion: 1;
	operationId: string;
	fingerprint: string;
	packageDirectory: string;
	manifestPath: string;
	manifestSha256: string;
}

export class DeliveryPackageService {
	readonly directory: string;

	constructor(
		private receipts: ExportReceiptStore,
		private qc: ExportQcService,
		directory = join(receipts.directory, "packages"),
	) {
		this.directory = resolve(directory);
	}

	async create(input: DeliveryPackageInput): Promise<DeliveryPackageResult> {
		const fingerprint = sha256(stableSerialize(input));
		const existing = await this.readReceipt(input.operationId);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for a different delivery package",
				);
			}
			const verified = await this.verify(input.operationId);
			return { ...verified, status: "replayed" };
		}

		const packageName = slug(input.packageName);
		const parent = resolve(input.outputDirectory);
		const packageDirectory = join(
			parent,
			`${packageName}-${sha256(input.operationId).slice(0, 12)}`,
		);
		const finalInfo = await stat(packageDirectory).catch(() => null);
		if (finalInfo) {
			const manifestPath = join(packageDirectory, "delivery-manifest.json");
			const recovered = await readManifest(manifestPath, input.operationId);
			if (recovered.requestFingerprint !== fingerprint) {
				throw new Error(
					`delivery package destination already exists: ${packageDirectory}`,
				);
			}
			await verifyManifestFiles(packageDirectory, recovered);
			const manifestSha256 = await hashFile(manifestPath);
			await this.writeReceipt({
				schemaVersion: 1,
				operationId: input.operationId,
				fingerprint,
				packageDirectory,
				manifestPath,
				manifestSha256,
			});
			return {
				status: "packaged",
				packageDirectory,
				manifestPath,
				manifestSha256,
				manifest: recovered,
			};
		}
		await mkdir(parent, { recursive: true });
		await mkdir(this.directory, { recursive: true });
		const staging = join(
			parent,
			`.${basename(packageDirectory)}.${randomBytes(10).toString("hex")}.tmp`,
		);
		await mkdir(staging);
		try {
			const prepared = await this.prepareSources(input);
			const files: DeliveryPackageFile[] = [];
			for (const source of prepared) {
				const mediaExtension = extname(source.output.path).toLowerCase();
				const mediaRelative =
					source.role === "master"
						? `master/master${mediaExtension}`
						: `variants/${slug(source.variantId!)}.${source.captionMode}${mediaExtension}`;
				files.push(
					await copyVerified({
						root: staging,
						sourcePath: source.output.path,
						relativePath: mediaRelative,
						role: source.role,
						logicalName: source.logicalName,
						sourceExportOperationId: source.exportOperationId,
					}),
				);
				files.push(
					await copyVerified({
						root: staging,
						sourcePath: this.receipts.receiptPath(source.exportOperationId),
						relativePath: `receipts/${source.logicalName}.export.json`,
						role: "export-receipt",
						logicalName: source.logicalName,
						sourceExportOperationId: source.exportOperationId,
					}),
					await copyVerified({
						root: staging,
						sourcePath: this.qc.reportPath(source.qcOperationId),
						relativePath: `qc/${source.logicalName}.qc.json`,
						role: "qc-report",
						logicalName: source.logicalName,
						sourceExportOperationId: source.exportOperationId,
					}),
					await copyVerified({
						root: staging,
						sourcePath: source.cover.path,
						relativePath: `covers/${source.logicalName}.png`,
						role: "cover",
						logicalName: source.logicalName,
						sourceExportOperationId: source.exportOperationId,
					}),
				);
				if (input.includeEvidence) {
					for (const evidence of source.evidence) {
						files.push(
							await copyVerified({
								root: staging,
								sourcePath: evidence.path,
								relativePath: `evidence/${source.logicalName}-${evidence.position}.png`,
								role: "evidence",
								logicalName: `${source.logicalName}-${evidence.position}`,
								sourceExportOperationId: source.exportOperationId,
							}),
						);
					}
				}
			}
			for (const sidecar of input.sidecars) {
				const extension = extname(sidecar.sourcePath).toLowerCase();
				files.push(
					await copyVerified({
						root: staging,
						sourcePath: resolve(sidecar.sourcePath),
						relativePath: `sidecars/${slug(sidecar.name)}${extension}`,
						role: "sidecar",
						logicalName: sidecar.name,
						sourceExportOperationId: null,
					}),
				);
			}
			const projectIds = new Set(prepared.map((source) => source.projectId));
			if (projectIds.size !== 1) {
				throw new Error(
					"delivery package exports belong to different projects",
				);
			}
			const contentHashes = new Set(
				prepared.map((source) => source.projectContentHash),
			);
			if (contentHashes.size !== 1) {
				throw new Error(
					"delivery package exports belong to different project revisions",
				);
			}
			const manifest: DeliveryPackageManifest = {
				schemaVersion: 1,
				packageOperationId: input.operationId,
				requestFingerprint: fingerprint,
				packageName: input.packageName,
				createdAt: new Date().toISOString(),
				projectId: prepared[0]!.projectId,
				batchId: input.batchId ?? null,
				sources: prepared.map((source) => ({
					logicalName: source.logicalName,
					role: source.role,
					variantId: source.variantId,
					captionMode: source.captionMode,
					exportOperationId: source.exportOperationId,
					qcOperationId: source.qcOperationId,
					qcOutcome: source.qcOutcome,
					projectContentHash: source.projectContentHash,
					saveReceiptId: source.saveReceiptId,
					rendererFingerprint: source.rendererFingerprint,
				})),
				files: files.sort((left, right) =>
					left.relativePath.localeCompare(right.relativePath),
				),
			};
			const stagingManifest = join(staging, "delivery-manifest.json");
			await writeFile(
				stagingManifest,
				`${JSON.stringify(manifest, null, 2)}\n`,
				{ flag: "wx" },
			);
			await rename(staging, packageDirectory);
			const manifestPath = join(packageDirectory, "delivery-manifest.json");
			const manifestSha256 = await hashFile(manifestPath);
			await this.writeReceipt({
				schemaVersion: 1,
				operationId: input.operationId,
				fingerprint,
				packageDirectory,
				manifestPath,
				manifestSha256,
			});
			return {
				status: "packaged",
				packageDirectory,
				manifestPath,
				manifestSha256,
				manifest,
			};
		} catch (error) {
			await rm(staging, { recursive: true, force: true }).catch(
				() => undefined,
			);
			throw error;
		}
	}

	async verify(operationId: string): Promise<DeliveryPackageResult> {
		const stored = await this.readReceipt(operationId);
		if (!stored) throw new Error(`delivery package not found: ${operationId}`);
		if (
			(await hashFile(stored.manifestPath).catch(() => null)) !==
			stored.manifestSha256
		) {
			throw new Error("delivery package manifest changed or is missing");
		}
		const manifest = await readManifest(stored.manifestPath, operationId);
		await verifyManifestFiles(stored.packageDirectory, manifest);
		return {
			status: "verified",
			packageDirectory: stored.packageDirectory,
			manifestPath: stored.manifestPath,
			manifestSha256: stored.manifestSha256,
			manifest,
		};
	}

	private async prepareSources(input: DeliveryPackageInput) {
		const requests = [
			{
				logicalName: "master",
				role: "master" as const,
				variantId: null,
				captionMode: null,
				...input.master,
			},
			...input.variants.map((variant) => ({
				logicalName: slug(variant.variantId),
				role: "variant" as const,
				variantId: variant.variantId,
				captionMode: variant.captionMode,
				exportOperationId: variant.exportOperationId,
				qcOperationId: variant.qcOperationId,
			})),
		];
		return Promise.all(
			requests.map(async (request) => {
				const receipt = await this.receipts.get(request.exportOperationId);
				if (!receipt) {
					throw new Error(
						`export receipt not found: ${request.exportOperationId}`,
					);
				}
				const report = await this.qc.verify(request.qcOperationId);
				if (report.exportOperationId !== request.exportOperationId) {
					throw new Error("QC report does not belong to its package export");
				}
				if (
					report.overall === "fail" ||
					(report.overall === "warn" && !input.allowQcWarnings)
				) {
					throw new Error(
						`QC outcome ${report.overall} blocks packaging for ${request.logicalName}`,
					);
				}
				const source = parseExportSource(receipt);
				if (
					request.captionMode === "clean" &&
					source.renderedCaptionMode !== "off"
				) {
					throw new Error(
						`clean variant ${request.logicalName} was not rendered with captions off`,
					);
				}
				if (
					request.captionMode === "burned-in" &&
					(source.renderedCaptionMode === "off" ||
						source.renderedCaptionCount === 0)
				) {
					throw new Error(
						`burned-in variant ${request.logicalName} was rendered with captions off`,
					);
				}
				return {
					...request,
					qcOutcome: report.overall as "pass" | "warn",
					...source,
				};
			}),
		);
	}

	receiptPath(operationId: string): string {
		return join(this.directory, `${sha256(operationId)}.json`);
	}

	private async readReceipt(
		operationId: string,
	): Promise<StoredPackageReceipt | null> {
		const path = this.receiptPath(operationId);
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) return null;
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new Error(`durable package receipt is invalid: ${path}`);
		}
		if (
			!isRecord(value) ||
			value.schemaVersion !== 1 ||
			value.operationId !== operationId ||
			typeof value.fingerprint !== "string" ||
			typeof value.packageDirectory !== "string" ||
			typeof value.manifestPath !== "string" ||
			typeof value.manifestSha256 !== "string"
		) {
			throw new Error("durable package receipt is incomplete");
		}
		return value as unknown as StoredPackageReceipt;
	}

	private async writeReceipt(receipt: StoredPackageReceipt): Promise<void> {
		const path = this.receiptPath(receipt.operationId);
		await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
		});
	}
}

function parseExportSource(receipt: ExportReceiptRecord) {
	const result = receipt.result;
	const output = fileIdentity({
		path: result.outputPath,
		bytes: result.bytesWritten,
		sha256: result.sha256,
	});
	if (!output)
		throw new Error(`export file identity is missing: ${receipt.operationId}`);
	const validation = requiredRecord(result.validation, "export validation");
	if (validation.status !== "validated") {
		throw new Error(`export did not pass validation: ${receipt.operationId}`);
	}
	const cover = fileIdentity(validation.coverFrame);
	if (!cover)
		throw new Error(`export cover frame is missing: ${receipt.operationId}`);
	const evidence = Array.isArray(validation.frameSamples)
		? validation.frameSamples
				.map((value) => {
					const identity = fileIdentity(value);
					return identity &&
						isRecord(value) &&
						typeof value.position === "string"
						? { ...identity, position: value.position }
						: null;
				})
				.filter((value): value is EvidenceIdentity => value !== null)
		: [];
	if (evidence.length < 3) {
		throw new Error(
			`export frame evidence is incomplete: ${receipt.operationId}`,
		);
	}
	const identity = requiredRecord(
		result.projectContentIdentity,
		"project content identity",
	);
	const hash = requiredRecord(identity.hash, "project content hash");
	const renderer = requiredRecord(result.renderer, "renderer provenance");
	const resolved = requiredRecord(
		result.resolvedRenderSpecification,
		"resolved render specification",
	);
	const captions = requiredRecord(resolved.captions, "resolved caption policy");
	const renderedCaptionMode = requiredString(
		captions.mode,
		"resolved caption mode",
	);
	if (!new Set(["off", "on", "preserve"]).has(renderedCaptionMode)) {
		throw new Error(
			`unsupported resolved caption mode: ${renderedCaptionMode}`,
		);
	}
	if (!Array.isArray(captions.elementIds)) {
		throw new Error("resolved caption element identities are missing");
	}
	const renderedCaptionCount = captions.elementIds.length;
	const environment = isRecord(renderer.environment)
		? renderer.environment
		: null;
	return {
		output,
		cover,
		evidence,
		projectId: requiredString(result.projectId, "project ID"),
		projectContentHash: requiredString(hash.digest, "project content hash"),
		saveReceiptId: requiredString(result.saveReceiptId, "save receipt ID"),
		rendererFingerprint:
			environment && typeof environment.fingerprint === "string"
				? environment.fingerprint
				: null,
		renderedCaptionMode,
		renderedCaptionCount,
	};
}

interface FileIdentity {
	path: string;
	bytes: number;
	sha256: string;
}

interface EvidenceIdentity extends FileIdentity {
	position: string;
}

async function copyVerified({
	root,
	sourcePath,
	relativePath,
	role,
	logicalName,
	sourceExportOperationId,
}: {
	root: string;
	sourcePath: string;
	relativePath: string;
	role: DeliveryPackageFile["role"];
	logicalName: string;
	sourceExportOperationId: string | null;
}): Promise<DeliveryPackageFile> {
	const destination = resolve(root, relativePath);
	if (!inside(root, destination))
		throw new Error("unsafe delivery package path");
	const source = await stat(sourcePath).catch(() => null);
	if (!source?.isFile())
		throw new Error(`package source is missing: ${sourcePath}`);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
	const copied = await stat(destination);
	return {
		role,
		logicalName,
		relativePath: relative(root, destination).replaceAll("\\", "/"),
		bytes: copied.size,
		sha256: await hashFile(destination),
		sourcePath: resolve(sourcePath),
		sourceExportOperationId,
	};
}

function parseManifest(
	value: unknown,
	operationId: string,
): DeliveryPackageManifest {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.packageOperationId !== operationId ||
		typeof value.requestFingerprint !== "string" ||
		typeof value.packageName !== "string" ||
		typeof value.projectId !== "string" ||
		!Array.isArray(value.sources) ||
		!Array.isArray(value.files)
	) {
		throw new Error("delivery package manifest is incomplete");
	}
	return value as unknown as DeliveryPackageManifest;
}

async function readManifest(
	path: string,
	operationId: string,
): Promise<DeliveryPackageManifest> {
	try {
		return parseManifest(JSON.parse(await readFile(path, "utf8")), operationId);
	} catch (error) {
		throw new Error(
			`delivery package manifest changed or is missing: ${error instanceof Error ? error.message : "invalid manifest"}`,
		);
	}
}

async function verifyManifestFiles(
	packageDirectory: string,
	manifest: DeliveryPackageManifest,
): Promise<void> {
	for (const file of manifest.files) {
		const path = resolve(packageDirectory, file.relativePath);
		if (!inside(packageDirectory, path)) {
			throw new Error("delivery package manifest contains an unsafe path");
		}
		const info = await stat(path).catch(() => null);
		if (
			!info?.isFile() ||
			info.size !== file.bytes ||
			(await hashFile(path)) !== file.sha256
		) {
			throw new Error(
				`delivery package file changed or is missing: ${file.relativePath}`,
			);
		}
	}
}

function fileIdentity(value: unknown): FileIdentity | null {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		typeof value.bytes !== "number" ||
		typeof value.sha256 !== "string"
	) {
		return null;
	}
	return {
		path: resolve(value.path),
		bytes: value.bytes,
		sha256: value.sha256,
	};
}

function requiredRecord(
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} is missing`);
	return value;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value)
		throw new Error(`${label} is missing`);
	return value;
}

function inside(root: string, path: string): boolean {
	const child = relative(resolve(root), resolve(path));
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function slug(value: string): string {
	const result = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	if (!result) throw new Error("package names must contain letters or numbers");
	return result;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
