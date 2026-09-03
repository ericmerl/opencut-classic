import {
	JOB_HEARTBEAT_INTERVAL_MS,
	JobStoreError,
	jobOwnerId,
	type JobFence,
	type JobPreconditions,
	type JobRecord,
	type JobStore,
	type JobType,
	type JsonValue,
} from "./job-store";

export interface InlineJobStart {
	jobId: string;
	jobType: JobType;
	operationId: string;
	semanticInputHash: string;
	capabilitySnapshotHash?: string | null;
	preconditions?: Partial<JobPreconditions>;
	input: JsonValue;
	progressUnits?: string;
	total?: number | null;
	phase?: string;
}

export interface InlineJobProgress {
	phase?: string;
	completed?: number;
	total?: number | null;
}

/**
 * Registers work that executes inline in this MCP process (range previews,
 * comparisons, transcription) as rows of the unified job store. The evidence
 * stores stay authoritative for their receipts; the mirror provides queue
 * visibility, heartbeats, cancellation observation, and restart reconciliation.
 *
 * Mirror failures never break the primary operation: they are reported on
 * stderr and the evidence path continues.
 */
export class InlineJobMirror {
	readonly ownerId: string;
	private readonly fences = new Map<string, JobFence>();
	private readonly trackers = new Map<string, ReturnType<typeof setInterval>>();

	constructor(
		private readonly jobs: JobStore,
		options: { ownerId?: string } = {},
	) {
		this.ownerId = options.ownerId ?? jobOwnerId();
	}

	async start(input: InlineJobStart): Promise<JobRecord | null> {
		return this.guard("start", input.jobId, async () => {
			await this.jobs.initialize();
			const existing = this.jobs.get(input.jobId);
			if (existing && existing.jobType !== input.jobType) {
				throw new Error(
					`job ${input.jobId} already exists as a ${existing.jobType} job`,
				);
			}
			const submitted =
				existing ??
				this.jobs.submit({
					jobId: input.jobId,
					jobType: input.jobType,
					operationId: input.operationId,
					semanticInputHash: input.semanticInputHash,
					capabilitySnapshotHash: input.capabilitySnapshotHash ?? null,
					preconditions: input.preconditions,
					attemptPolicy: {
						maximumAttempts: 1,
						retryableErrorClasses: [],
						boundedBackoffMs: 0,
					},
					progressUnits: input.progressUnits ?? "steps",
					input: input.input,
				}).record;
			if (submitted.state !== "queued") {
				return this.fences.has(input.jobId) ? submitted : null;
			}
			const claim = this.jobs.claim(input.jobId, this.ownerId);
			if (!claim) return null;
			const fence = { ownerId: claim.ownerId, fencingToken: claim.fencingToken };
			this.fences.set(input.jobId, fence);
			return this.jobs.start(input.jobId, fence, {
				phase: input.phase ?? "running",
				completed: 0,
				total: input.total ?? null,
			});
		});
	}

	/** Heartbeat on a fixed cadence from a progress source until stopped. */
	track(jobId: string, read: () => Promise<InlineJobProgress | null>): void {
		this.untrack(jobId);
		const timer = setInterval(() => {
			void read()
				.then((progress) => this.progress(jobId, progress ?? {}))
				.catch(() => undefined);
		}, JOB_HEARTBEAT_INTERVAL_MS);
		this.trackers.set(jobId, timer);
	}

	untrack(jobId: string): void {
		const timer = this.trackers.get(jobId);
		if (timer) clearInterval(timer);
		this.trackers.delete(jobId);
	}

	async progress(jobId: string, progress: InlineJobProgress): Promise<void> {
		const fence = this.fences.get(jobId);
		if (!fence) return;
		await this.guard("progress", jobId, async () => {
			this.jobs.heartbeat(jobId, fence, {
				progress: {
					...(progress.phase !== undefined ? { phase: progress.phase } : {}),
					...(progress.completed !== undefined
						? { completed: progress.completed }
						: {}),
					...(progress.total !== undefined ? { total: progress.total } : {}),
				},
			});
		});
	}

	async cancelRequest(jobId: string, reason: string): Promise<JobRecord | null> {
		return this.guard("cancel", jobId, async () => {
			await this.jobs.initialize();
			return this.jobs.get(jobId) ? this.jobs.cancel(jobId, reason) : null;
		});
	}

	async succeed(jobId: string, result: JsonValue): Promise<void> {
		await this.finish(jobId, (fence) =>
			this.jobs.succeed(jobId, fence, { result }),
		);
	}

	async fail(jobId: string, error: string, errorClass = "inline-failed"): Promise<void> {
		await this.finish(jobId, (fence) =>
			this.jobs.fail(jobId, fence, { error, errorClass }),
		);
	}

	async cancelled(jobId: string, reason: string): Promise<void> {
		await this.finish(jobId, (fence) =>
			this.jobs.confirmCancelled(jobId, fence, { reason }),
		);
	}

	/**
	 * Inline work cannot outlive its process, so every inline job left active
	 * by a dead owner failed. The caller can also fail the evidence record.
	 */
	async reconcileInterrupted(
		onInterrupted?: (record: JobRecord) => Promise<void>,
	): Promise<JobRecord[]> {
		await this.jobs.initialize();
		const reconciled = await this.jobs.reconcileInterrupted({
			reconcile: async (record) => {
				if (!isInlineType(record.jobType)) {
					return {
						kind: "recovery-required",
						code: "unknown-outcome",
						detail: `owner of ${record.jobType} job died before publishing an outcome`,
					};
				}
				await onInterrupted?.(record).catch(() => undefined);
				return record.cancellationRequestedAt
					? { kind: "cancelled", reason: "MCP process stopped while cancelling inline work" }
					: {
							kind: "failed",
							error: "MCP process stopped while inline work was running",
						};
			},
		});
		return reconciled.filter((record) => isInlineType(record.jobType));
	}

	private async finish(
		jobId: string,
		run: (fence: JobFence) => JobRecord,
	): Promise<void> {
		this.untrack(jobId);
		const fence = this.fences.get(jobId);
		if (!fence) return;
		this.fences.delete(jobId);
		await this.guard("finish", jobId, async () => {
			run(fence);
		});
	}

	private async guard<T>(
		step: string,
		jobId: string,
		run: () => Promise<T>,
	): Promise<T | null> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof JobStoreError && error.code === "JOB_FENCE_REJECTED") {
				this.fences.delete(jobId);
			}
			console.error(
				`[opencut-mcp] inline job mirror ${step} for ${jobId} failed:`,
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}
	}
}

export function isInlineType(type: JobType): boolean {
	return type === "preview-range" || type === "comparison" || type === "transcription";
}
