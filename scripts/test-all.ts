import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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

run({
	label: "MCP server tests",
	command: process.execPath,
	args: ["test", mcpRoot],
});

run({
	label: "Project-state WASM test runtime",
	command: wasmPack,
	args: ["build", "rust/wasm", "--target", "nodejs", "--out-dir", "pkg-node"],
});

const webTests = Array.from(
	new Bun.Glob("**/*.test.{ts,tsx,js,mjs}").scanSync({
		cwd: webRoot,
		onlyFiles: true,
	}),
)
	.map((path) => join(webRoot, path))
	.sort((left, right) => left.localeCompare(right, "en"));

console.log(`\n==> Web tests (${webTests.length} isolated processes)`);
for (const testPath of webTests) {
	run({
		label: testPath.slice(repositoryRoot.length + 1),
		command: process.execPath,
		args: ["test", "--preload", webPreload, testPath],
		env: webTestEnvironment,
	});
}

run({
	label: "Rust workspace tests",
	command: cargo,
	args: ["test", "--workspace"],
});

if (realVideoEnvironment) runRealVideoMilestone(realVideoEnvironment);
console.log("\nAll configured test suites passed.");

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
