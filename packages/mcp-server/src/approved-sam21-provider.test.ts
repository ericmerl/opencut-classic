import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const provider = resolve(import.meta.dir, "../providers/sam21_hiera_small.py");

describe("approved SAM 2.1 provider command", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-sam21-provider-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("reports the immutable provider identity without importing the model runtime", async () => {
		const result = Bun.spawnSync(["python", provider, "--version"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe(
			"opencut-sam21-provider/2 facebook/sam2.1-hiera-small@ee5bba1d82bb8749febdf90f45e84b687142ba03 facebookresearch/sam2@2b90b9f5ceec907a1c18123530e92e794ad901a4",
		);
	});

	test("probe fails closed on changed model bytes before loading Python ML packages", async () => {
		const modelPath = join(directory, "model.safetensors");
		await writeFile(modelPath, "not-the-approved-model");
		const result = Bun.spawnSync([
			"python",
			provider,
			"--probe-json",
			"--model-path",
			modelPath,
			"--sam2-code-dir",
			directory,
			"--device",
			"cpu",
		]);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			status: "unavailable",
			canExecute: false,
			code: "MODEL_HASH_MISMATCH",
			model: {
				id: "facebook/sam2.1-hiera-small",
				revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
				sha256:
					"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
			},
		});
	});
});
