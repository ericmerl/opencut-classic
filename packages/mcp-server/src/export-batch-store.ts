import { createHash, randomBytes } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	readdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { ExpandedExportVariant } from "./export-variants";

export interface ExportBatchRecord {
	schemaVersion: 1;
	batchId: string;
	fingerprint: string;
	createdAt: string;
	projectId: string;
	expectedRevision: number;
	variants: ExpandedExportVariant[];
}

export class ExportBatchStore {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = resolve(directory);
	}

	async create(
		record: ExportBatchRecord,
	): Promise<{ record: ExportBatchRecord; replayed: boolean }> {
		const existing = await this.get(record.batchId);
		if (existing) {
			if (existing.fingerprint !== record.fingerprint) {
				throw new Error(
					"batchId was already used for a different export batch",
				);
			}
			return { record: existing, replayed: true };
		}
		await mkdir(this.directory, { recursive: true });
		const path = this.path(record.batchId);
		const temporaryPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
			flag: "wx",
		});
		try {
			await link(temporaryPath, path);
			await unlink(temporaryPath);
			return { record, replayed: false };
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			const raced = await this.get(record.batchId);
			if (!raced || raced.fingerprint !== record.fingerprint) throw error;
			return { record: raced, replayed: true };
		}
	}

	async get(batchId: string): Promise<ExportBatchRecord | null> {
		return readFile(this.path(batchId), "utf8")
			.then((text) => parseRecord(JSON.parse(text), batchId))
			.catch((error: unknown) => {
				if (isMissingFile(error)) return null;
				throw error;
			});
	}

	async list(): Promise<ExportBatchRecord[]> {
		const names = await readdir(this.directory).catch(() => [] as string[]);
		const records = await Promise.all(
			names
				.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
				.map(async (name) =>
					parseRecord(
						JSON.parse(await readFile(resolve(this.directory, name), "utf8")),
					),
				),
		);
		return records.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
	}

	private path(batchId: string): string {
		const key = createHash("sha256").update(batchId).digest("hex");
		return resolve(this.directory, `${key}.json`);
	}
}

function parseRecord(
	value: unknown,
	expectedBatchId?: string,
): ExportBatchRecord {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.batchId !== "string" ||
		(expectedBatchId !== undefined && value.batchId !== expectedBatchId) ||
		typeof value.fingerprint !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.projectId !== "string" ||
		typeof value.expectedRevision !== "number" ||
		!Array.isArray(value.variants)
	) {
		throw new Error("durable export batch is incomplete");
	}
	return value as unknown as ExportBatchRecord;
}

function isMissingFile(error: unknown): boolean {
	return (
		isRecord(error) && typeof error.code === "string" && error.code === "ENOENT"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
