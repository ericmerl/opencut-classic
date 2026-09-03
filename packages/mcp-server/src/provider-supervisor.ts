import { spawn } from "node:child_process";
import { join } from "node:path";
import type { JobStore } from "./job-store";
import {
	ProviderSupervisorReuseError,
	ProviderSupervisorStore,
	providerJobId,
	providerSupervisorFingerprint,
	type ProviderSupervisorKind,
	type ProviderSupervisorRecord,
	type ProviderSupervisorSubmission,
} from "./provider-supervisor-store";

export interface DurableProviderSupervisorOptions {
	/** Directory of the shared job store; every provider uses the same one. */
	directory: string;
	jobs?: JobStore;
	workerEntry?: string;
	runtimePath?: string;
	workerEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Runs provider commands in detached worker processes that claim, heartbeat,
 * and publish through the unified job store, so a dead MCP parent never loses
 * a provider outcome and a dead worker never leaves a job stuck.
 */
export class DurableProviderSupervisor {
	readonly store: ProviderSupervisorStore;
	private initialized = false;

	constructor(private readonly options: DurableProviderSupervisorOptions) {
		this.store = new ProviderSupervisorStore(options.directory, options.jobs);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.store.initialize();
		this.initialized = true;
	}

	close(): void {
		if (!this.options.jobs) this.store.close();
		this.initialized = false;
	}

	async submit(
		input: ProviderSupervisorSubmission,
	): Promise<ProviderSupervisorRecord> {
		await this.initialize();
		const record = this.store.claim(input);
		if (record.state === "queued") this.launch(record.jobId);
		return record;
	}

	async query(
		provider: ProviderSupervisorKind,
		operationId: string,
	): Promise<ProviderSupervisorRecord | null> {
		await this.initialize();
		const record = this.store.read(provider, operationId);
		if (record?.state === "started") {
			await this.store.reconcileDeadSupervisors();
			return this.store.read(provider, operationId);
		}
		return record;
	}

	async waitForTerminal(
		provider: ProviderSupervisorKind,
		operationId: string,
		timeoutMs: number,
	): Promise<ProviderSupervisorRecord> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const record = await this.query(provider, operationId);
			if (!record) throw new Error("provider supervisor operation was not found");
			if (
				record.state === "succeeded" ||
				record.state === "failed" ||
				record.state === "unknown"
			) {
				return record;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("timed out waiting for durable provider supervisor result");
	}

	/**
	 * Resolve a provider job whose supervisor died. Rerunning launches a fresh
	 * worker for a new attempt under the same job identity.
	 */
	async resolve(
		provider: ProviderSupervisorKind,
		operationId: string,
		resolution: {
			kind: "rerun-as-new-attempt" | "mark-failed";
			reason: string;
			operationId: string | null;
		},
	): Promise<ProviderSupervisorRecord> {
		await this.initialize();
		const jobId = providerJobId(provider, operationId);
		const record = this.store.resolve(jobId, resolution);
		if (record.state === "queued") this.launch(jobId);
		return record;
	}

	/** Launch a worker for a queued provider job by id. */
	launch(jobId: string): void {
		const child = spawn(
			this.options.runtimePath ?? process.execPath,
			[
				this.options.workerEntry ??
					join(import.meta.dir, "provider-supervisor-worker.ts"),
				this.store.directory,
				jobId,
			],
			{
				detached: true,
				windowsHide: true,
				stdio: "ignore",
				env: { ...process.env, ...this.options.workerEnvironment },
			},
		);
		child.unref();
	}
}

export { ProviderSupervisorReuseError, providerJobId, providerSupervisorFingerprint };
export type {
	ProviderSupervisorKind,
	ProviderSupervisorRecord,
	ProviderSupervisorSubmission,
};
