import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DurableProviderSupervisor,
	ProviderSupervisorReuseError,
	providerSupervisorFingerprint,
} from "./provider-supervisor";
import type {
	ProviderSupervisorKind,
	ProviderSupervisorRecord,
	ProviderSupervisorSubmission,
} from "./provider-supervisor-store";

describe("durable detached provider supervisor", () => {
	let directory: string;
	const clients: DurableProviderSupervisor[] = [];
	const fixtureParents: Array<{ pid: number; exited: Promise<number> }> = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-provider-supervisor-"));
	});

	afterEach(async () => {
		for (const parent of fixtureParents.splice(0)) {
			if (processIsAlive(parent.pid)) await hardKill(parent.pid);
			await parent.exited.catch(() => undefined);
		}
		for (const client of clients.splice(0)) client.close();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
		await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	test(
		"survives hard-killed MCP parents and publishes exact audio, matte, and full tracker results",
		async () => {
			const providers: ProviderSupervisorKind[] = [
				"audio-cleaner-command",
				"matte-producer-command",
				"subject-tracker-command",
			];
			for (const [index, provider] of providers.entries()) {
				const fixture = await prepareFixture(directory, provider, `hard-kill-${index}`);
				const commitDelay = provider === "matte-producer-command" ? 600 : 0;
				const parent = Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, "provider-supervisor-fixture-parent.ts"),
						fixture.storeDirectory,
						fixture.submissionPath,
						fixture.parentReadyPath,
						String(commitDelay),
					],
					{ stdout: "ignore", stderr: "pipe", env: process.env },
				);
				fixtureParents.push(parent);
				await waitForFile(fixture.parentReadyPath, 5_000);
				await waitForFile(
					provider === "matte-producer-command"
						? fixture.donePath
						: fixture.startedPath,
					5_000,
				);
				await hardKill(parent.pid);
				await parent.exited;

				const restarted = trackClient(
					new DurableProviderSupervisor({ directory: fixture.storeDirectory }),
					clients,
				);
				const result = await restarted.waitForTerminal(
					provider,
					fixture.submission.operationId,
					10_000,
				);
				expect(result.state).toBe("succeeded");
				expect(await invocationCount(fixture.counterPath)).toBe(1);
				assertExactResult(provider, result);
			}
		},
		30_000,
	);

	test("overlapping clients share one invocation and changed semantic reuse is rejected", async () => {
		const fixture = await prepareFixture(
			directory,
			"audio-cleaner-command",
			"overlap",
			350,
		);
		const first = trackClient(
			new DurableProviderSupervisor({ directory: fixture.storeDirectory }),
			clients,
		);
		const second = trackClient(
			new DurableProviderSupervisor({ directory: fixture.storeDirectory }),
			clients,
		);
		await Promise.all([
			first.submit(fixture.submission),
			second.submit(fixture.submission),
		]);
		const result = await second.waitForTerminal(
			fixture.submission.provider,
			fixture.submission.operationId,
			10_000,
		);
		expect(result.state).toBe("succeeded");
		expect(await invocationCount(fixture.counterPath)).toBe(1);
		await expect(
			first.submit({
				...fixture.submission,
				semanticFingerprint: providerSupervisorFingerprint({ changed: true }),
			}),
		).rejects.toBeInstanceOf(ProviderSupervisorReuseError);
	});

	test("supervisor death leaves a resolvable unknown outcome that only an explicit rerun repeats", async () => {
		const fixture = await prepareFixture(
			directory,
			"subject-tracker-command",
			"unknown",
			900,
		);
		const client = trackClient(
			new DurableProviderSupervisor({ directory: fixture.storeDirectory }),
			clients,
		);
		await client.submit(fixture.submission);
		await waitForFile(fixture.startedPath, 5_000);
		const started = await waitForState(
			client,
			fixture.submission.provider,
			fixture.submission.operationId,
			"started",
			5_000,
		);
		if (started.supervisorPid === null) throw new Error("supervisor PID is missing");
		await hardKill(started.supervisorPid);
		const unknown = await client.waitForTerminal(
			fixture.submission.provider,
			fixture.submission.operationId,
			5_000,
		);
		expect(unknown).toMatchObject({
			state: "unknown",
			result: null,
		});
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
		const replay = await client.submit(fixture.submission);
		expect(replay.state).toBe("unknown");
		expect(replay.jobState).toBe("recovery-required");
		expect(await invocationCount(fixture.counterPath)).toBe(1);
		const rerun = await client.resolve(
			fixture.submission.provider,
			fixture.submission.operationId,
			{ kind: "rerun-as-new-attempt", reason: "operator rerun", operationId: null },
		);
		expect(rerun).toMatchObject({ state: "queued", attempt: 1 });
		const reran = await client.waitForTerminal(
			fixture.submission.provider,
			fixture.submission.operationId,
			10_000,
		);
		expect(reran).toMatchObject({ state: "succeeded", attempt: 2 });
		expect(await invocationCount(fixture.counterPath)).toBe(2);
	});
});

async function prepareFixture(
	root: string,
	provider: ProviderSupervisorKind,
	name: string,
	delayMs = 450,
) {
	const base = join(root, name);
	const storeDirectory = join(base, "store");
	const outputDirectory = join(base, "output");
	const counterPath = join(base, "invocations.txt");
	const startedPath = join(base, "provider-started.txt");
	const donePath = join(base, "provider-done.txt");
	const parentReadyPath = join(base, "parent-ready.txt");
	const submissionPath = join(base, "submission.json");
	await mkdir(outputDirectory, { recursive: true });
	await Bun.write(join(base, "source.bin"), "fixture source");
	const sourcePath = join(base, "source.bin");
	const request =
		provider === "subject-tracker-command"
			? {
					protocolVersion: 1,
					operationId: `${name}-operation`,
					timebase: { ticksPerSecond: 120_000 },
					source: {
						path: sourcePath,
						name: "source.mp4",
						mimeType: "video/mp4",
						contentHash: "a".repeat(64),
						sourceFingerprint: "fixture",
						width: 320,
						height: 240,
						durationTicks: 36_000,
						fps: 30,
					},
					clip: { trimStart: 0, trimEnd: 0, duration: 36_000, retimeRate: 1 },
					sampling: { intervalTicks: 12_000, maxSamples: 10 },
					options: {},
				}
			: {
					protocolVersion: 1,
					operationId: `${name}-operation`,
					outputDirectory,
					source: {
						path: sourcePath,
						name: "source.mp4",
						mimeType: "video/mp4",
						contentHash: "a".repeat(64),
					},
					options: {},
				};
	const submission: ProviderSupervisorSubmission = {
		provider,
		operationId: `${name}-operation`,
		semanticFingerprint: providerSupervisorFingerprint({
			provider,
			operationId: `${name}-operation`,
			contentHash: "a".repeat(64),
			options: {},
		}),
		command: process.execPath,
		args: [
			join(import.meta.dir, "provider-supervisor-fixture-provider.ts"),
			provider,
			counterPath,
			startedPath,
			donePath,
			String(delayMs),
		],
		request,
		timeoutMs: 10_000,
	};
	await Bun.write(submissionPath, JSON.stringify(submission));
	return {
		storeDirectory,
		outputDirectory,
		counterPath,
		startedPath,
		donePath,
		parentReadyPath,
		submissionPath,
		submission,
	};
}

function assertExactResult(
	provider: ProviderSupervisorKind,
	record: ProviderSupervisorRecord,
): void {
	expect(record.provenance).toMatchObject({
		provider,
		providerProtocolVersion: 1,
		supervisorProtocolVersion: 2,
	});
	if (provider === "audio-cleaner-command") {
		expect(record.result).toMatchObject({
			modelId: "fixture-cleaner",
			modelVersion: "1",
			warnings: ["audio-cleaner-command fixture"],
		});
		expect(record.provenance?.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
		return;
	}
	if (provider === "matte-producer-command") {
		expect(record.result).toMatchObject({
			channel: "red",
			modelId: "fixture-matte",
			modelVersion: "2",
			warnings: ["matte-producer-command fixture"],
		});
		expect(record.provenance?.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
		return;
	}
	const result = record.result as Record<string, unknown>;
	expect(result).toMatchObject({
		modelId: "fixture-tracker",
		modelVersion: "3",
		warnings: ["full tracker fixture"],
	});
	expect(result.samples).toEqual([
		{
			sourceTime: 0,
			box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
			confidence: 0.95,
		},
		{
			sourceTime: 12_000,
			box: { x: 0.2, y: 0.25, width: 0.3, height: 0.4 },
			confidence: 0.9,
		},
		{
			sourceTime: 24_000,
			box: { x: 0.3, y: 0.3, width: 0.3, height: 0.4 },
			confidence: 0.85,
		},
	]);
}

async function hardKill(pid: number): Promise<void> {
	if (process.platform === "win32") {
		const child = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/F"], {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const code = await child.exited;
		if (code !== 0 && processIsAlive(pid)) throw new Error(`taskkill failed for ${pid}`);
		return;
	}
	process.kill(pid, "SIGKILL");
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await stat(path).catch(() => null)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForState(
	client: DurableProviderSupervisor,
	provider: ProviderSupervisorKind,
	operationId: string,
	state: ProviderSupervisorRecord["state"],
	timeoutMs: number,
): Promise<ProviderSupervisorRecord> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = await client.query(provider, operationId);
		if (record?.state === state) return record;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error(`timed out waiting for provider state ${state}`);
}

async function invocationCount(path: string): Promise<number> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text.split(/\r?\n/).filter(Boolean).length;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function trackClient(
	client: DurableProviderSupervisor,
	clients: DurableProviderSupervisor[],
): DurableProviderSupervisor {
	clients.push(client);
	return client;
}
