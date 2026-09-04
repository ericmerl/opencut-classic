import { join } from "node:path";
import { ExportBatchStore, type ExportBatchRecord } from "./export-batch-store";
import type { ExportJobRecord } from "./export-job-store";
import { ExportJobQueue } from "./export-jobs";
import { expandExportBatch, type ExportBatchInput } from "./export-variants";
import { stableSerialize } from "./matte-generation-data";

export type ExportBatchStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "partial"
	| "incomplete";

export interface ExportBatchSummary {
	batch: ExportBatchRecord;
	status: ExportBatchStatus;
	counts: Record<ExportJobRecord["status"] | "missing", number>;
	jobs: Array<ExportJobRecord | null>;
	manifest: {
		schemaVersion: 1;
		batchId: string;
		manifestPath: string;
		variants: Array<{
			variantId: string;
			preset: string;
			jobId: string;
			status: ExportJobRecord["status"] | "missing";
			requested: ExportJobRecord["input"];
			result: Record<string, unknown> | null;
			error: string | null;
		}>;
	};
}

export class ExportBatchQueue {
	constructor(
		private jobs: ExportJobQueue,
		readonly store: ExportBatchStore,
	) {}

	static storeForReceiptDirectory(receiptDirectory: string): ExportBatchStore {
		return new ExportBatchStore(join(receiptDirectory, "batches"));
	}

	async enqueue(
		input: ExportBatchInput,
	): Promise<{ replayed: boolean; summary: ExportBatchSummary }> {
		const variants = expandExportBatch(input);
		const created = await this.store.create({
			schemaVersion: 1,
			batchId: input.batchId,
			fingerprint: stableSerialize(input),
			createdAt: new Date().toISOString(),
			projectId: input.projectId,
			expectedRevision: input.expectedRevision,
			variants,
		});
		for (const variant of created.record.variants) {
			await this.jobs.enqueue({ jobId: variant.jobId, input: variant.input });
		}
		return {
			replayed: created.replayed,
			summary: await this.summarize(created.record),
		};
	}

	async get(batchId: string): Promise<ExportBatchSummary | null> {
		const batch = await this.store.get(batchId);
		return batch ? this.summarize(batch) : null;
	}

	async list(limit: number): Promise<ExportBatchSummary[]> {
		const batches = (await this.store.list()).slice(0, limit);
		return Promise.all(batches.map((batch) => this.summarize(batch)));
	}

	async cancel(batchId: string): Promise<ExportBatchSummary | null> {
		const batch = await this.store.get(batchId);
		if (!batch) return null;
		for (const variant of batch.variants) {
			const job = await this.jobs.get(variant.jobId);
			if (job?.status === "queued") await this.jobs.cancel(variant.jobId);
		}
		return this.summarize(batch);
	}

	private async summarize(
		batch: ExportBatchRecord,
	): Promise<ExportBatchSummary> {
		const jobs = await Promise.all(
			batch.variants.map((variant) => this.jobs.get(variant.jobId)),
		);
		const counts: ExportBatchSummary["counts"] = {
			queued: 0,
			running: 0,
			completed: 0,
			failed: 0,
			cancelled: 0,
			cancelling: 0,
			blocked: 0,
			"recovery-required": 0,
			missing: 0,
		};
		for (const job of jobs) counts[job?.status ?? "missing"]++;
		return {
			batch,
			status: deriveStatus(counts, jobs.length),
			counts,
			jobs,
			manifest: {
				schemaVersion: 1,
				batchId: batch.batchId,
				manifestPath: this.store.manifestPath(batch.batchId),
				variants: batch.variants.map((variant, index) => {
					const job = jobs[index];
					return {
						variantId: variant.variantId,
						preset: variant.preset,
						jobId: variant.jobId,
						status: job?.status ?? "missing",
						requested: variant.input,
						result: job?.result ?? null,
						error: job?.lastError ?? null,
					};
				}),
			},
		};
	}
}

function deriveStatus(
	counts: ExportBatchSummary["counts"],
	total: number,
): ExportBatchStatus {
	if (counts.missing > 0) return "incomplete";
	if (counts.completed === total) return "completed";
	if (counts.cancelled === total) return "cancelled";
	if (counts.running + counts.cancelling > 0) return "running";
	if (counts.queued + counts.blocked + counts["recovery-required"] > 0)
		return "queued";
	if (counts.failed === total) return "failed";
	return "partial";
}
