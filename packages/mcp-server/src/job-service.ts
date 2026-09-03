import type { ExportJobQueue } from "./export-jobs";
import type { InlineJobMirror } from "./inline-jobs";
import {
	JobStoreError,
	type JobListFilter,
	type JobRecord,
	type JobStore,
	type JobType,
} from "./job-store";
import type { DurableProviderSupervisor } from "./provider-supervisor";

export interface JobResolution {
	kind: "rerun-as-new-attempt" | "mark-failed";
	reason: string;
	operationId: string | null;
}

export interface JobServiceOptions {
	jobs: JobStore;
	exportJobs: Pick<ExportJobQueue, "cancel" | "retry" | "resolve">;
	providers: Pick<DurableProviderSupervisor, "launch" | "initialize">;
	mirror: InlineJobMirror;
	/** Per-type cancellation for inline work whose evidence store owns the signal. */
	cancelInline: Partial<Record<JobType, (record: JobRecord) => Promise<unknown>>>;
}

export class JobServiceError extends Error {
	constructor(
		readonly code:
			| "JOB_NOT_FOUND"
			| "JOB_ILLEGAL_TRANSITION"
			| "JOB_ATTEMPTS_EXHAUSTED"
			| "JOB_RESOLUTION_UNSUPPORTED",
		message: string,
	) {
		super(message);
		this.name = "JobServiceError";
	}
}

/**
 * Public surface over the unified job store. Reads are direct; mutations
 * dispatch by job type so that the runner responsible for that type also
 * observes the change (export queue, provider worker launch, inline mirror).
 */
export class JobService {
	constructor(private readonly options: JobServiceOptions) {}

	async get(jobId: string): Promise<JobRecord | null> {
		await this.options.jobs.initialize();
		return this.options.jobs.get(jobId);
	}

	async list(filter: JobListFilter): Promise<JobRecord[]> {
		await this.options.jobs.initialize();
		return this.options.jobs.list(filter);
	}

	async history(jobId: string) {
		await this.options.jobs.initialize();
		return this.options.jobs.history(jobId);
	}

	async summary() {
		await this.options.jobs.initialize();
		return this.options.jobs.summary();
	}

	async cancel(jobId: string, reason: string): Promise<JobRecord> {
		const record = await this.require(jobId);
		return this.translate(async () => {
			switch (record.jobType) {
				case "export":
					await this.options.exportJobs.cancel(jobId);
					break;
				case "preview-range":
				case "comparison": {
					const cancel = this.options.cancelInline[record.jobType];
					if (cancel) await cancel(record);
					await this.options.mirror.cancelRequest(jobId, reason);
					break;
				}
				default:
					this.options.jobs.cancel(jobId, reason);
			}
			return this.options.jobs.require(jobId);
		});
	}

	async retry(
		jobId: string,
		options: { reason: string; operationId: string | null },
	): Promise<JobRecord> {
		const record = await this.require(jobId);
		return this.translate(async () => {
			switch (record.jobType) {
				case "export":
					await this.options.exportJobs.retry(jobId, options);
					break;
				case "provider": {
					const retried = this.options.jobs.retry(jobId, options);
					if (retried.state === "queued") {
						await this.options.providers.initialize();
						this.options.providers.launch(jobId);
					}
					break;
				}
				default:
					throw new JobServiceError(
						"JOB_RESOLUTION_UNSUPPORTED",
						`${record.jobType} jobs run inline with their tool call; retry by invoking the tool again with a new operationId`,
					);
			}
			return this.options.jobs.require(jobId);
		});
	}

	async resolve(jobId: string, resolution: JobResolution): Promise<JobRecord> {
		const record = await this.require(jobId);
		return this.translate(async () => {
			switch (record.jobType) {
				case "export":
					await this.options.exportJobs.resolve(jobId, resolution);
					break;
				case "provider": {
					const resolved = this.options.jobs.resolve(jobId, resolution);
					if (resolved.state === "queued") {
						await this.options.providers.initialize();
						this.options.providers.launch(jobId);
					}
					break;
				}
				default:
					if (resolution.kind === "rerun-as-new-attempt") {
						throw new JobServiceError(
							"JOB_RESOLUTION_UNSUPPORTED",
							`${record.jobType} jobs run inline with their tool call; mark the job failed and invoke the tool again with a new operationId`,
						);
					}
					this.options.jobs.resolve(jobId, resolution);
			}
			return this.options.jobs.require(jobId);
		});
	}

	private async require(jobId: string): Promise<JobRecord> {
		const record = await this.get(jobId);
		if (!record) {
			throw new JobServiceError("JOB_NOT_FOUND", `job not found: ${jobId}`);
		}
		return record;
	}

	private async translate<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof JobStoreError) {
				const code =
					error.code === "JOB_NOT_FOUND"
						? "JOB_NOT_FOUND"
						: error.code === "JOB_ATTEMPTS_EXHAUSTED"
							? "JOB_ATTEMPTS_EXHAUSTED"
							: "JOB_ILLEGAL_TRANSITION";
				throw new JobServiceError(code, error.message);
			}
			throw error;
		}
	}
}
