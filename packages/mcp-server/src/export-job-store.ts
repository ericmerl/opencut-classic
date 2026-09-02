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
import type { ExportProjectInput } from "./export-project";

export type ExportJobStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface ExportJobRecord {
	schemaVersion: 1;
	storeRevision: number;
	jobId: string;
	fingerprint: string;
	status: ExportJobStatus;
	createdAt: string;
	updatedAt: string;
	attempts: number;
	lastAttemptAt: string | null;
	completedAt: string | null;
	input: ExportProjectInput;
	result: Record<string, unknown> | null;
	lastError: string | null;
}

export class ExportJobStore {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = resolve(directory);
	}

	async create(
		record: Omit<ExportJobRecord, "storeRevision">,
	): Promise<{ record: ExportJobRecord; replayed: boolean }> {
		const existing = await this.get(record.jobId);
		if (existing) {
			if (existing.fingerprint !== record.fingerprint) {
				throw new Error("jobId was already used for a different export job");
			}
			return { record: existing, replayed: true };
		}
		const created = { ...record, storeRevision: 0 };
		try {
			await this.publish(created);
			return { record: created, replayed: false };
		} catch (error) {
			const raced = await this.get(record.jobId);
			if (!raced || raced.fingerprint !== record.fingerprint) throw error;
			return { record: raced, replayed: true };
		}
	}

	async update(
		jobId: string,
		change: (current: ExportJobRecord) => ExportJobRecord,
	): Promise<ExportJobRecord> {
		const current = await this.get(jobId);
		if (!current) throw new Error(`export job not found: ${jobId}`);
		const next = change(current);
		if (
			next.jobId !== current.jobId ||
			next.fingerprint !== current.fingerprint ||
			next.createdAt !== current.createdAt
		) {
			throw new Error("export job identity cannot be changed");
		}
		const updated = {
			...next,
			storeRevision: current.storeRevision + 1,
			updatedAt: new Date().toISOString(),
		};
		await this.publish(updated);
		return updated;
	}

	async get(jobId: string): Promise<ExportJobRecord | null> {
		const key = jobKey(jobId);
		const names = await this.versionFiles(key);
		if (names.length === 0) return null;
		return parseRecord(
			JSON.parse(
				await readFile(resolve(this.directory, names.at(-1)!), "utf8"),
			),
			jobId,
		);
	}

	async list(): Promise<ExportJobRecord[]> {
		const names = await readdir(this.directory).catch(() => [] as string[]);
		const latest = new Map<string, string>();
		for (const name of names.sort()) {
			const match = /^([a-f0-9]{64})\.(\d{12})\.json$/.exec(name);
			if (match) latest.set(match[1]!, name);
		}
		const records = await Promise.all(
			[...latest.values()].map(async (name) =>
				parseRecord(
					JSON.parse(await readFile(resolve(this.directory, name), "utf8")),
				),
			),
		);
		return records.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
	}

	async recoverInterrupted(): Promise<ExportJobRecord[]> {
		const running = (await this.list()).filter(
			(record) => record.status === "running",
		);
		return Promise.all(
			running.map((record) =>
				this.update(record.jobId, (current) => ({
					...current,
					status: "queued",
					lastError: "MCP process stopped while the export job was running",
				})),
			),
		);
	}

	private async publish(record: ExportJobRecord): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const path = resolve(
			this.directory,
			`${jobKey(record.jobId)}.${String(record.storeRevision).padStart(12, "0")}.json`,
		);
		const tempPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
			flag: "wx",
		});
		try {
			await link(tempPath, path);
			await unlink(tempPath);
		} catch (error) {
			await unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}

	private async versionFiles(key: string): Promise<string[]> {
		const names = await readdir(this.directory).catch(() => [] as string[]);
		return names
			.filter((name) => name.startsWith(`${key}.`) && name.endsWith(".json"))
			.sort();
	}
}

function parseRecord(value: unknown, expectedJobId?: string): ExportJobRecord {
	if (!isRecord(value)) throw new Error("durable export job is not an object");
	if (
		value.schemaVersion !== 1 ||
		typeof value.storeRevision !== "number" ||
		typeof value.jobId !== "string" ||
		(expectedJobId !== undefined && value.jobId !== expectedJobId) ||
		typeof value.fingerprint !== "string" ||
		!isJobStatus(value.status) ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		typeof value.attempts !== "number" ||
		!isRecord(value.input)
	) {
		throw new Error("durable export job is incomplete");
	}
	return value as unknown as ExportJobRecord;
}

function jobKey(jobId: string): string {
	return createHash("sha256").update(jobId).digest("hex");
}

function isJobStatus(value: unknown): value is ExportJobStatus {
	return (
		value === "queued" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
