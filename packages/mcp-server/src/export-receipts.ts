import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	mkdir,
	link,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type WatermarkInspectionStatus =
	| "pending"
	| "verified-clean"
	| "rejected";

export interface ExportInspection {
	status: WatermarkInspectionStatus;
	outputSha256: string;
	reviewer: string | null;
	notes: string | null;
	inspectedAt: string | null;
}

export interface ExportReceiptRecord {
	schemaVersion: 1;
	operationId: string;
	fingerprint: string;
	createdAt: string;
	result: Record<string, unknown>;
	inspection: ExportInspection;
}

export class ExportReceiptStore {
	readonly directory: string;

	constructor(directory = defaultReceiptDirectory()) {
		this.directory = resolve(directory);
	}

	async get(operationId: string): Promise<ExportReceiptRecord | null> {
		const stored = await readJson(this.receiptPath(operationId));
		if (!stored) return null;
		const receipt = parseReceipt(stored, operationId);
		const inspection = await readJson(this.inspectionPath(operationId));
		return inspection
			? { ...receipt, inspection: parseInspection(inspection) }
			: receipt;
	}

	async write(
		receipt: ExportReceiptRecord,
	): Promise<{ receipt: ExportReceiptRecord; path: string }> {
		await mkdir(this.directory, { recursive: true });
		const path = this.receiptPath(receipt.operationId);
		const existing = await this.get(receipt.operationId);
		if (existing) {
			if (existing.fingerprint !== receipt.fingerprint) {
				throw new Error(
					"operationId was already used for a different durable export receipt",
				);
			}
			return { receipt: existing, path };
		}

		const tempPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
		});
		try {
			await link(tempPath, path);
			await unlink(tempPath);
		} catch (error) {
			await unlink(tempPath).catch(() => undefined);
			const raced = await this.get(receipt.operationId);
			if (!raced || raced.fingerprint !== receipt.fingerprint) throw error;
			return { receipt: raced, path };
		}
		return { receipt, path };
	}

	async recordInspection({
		operationId,
		outputSha256,
		status,
		reviewer,
		notes,
	}: {
		operationId: string;
		outputSha256: string;
		status: Exclude<WatermarkInspectionStatus, "pending">;
		reviewer?: string;
		notes?: string;
	}): Promise<{ receipt: ExportReceiptRecord; path: string }> {
		const receipt = await this.get(operationId);
		if (!receipt) throw new Error(`export receipt not found: ${operationId}`);
		if (receipt.inspection.outputSha256 !== outputSha256) {
			throw new Error("inspection SHA-256 does not match the exported file");
		}
		await verifyInspectionEvidence(receipt);
		const inspection: ExportInspection = {
			status,
			outputSha256,
			reviewer: reviewer?.trim() || null,
			notes: notes?.trim() || null,
			inspectedAt: new Date().toISOString(),
		};
		await mkdir(this.directory, { recursive: true });
		const path = this.inspectionPath(operationId);
		await writeFile(path, `${JSON.stringify(inspection, null, 2)}\n`);
		return { receipt: { ...receipt, inspection }, path };
	}

	async verifyForReview(
		operationId: string,
		expectedOutputSha256: string,
	): Promise<ExportReceiptRecord> {
		const receipt = await this.get(operationId);
		if (!receipt) throw new Error(`export receipt not found: ${operationId}`);
		if (
			receipt.inspection.outputSha256 !== expectedOutputSha256 ||
			receipt.result.sha256 !== expectedOutputSha256
		) {
			throw new Error("review target SHA-256 does not match the exported file");
		}
		await verifyInspectionEvidence(receipt);
		return receipt;
	}

	async artifactsDirectory(operationId: string): Promise<string> {
		const path = join(this.directory, "artifacts", operationKey(operationId));
		await mkdir(path, { recursive: true });
		return path;
	}

	receiptPath(operationId: string): string {
		return join(this.directory, `${operationKey(operationId)}.json`);
	}

	private inspectionPath(operationId: string): string {
		return join(this.directory, `${operationKey(operationId)}.inspection.json`);
	}
}

function defaultReceiptDirectory(): string {
	const configured = globalThis.process.env.OPENCUT_RECEIPT_DIR;
	if (configured) return configured;
	if (globalThis.process.platform === "win32") {
		const localAppData = globalThis.process.env.LOCALAPPDATA;
		if (localAppData) return join(localAppData, "OpenCut", "mcp", "receipts");
	}
	const stateHome = globalThis.process.env.XDG_STATE_HOME;
	return stateHome
		? join(stateHome, "opencut", "mcp", "receipts")
		: join(homedir(), ".local", "state", "opencut", "mcp", "receipts");
}

function operationKey(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

async function verifyInspectionEvidence(
	receipt: ExportReceiptRecord,
): Promise<void> {
	const result = receipt.result;
	if (
		typeof result.outputPath !== "string" ||
		typeof result.bytesWritten !== "number" ||
		typeof result.sha256 !== "string"
	) {
		throw new Error("export receipt does not contain a complete file identity");
	}
	await verifyFile({
		path: result.outputPath,
		bytes: result.bytesWritten,
		sha256: result.sha256,
		label: "export output",
	});
	const validation = result.validation;
	if (!isRecord(validation) || validation.status !== "validated") {
		throw new Error("export has not passed media validation");
	}
	const samples = validation.frameSamples;
	if (!Array.isArray(samples)) {
		throw new Error("export receipt does not contain frame samples");
	}
	for (const position of ["opening", "middle", "ending"] as const) {
		const sample = samples.find(
			(value) => isRecord(value) && value.position === position,
		);
		if (
			!isRecord(sample) ||
			typeof sample.path !== "string" ||
			typeof sample.bytes !== "number" ||
			typeof sample.sha256 !== "string"
		) {
			throw new Error(`${position} frame sample is missing from the receipt`);
		}
		await verifyFile({
			path: sample.path,
			bytes: sample.bytes,
			sha256: sample.sha256,
			label: `${position} frame sample`,
		});
	}
}

async function verifyFile({
	path,
	bytes,
	sha256,
	label,
}: {
	path: string;
	bytes: number;
	sha256: string;
	label: string;
}): Promise<void> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) throw new Error(`${label} is missing`);
	if (info.size !== bytes) throw new Error(`${label} size no longer matches`);
	if ((await hashFile(path)) !== sha256) {
		throw new Error(`${label} SHA-256 no longer matches`);
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function readJson(path: string): Promise<unknown | null> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return null;
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error(`durable export receipt is invalid: ${path}`);
	}
}

function parseReceipt(
	value: unknown,
	operationId: string,
): ExportReceiptRecord {
	if (!isRecord(value))
		throw new Error("durable export receipt is not an object");
	if (
		value.schemaVersion !== 1 ||
		value.operationId !== operationId ||
		typeof value.fingerprint !== "string" ||
		typeof value.createdAt !== "string" ||
		!isRecord(value.result)
	) {
		throw new Error("durable export receipt is incomplete");
	}
	return {
		schemaVersion: 1,
		operationId,
		fingerprint: value.fingerprint,
		createdAt: value.createdAt,
		result: value.result,
		inspection: parseInspection(value.inspection),
	};
}

function parseInspection(value: unknown): ExportInspection {
	if (!isRecord(value)) throw new Error("export inspection is incomplete");
	if (
		(value.status !== "pending" &&
			value.status !== "verified-clean" &&
			value.status !== "rejected") ||
		typeof value.outputSha256 !== "string"
	) {
		throw new Error("export inspection is invalid");
	}
	return {
		status: value.status,
		outputSha256: value.outputSha256,
		reviewer: typeof value.reviewer === "string" ? value.reviewer : null,
		notes: typeof value.notes === "string" ? value.notes : null,
		inspectedAt:
			typeof value.inspectedAt === "string" ? value.inspectedAt : null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
