import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { RangePreviewEvidenceStore } from "./range-preview-evidence-store";

describe("RangePreviewEvidenceStore", () => {
	let directory: string;
	let store: RangePreviewEvidenceStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "opencut-preview-range-test-"));
		store = new RangePreviewEvidenceStore(directory, 32191, {
			maxDurationSeconds: 10,
			maxDurationTicks: 1_200_000,
			maxFrames: 300,
		});
		await store.readiness();
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("persists exact frame progress, cancellation, and restart-safe integrity", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		const schedule = frameSchedule();
		await store.receive(
			token,
			"manifest",
			new Request("http://localhost", {
				method: "PUT",
				body: JSON.stringify(schedule),
			}),
		);
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#123456" },
		})
			.png()
			.toBuffer();
		const pngCopy = new Uint8Array(png.byteLength);
		pngCopy.set(png);
		const upload = await store.receive(
			token,
			"frames/0",
			new Request("http://localhost", {
				method: "PUT",
				body: new Blob([pngCopy.buffer]),
			}),
		);
		expect(upload).toMatchObject({
			completed: 1,
			total: 2,
			cancellationRequested: false,
		});
		const cancelling = await store.cancel("range-1");
		expect(cancelling?.execution).toMatchObject({
			status: "cancelling",
			completed: 1,
			total: 2,
		});
		const cancelled = await store.finalize("range-1", "cancelled", {
			renderer: "test",
		});
		expect(cancelled.execution.status).toBe("cancelled");
		expect(cancelled.checksum).toMatch(/^[a-f0-9]{64}$/);

		const restarted = new RangePreviewEvidenceStore(directory, 32191, {
			maxDurationSeconds: 10,
			maxDurationTicks: 1_200_000,
			maxFrames: 300,
		});
		const recovered = await restarted.get("preview-range:range-1");
		expect(recovered).toMatchObject({
			operationId: "range-1",
			execution: { status: "cancelled", completed: 1, total: 2 },
			frames: [{ ordinal: 0, frameIndex: 0, timelineTicks: 0 }],
		});
	});

	test("requires requested audio and every frame before successful finalization", async () => {
		const session = await store.createSession({
			...input(),
			includeAudio: true,
		});
		const token = session.baseUrl.split("/").at(-1)!;
		await store.receive(token, "manifest", request(frameSchedule()));
		await expect(store.finalize("range-1", "rendered", {})).rejects.toThrow(
			"every scheduled frame",
		);
	});

	test("rejects a manifest above configured limits", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		await expect(
			store.receive(
				token,
				"manifest",
				request({ ...frameSchedule(), frameCount: 301 }),
			),
		).rejects.toThrow("Rust-recomputed schedule");
	});

	test("rejects a structurally valid manifest with noncanonical timestamps", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		const schedule = frameSchedule();
		schedule.frames[1]!.timelineTicks = 4_001;
		await expect(
			store.receive(token, "manifest", request(schedule)),
		).rejects.toThrow("Rust-recomputed schedule");
	});

	test("rejects invalid ordinals and oversized bodies before publishing artifacts", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		await store.receive(token, "manifest", request(frameSchedule()));
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#654321" },
		})
			.png()
			.toBuffer();
		await expect(
			store.receive(token, "frames/99", putRequest(png)),
		).rejects.toThrow("outside the schedule");
		const oversized = new Uint8Array(16 * 16 * 4 + 1024 * 1024 + 1);
		await expect(
			store.receive(token, "frames/0", putRequest(oversized)),
		).rejects.toThrow("exceeds its byte limit");
		expect(await readdir(join(directory, "artifacts"))).toEqual([]);
	});

	test("a late rendered result cannot overwrite durable cancellation", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		await store.receive(token, "manifest", request(frameSchedule()));
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#123456" },
		})
			.png()
			.toBuffer();
		await store.receive(token, "frames/0", putRequest(png));
		await store.receive(token, "frames/1", putRequest(png));
		await store.cancel("range-1");
		await store.status(token);
		const observedAt = (await store.getByOperation("range-1"))?.execution
			.cancellationObservedAt;
		expect(observedAt).toEqual(expect.any(String));
		const terminal = await store.finalize("range-1", "rendered", {});
		expect(terminal.execution).toMatchObject({
			status: "cancelled",
			cancellationRequestedAt: expect.any(String),
			cancellationObservedAt: observedAt,
		});
		expect((await store.cancel("range-1"))?.execution.status).toBe("cancelled");
	});

	test("concurrent cancellation observation and finalization retain checksum integrity", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		await store.receive(token, "manifest", request(frameSchedule()));
		await store.cancel("range-1");
		await Promise.all([
			store.status(token),
			store.finalize("range-1", "cancelled", {}),
		]);
		const terminal = await store.getByOperation("range-1");
		expect(terminal?.execution.status).toBe("cancelled");
		expect(terminal?.checksum).toMatch(/^[a-f0-9]{64}$/);
	});

	test("a delayed upload cannot mutate a failed terminal receipt", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		const upload = store.receive(
			token,
			"manifest",
			new Request("http://localhost", { method: "PUT", body }),
		);
		await Promise.resolve();
		const failure = store.fail("range-1", "bridge timed out");
		controller.enqueue(
			new TextEncoder().encode(JSON.stringify(frameSchedule())),
		);
		controller.close();
		await Promise.all([upload, failure]);
		const terminal = await store.getByOperation("range-1");
		expect(terminal?.execution.status).toBe("failed");
		expect(terminal?.checksum).toMatch(/^[a-f0-9]{64}$/);
	});

	test("two store instances preserve cancellation racing an upload commit", async () => {
		const other = new RangePreviewEvidenceStore(directory, 32192, {
			maxDurationSeconds: 10,
			maxDurationTicks: 1_200_000,
			maxFrames: 300,
		});
		await other.readiness();
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		await store.receive(token, "manifest", request(frameSchedule()));
		const png = await sharp({
			create: { width: 16, height: 16, channels: 4, background: "#abcdef" },
		})
			.png()
			.toBuffer();
		let announceWrite!: () => void;
		let releaseWrite!: () => void;
		const writeStarted = new Promise<void>(
			(resolve) => (announceWrite = resolve),
		);
		const writeReleased = new Promise<void>(
			(resolve) => (releaseWrite = resolve),
		);
		const originalWrite = Reflect.get(store, "write").bind(store) as (
			record: unknown,
		) => Promise<void>;
		Reflect.set(store, "write", async (record: { frames?: unknown[] }) => {
			if (record.frames?.length === 1) {
				announceWrite();
				await writeReleased;
			}
			await originalWrite(record);
		});
		const upload = store.receive(token, "frames/0", putRequest(png));
		await writeStarted;
		const cancellation = other.cancel("range-1");
		await new Promise((resolve) => setTimeout(resolve, 25));
		releaseWrite();
		await Promise.all([upload, cancellation]);
		const merged = await other.getByOperation("range-1");
		expect(merged).toMatchObject({
			frames: [{ ordinal: 0 }],
			execution: {
				status: "cancelling",
				completed: 1,
				cancellationRequestedAt: expect.any(String),
			},
		});
		await other.finalize("range-1", "cancelled", {});
		expect((await store.getByOperation("range-1"))?.checksum).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});

	test("rejects a terminal receipt whose checksum was removed through get and list", async () => {
		const session = await store.createSession(input());
		const token = session.baseUrl.split("/").at(-1)!;
		await store.receive(token, "manifest", request(frameSchedule()));
		await store.finalize("range-1", "cancelled", {});
		const [name] = await readdir(join(directory, "records"));
		const path = join(directory, "records", name!);
		const record = JSON.parse(await readFile(path, "utf8"));
		record.checksum = null;
		await writeFile(path, `${JSON.stringify(record)}\n`);
		await expect(store.get("preview-range:range-1")).rejects.toThrow(
			"has no checksum",
		);
		await expect(store.list({ limit: 10 })).rejects.toThrow("has no checksum");
	});
});

function input() {
	return {
		operationId: "range-1",
		inputFingerprint: "a".repeat(64),
		semanticInputHash: "e".repeat(64),
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 2,
		contentHash: "b".repeat(64),
		writeVersion: 3,
		saveReceiptId: "save-1",
		includeAudio: false,
		canvasSize: { width: 16, height: 16 },
		capabilitySnapshotHash: "c".repeat(64),
		requiredWasmSha256: "d".repeat(64),
	};
}

function putRequest(value: Uint8Array) {
	const copy = new Uint8Array(value.byteLength);
	copy.set(value);
	return new Request("http://localhost", {
		method: "PUT",
		body: new Blob([copy.buffer]),
	});
}

function frameSchedule() {
	return {
		schemaVersion: "opencut.frame-range-schedule.v1",
		sceneDurationTicks: 1_200_000,
		ticksPerSecond: 120_000,
		ticksPerFrame: 4_000,
		rate: { numerator: 30, denominator: 1 },
		endpointPolicy: "start-inclusive-end-exclusive",
		requestedRange: {
			kind: "frame-index",
			startFrameIndex: 0,
			endFrameIndexExclusive: 2,
		},
		frameCount: 2,
		requestedDurationTicks: 8_000,
		resolvedStartTicks: 0,
		resolvedEndTicksExclusive: 8_000,
		startFrameIndex: 0,
		endFrameIndexExclusive: 2,
		scheduledDurationTicks: 8_000,
		policy: {
			outputCadence: "constant-frame-rate",
			outputFrames: "contiguous-once-fail-on-missing",
			sourceSampling: "presentation-interval-containing-mapped-time",
			unavailableSourceFrame: "fail-range",
		},
		frames: [
			{
				ordinal: 0,
				frameIndex: 0,
				timelineTicks: 0,
				outputTicks: 0,
				durationTicks: 4_000,
			},
			{
				ordinal: 1,
				frameIndex: 1,
				timelineTicks: 4_000,
				outputTicks: 4_000,
				durationTicks: 4_000,
			},
		],
	};
}

function request(value: unknown): Request {
	return new Request("http://localhost", {
		method: "PUT",
		body: JSON.stringify(value),
	});
}
