import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const webRoot = join(repositoryRoot, "apps", "web", "src");
const webPreload = join(
	repositoryRoot,
	"apps",
	"web",
	"test",
	"opencut-wasm.setup.ts",
);
const mcpRoot = join(repositoryRoot, "packages", "mcp-server", "src");
/**
 * wasm-pack's profiling profile compiles with the same release codegen the
 * published package uses, so tested behaviour matches what ships, but
 * rust/wasm/Cargo.toml turns off its optimizer pass. That pass is the whole
 * cost of this build and it only shrinks a file Bun loads from disk.
 */
const nativeRuntimeProfile = "--profiling";
const cargo = findExecutable({
	name: process.platform === "win32" ? "cargo.exe" : "cargo",
	fallbacks:
		process.platform === "win32"
			? [join(homedir(), ".cargo", "bin", "cargo.exe")]
			: [join(homedir(), ".cargo", "bin", "cargo")],
});
if (!cargo) {
	fail(
		"Rust tests: cargo was not found on PATH or in the standard rustup home",
	);
}
const wasmPack = findExecutable({
	name: process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack",
	fallbacks:
		process.platform === "win32"
			? [join(homedir(), ".cargo", "bin", "wasm-pack.exe")]
			: [join(homedir(), ".cargo", "bin", "wasm-pack")],
});
if (!wasmPack) {
	fail(
		"Web tests: wasm-pack was not found on PATH or in the standard Cargo bin directory",
	);
}
const webTestEnvironment = {
	...process.env,
	OPENCUT_TEST_CARGO_PATH: cargo,
};
const realVideoEnvironment = await prepareRealVideoMilestone();

buildSharedNativeRuntime();

run({
	label: "MCP server tests",
	command: process.execPath,
	args: ["test", mcpRoot],
});

const webTests = Array.from(
	new Bun.Glob("**/*.test.{ts,tsx,js,mjs}").scanSync({
		cwd: webRoot,
		onlyFiles: true,
	}),
)
	.map((path) => join(webRoot, path))
	.sort(webTestOrder);

await runWebTests(webTests);

run({
	label: "Rust workspace tests",
	command: cargo,
	args: ["test", "--workspace"],
});

if (realVideoEnvironment) runRealVideoMilestone(realVideoEnvironment);
console.log("\nAll configured test suites passed.");

/**
 * Every web suite runs in its own process so that one file's module mocks and
 * global patches cannot reach another. Those processes are independent, and
 * each spends far longer starting up than testing, so run several at once.
 *
 * The pool stays at or below eight: Bun crashes intermittently under sixteen
 * concurrent test runners, and the timing-sensitive suites need spare cores to
 * meet their own deadlines. Set OPENCUT_TEST_WEB_WORKERS=1 to restore the fully
 * sequential run.
 */
async function runWebTests(testPaths: string[]): Promise<void> {
	const workers = Math.max(1, Math.min(webWorkerLimit(), testPaths.length));
	console.log(
		`\n==> Web tests (${testPaths.length} isolated processes, ${workers} at a time)`,
	);

	const queue = testPaths.slice();
	const failures: string[] = [];
	async function consume(): Promise<void> {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const label = next.slice(repositoryRoot.length + 1);
			const child = Bun.spawn(
				[process.execPath, "test", "--preload", webPreload, next],
				{
					cwd: repositoryRoot,
					env: webTestEnvironment,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			console.log(`\n==> ${label}`);
			process.stdout.write(stdout);
			process.stderr.write(stderr);
			if (exitCode === 0) continue;
			console.error(`\nERROR: ${label}: exited with status ${exitCode}`);
			failures.push(label);
		}
	}

	await Promise.all(Array.from({ length: workers }, consume));
	if (failures.length > 0) {
		fail(
			`Web tests: ${failures.length} of ${testPaths.length} suites failed\n  ${failures.join("\n  ")}`,
		);
	}
}

function webWorkerLimit(): number {
	const configured = Number(process.env.OPENCUT_TEST_WEB_WORKERS?.trim());
	if (Number.isInteger(configured) && configured > 0) return configured;
	return Math.min(8, availableParallelism());
}

/**
 * Longest-running suites first, so the pool never finishes its short work and
 * then waits on one straggler. The native parity suite dominates because it
 * builds and runs a Rust evaluator, and it holds cargo's build lock while it
 * does, which would serialize anything scheduled beside it later in the run.
 */
function webTestOrder(left: string, right: string): number {
	const ranked = Number(isSlowWebTest(right)) - Number(isSlowWebTest(left));
	return ranked === 0 ? left.localeCompare(right, "en") : ranked;
}

function isSlowWebTest(path: string): boolean {
	return path.endsWith("edit-plan-native-parity.test.ts");
}

/**
 * The Node-target WASM package is a pure function of the Rust sources, the
 * resolved dependency versions, and the toolchain that compiles them. Rebuilding
 * it when none of those changed costs about half a minute of wasm-opt for a
 * byte-identical artifact, so record the inputs that produced the current
 * package and skip the build while both the stamp and its outputs still match.
 */
function buildSharedNativeRuntime(): void {
	const label = "Shared native WASM test runtime";
	const outputDirectory = join(repositoryRoot, "rust", "wasm", "pkg-node");
	const stampPath = join(outputDirectory, ".build-stamp");
	const outputs = [
		join(outputDirectory, "opencut_wasm.js"),
		join(outputDirectory, "opencut_wasm_bg.wasm"),
	];
	const stamp = nativeRuntimeStamp();
	if (
		stamp &&
		outputs.every((path) => existsSync(path)) &&
		readStamp(stampPath) === stamp
	) {
		console.log(`\n==> ${label} (unchanged, reusing pkg-node)`);
		return;
	}

	run({
		label,
		command: wasmPack,
		args: [
			"build",
			"rust/wasm",
			nativeRuntimeProfile,
			"--target",
			"nodejs",
			"--out-dir",
			"pkg-node",
		],
	});
	if (stamp) writeFileSync(stampPath, stamp);
}

/**
 * Hashes every input the Node-target package is built from: the Rust sources and
 * manifests, the resolved dependency graph, and the wasm-pack version. Returns
 * undefined when any input cannot be read, which forces an unconditional build.
 */
function nativeRuntimeStamp(): string | undefined {
	const version = spawnSync(wasmPack, ["--version"], { encoding: "utf8" });
	if (version.error || version.status !== 0) return undefined;

	const digest = createHash("sha256")
		.update(`${version.stdout.trim()}\n`)
		.update(`${nativeRuntimeProfile}\n`);
	const sources = Array.from(
		new Bun.Glob("rust/**/*.{rs,toml}").scanSync({
			cwd: repositoryRoot,
			onlyFiles: true,
		}),
	)
		.concat("Cargo.toml", "Cargo.lock")
		.sort((left, right) => left.localeCompare(right, "en"));
	try {
		for (const source of sources) {
			digest.update(`${source.replaceAll("\\", "/")}\n`);
			digest.update(readFileSync(join(repositoryRoot, source)));
		}
	} catch {
		return undefined;
	}
	return digest.digest("hex");
}

function readStamp(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

async function prepareRealVideoMilestone(): Promise<NodeJS.ProcessEnv | null> {
	const url = process.env.OPENCUT_HEADLESS_INTEGRATION_URL?.trim();
	const configuredBrowser = process.env.OPENCUT_HEADLESS_BROWSER_PATH?.trim();
	const configuredFfmpeg =
		process.env.OPENCUT_FFMPEG_PATH?.trim() ?? process.env.FFMPEG_PATH?.trim();
	const configuredFfprobe =
		process.env.OPENCUT_FFPROBE_PATH?.trim() ??
		process.env.FFPROBE_PATH?.trim();
	if (!url) {
		console.log(
			"\n==> Real-video milestone skipped: set OPENCUT_HEADLESS_INTEGRATION_URL and OPENCUT_HEADLESS_BROWSER_PATH after starting the web editor",
		);
		return null;
	}
	if (!configuredBrowser || !existsSync(configuredBrowser)) {
		fail(
			"Real-video milestone: OPENCUT_HEADLESS_BROWSER_PATH must name an existing Chrome or Edge executable",
		);
	}
	const ffmpeg = configuredFfmpeg
		? resolveExecutablePath(configuredFfmpeg)
		: findExecutable({
				name: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
				fallbacks: [],
			});
	const ffprobe = configuredFfprobe
		? resolveExecutablePath(configuredFfprobe)
		: findExecutable({
				name: process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
				fallbacks: [],
			});
	if (!ffmpeg || !ffprobe) {
		fail(
			"Real-video milestone: ffmpeg and ffprobe must both be on PATH or configured with OPENCUT_FFMPEG_PATH and OPENCUT_FFPROBE_PATH",
		);
	}

	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) {
			fail(
				`Real-video milestone: web editor returned HTTP ${response.status} at ${url}`,
			);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		fail(
			`Real-video milestone: web editor is not reachable at ${url}. Start it first, then retry. (${detail})`,
		);
	}

	return {
		...process.env,
		OPENCUT_RUN_HEADLESS_INTEGRATION: "1",
		OPENCUT_FFMPEG_PATH: ffmpeg,
		OPENCUT_FFPROBE_PATH: ffprobe,
	};
}

function runRealVideoMilestone(env: NodeJS.ProcessEnv): void {
	run({
		label: "Real-video MCP stdio milestone",
		command: process.execPath,
		args: ["test", join(mcpRoot, "mcp-stdio.integration.test.ts")],
		env,
	});
}

function run({
	label,
	command,
	args,
	env = process.env,
}: {
	label: string;
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
}): void {
	console.log(`\n==> ${label}`);
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		env,
		stdio: "inherit",
	});
	if (result.error) fail(`${label}: ${result.error.message}`);
	if (result.status !== 0) {
		fail(`${label}: exited with status ${result.status ?? "unknown"}`);
	}
}

function findExecutable({
	name,
	fallbacks,
}: {
	name: string;
	fallbacks: string[];
}): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory.replace(/^"|"$/g, ""), name);
		if (existsSync(candidate)) return candidate;
	}
	return fallbacks.find((candidate) => existsSync(candidate));
}

function resolveExecutablePath(value: string): string | undefined {
	return existsSync(value)
		? value
		: findExecutable({
				name: value,
				fallbacks: [],
			});
}

function fail(message: string): never {
	console.error(`\nERROR: ${message}`);
	process.exit(1);
}
