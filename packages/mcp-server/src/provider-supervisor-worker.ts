import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { JOB_HEARTBEAT_INTERVAL_MS } from "./job-store";
import {
	ProviderSupervisorStore,
	type ProviderSupervisorKind,
	type ProviderSupervisorProvenance,
	type ProviderSupervisorRecord,
} from "./provider-supervisor-store";

const [directory, jobId] = process.argv.slice(2);
if (!directory || !jobId) {
	throw new Error("provider supervisor worker requires the job store directory and a job ID");
}

const store = new ProviderSupervisorStore(directory);
await store.initialize();
const nonce = randomUUID();
const acquired = store.acquire(jobId, process.pid, nonce);
if (!acquired) {
	store.close();
	process.exit(0);
}
const { record, fence } = acquired;
let cancellationRequested = false;
let activeChild: { kill: () => void } | null = null;
const heartbeat = setInterval(() => {
	try {
		store.heartbeat(jobId, fence);
		if (!cancellationRequested && store.jobs.get(jobId)?.cancellationRequestedAt) {
			// The provider observes cancellation within one heartbeat interval.
			cancellationRequested = true;
			activeChild?.kill();
		}
	} catch {
		// A rejected fence means the job was reconciled away from this worker;
		// the terminal publication below will be rejected the same way.
	}
}, JOB_HEARTBEAT_INTERVAL_MS);

try {
	const terminal = await invoke(record);
	const delay = Number(process.env.OPENCUT_PROVIDER_SUPERVISOR_TEST_COMMIT_DELAY_MS ?? 0);
	if (Number.isSafeInteger(delay) && delay > 0) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
	}
	store.heartbeat(jobId, fence, "publishing");
	store.complete(jobId, fence, terminal.result, terminal.provenance);
} catch (error) {
	const message =
		error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	try {
		if (cancellationRequested) {
			store.jobs.confirmCancelled(jobId, fence, {
				reason: "provider process was stopped after the cancellation request",
			});
		} else {
			store.fail(
				jobId,
				fence,
				message,
				/timed out/.test(message) ? "provider-timeout" : "provider-failed",
			);
		}
	} catch {
		// The fence was rejected: another owner already reconciled the job.
	}
} finally {
	clearInterval(heartbeat);
	store.close();
}

async function invoke(record: ProviderSupervisorRecord): Promise<{
	result: unknown;
	provenance: ProviderSupervisorProvenance;
}> {
	const request = requireRecord(record.request, "provider request");
	const cwd = providerCwd(record.provider, request);
	const child = Bun.spawn([record.command, ...record.args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	activeChild = child;
	if (cancellationRequested) child.kill();
	child.stdin.write(JSON.stringify(request));
	child.stdin.end();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, record.timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	if (timedOut) throw new Error(`${record.provider} timed out`);
	if (exitCode !== 0) {
		throw new Error(
			`${record.provider} exited with code ${exitCode}: ${stderr.trim() || "no diagnostic output"}`,
		);
	}
	let response: unknown;
	try {
		response = JSON.parse(stdout);
	} catch {
		throw new Error(`${record.provider} returned invalid JSON`);
	}
	return normalizeProviderResult(record.provider, request, response);
}

async function normalizeProviderResult(
	provider: ProviderSupervisorKind,
	request: Record<string, unknown>,
	responseValue: unknown,
): Promise<{ result: unknown; provenance: ProviderSupervisorProvenance }> {
	const response = requireRecord(responseValue, "provider response");
	if (response.protocolVersion !== 1 || response.status !== "completed") {
		throw new Error("provider response has an unsupported protocol or status");
	}
	const model = requireRecord(response.model, "provider model");
	const modelId = requireString(model.id, "provider model id");
	const modelVersion = requireString(model.version, "provider model version");
	const warnings =
		response.warnings === undefined
			? []
			: requireStrings(response.warnings, "provider warnings");
	let artifactSha256: string | null = null;
	let artifactBytes: number | null = null;
	let result: unknown;
	if (provider === "subject-tracker-command") {
		if (response.coordinateSpace !== "normalized-source") {
			throw new Error("tracker coordinate space must be normalized-source");
		}
		const samples = validateSamples(response.samples, request);
		result = { samples, modelId, modelVersion, warnings };
	} else {
		const artifact = requireRecord(response.artifact, "provider artifact");
		const outputDirectory = requireString(
			request.outputDirectory,
			"provider output directory",
		);
		const artifactPath = resolveContainedPath(
			outputDirectory,
			requireString(artifact.path, "provider artifact path"),
		);
		const info = await stat(artifactPath).catch(() => null);
		if (!info?.isFile() || info.size === 0) {
			throw new Error("provider artifact is missing or empty");
		}
		artifactBytes = info.size;
		artifactSha256 = await hashFile(artifactPath);
		result =
			provider === "matte-producer-command"
				? {
						artifactPath,
						channel: requireChannel(artifact.channel),
						modelId,
						modelVersion,
						warnings,
					}
				: { artifactPath, modelId, modelVersion, warnings };
	}
	return {
		result,
		provenance: {
			provider,
			providerProtocolVersion: 1,
			supervisorProtocolVersion: 2,
			modelId,
			modelVersion,
			artifactSha256,
			artifactBytes,
		},
	};
}

function providerCwd(
	provider: ProviderSupervisorKind,
	request: Record<string, unknown>,
): string {
	if (provider !== "subject-tracker-command") {
		return requireString(request.outputDirectory, "provider output directory");
	}
	const source = requireRecord(request.source, "tracker source");
	return dirname(requireString(source.path, "tracker source path"));
}

function validateSamples(
	value: unknown,
	request: Record<string, unknown>,
): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) throw new Error("tracker samples must be an array");
	const source = requireRecord(request.source, "tracker source");
	const duration = requireNumber(source.durationTicks, "tracker source duration");
	const sampling = requireRecord(request.sampling, "tracker sampling");
	const maxSamples = requireNumber(sampling.maxSamples, "tracker maximum samples");
	if (value.length > maxSamples) throw new Error("tracker returned too many samples");
	let previous = -1;
	return value.map((candidate, index) => {
		const sample = requireRecord(candidate, `tracker sample ${index}`);
		const sourceTime = requireNumber(sample.sourceTime, "tracker sample source time");
		if (sourceTime <= previous || sourceTime < 0 || sourceTime > duration) {
			throw new Error("tracker sample times must be strictly increasing and in range");
		}
		previous = sourceTime;
		const box = requireRecord(sample.box, "tracker sample box");
		const x = requireNumber(box.x, "tracker box x");
		const y = requireNumber(box.y, "tracker box y");
		const width = requireNumber(box.width, "tracker box width");
		const height = requireNumber(box.height, "tracker box height");
		if (
			x < 0 ||
			y < 0 ||
			width <= 0 ||
			height <= 0 ||
			x + width > 1 ||
			y + height > 1
		) {
			throw new Error("tracker box is outside normalized bounds");
		}
		if (sample.confidence !== undefined) {
			const confidence = requireNumber(sample.confidence, "tracker confidence");
			if (confidence < 0 || confidence > 1) {
				throw new Error("tracker confidence is invalid");
			}
		}
		return sample;
	});
}

function resolveContainedPath(outputDirectory: string, artifactPath: string): string {
	const root = resolve(outputDirectory);
	const path = resolve(root, artifactPath);
	const child = relative(root, path);
	if (child.startsWith("..") || isAbsolute(child)) {
		throw new Error("provider artifact escapes its output directory");
	}
	return path;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be finite`);
	}
	return value;
}

function requireStrings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be an array of strings`);
	}
	return value;
}

function requireChannel(value: unknown): "alpha" | "red" {
	if (value !== "alpha" && value !== "red") {
		throw new Error("matte artifact channel must be alpha or red");
	}
	return value;
}
