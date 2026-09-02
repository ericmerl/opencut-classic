import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorBridge } from "./editor-bridge";
import { ExportReceiptStore } from "./export-receipts";
import { ExportValidator } from "./export-validator";
import { ManagedEditorWorker } from "./managed-editor-worker";

const integrationTest =
	process.env.OPENCUT_RUN_HEADLESS_INTEGRATION === "1" ? test : test.skip;

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-headless-integration-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

integrationTest(
	"connects the real web editor through a one-time bootstrap ticket",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl)
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		const port = Number(
			process.env.OPENCUT_HEADLESS_INTEGRATION_BRIDGE_PORT ?? "32291",
		);
		const bridge = new EditorBridge({
			token: randomBytes(32).toString("hex"),
			port,
		});
		let browserDiagnostics = "";
		const spawnWithDiagnostics = ((
			command: string,
			args: readonly string[],
		) => {
			const child = spawn(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			child.stdout?.on("data", (data) => {
				browserDiagnostics += String(data);
			});
			child.stderr?.on("data", (data) => {
				browserDiagnostics += String(data);
			});
			return child;
		}) as typeof spawn;
		const worker = new ManagedEditorWorker(bridge, {
			baseUrl,
			browserPath: process.env.OPENCUT_HEADLESS_BROWSER_PATH,
			profileDirectory: join(directory, "profile"),
			connectionTimeoutMs: 90_000,
			spawnProcess: spawnWithDiagnostics,
			browserArguments: ["--enable-logging=stderr", "--v=0"],
		});

		try {
			const status = await worker.ensureConnected().catch((error) => {
				const focusedDiagnostics = browserDiagnostics
					.split(/\r?\n/)
					.filter((line) =>
						/CONSOLE|ERROR|bootstrap|WebSocket|127\.0\.0\.1:3100|127\.0\.0\.1:32291/i.test(
							line,
						),
					)
					.join("\n");
				console.error(focusedDiagnostics.slice(-30_000));
				throw error;
			});
			expect(status).toMatchObject({ running: true, connected: true });
			const initialBridgeStatus = bridge.getStatus();
			expect(initialBridgeStatus).toMatchObject({
				connected: true,
				negotiatedProtocolVersion: 2,
				connectionIdentity: {
					serverInstanceId: initialBridgeStatus.serverInstanceId,
					connectionGeneration: 1,
				},
			});
			const initialConnectionIdentity = initialBridgeStatus.connectionIdentity;
			if (!initialConnectionIdentity) {
				throw new Error("negotiated editor identity is missing");
			}

			const catalog = requireRecord(
				await bridge.request("list_visual_assets", {}),
			);
			expect(catalog.graphics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ definitionId: "rectangle" }),
				]),
			);
			expect(catalog.masks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ maskType: "ellipse" }),
				]),
			);

			const initial = requireRecord(
				await bridge.request(
					"read_project",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: initialConnectionIdentity,
					},
					undefined,
					initialConnectionIdentity,
				),
			);
			const projectId = requireString(initial.projectId, "projectId");
			const revision = requireNumber(initial.revision, "revision");
			const inserted = requireRecord(
				await bridge.request(
					"apply_edit_plan",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: initialConnectionIdentity,
						projectId,
						operationId: "visual-integration-insert",
						expectedRevision: revision,
						description: "Insert native visual automation fixtures",
						operations: [
							{
								kind: "insert_graphic",
								definitionId: "rectangle",
								startTime: 0,
								duration: 120_000,
								params: { fill: "#ff0000", cornerRadius: 24 },
							},
							{
								kind: "insert_adjustment_layer",
								effectType: "color-grade",
								startTime: 0,
								duration: 120_000,
								params: { contrast: 12, highlights: -35 },
							},
						],
					},
					undefined,
					initialConnectionIdentity,
				),
			);
			expect(inserted.status).toBe("applied");
			const insertedSnapshot = requireRecord(inserted.snapshot);
			const elements = requireRecords(insertedSnapshot.elements, "elements");
			const graphic = elements.find((element) => element.type === "graphic");
			expect(graphic).toMatchObject({
				graphicDefinitionId: "rectangle",
				params: expect.objectContaining({ fill: "#ff0000", cornerRadius: 24 }),
			});
			expect(elements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "effect",
						effectType: "color-grade",
						params: expect.objectContaining({ contrast: 12, highlights: -35 }),
					}),
				]),
			);

			if (!graphic) throw new Error("inserted graphic missing from snapshot");
			const masked = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "visual-integration-mask",
					expectedRevision: requireNumber(inserted.revision, "revision"),
					description: "Author a native ellipse mask",
					operations: [
						{
							kind: "set_mask",
							trackId: requireString(graphic.trackId, "trackId"),
							elementId: requireString(graphic.elementId, "elementId"),
							maskId: "ellipse-mask-1",
							maskType: "ellipse",
							params: { feather: 12 },
						},
					],
				}),
			);
			const maskedElements = requireRecords(
				requireRecord(masked.snapshot).elements,
				"elements",
			);
			expect(
				maskedElements.find(
					(element) => element.elementId === graphic.elementId,
				),
			).toMatchObject({
				masks: [
					expect.objectContaining({
						maskId: "ellipse-mask-1",
						maskType: "ellipse",
						params: expect.objectContaining({ feather: 12 }),
					}),
				],
			});

			const duplicated = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-duplicate",
					expectedRevision: requireNumber(masked.revision, "revision"),
					description: "Insert a following graphic and duplicate the first",
					operations: [
						{
							kind: "insert_graphic",
							definitionId: "rectangle",
							name: "Following graphic",
							trackId: requireString(graphic.trackId, "trackId"),
							startTime: 120_000,
							duration: 120_000,
							params: { fill: "#00ff00" },
						},
						{
							kind: "duplicate_elements",
							elements: [
								{
									trackId: requireString(graphic.trackId, "trackId"),
									elementId: requireString(graphic.elementId, "elementId"),
								},
							],
						},
					],
				}),
			);
			expect(duplicated.status).toBe("applied");
			const duplicatedElements = requireRecords(
				requireRecord(duplicated.snapshot).elements,
				"elements",
			);
			expect(
				duplicatedElements.filter(
					(element) => element.graphicDefinitionId === "rectangle",
				),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "Following graphic",
						startTime: 120_000,
					}),
					expect.objectContaining({ name: expect.stringContaining("(copy)") }),
				]),
			);

			const rippled = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-ripple-delete",
					expectedRevision: requireNumber(duplicated.revision, "revision"),
					description: "Ripple-delete the first graphic",
					operations: [
						{
							kind: "delete",
							trackId: requireString(graphic.trackId, "trackId"),
							elementId: requireString(graphic.elementId, "elementId"),
							ripple: true,
						},
					],
				}),
			);
			expect(rippled.status).toBe("applied");
			const rippledElements = requireRecords(
				requireRecord(rippled.snapshot).elements,
				"elements",
			);
			expect(
				rippledElements.find((element) => element.name === "Following graphic"),
			).toMatchObject({ startTime: 0 });
			expect(
				rippledElements.some(
					(element) => element.elementId === graphic.elementId,
				),
			).toBe(false);

			const followingGraphic = rippledElements.find(
				(element) => element.name === "Following graphic",
			);
			const duplicatedGraphic = rippledElements.find(
				(element) =>
					typeof element.name === "string" && element.name.includes("(copy)"),
			);
			if (!followingGraphic || !duplicatedGraphic) {
				throw new Error("relationship integration fixtures are missing");
			}
			const relationshipRefs = [followingGraphic, duplicatedGraphic].map(
				(element) => ({
					trackId: requireString(element.trackId, "trackId"),
					elementId: requireString(element.elementId, "elementId"),
				}),
			);
			const grouped = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-group",
					expectedRevision: requireNumber(rippled.revision, "revision"),
					description: "Create a persistent group",
					operations: [
						{
							kind: "set_group",
							groupId: "integration-group-1",
							elements: relationshipRefs,
						},
					],
				}),
			);
			const groupMoved = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-group-move",
					expectedRevision: requireNumber(grouped.revision, "revision"),
					description: "Move the complete persistent group",
					operations: [
						{
							kind: "move",
							...relationshipRefs[0],
							startTime: 120_000,
						},
					],
				}),
			);
			const groupMovedElements = requireRecords(
				requireRecord(groupMoved.snapshot).elements,
				"elements",
			);
			for (const ref of relationshipRefs) {
				expect(
					groupMovedElements.find(
						(element) => element.elementId === ref.elementId,
					),
				).toMatchObject({
					groupId: "integration-group-1",
					startTime: 120_000,
				});
			}

			const linked = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-link",
					expectedRevision: requireNumber(groupMoved.revision, "revision"),
					description: "Replace the group with a persistent link",
					operations: [
						{
							kind: "set_link",
							linkId: "integration-link-1",
							elements: relationshipRefs,
						},
						{ kind: "clear_group", groupId: "integration-group-1" },
					],
				}),
			);
			const linkMoved = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-link-move",
					expectedRevision: requireNumber(linked.revision, "revision"),
					description: "Move the complete persistent link",
					operations: [
						{
							kind: "move",
							...relationshipRefs[0],
							startTime: 240_000,
						},
					],
				}),
			);
			const linkMovedElements = requireRecords(
				requireRecord(linkMoved.snapshot).elements,
				"elements",
			);
			for (const ref of relationshipRefs) {
				const linkedElement = linkMovedElements.find(
					(element) => element.elementId === ref.elementId,
				);
				expect(linkedElement).toMatchObject({
					linkId: "integration-link-1",
					startTime: 240_000,
				});
				expect(linkedElement?.groupId).toBeUndefined();
			}

			const compounded = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-compound",
					expectedRevision: requireNumber(linkMoved.revision, "revision"),
					description: "Create a persistent linked compound clip",
					operations: [
						{
							kind: "create_compound",
							compoundId: "integration-compound-1",
							name: "Integration compound",
							elements: relationshipRefs,
							relationshipScope: "link",
						},
					],
				}),
			);
			const compoundedElements = requireRecords(
				requireRecord(compounded.snapshot).elements,
				"elements",
			);
			const compound = compoundedElements.find(
				(element) => element.elementId === "integration-compound-1",
			);
			if (!compound) throw new Error("compound integration fixture is missing");
			const nestedElements = requireRecords(
				requireRecord(compound.compound).elements,
				"compound elements",
			);
			expect(nestedElements).toHaveLength(2);
			expect(
				nestedElements.every(
					(element) =>
						element.linkId === "integration-link-1" && element.startTime === 0,
				),
			).toBe(true);

			const sourcePath = join(directory, "save-barrier-source.mp4");
			await createSyntheticVideo(sourcePath);
			const sourceBytes = await readFile(sourcePath);
			const sourceSha256 = createHash("sha256")
				.update(sourceBytes)
				.digest("hex");
			const sourceTicket = await bridge.mediaTickets.create(sourcePath);
			const imported = requireRecord(
				await bridge.request(
					"import_media",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: initialConnectionIdentity,
						projectId,
						operationId: "save-barrier-media-import",
						expectedRevision: requireNumber(compounded.revision, "revision"),
						url: sourceTicket.url,
						name: sourceTicket.name,
						mimeType: sourceTicket.mimeType,
						sourceFingerprint: sourceTicket.sourceFingerprint,
						startTime: 480_000,
						adoptMediaSettings: false,
					},
					undefined,
					initialConnectionIdentity,
				),
			);
			expect(imported.status).toBe("applied");
			const importedSnapshot = requireRecord(imported.snapshot);
			const importedHash = requireProjectContentHash(importedSnapshot);
			const importedAssetId = requireString(imported.assetId, "assetId");
			const importedAssets = requireRecords(
				importedSnapshot.mediaAssets,
				"mediaAssets",
			);
			expect(
				requireRecord(
					requireRecord(
						importedAssets.find((asset) => asset.assetId === importedAssetId)
							?.sourceIdentity,
					).contentHash,
				).digest,
			).toBe(sourceSha256);
			const importedElementId = requireString(imported.elementId, "elementId");
			const importedElement = requireRecords(
				importedSnapshot.elements,
				"elements",
			).find((element) => element.elementId === importedElementId);
			if (!importedElement)
				throw new Error("imported video element is missing");

			const graded = requireRecord(
				await bridge.request(
					"apply_edit_plan",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: initialConnectionIdentity,
						projectId,
						operationId: "save-barrier-observable-grade",
						expectedRevision: requireNumber(imported.revision, "revision"),
						description: "Apply the complete realistic color grade",
						operations: [
							{
								kind: "upsert_effect",
								trackId: requireString(importedElement.trackId, "trackId"),
								elementId: importedElementId,
								effectId: "save-barrier-realistic-grade",
								effectType: "color-grade",
								params: {
									temperature: -3,
									tint: 2,
									saturation: -6,
									exposure: -3,
									contrast: 12,
									highlights: -35,
									shadows: 18,
									fade: 6,
								},
								enabled: true,
							},
						],
					},
					undefined,
					initialConnectionIdentity,
				),
			);
			expect(graded.status).toBe("applied");
			const gradedSnapshot = requireRecord(graded.snapshot);
			const gradedHash = requireProjectContentHash(gradedSnapshot);
			const saveRequest = {
				bridgeProtocolVersion: 2 as const,
				expectedConnectionIdentity: initialConnectionIdentity,
				projectId,
				sceneId: requireString(gradedSnapshot.sceneId, "sceneId"),
				operationId: "managed-video-save-barrier",
				expectedRevision: requireNumber(graded.revision, "revision"),
				expectedContentHash: gradedHash,
			};
			const saved = requireRecord(
				await bridge.request(
					"save_project",
					saveRequest,
					5 * 60_000,
					initialConnectionIdentity,
				),
			);
			expect(saved).toMatchObject({
				status: "saved",
				projectId,
				contentHash: gradedHash,
				readbackContentHash: gradedHash,
				reloadVerified: true,
			});
			const saveReceiptId = requireString(saved.receiptId, "receiptId");
			const saveWriteVersion = requireNumber(
				saved.writeVersion,
				"writeVersion",
			);
			expect(saveWriteVersion).toBeGreaterThan(0);
			expect(
				Date.parse(requireString(saved.persistedAt, "persistedAt")),
			).not.toBeNaN();
			expect(
				Date.parse(requireString(saved.completedAt, "completedAt")),
			).not.toBeNaN();
			const queriedReceipt = requireRecord(
				await bridge.request(
					"get_save_receipt",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: initialConnectionIdentity,
						operationId: saveRequest.operationId,
					},
					undefined,
					initialConnectionIdentity,
				),
			);
			expect(queriedReceipt).toMatchObject({
				status: "found",
				receiptId: saveReceiptId,
				writeVersion: saveWriteVersion,
			});

			await worker.stop();
			const restarted = await worker.ensureConnected(projectId);
			expect(restarted).toMatchObject({ running: true, connected: true });
			const restartedBridgeStatus = bridge.getStatus();
			expect(restartedBridgeStatus).toMatchObject({
				negotiatedProtocolVersion: 2,
				connectionIdentity: {
					serverInstanceId: initialConnectionIdentity.serverInstanceId,
					editorInstanceId: initialConnectionIdentity.editorInstanceId,
					connectionGeneration:
						initialConnectionIdentity.connectionGeneration + 1,
				},
			});
			expect(
				restartedBridgeStatus.connectionIdentity?.editorSessionId,
			).not.toBe(initialConnectionIdentity.editorSessionId);
			const restartedConnectionIdentity =
				restartedBridgeStatus.connectionIdentity;
			if (!restartedConnectionIdentity) {
				throw new Error("restarted editor identity is missing");
			}
			const reloaded = requireRecord(
				await bridge.request(
					"read_project",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: restartedConnectionIdentity,
					},
					undefined,
					restartedConnectionIdentity,
				),
			);
			expect(reloaded.connectionIdentity).toEqual(
				restartedBridgeStatus.connectionIdentity,
			);
			expect(requireProjectContentHash(reloaded)).toBe(gradedHash);
			const reloadedAssets = requireRecords(
				reloaded.mediaAssets,
				"mediaAssets",
			);
			expect(
				requireRecord(
					requireRecord(
						reloadedAssets.find((asset) => asset.assetId === importedAssetId)
							?.sourceIdentity,
					).contentHash,
				).digest,
			).toBe(sourceSha256);
			const reloadedElements = requireRecords(reloaded.elements, "elements");
			expect(
				reloadedElements.find(
					(element) => element.elementId === importedElementId,
				),
			).toMatchObject({
				type: "video",
				effects: [
					expect.objectContaining({
						effectId: "save-barrier-realistic-grade",
						effectType: "color-grade",
						enabled: true,
						params: {
							temperature: -3,
							tint: 2,
							saturation: -6,
							exposure: -3,
							contrast: 12,
							highlights: -35,
							shadows: 18,
							fade: 6,
						},
					}),
				],
			});
			const replayedSave = requireRecord(
				await bridge.request(
					"save_project",
					{
						...saveRequest,
						expectedConnectionIdentity: restartedConnectionIdentity,
					},
					5 * 60_000,
					restartedConnectionIdentity,
				),
			);
			expect(replayedSave).toMatchObject({
				status: "replayed",
				receiptId: saveReceiptId,
				writeVersion: saveWriteVersion,
				contentHash: gradedHash,
			});

			const verifiedExportPath = join(directory, "save-barrier-verified.webm");
			const verifiedExportTicket = await bridge.exportTickets.create(
				verifiedExportPath,
				"webm",
			);
			const verifiedExport = requireRecord(
				await bridge.request(
					"export_project",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: restartedConnectionIdentity,
						projectId,
						operationId: "save-barrier-pinned-export",
						expectedRevision: requireNumber(reloaded.revision, "revision"),
						expectedProjectContentHash: gradedHash,
						format: "webm",
						quality: "low",
						fps: { numerator: 30, denominator: 1 },
						includeAudio: true,
						canvasSize: { width: 320, height: 240 },
						outputPath: verifiedExportTicket.outputPath,
						url: verifiedExportTicket.url,
					},
					5 * 60_000,
					restartedConnectionIdentity,
				),
			);
			if (verifiedExport.status !== "exported") {
				throw new Error(
					`verified export failed: ${JSON.stringify(verifiedExport)}`,
				);
			}
			expect(verifiedExport).toMatchObject({
				status: "exported",
				savedContentHash: gradedHash,
			});
			expect(typeof verifiedExport.saveReceiptId).toBe("string");
			const verifiedValidation = await new ExportValidator(
				new ExportReceiptStore(join(directory, "save-barrier-receipts")),
			).validate({
				operationId: "save-barrier-pinned-export",
				outputPath: verifiedExportPath,
				format: "webm",
				expectedWidth: 320,
				expectedHeight: 240,
				expectedFps: 30,
				includeAudio: true,
			});
			expect(verifiedValidation).toMatchObject({
				status: "validated",
				fullDecode: true,
				video: { width: 320, height: 240, fps: 30 },
				audio: { present: true },
			});
			expect(
				verifiedValidation.frameSamples.map((sample) => sample.position),
			).toEqual(["opening", "middle", "ending"]);
			for (const sample of verifiedValidation.frameSamples) {
				expect(sample.bytes).toBeGreaterThan(0);
				expect(sample.sha256).toMatch(/^[a-f0-9]{64}$/);
			}
			const reloadedCompound = reloadedElements.find(
				(element) => element.elementId === "integration-compound-1",
			);
			expect(reloadedCompound).toMatchObject({
				type: "compound",
				name: "Integration compound",
			});
			const reloadedCompoundTrackId = requireString(
				reloadedCompound?.trackId,
				"compound trackId",
			);

			const brokenApart = requireRecord(
				await bridge.request(
					"apply_edit_plan",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: restartedConnectionIdentity,
						projectId,
						operationId: "timeline-integration-break-apart",
						expectedRevision: requireNumber(reloaded.revision, "revision"),
						description: "Restore the nested linked elements",
						operations: [
							{
								kind: "break_apart_compound",
								trackId: reloadedCompoundTrackId,
								elementId: "integration-compound-1",
							},
						],
					},
					undefined,
					restartedConnectionIdentity,
				),
			);
			const restoredElements = requireRecords(
				requireRecord(brokenApart.snapshot).elements,
				"elements",
			);
			for (const ref of relationshipRefs) {
				expect(
					restoredElements.find(
						(element) => element.elementId === ref.elementId,
					),
				).toMatchObject({
					linkId: "integration-link-1",
					startTime: 240_000,
				});
			}

			const variantPath = join(directory, "square-variant.webm");
			const variantTicket = await bridge.exportTickets.create(
				variantPath,
				"webm",
			);
			const variantExport = requireRecord(
				await bridge.request(
					"export_project",
					{
						bridgeProtocolVersion: 2,
						expectedConnectionIdentity: restartedConnectionIdentity,
						projectId,
						operationId: "timeline-integration-square-export",
						expectedRevision: requireNumber(brokenApart.revision, "revision"),
						expectedProjectContentHash: requireProjectContentHash(
							requireRecord(brokenApart.snapshot),
						),
						format: "webm",
						quality: "low",
						fps: { numerator: 30, denominator: 1 },
						includeAudio: false,
						canvasSize: { width: 320, height: 320 },
						outputPath: variantTicket.outputPath,
						url: variantTicket.url,
					},
					5 * 60_000,
					restartedConnectionIdentity,
				),
			);
			if (variantExport.status !== "exported") {
				const diagnostics = browserDiagnostics
					.split(/\r?\n/)
					.filter((line) => /CONSOLE|ERROR|export|compositor|wasm/i.test(line))
					.slice(-100)
					.join("\n");
				throw new Error(
					`variant export failed: ${JSON.stringify(variantExport)}\n${diagnostics}`,
				);
			}
			expect(variantExport.connectionIdentity).toEqual(
				restartedBridgeStatus.connectionIdentity,
			);
			expect(requireProjectContentHash(variantExport)).toBe(
				requireProjectContentHash(requireRecord(brokenApart.snapshot)),
			);
			expect((await stat(variantPath)).size).toBeGreaterThan(0);
			const variantValidation = await new ExportValidator(
				new ExportReceiptStore(join(directory, "variant-receipts")),
			).validate({
				operationId: "timeline-integration-square-export",
				outputPath: variantPath,
				format: "webm",
				expectedWidth: 320,
				expectedHeight: 320,
				expectedFps: 30,
				includeAudio: false,
			});
			expect(variantValidation).toMatchObject({
				status: "validated",
				fullDecode: true,
				video: { width: 320, height: 320, fps: 30 },
			});

			const linkDeleted = requireRecord(
				await bridge.request("apply_edit_plan", {
					projectId,
					operationId: "timeline-integration-link-delete",
					expectedRevision: requireNumber(brokenApart.revision, "revision"),
					description: "Delete the complete persistent link",
					operations: [
						{
							kind: "delete",
							...relationshipRefs[0],
							relationshipScope: "link",
						},
					],
				}),
			);
			const linkDeletedElements = requireRecords(
				requireRecord(linkDeleted.snapshot).elements,
				"elements",
			);
			expect(
				relationshipRefs.every((ref) =>
					linkDeletedElements.every(
						(element) => element.elementId !== ref.elementId,
					),
				),
			).toBe(true);
		} finally {
			await worker.stop();
			bridge.stop();
		}
	},
	5 * 60_000,
);

async function createSyntheticVideo(outputPath: string): Promise<void> {
	const ffmpeg =
		process.env.OPENCUT_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
	await new Promise<void>((resolve, reject) => {
		let diagnostics = "";
		const child = spawn(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=320x240:rate=30:duration=2",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=48000:duration=2",
				"-shortest",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-ar",
				"48000",
				"-ac",
				"2",
				outputPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
		);
		child.stderr?.on("data", (data) => {
			diagnostics += String(data);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else
				reject(new Error(`synthetic video generation failed: ${diagnostics}`));
		});
	});
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object response");
	}
	return Object.fromEntries(Object.entries(value));
}

function requireProjectContentHash(value: Record<string, unknown>): string {
	const identity = requireRecord(value.contentIdentity);
	if (identity.status !== "hashed") {
		throw new Error(`project content identity is ${String(identity.status)}`);
	}
	const hash = requireRecord(identity.hash);
	return requireString(hash.digest, "project content digest");
}

function requireRecords(
	value: unknown,
	name: string,
): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map(requireRecord);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number") throw new Error(`${name} must be a number`);
	return value;
}
