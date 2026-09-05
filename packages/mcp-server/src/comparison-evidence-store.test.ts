import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
	ComparisonEvidenceStore,
	type ComparisonNativeAdapter,
} from "./comparison-evidence-store";
import { removeTestDirectory } from "./test-filesystem";

describe("ComparisonEvidenceStore", () => {
	let directory: string;
	let store: ComparisonEvidenceStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-comparison-store-test-"));
		store = new ComparisonEvidenceStore(directory, 32191, limits, native);
		await store.readiness();
	});

	afterEach(async () => {
		await removeTestDirectory(directory);
	});

	test("durably links both source captures and publishes verified diff and side-by-side artifacts", async () => {
		const session = await store.createSession(input());
		await uploadCapture(store, session.beforeBaseUrl, [10, 20, 30, 255]);
		expect((await store.getByOperation("compare-1"))?.execution).toMatchObject({
			phase: "rendering-after",
			completed: 0,
			total: null,
		});
		await uploadCapture(store, session.afterBaseUrl, [15, 20, 30, 255]);
		expect((await store.getByOperation("compare-1"))?.execution).toMatchObject({
			phase: "comparing",
			completed: 1,
			total: 1,
		});

		const receipt = await store.finalize("compare-1", "rendered", {
			before: { binding: "before" },
			after: { binding: "after" },
			sharedRenderer: { backend: "webgpu" },
		});

		expect(receipt).toMatchObject({
			receiptId: "comparison:compare-1",
			execution: { status: "succeeded", completed: 1, total: 1 },
			captures: {
				before: { receiptId: "preview-range:compare-1:comparison:before" },
				after: { receiptId: "preview-range:compare-1:comparison:after" },
			},
			operationHistory: {
				beforeSaveOperationId: "save-before",
				afterSaveOperationId: "save-after",
				comparisonOperationId: "compare-1",
			},
			frames: [
				{
					ordinal: 0,
					metrics: { changedPixels: 16, totalPixels: 16 },
					regions: { items: [{ x: 0, y: 0, width: 4, height: 4 }] },
					before: {
						width: 4,
						height: 4,
						pngSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
					},
					after: {
						width: 4,
						height: 4,
						pngSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
					},
					diff: { width: 4, height: 4 },
					comparison: { width: 8, height: 4 },
				},
			],
			aggregateMetrics: { frameCount: 1, changedPixels: 16 },
		});
		expect(receipt.checksum).toMatch(/^[a-f0-9]{64}$/);
		await expect(store.get("comparison:compare-1")).resolves.toEqual(receipt);
		await expect(
			new ComparisonEvidenceStore(directory, 32191, limits, native).get(
				"comparison:compare-1",
			),
		).resolves.toEqual(receipt);
	});

	test("rejects captures whose Rust-verified frame schedules differ", async () => {
		const session = await store.createSession(input());
		await uploadCapture(store, session.beforeBaseUrl, [0, 0, 0, 255]);
		await uploadCapture(
			store,
			session.afterBaseUrl,
			[0, 0, 0, 255],
			frameSchedule(4_000),
		);
		await expect(
			store.finalize("compare-1", "rendered", {
				before: {},
				after: {},
			}),
		).rejects.toThrow("one complete frame schedule");
	});

	test("detects a changed terminal receipt and changed artifact bytes", async () => {
		const session = await store.createSession(input());
		await uploadCapture(store, session.beforeBaseUrl, [1, 2, 3, 255]);
		await uploadCapture(store, session.afterBaseUrl, [4, 5, 6, 255]);
		const receipt = await store.finalize("compare-1", "rendered", {
			before: {},
			after: {},
		});
		await writeFile(receipt.frames[0]!.diff.path, "changed");
		await expect(store.get(receipt.receiptId)).rejects.toThrow(
			"artifact integrity",
		);

		const fresh = new ComparisonEvidenceStore(
			await mkdtemp(join(tmpdir(), "opencut-comparison-receipt-test-")),
			32192,
			limits,
			native,
		);
		try {
			const next = await fresh.createSession({
				...input(),
				operationId: "compare-2",
			});
			await uploadCapture(fresh, next.beforeBaseUrl, [1, 1, 1, 255]);
			await uploadCapture(fresh, next.afterBaseUrl, [2, 2, 2, 255]);
			const terminal = await fresh.finalize("compare-2", "rendered", {
				before: {},
				after: {},
			});
			const recordPath = join(
				fresh.directory,
				"records",
				await readdirSingle(join(fresh.directory, "records")),
			);
			const raw = JSON.parse(await readFile(recordPath, "utf8"));
			raw.pixelTolerance = terminal.pixelTolerance + 1;
			await writeFile(recordPath, JSON.stringify(raw));
			await expect(fresh.get(terminal.receiptId)).rejects.toThrow(
				"receipt checksum",
			);
		} finally {
			await removeTestDirectory(fresh.directory);
		}
	});

	test("failed finalization removes operation-scoped comparison artifacts", async () => {
		const failing = new ComparisonEvidenceStore(directory, 32191, limits, {
			...native,
			aggregateFrameMetrics: () => {
				throw new Error("aggregate failed");
			},
		});
		const session = await failing.createSession(input());
		await uploadCapture(failing, session.beforeBaseUrl, [1, 2, 3, 255]);
		await uploadCapture(failing, session.afterBaseUrl, [4, 5, 6, 255]);
		await expect(
			failing.finalize("compare-1", "rendered", { before: {}, after: {} }),
		).rejects.toThrow("aggregate failed");
		await failing.fail("compare-1", "aggregate failed");
		expect(await readdirNames(join(directory, "artifacts"))).toEqual([]);
	});

	test("cancellation reaches both child captures and is terminal and replayable", async () => {
		await store.createSession(input());
		const requested = await store.cancel("compare-1");
		expect(requested?.execution.status).toBe("cancelling");
		const receipt = await store.finalize("compare-1", "cancelled", {
			before: {},
			after: {},
		});
		expect(receipt.execution).toMatchObject({
			status: "cancelled",
			cancellationObservedAt: expect.any(String),
		});
		await expect(store.get(receipt.receiptId)).resolves.toEqual(receipt);
	});

	test("a cancellation committed during finalization cannot be overwritten by success", async () => {
		const session = await store.createSession(input());
		await uploadCapture(store, session.beforeBaseUrl, [10, 20, 30, 255]);
		await uploadCapture(store, session.afterBaseUrl, [15, 20, 30, 255]);
		const finalizing = store.finalize("compare-1", "rendered", {
			before: {},
			after: {},
		});
		await store.cancel("compare-1");
		const receipt = await finalizing;
		expect(receipt.execution).toMatchObject({
			status: "cancelled",
			cancellationRequestedAt: expect.any(String),
			cancellationObservedAt: expect.any(String),
		});
		await expect(store.finalize("compare-1", "rendered", {})).resolves.toEqual(
			receipt,
		);
	});

	test("records aligned PCM metrics and exact changed-audio identities", async () => {
		const session = await store.createSession({
			...input(),
			output: {
				frameFormat: "png",
				comparison: "wipe",
				wipePosition: 0.5,
				includeAudio: true,
			},
		});
		await uploadCapture(
			store,
			session.beforeBaseUrl,
			[0, 0, 0, 255],
			frameSchedule(0),
			pcmWav(1),
		);
		await uploadCapture(
			store,
			session.afterBaseUrl,
			[0, 0, 0, 255],
			frameSchedule(0),
			pcmWav(2),
		);
		const receipt = await store.finalize("compare-1", "rendered", {
			before: {},
			after: {},
		});
		expect(receipt.audioMetrics).toMatchObject({
			changed: true,
			beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			metrics: { sampleCount: 2_940 },
		});
	});
});

const limits = {
	maxDurationSeconds: 10,
	maxDurationTicks: 1_200_000,
	maxFrames: 300,
};

const native: ComparisonNativeAdapter = {
	compareRgba: ({ before, width, height }) => ({
		metrics: { changedPixels: width * height, totalPixels: width * height },
		regions: { items: [{ x: 0, y: 0, width, height }] },
		diffRgba: new Uint8Array(
			before.map((value, index) => (index % 4 === 3 ? 255 : value)),
		),
	}),
	composeRgba: ({ before, after, width, height, mode }) => {
		if (mode === "wipe") return { width, height, rgba: before };
		const rgba = new Uint8Array(width * 2 * height * 4);
		for (let y = 0; y < height; y++) {
			rgba.set(
				before.subarray(y * width * 4, (y + 1) * width * 4),
				y * width * 8,
			);
			rgba.set(
				after.subarray(y * width * 4, (y + 1) * width * 4),
				y * width * 8 + width * 4,
			);
		}
		return { width: width * 2, height, rgba };
	},
	aggregateFrameMetrics: (metrics) => ({
		frameCount: metrics.length,
		changedPixels: metrics.reduce(
			(sum, item) => sum + Number(item.changedPixels),
			0,
		),
	}),
	comparePcmI16: ({ before }) => ({ sampleCount: before.length }),
};

function input() {
	return {
		operationId: "compare-1",
		inputFingerprint: "a".repeat(64),
		semanticInputHash: "b".repeat(64),
		capabilitySnapshotHash: "c".repeat(64),
		requiredWasmSha256: "d".repeat(64),
		projectId: "project-1",
		sceneId: "scene-1",
		before: source("before", 1),
		after: source("after", 2),
		range: {
			kind: "frame-index",
			startFrameIndex: 0,
			endFrameIndexExclusive: 1,
		},
		canvasSize: { width: 4, height: 4 },
		normalization: {
			canvas: "none" as const,
			color: "none" as const,
			fonts: "exact" as const,
			timing: "shared-schedule" as const,
		},
		output: {
			frameFormat: "png" as const,
			comparison: "side-by-side" as const,
			includeAudio: false,
		},
		pixelTolerance: 4,
		audioSampleTolerance: 16,
	};
}

function source(name: string, revision: number) {
	return {
		revision,
		projectContentHash: name === "before" ? "1".repeat(64) : "2".repeat(64),
		projectionName: "opencut-project-content" as const,
		projectionVersion: 2 as const,
		writeVersion: revision,
		saveReceiptOperationId: `save-${name}`,
		saveReceiptId: `save:${name}`,
	};
}

async function uploadCapture(
	store: ComparisonEvidenceStore,
	baseUrl: string,
	color: [number, number, number, number],
	schedule = frameSchedule(0),
	audio?: Uint8Array,
) {
	const token = baseUrl.split("/").at(-1)!;
	await store.receiveCapture(token, "manifest", jsonRequest(schedule));
	const png = await sharp({
		create: {
			width: 4,
			height: 4,
			channels: 4,
			background: {
				r: color[0],
				g: color[1],
				b: color[2],
				alpha: color[3] / 255,
			},
		},
	})
		.png()
		.toBuffer();
	await store.receiveCapture(token, "frames/0", putRequest(png));
	if (audio) {
		await store.receiveCapture(
			token,
			"audio",
			new Request("http://localhost", {
				method: "PUT",
				headers: {
					"X-OpenCut-Audio-Start-Ticks": "0",
					"X-OpenCut-Audio-End-Ticks-Exclusive": "4000",
				},
				body: new Blob([new Uint8Array(audio).buffer]),
			}),
		);
	}
}

function pcmWav(sample: number) {
	const sampleFrames = 1_470;
	const dataBytes = sampleFrames * 2 * 2;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 2, true);
	view.setUint32(24, 44_100, true);
	view.setUint32(28, 44_100 * 4, true);
	view.setUint16(32, 4, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	for (let offset = 44; offset < bytes.length; offset += 2)
		view.setInt16(offset, sample, true);
	return bytes;
}

function frameSchedule(startTicks: number) {
	return {
		schemaVersion: "opencut.frame-range-schedule.v1",
		sceneDurationTicks: 1_200_000,
		ticksPerSecond: 120_000,
		ticksPerFrame: 4_000,
		rate: { numerator: 30, denominator: 1 },
		endpointPolicy: "start-inclusive-end-exclusive",
		requestedRange: {
			kind: "frame-index",
			startFrameIndex: startTicks / 4_000,
			endFrameIndexExclusive: startTicks / 4_000 + 1,
		},
		frameCount: 1,
		requestedDurationTicks: 4_000,
		resolvedStartTicks: startTicks,
		resolvedEndTicksExclusive: startTicks + 4_000,
		startFrameIndex: startTicks / 4_000,
		endFrameIndexExclusive: startTicks / 4_000 + 1,
		scheduledDurationTicks: 4_000,
		policy: {
			outputCadence: "constant-frame-rate",
			outputFrames: "contiguous-once-fail-on-missing",
			sourceSampling: "presentation-interval-containing-mapped-time",
			unavailableSourceFrame: "fail-range",
		},
		frames: [
			{
				ordinal: 0,
				frameIndex: startTicks / 4_000,
				timelineTicks: startTicks,
				outputTicks: 0,
				durationTicks: 4_000,
			},
		],
	};
}

function jsonRequest(value: unknown) {
	return new Request("http://localhost", {
		method: "PUT",
		body: JSON.stringify(value),
	});
}

function putRequest(value: Uint8Array) {
	const copy = new Uint8Array(value);
	return new Request("http://localhost", {
		method: "PUT",
		body: new Blob([copy.buffer]),
	});
}

async function readdirSingle(directory: string) {
	const { readdir } = await import("node:fs/promises");
	return (await readdir(directory))[0]!;
}

async function readdirNames(directory: string) {
	const { readdir } = await import("node:fs/promises");
	return readdir(directory);
}
