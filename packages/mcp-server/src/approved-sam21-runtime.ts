interface Sam21Probe {
	status: "ready" | "degraded" | "unavailable";
	canExecute: boolean;
	code: string | null;
	reason: string | null;
	model: {
		id: string;
		revision: string;
		sha256: string;
		codeRevision: string;
	};
	runtime?: {
		device: "cpu" | "cuda";
		framework: string;
		deterministic: boolean;
		conformanceVerified: boolean;
	};
}

export async function readApprovedSam21Runtime(
	artifactReadiness: Record<string, unknown>,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
	if (
		artifactReadiness.canExecute !== false &&
		artifactReadiness.status !== "degraded"
	) {
		return artifactReadiness;
	}
	if (!isReadyArtifact(artifactReadiness)) return artifactReadiness;
	const command = environment.OPENCUT_SUBJECT_TRACKER_COMMAND;
	if (!command) {
		return unavailable(
			artifactReadiness,
			"SUBJECT_TRACKER_COMMAND_MISSING",
			"The approved artifact is verified, but OPENCUT_SUBJECT_TRACKER_COMMAND is not configured.",
		);
	}
	const args = parseArgs(environment.OPENCUT_SUBJECT_TRACKER_ARGS);
	if (!args.ok)
		return unavailable(
			artifactReadiness,
			"SUBJECT_TRACKER_ARGS_INVALID",
			args.reason,
		);
	const child = Bun.spawn([command, ...args.value, "--probe-json"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...environment },
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 15_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	if (timedOut || exitCode !== 0) {
		return unavailable(
			artifactReadiness,
			timedOut
				? "SUBJECT_TRACKER_PROBE_TIMEOUT"
				: "SUBJECT_TRACKER_PROBE_FAILED",
			stderr.trim() || `subject tracker probe exited with code ${exitCode}`,
		);
	}
	let probe: Sam21Probe;
	try {
		probe = JSON.parse(stdout) as Sam21Probe;
	} catch {
		return unavailable(
			artifactReadiness,
			"SUBJECT_TRACKER_PROBE_MALFORMED",
			"Subject tracker readiness probe did not return JSON.",
		);
	}
	if (!validProbe(probe)) {
		return unavailable(
			artifactReadiness,
			"SUBJECT_TRACKER_PROBE_IDENTITY_MISMATCH",
			"Subject tracker probe did not attest the approved model, code, runtime, and conformance identity.",
		);
	}
	return {
		...artifactReadiness,
		status: probe.status,
		canExecute: probe.canExecute,
		code: probe.code,
		reason: probe.reason,
		provider: probe,
	};
}

function validProbe(probe: Sam21Probe): boolean {
	return (
		probe?.model?.id === "facebook/sam2.1-hiera-small" &&
		probe.model.revision === "ee5bba1d82bb8749febdf90f45e84b687142ba03" &&
		probe.model.sha256 ===
			"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60" &&
		probe.model.codeRevision === "2b90b9f5ceec907a1c18123530e92e794ad901a4" &&
		probe.runtime?.framework === "facebookresearch/sam2" &&
		probe.runtime.deterministic === true &&
		probe.canExecute ===
			(probe.status === "ready" && probe.runtime.conformanceVerified === true)
	);
}

function isReadyArtifact(readiness: Record<string, unknown>): boolean {
	return isRecord(readiness.artifact) && readiness.artifact.status === "ready";
}

function unavailable(
	artifactReadiness: Record<string, unknown>,
	code: string,
	reason: string,
): Record<string, unknown> {
	return {
		...artifactReadiness,
		status: "unavailable",
		canExecute: false,
		code,
		reason,
	};
}

function parseArgs(
	raw: string | undefined,
): { ok: true; value: string[] } | { ok: false; reason: string } {
	if (!raw) return { ok: true, value: [] };
	try {
		const value = JSON.parse(raw);
		return Array.isArray(value) &&
			value.every((entry) => typeof entry === "string")
			? { ok: true, value }
			: {
					ok: false,
					reason:
						"OPENCUT_SUBJECT_TRACKER_ARGS must be a JSON array of strings.",
				};
	} catch {
		return {
			ok: false,
			reason: "OPENCUT_SUBJECT_TRACKER_ARGS is not valid JSON.",
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
