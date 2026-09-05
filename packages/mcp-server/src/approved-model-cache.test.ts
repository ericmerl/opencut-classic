import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovedModelCache } from "./approved-model-cache";

const SILERO = "opencut.task.voice-activity-detection.v1";
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-model-cache-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("reports an approved artifact as unavailable until its exact bytes are cached", async () => {
	const cache = new ApprovedModelCache(root);
	const result = await cache.readiness(SILERO);
	expect(result).toMatchObject({
		status: "unavailable",
		canExecute: false,
		artifact: {
			status: "missing",
			sha256:
				"1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
		},
	});
	expect(result.cachePath).toBe(
		join(
			root,
			"v1",
			SILERO,
			"1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
			"silero_vad.onnx",
		),
	);
});

test("refuses a downloaded hash mismatch without publishing it to the deterministic cache", async () => {
	const cache = new ApprovedModelCache(root, {
		fetch: async () => new Response("tampered model"),
	});
	await expect(cache.acquire(SILERO)).rejects.toThrow(
		"MODEL_ARTIFACT_HASH_MISMATCH",
	);
	const readiness = await cache.readiness(SILERO);
	expect(readiness).toMatchObject({
		status: "unavailable",
		artifact: { status: "missing" },
	});
});

test("reuses an immutable verified cache entry and enforces canonical Silero CPU policy", async () => {
	const expected = {
		sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
		bytes: 2_327_524,
	};
	const cache = new ApprovedModelCache(root, {
		inspectArtifact: async () => expected,
		fetch: async () => {
			throw new Error("verified cache entries must not be downloaded again");
		},
	});
	const cachePath = cache.pathFor(SILERO);
	await mkdir(join(cachePath, ".."), { recursive: true });
	await Bun.write(cachePath, "fixture boundary");
	const acquired = await cache.acquire(SILERO);
	expect(acquired).toMatchObject({ status: "cached", cachePath });

	const wrongThreads = await cache.readiness(SILERO, {
		runtimeId: "onnxruntime",
		runtimeVersion: "1.22.1",
		device: "cpu",
		hostOs: "windows",
		environment: "native",
		threads: 2,
		deterministicConformance: true,
	});
	expect(wrongThreads).toMatchObject({
		status: "misconfigured",
		canExecute: false,
		code: "MODEL_EXECUTION_POLICY_VIOLATION",
	});

	const ready = await cache.readiness(SILERO, {
		runtimeId: "onnxruntime",
		runtimeVersion: "1.22.1",
		device: "cpu",
		hostOs: "windows",
		environment: "native",
		threads: 1,
		deterministicConformance: true,
	});
	expect(ready).toMatchObject({
		status: "ready",
		canExecute: true,
		device: "cpu",
	});
	expect(await readFile(cachePath, "utf8")).toBe("fixture boundary");
});
