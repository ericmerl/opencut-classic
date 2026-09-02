import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
	PreviewEvidenceIntegrityError,
	PreviewEvidenceStore,
	type PreviewFrameReceipt,
} from "./preview-evidence-store";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("preview evidence store", () => {
	test("publishes content-addressed PNG evidence and survives restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-preview-test-"));
		directories.push(directory);
		const png = await testPng(320, 180);
		const store = new PreviewEvidenceStore(directory, 32191);
		await store.readiness();
		const ticket = store.createTicket("preview-op-1", 320, 180);
		const id = new URL(ticket.url).pathname.split("/").at(-1)!;
		const uploaded = await store.receive(
			id,
			new Request(ticket.url, {
				method: "PUT",
				headers: { "Content-Type": "image/png" },
				body: requestBody(png),
			}),
		);
		const upload = await store.uploadIdentity("preview-op-1");
		expect(uploaded.sha256).toBe(
			createHash("sha256").update(png).digest("hex"),
		);
		const receipt = await store.write(makeReceipt(upload!));
		await expect(
			store.write({ ...receipt, saveReceiptOperationId: "different-save-op" }),
		).rejects.toThrow("save receipt");
		await expect(
			store.write({
				...receipt,
				fontReadiness: {
					...receipt.fontReadiness,
					descriptors: receipt.fontReadiness.descriptors.map((descriptor) => ({
						...descriptor,
						matchedFaces: descriptor.matchedFaces.map((face) => ({
							...face,
							weight: "400",
						})),
					})),
				},
			}),
		).rejects.toThrow("font readiness");
		await expect(
			store.write({
				...receipt,
				sourceVerification: {
					...receipt.sourceVerification,
					revisionAfter: receipt.revision + 1,
				},
			}),
		).rejects.toThrow("source verification");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { PreviewEvidenceStore } = await import("./packages/mcp-server/src/preview-evidence-store.ts"); const store = new PreviewEvidenceStore(${JSON.stringify(directory)}, 32191); const receipt = await store.get(${JSON.stringify(receipt.receiptId)}); console.log(receipt?.artifact.sha256 ?? "missing"); store.close();`,
			],
			{
				cwd: resolve(import.meta.dir, "../../.."),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [childExit, childStdout, childStderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(childExit, childStderr).toBe(0);
		expect(childStdout.trim()).toBe(receipt.artifact.sha256);
		store.close();

		const restarted = new PreviewEvidenceStore(directory, 32191);
		const recovered = await restarted.get(receipt.receiptId);
		expect(recovered?.artifact).toMatchObject({
			sha256: uploaded.sha256,
			width: 320,
			height: 180,
		});
		expect((await restarted.list({ limit: 10 })).receipts).toHaveLength(1);
		restarted.close();
	});

	test("fails closed when a durable artifact is tampered with", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-preview-test-"));
		directories.push(directory);
		const store = new PreviewEvidenceStore(directory, 32191);
		const ticket = store.createTicket("preview-op-1", 8, 8);
		const id = new URL(ticket.url).pathname.split("/").at(-1)!;
		await store.receive(
			id,
			new Request(ticket.url, {
				method: "PUT",
				headers: { "Content-Type": "image/png" },
				body: requestBody(await testPng(8, 8)),
			}),
		);
		const upload = (await store.uploadIdentity("preview-op-1"))!;
		const receipt = await store.write(makeReceipt(upload));
		await writeFile(receipt.artifact.path, await testPng(9, 9));
		await expect(store.get(receipt.receiptId)).rejects.toBeInstanceOf(
			PreviewEvidenceIntegrityError,
		);
		store.close();
	});

	test("reconciles concurrent writers and a crash between upload and receipt", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-preview-test-"));
		directories.push(directory);
		const uploader = new PreviewEvidenceStore(directory, 32191);
		await Promise.all(Array.from({ length: 8 }, () => uploader.readiness()));
		const ticket = uploader.createTicket("preview-op-1", 8, 8);
		const id = new URL(ticket.url).pathname.split("/").at(-1)!;
		await uploader.receive(
			id,
			new Request(ticket.url, {
				method: "PUT",
				headers: { "Content-Type": "image/png" },
				body: requestBody(await testPng(8, 8)),
			}),
		);
		const upload = (await uploader.uploadIdentity("preview-op-1"))!;
		uploader.close();

		const left = new PreviewEvidenceStore(directory, 32191);
		const right = new PreviewEvidenceStore(directory, 32191);
		const receipt = makeReceipt(upload);
		const [leftResult, rightResult] = await Promise.all([
			left.write(receipt),
			right.write(receipt),
		]);
		expect(leftResult).toEqual(rightResult);
		await expect(
			right.write({ ...receipt, inputFingerprint: "9".repeat(64) }),
		).rejects.toThrow("different preview receipt");
		const competingTicket = left.createTicket("preview-op-2", 8, 8);
		const competingId = new URL(competingTicket.url).pathname
			.split("/")
			.at(-1)!;
		await left.receive(
			competingId,
			new Request(competingTicket.url, {
				method: "PUT",
				headers: { "Content-Type": "image/png" },
				body: requestBody(await testPng(8, 8)),
			}),
		);
		const competingUpload = (await left.uploadIdentity("preview-op-2"))!;
		const competing = makeReceipt(competingUpload, {
			operationId: "preview-op-2",
			inputFingerprint: "2".repeat(64),
		});
		const outcomes = await Promise.allSettled([
			left.write(competing),
			right.write({ ...competing, inputFingerprint: "3".repeat(64) }),
		]);
		expect(
			outcomes.filter(({ status }) => status === "fulfilled"),
		).toHaveLength(1);
		expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
			1,
		);
		expect((await left.list({ limit: 1 })).receipts).toHaveLength(1);
		await expect(
			left.list({ limit: 1, cursor: "x".repeat(513) }),
		).rejects.toThrow("512-character limit");
		left.close();
		right.close();
	});

	test("recovers killed schema and artifact publication processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "opencut-preview-crash-"));
		directories.push(root);
		const schemaDirectory = join(root, "schema");
		const schemaMarker = join(root, "schema.marker");
		const schemaChild = spawnHidden(
			`const { PreviewEvidenceStore } = await import("./packages/mcp-server/src/preview-evidence-store.ts"); const store = new PreviewEvidenceStore(${JSON.stringify(schemaDirectory)}, 32191); await store.readiness();`,
			{
				OPENCUT_PREVIEW_TEST_PAUSE: "after-schema-ddl",
				OPENCUT_PREVIEW_TEST_MARKER: schemaMarker,
			},
		);
		await waitForPath(schemaMarker);
		schemaChild.kill();
		await childExit(schemaChild);
		const afterSchemaKill = new PreviewEvidenceStore(schemaDirectory, 32191);
		await afterSchemaKill.readiness();
		afterSchemaKill.close();

		const publicationDirectory = join(root, "publication");
		const publicationMarker = join(root, "publication.marker");
		const png = await testPng(8, 8);
		const publicationChild = spawnHidden(
			`const { PreviewEvidenceStore } = await import("./packages/mcp-server/src/preview-evidence-store.ts"); const store = new PreviewEvidenceStore(${JSON.stringify(publicationDirectory)}, 32191); const ticket = store.createTicket("killed-publication", 8, 8); const id = new URL(ticket.url).pathname.split("/").at(-1); const bytes = Buffer.from(${JSON.stringify(png.toString("base64"))}, "base64"); await store.receive(id, new Request(ticket.url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes }));`,
			{
				OPENCUT_PREVIEW_TEST_PAUSE: "after-artifact-publication",
				OPENCUT_PREVIEW_TEST_MARKER: publicationMarker,
			},
		);
		await waitForPath(publicationMarker);
		publicationChild.kill();
		await childExit(publicationChild);
		const recovered = new PreviewEvidenceStore(publicationDirectory, 32191);
		const ticket = recovered.createTicket("killed-publication", 8, 8);
		const id = new URL(ticket.url).pathname.split("/").at(-1)!;
		await recovered.receive(
			id,
			new Request(ticket.url, {
				method: "PUT",
				headers: { "Content-Type": "image/png" },
				body: requestBody(png),
			}),
		);
		const upload = (await recovered.uploadIdentity("killed-publication"))!;
		const receipt = await recovered.write(
			makeReceipt(upload, { operationId: "killed-publication" }),
		);
		expect((await recovered.get(receipt.receiptId))?.artifact.sha256).toBe(
			upload.sha256,
		);
		recovered.close();
	});

	test("serializes cold starts and same or competing cross-process writers", async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-preview-process-"));
		directories.push(directory);
		const coldGate = join(directory, "cold.gate");
		const coldScript = `while (!(await Bun.file(${JSON.stringify(coldGate)}).exists())) await Bun.sleep(5); const { PreviewEvidenceStore } = await import("./packages/mcp-server/src/preview-evidence-store.ts"); const store = new PreviewEvidenceStore(${JSON.stringify(directory)}, 32191); await store.readiness(); console.log("ready"); store.close();`;
		const coldChildren = [spawnHidden(coldScript), spawnHidden(coldScript)];
		await writeFile(coldGate, "go");
		const coldResults = await Promise.all(coldChildren.map(childResult));
		expect(coldResults.map(({ code }) => code)).toEqual([0, 0]);

		const store = new PreviewEvidenceStore(directory, 32191);
		const sameReceipt = await prepareReceipt({
			store,
			operationId: "cross-process-same",
		});
		store.close();
		const sameGate = join(directory, "same.gate");
		const sameChildren = [
			spawnHidden(writeReceiptScript(directory, sameGate, sameReceipt)),
			spawnHidden(writeReceiptScript(directory, sameGate, sameReceipt)),
		];
		await writeFile(sameGate, "go");
		const sameResults = await Promise.all(sameChildren.map(childResult));
		expect(sameResults.map(({ code }) => code)).toEqual([0, 0]);

		const competingStore = new PreviewEvidenceStore(directory, 32191);
		const competing = await prepareReceipt({
			store: competingStore,
			operationId: "cross-process-competing",
		});
		competingStore.close();
		const competingGate = join(directory, "competing.gate");
		const competingChildren = [
			spawnHidden(writeReceiptScript(directory, competingGate, competing)),
			spawnHidden(
				writeReceiptScript(directory, competingGate, {
					...competing,
					inputFingerprint: "f".repeat(64),
				}),
			),
		];
		await writeFile(competingGate, "go");
		const competingResults = await Promise.all(
			competingChildren.map(childResult),
		);
		expect(competingResults.filter(({ code }) => code === 0)).toHaveLength(1);
		expect(competingResults.filter(({ code }) => code !== 0)).toHaveLength(1);
		const verified = new PreviewEvidenceStore(directory, 32191);
		expect(
			(await verified.getByOperation("cross-process-competing"))
				?.inputFingerprint,
		).toMatch(/^(a|f){64}$/);
		verified.close();
	});
});

async function prepareReceipt({
	store,
	operationId,
}: {
	store: PreviewEvidenceStore;
	operationId: string;
}): Promise<PreviewFrameReceipt> {
	const ticket = store.createTicket(operationId, 8, 8);
	const id = new URL(ticket.url).pathname.split("/").at(-1)!;
	await store.receive(
		id,
		new Request(ticket.url, {
			method: "PUT",
			headers: { "Content-Type": "image/png" },
			body: requestBody(await testPng(8, 8)),
		}),
	);
	return makeReceipt((await store.uploadIdentity(operationId))!, {
		operationId,
	});
}

function writeReceiptScript(
	directory: string,
	gate: string,
	receipt: PreviewFrameReceipt,
): string {
	return `while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(5); const { PreviewEvidenceStore } = await import("./packages/mcp-server/src/preview-evidence-store.ts"); const store = new PreviewEvidenceStore(${JSON.stringify(directory)}, 32191); try { await store.write(JSON.parse(${JSON.stringify(JSON.stringify(receipt))})); console.log("written"); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; } finally { store.close(); }`;
}

function spawnHidden(
	script: string,
	environment: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
	return spawn(process.execPath, ["-e", script], {
		cwd: resolve(import.meta.dir, "../../.."),
		env: { ...process.env, ...environment },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
}

async function childResult(child: ChildProcessWithoutNullStreams): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
	const code = await childExit(child);
	return {
		code,
		stdout: Buffer.concat(stdout).toString(),
		stderr: Buffer.concat(stderr).toString(),
	};
}

function childExit(
	child: ChildProcessWithoutNullStreams,
): Promise<number | null> {
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", resolveExit);
	});
}

async function waitForPath(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (true) {
		if (
			await access(path).then(
				() => true,
				() => false,
			)
		)
			return;
		if (Date.now() >= deadline)
			throw new Error(`timed out waiting for ${path}`);
		await Bun.sleep(10);
	}
}

function makeReceipt(
	upload: NonNullable<
		Awaited<ReturnType<PreviewEvidenceStore["uploadIdentity"]>>
	>,
	options: {
		operationId?: string;
		inputFingerprint?: string;
	} = {},
): PreviewFrameReceipt {
	const operationId = options.operationId ?? "preview-op-1";
	return {
		schemaVersion: 2,
		receiptId: `preview:${operationId}`,
		operationId,
		inputFingerprint: options.inputFingerprint ?? "a".repeat(64),
		createdAt: new Date().toISOString(),
		projectId: "project-1",
		sceneId: "scene-1",
		revision: 4,
		contentHash: "b".repeat(64),
		writeVersion: 9,
		saveReceiptId: "save:project-1:9",
		saveReceiptOperationId: "save-op",
		connectionIdentity: {
			serverInstanceId: "server",
			editorInstanceId: "editor",
			editorSessionId: "session",
			connectionGeneration: 1,
		},
		requestedTime: { kind: "frame-index", frameIndex: 2 },
		requestedTicks: 8_000,
		resolvedTicks: 8_000,
		frameIndex: 2,
		fps: { numerator: 30, denominator: 1 },
		ticksPerFrame: 4_000,
		rounding: "exact",
		artifact: {
			artifactId: upload.sha256,
			path: upload.path,
			mimeType: "image/png",
			bytes: upload.bytes,
			sha256: upload.sha256,
			width: upload.width,
			height: upload.height,
			pixelRgbaSha256: upload.pixel_rgba_sha256,
			colorSpace: "srgb",
			alphaMode: "straight",
		},
		saveReceipt: {
			status: "saved",
			receiptId: "save:project-1:9",
			operationId: "save-op",
			projectId: "project-1",
			sceneId: "scene-1",
			revision: 4,
			contentHash: "b".repeat(64),
			persistedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			storageSchemaVersion: 1,
			writeVersion: 9,
			reloadVerified: true,
			readbackContentHash: "b".repeat(64),
		},
		renderer: {
			provider: "opencut-web-renderer",
			pipeline: "editor-native-exact-frame",
			compositor: "opencut-wasm-webgl",
			browser: "test-browser",
			encoder: "browser-canvas-png",
			bridgeProtocolVersion: 2,
			mcpBuild: "test",
			wasmPackageVersion: "0.2.10",
			renderSpecFingerprint: "d".repeat(64),
			capabilityHash: "e".repeat(64),
			executionIdentity: {
				serverInstanceId: "server",
				editorInstanceId: "editor",
				editorSessionId: "session",
				connectionGeneration: 1,
			},
		},
		fontReadiness: fontReadiness(),
		editorState: {
			unchanged: true,
			playheadTicks: 0,
			isPlaying: false,
			selectionFingerprint: "{}",
			canUndo: false,
			canRedo: false,
		},
		sourceVerification: {
			revisionBefore: 4,
			revisionAfter: 4,
			contentHashBefore: "b".repeat(64),
			contentHashAfter: "b".repeat(64),
		},
		operationLedgerId: operationId,
	};
}

function fontReadiness(): PreviewFrameReceipt["fontReadiness"] {
	const face = {
		provenance: "system-local-font-face" as const,
		family: "Arial",
		style: "italic",
		weight: "700",
		stretch: "100%",
		unicodeRange: "U+0-10FFFF",
		featureSettings: "normal",
		display: "auto",
	};
	const matchedFace = {
		...face,
		identitySha256: createHash("sha256")
			.update(JSON.stringify(face))
			.digest("hex"),
	};
	const descriptorBase = {
		family: "Arial",
		style: "italic",
		weight: "bold",
		stretch: "normal",
		css: 'italic bold 16px "Arial"',
	};
	const descriptor = {
		...descriptorBase,
		identitySha256: createHash("sha256")
			.update(JSON.stringify(descriptorBase))
			.digest("hex"),
		matchedFaceIdentities: [matchedFace.identitySha256],
		matchedFaces: [matchedFace],
	};
	return {
		status: "ready",
		families: ["Arial"],
		descriptors: [descriptor],
		descriptorsSha256: createHash("sha256")
			.update(JSON.stringify([descriptor]))
			.digest("hex"),
	};
}

function testPng(width: number, height: number): Promise<Buffer> {
	return sharp({
		create: {
			width,
			height,
			channels: 4,
			background: { r: 12, g: 34, b: 56, alpha: 0.75 },
		},
	})
		.png()
		.toBuffer();
}

function requestBody(bytes: Buffer): Uint8Array<ArrayBuffer> {
	const body = new Uint8Array(bytes.byteLength);
	body.set(bytes);
	return body;
}
