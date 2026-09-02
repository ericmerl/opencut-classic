import { spawn } from "node:child_process";
import { join } from "node:path";
import {
	ProviderSupervisorReuseError,
	ProviderSupervisorStore,
	providerSupervisorFingerprint,
	type ProviderSupervisorKind,
	type ProviderSupervisorRecord,
	type ProviderSupervisorSubmission,
} from "./provider-supervisor-store";

export interface DurableProviderSupervisorOptions {
	directory: string;
	workerEntry?: string;
	runtimePath?: string;
	workerEnvironment?: NodeJS.ProcessEnv;
}

export class DurableProviderSupervisor {
	private readonly store: ProviderSupervisorStore;
	private initialized = false;

	constructor(private readonly options: DurableProviderSupervisorOptions) {
		this.store = new ProviderSupervisorStore(options.directory);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.store.initialize();
		this.initialized = true;
	}

	close(): void {
		this.store.close();
		this.initialized = false;
	}

	async submit(
		input: ProviderSupervisorSubmission,
	): Promise<ProviderSupervisorRecord> {
		await this.initialize();
		const record = this.store.claim(input);
		if (record.state === "queued") this.launch(input.provider, input.operationId);
		return record;
	}

	async query(
		provider: ProviderSupervisorKind,
		operationId: string,
	): Promise<ProviderSupervisorRecord | null> {
		await this.initialize();
		const record = this.store.read(provider, operationId);
		if (
			record?.state === "started" &&
			record.supervisorPid !== null &&
			record.supervisorNonce !== null &&
			!processIsAlive(record.supervisorPid)
		) {
			try {
				return this.store.markUnknownIfOwned(
					provider,
					operationId,
					record.supervisorPid,
					record.supervisorNonce,
				);
			} catch {
				return this.store.read(provider, operationId);
			}
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

	private launch(provider: ProviderSupervisorKind, operationId: string): void {
		const child = spawn(
			this.options.runtimePath ?? process.execPath,
			[
				this.options.workerEntry ??
					join(import.meta.dir, "provider-supervisor-worker.ts"),
				this.store.directory,
				provider,
				operationId,
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

export { ProviderSupervisorReuseError, providerSupervisorFingerprint };
export type {
	ProviderSupervisorKind,
	ProviderSupervisorRecord,
	ProviderSupervisorSubmission,
};

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		return code !== "ESRCH";
	}
}
