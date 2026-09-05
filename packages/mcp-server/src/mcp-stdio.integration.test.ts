import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const integrationTest =
	process.env.OPENCUT_RUN_HEADLESS_INTEGRATION === "1" ? test : test.skip;
// Preview frames are straight RGBA while the WebM carries lossy VP9 with 4:2:0
// chroma, so bitwise equality is impossible. MAE bounds the average per-channel
// drift; the PSNR floor catches a small number of large errors (a wrong frame,
// a missing overlay) that a low MAE would hide. A frame taken from the wrong
// time measured 20 dB on the real path while matching frames measure 33 dB
// and above, so 28 dB separates the two with margin for codec loss.
const PREVIEW_EXPORT_RGBA_MAE_TOLERANCE = 16;
const PREVIEW_EXPORT_RGBA_MIN_PSNR_DB = 28;
// The preview WAV is lossless PCM while the WebM carries lossy Opus. Both are
// decoded to the same 44.1 kHz stereo PCM so the comparison measures encoder
// loss only. The export is decoded once in full and each window is sliced by
// sample index, because seeking into the Opus stream with ffmpeg lands on a
// packet boundary and fakes a lag of up to 10 ms. The streams are then aligned
// within a 20 ms search window before the sample comparison, and the lag is
// bounded separately because it is the audio-to-video sync error. The real path
// measured a 0.7 ms lag and an aligned MAE of about 10 on a signal averaging
// 1275, so 2 ms and 128 (0.4% of full scale) leave several times the observed
// values while still rejecting a dropped Opus frame (20 ms) or a dropout.
const PREVIEW_EXPORT_PCM_MAE_TOLERANCE = 128;
const PREVIEW_EXPORT_PCM_LAG_SEARCH_SECONDS = 0.02;
const PREVIEW_EXPORT_PCM_MAX_LAG_SECONDS = 0.002;
const PREVIEW_EXPORT_PCM_SAMPLE_COUNT_TOLERANCE_SECONDS = 0.001;
const PREVIEW_EXPORT_LOUDNESS_TOLERANCE_LU = 1;
const PREVIEW_EXPORT_TRUE_PEAK_TOLERANCE_DB = 1;
const AUDIO_BOUNDARY_WINDOW_SECONDS = 0.5;
const MEDIA_TICKS_PER_SECOND = 120_000;
const PARITY_AUDIO_SAMPLE_RATE = 44_100;
const PARITY_AUDIO_CHANNELS = 2;

let directory: string;
const processes: McpStdioHarness[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-public-mcp-integration-"));
});

afterEach(async () => {
	for (const process of processes.splice(0)) await process.close();
	if (process.env.OPENCUT_INTEGRATION_KEEP_ARTIFACTS === "1") {
		console.log(`[integration] keeping artifacts in ${directory}`);
		return;
	}
	await removeTemporaryDirectory(directory);
});

integrationTest(
	"flushes every WebM Opus audio frame through the public export path",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl)
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath)
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");

		const bridgePort = await availablePort();
		const profileDirectory = join(directory, "opus-tail-profile");
		const receiptDirectory = join(directory, "opus-tail-receipts");
		const sourcePath = join(directory, "opus-tail-source.mp4");
		const outputPath = join(directory, "opus-tail-export.webm");
		await createSyntheticVideo(sourcePath);

		const mcp = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await mcp.callTool("opencut_start_editor_worker", {});
		const status = await mcp.callTool("opencut_connection_status", {});
		const identity = requireRecord(
			status.connectionIdentity,
			"connectionIdentity",
		);
		const initial = await mcp.callTool(
			"opencut_get_project",
			affinity(identity),
		);
		const projectId = requireString(initial.projectId, "projectId");
		const imported = await mcp.callTool("opencut_import_media", {
			...affinity(identity),
			projectId,
			operationId: "opus-tail-import",
			expectedRevision: requireNumber(initial.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(initial),
			path: sourcePath,
			startTime: 0,
			adoptMediaSettings: true,
		});
		const importedSnapshot = requireRecord(
			imported.snapshot,
			"imported snapshot",
		);
		const exported = await mcp.callTool(
			"opencut_export_project",
			{
				...affinity(identity),
				projectId,
				operationId: "opus-tail-export",
				expectedRevision: requireNumber(imported.revision, "import revision"),
				expectedProjectContentHash: requireProjectContentHash(importedSnapshot),
				outputPath,
				format: "webm",
				quality: "low",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: true,
				canvasSize: { width: 64, height: 64 },
			},
			5 * 60_000,
		);
		expect(exported).toMatchObject({
			status: "exported",
			validation: {
				status: "validated",
				audio: {
					codec: "opus",
					declaredCodecDelaySeconds: 0.0065,
					declaredSeekPreRollSeconds: 0.08,
				},
			},
		});
		const webmValidation = requireRecord(exported.validation, "validation");
		expect(
			Math.abs(
				requireNumber(webmValidation.durationSeconds, "durationSeconds") - 2,
			),
		).toBeLessThanOrEqual(0.001);

		const decodedAudio = await extractPcmI16(outputPath, 48_000);
		const decodedFrames = decodedAudio.length / PARITY_AUDIO_CHANNELS;
		expect(Math.abs(decodedFrames - 96_000)).toBeLessThanOrEqual(1);

		const mp4OutputPath = join(directory, "aac-priming-export.mp4");
		const aacExported = await mcp.callTool(
			"opencut_export_project",
			{
				...affinity(identity),
				projectId,
				operationId: "aac-priming-export",
				expectedRevision: requireNumber(imported.revision, "import revision"),
				expectedProjectContentHash: requireProjectContentHash(importedSnapshot),
				outputPath: mp4OutputPath,
				format: "mp4",
				quality: "low",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: true,
				canvasSize: { width: 64, height: 64 },
			},
			5 * 60_000,
		);
		expect(aacExported).toMatchObject({
			status: "exported",
			validation: {
				status: "validated",
				audio: {
					codec: "aac",
					declaredCodecDelaySeconds: null,
					declaredSeekPreRollSeconds: null,
				},
			},
		});
		const decodedAacAudio = await extractPcmI16(mp4OutputPath, 48_000);
		const decodedAacFrames = decodedAacAudio.length / PARITY_AUDIO_CHANNELS;
		// Chromium emits whole 1024-sample AAC access units and this MP4 path has
		// no declared codec delay. Preserve the confirmed behavior as a bound: no
		// timeline content is cut, and the surplus stays within one AAC unit after
		// resampling the 44.1 kHz stream to the comparison rate.
		expect(decodedAacFrames).toBeGreaterThanOrEqual(96_000);
		expect(decodedAacFrames - 96_000).toBeLessThanOrEqual(
			Math.ceil((1024 * 48_000) / 44_100),
		);

		const receipt = await mcp.callTool("opencut_get_export_receipt", {
			operationId: "opus-tail-export",
		});
		expect(receipt).toMatchObject({
			status: "found",
			receipt: {
				result: {
					validation: {
						audio: { declaredCodecDelaySeconds: 0.0065 },
					},
				},
			},
		});
		await mcp.callTool("opencut_stop_editor_worker", {});
		await mcp.close();

		const restarted = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await restarted.callTool("opencut_start_editor_worker", { projectId });
		const restartedStatus = await restarted.callTool(
			"opencut_connection_status",
			{},
		);
		const restartedIdentity = requireRecord(
			restartedStatus.connectionIdentity,
			"restarted connectionIdentity",
		);
		const replayed = await restarted.callTool(
			"opencut_export_project",
			{
				...affinity(restartedIdentity),
				projectId,
				operationId: "opus-tail-export",
				expectedRevision: requireNumber(imported.revision, "import revision"),
				expectedProjectContentHash: requireProjectContentHash(importedSnapshot),
				outputPath,
				format: "webm",
				quality: "low",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: true,
				canvasSize: { width: 64, height: 64 },
			},
			5 * 60_000,
		);
		expect(replayed).toMatchObject({
			status: "exported",
			durableOperationStatus: "replayed",
			sha256: exported.sha256,
			validation: {
				audio: { declaredCodecDelaySeconds: 0.0065 },
			},
		});
		await restarted.callTool("opencut_stop_editor_worker", {});
	},
	10 * 60_000,
);

integrationTest(
	"lists native history and safely performs multi-step undo, redo, checkpoint, restore, and restart rejection",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl)
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath)
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		const bridgePort = await availablePort();
		const profileDirectory = join(directory, "history-profile");
		const receiptDirectory = join(directory, "history-receipts");
		const first = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await first.callTool("opencut_start_editor_worker", {});
		const firstStatus = await first.callTool("opencut_connection_status", {});
		const firstIdentity = requireRecord(
			firstStatus.connectionIdentity,
			"connectionIdentity",
		);
		const initial = await first.callTool(
			"opencut_get_project",
			affinity(firstIdentity),
		);
		const projectId = requireString(initial.projectId, "projectId");
		const sceneId = requireString(initial.sceneId, "sceneId");
		const initialHash = requireProjectContentHash(initial);
		const safety = (
			project: Record<string, unknown>,
			identity = firstIdentity,
		) => ({
			...affinity(identity),
			projectId,
			sceneId,
			expectedRevision: requireNumber(project.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(project),
		});

		const initialHistory = await first.callTool(
			"opencut_get_history_state",
			safety(initial),
		);
		expect(initialHistory).toMatchObject({
			status: "history-state",
			projectId,
			sceneId,
			revision: initial.revision,
			contentHash: initialHash,
		});
		const baselineNativeHistory = requireRecord(
			initialHistory.nativeHistory,
			"nativeHistory",
		);

		const createdCheckpoint = await first.callTool(
			"opencut_create_checkpoint",
			{
				...safety(initial),
				operationId: "history-create-checkpoint",
				checkpointId: "history-baseline",
				name: "Baseline before color changes",
			},
		);
		expect(createdCheckpoint).toMatchObject({
			status: "checkpoint-created",
			checkpointId: "history-baseline",
			contentHash: initialHash,
			operationRecord: {
				relationships: { checkpointId: "history-baseline" },
				affectedObjects: expect.arrayContaining([
					{
						objectType: "checkpoint",
						objectId: "history-baseline",
						action: "created",
					},
				]),
			},
		});

		const applyBackground = async (
			project: Record<string, unknown>,
			operationId: string,
			color: string,
		) => {
			const contentHash = requireProjectContentHash(project);
			const revision = requireNumber(project.revision, "revision");
			const saveOperationId = `${operationId}:save`;
			const saved = await first.callTool("opencut_save_project", {
				...affinity(firstIdentity),
				projectId,
				sceneId,
				operationId: saveOperationId,
				expectedRevision: revision,
				expectedContentHash: contentHash,
			});
			const description = `Set project background to ${color}`;
			const operations = [
				{
					kind: "set_project_settings",
					background: { type: "color", color },
				},
			];
			const preflight = await first.callTool("opencut_preflight_edit_plan", {
				contractVersion: 2,
				...affinity(firstIdentity),
				preflightId: `${operationId}:preflight`,
				projectId,
				sceneId,
				expectedRevision: revision,
				expectedProjectContentHash: contentHash,
				expectedWriteVersion: requireNumber(saved.writeVersion, "writeVersion"),
				saveReceiptOperationId: saveOperationId,
				expectedSaveReceiptId: requireString(saved.receiptId, "receiptId"),
				description,
				operations,
				policy: {
					warningPolicy: "allow",
					providerExecution: "forbidden",
					costPolicy: "require-exact",
				},
			});
			const preflightResult = requireRecord(
				preflight.result,
				"preflight result",
			);
			const evaluation = requireRecord(
				preflightResult.evaluation,
				"preflight evaluation",
			);
			const applied = await first.callTool("opencut_apply_edit_plan", {
				...safety(project),
				operationId,
				description,
				operations,
				preflight: {
					receiptId: requireString(preflight.receiptId, "preflight receiptId"),
					planFingerprint: requireString(
						evaluation.planFingerprint,
						"planFingerprint",
					),
					preflightFingerprint: requireString(
						evaluation.preflightFingerprint,
						"preflightFingerprint",
					),
					planDiffHash: requireString(evaluation.planDiffHash, "planDiffHash"),
				},
			});
			expect(applied.status).toBe("applied");
			return requireRecord(applied.snapshot, "applied snapshot");
		};

		const afterFirstEdit = await applyBackground(
			initial,
			"history-edit-one",
			"#112233",
		);
		const afterSecondEdit = await applyBackground(
			afterFirstEdit,
			"history-edit-two",
			"#334455",
		);
		const secondHash = requireProjectContentHash(afterSecondEdit);
		const afterEditsHistory = await first.callTool(
			"opencut_get_history_state",
			safety(afterSecondEdit),
		);
		expect(
			requireRecords(
				requireRecord(afterEditsHistory.nativeHistory, "nativeHistory").history,
				"history",
			).length,
		).toBe(
			requireRecords(baselineNativeHistory.history, "baseline history").length +
				2,
		);

		const undone = await first.callTool("opencut_undo", {
			...safety(afterSecondEdit),
			operationId: "history-undo-two",
			steps: 2,
			undoOfOperationId: "history-edit-two",
		});
		expect(undone).toMatchObject({
			status: "undone",
			steps: 2,
			operationRecord: {
				relationships: { undoOf: "history-edit-two" },
				affectedObjects: expect.arrayContaining([
					expect.objectContaining({ objectType: "project" }),
				]),
			},
		});
		const undoneSnapshot = requireRecord(undone.snapshot, "undone snapshot");
		expect(requireProjectContentHash(undoneSnapshot)).toBe(initialHash);

		const redone = await first.callTool("opencut_redo", {
			...safety(undoneSnapshot),
			operationId: "history-redo-two",
			steps: 2,
			redoOfOperationId: "history-undo-two",
		});
		expect(redone).toMatchObject({
			status: "redone",
			steps: 2,
			operationRecord: {
				relationships: { redoOf: "history-undo-two" },
			},
		});
		const redoneSnapshot = requireRecord(redone.snapshot, "redone snapshot");
		expect(requireProjectContentHash(redoneSnapshot)).toBe(secondHash);

		const restored = await first.callTool("opencut_restore_checkpoint", {
			...safety(redoneSnapshot),
			operationId: "history-restore-baseline",
			checkpointId: "history-baseline",
		});
		expect(restored).toMatchObject({
			status: "restored",
			checkpointId: "history-baseline",
			operationRecord: {
				relationships: { restoresCheckpointId: "history-baseline" },
			},
		});
		const restoredSnapshot = requireRecord(
			restored.snapshot,
			"restored snapshot",
		);
		expect(requireProjectContentHash(restoredSnapshot)).toBe(initialHash);

		const history = await first.callTool("opencut_list_operation_history", {
			projectId,
			limit: 100,
		});
		const historyRecords = requireRecords(
			history.entries,
			"history entries",
		).map((entry) => requireRecord(entry.record, "operation record"));
		for (const operationId of [
			"history-create-checkpoint",
			"history-undo-two",
			"history-redo-two",
			"history-restore-baseline",
		]) {
			const record = historyRecords.find(
				(candidate) => candidate.operationId === operationId,
			);
			expect(record).toBeDefined();
			expect(
				requireString(record!.description, "description").length,
			).toBeGreaterThan(0);
			expect(Array.isArray(record!.affectedObjects)).toBe(true);
		}

		await first.callTool("opencut_stop_editor_worker", {});
		await first.close();
		const second = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await second.callTool("opencut_start_editor_worker", { projectId });
		const secondStatus = await second.callTool("opencut_connection_status", {});
		const secondIdentity = requireRecord(
			secondStatus.connectionIdentity,
			"restarted connectionIdentity",
		);
		const listed = await second.callTool("opencut_list_checkpoints", {
			projectId,
			limit: 10,
		});
		expect(listed).toMatchObject({
			schemaVersion: "opencut.history-checkpoint.v1",
			entries: [expect.objectContaining({ checkpointId: "history-baseline" })],
		});
		const reloaded = await second.callTool(
			"opencut_get_project",
			affinity(secondIdentity),
		);
		const rejectedRestore = await second.callTool(
			"opencut_restore_checkpoint",
			{
				...safety(reloaded, secondIdentity),
				operationId: "history-restore-after-session-loss",
				checkpointId: "history-baseline",
			},
		);
		expect(rejectedRestore).toMatchObject({
			status: "history-diverged",
			reason: expect.stringContaining("different editor session"),
			operationDisposition: "not-applied",
			operationRecord: {
				relationships: { restoresCheckpointId: "history-baseline" },
				affectedObjects: [],
			},
		});
		await second.callTool("opencut_stop_editor_worker", {});
	},
	180_000,
);

integrationTest(
	"applies a preflighted scene lifecycle mutation through the MCP ledger",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl) {
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		}
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath) {
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		}
		const bridgePort = await availablePort();
		const profileDirectory = join(directory, "lifecycle-profile");
		const receiptDirectory = join(directory, "lifecycle-receipts");
		const harness = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await harness.callTool("opencut_start_editor_worker", {});
		const status = await harness.callTool("opencut_connection_status", {});
		const identity = requireRecord(
			status.connectionIdentity,
			"connectionIdentity",
		);
		const initial = await harness.callTool(
			"opencut_get_project",
			affinity(identity),
		);
		const projectId = requireString(initial.projectId, "projectId");
		const request = {
			projectId,
			expectedRevision: requireNumber(initial.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(initial),
			name: "Lifecycle MCP regression",
			activate: false,
		};
		const preflight = await harness.callTool(
			"opencut_preflight_lifecycle_mutation",
			{
				...affinity(identity),
				method: "create_scene",
				request,
			},
		);
		expect(preflight.status).toBe("validated");
		const created = await harness.callTool("opencut_create_scene", {
			...affinity(identity),
			...request,
			operationId: "mcp-lifecycle-create-scene",
			preflightFingerprint: requireString(
				preflight.preflightFingerprint,
				"preflightFingerprint",
			),
		});
		expect(created).toMatchObject({
			status: "applied",
			operationId: "mcp-lifecycle-create-scene",
			activeSceneId: initial.sceneId,
		});
		expect(created.sceneId).not.toBe(initial.sceneId);

		// Cloning the original scene with activation must ledger a snapshot
		// whose active scene is the clone, not the source scene.
		const cloneRequest = {
			projectId,
			expectedRevision: requireNumber(created.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(
				requireRecord(created.snapshot, "snapshot"),
			),
			sceneId: requireString(initial.sceneId, "sceneId"),
			name: "Lifecycle MCP clone",
			activate: true,
		};
		const clonePreflight = await harness.callTool(
			"opencut_preflight_lifecycle_mutation",
			{
				...affinity(identity),
				method: "clone_scene",
				request: cloneRequest,
			},
		);
		expect(clonePreflight.status).toBe("validated");
		const cloned = await harness.callTool("opencut_clone_scene", {
			...affinity(identity),
			...cloneRequest,
			operationId: "mcp-lifecycle-clone-scene",
			preflightFingerprint: requireString(
				clonePreflight.preflightFingerprint,
				"preflightFingerprint",
			),
		});
		expect(cloned).toMatchObject({
			status: "applied",
			operationId: "mcp-lifecycle-clone-scene",
		});
		const clonedSceneId = requireString(cloned.sceneId, "sceneId");
		expect(clonedSceneId).not.toBe(initial.sceneId);
		expect(clonedSceneId).not.toBe(created.sceneId);
		expect(cloned.activeSceneId).toBe(clonedSceneId);
		expect(requireRecord(cloned.snapshot, "snapshot").sceneId).toBe(
			clonedSceneId,
		);

		// Renaming the inactive scene must leave the clone active and ledger
		// the operation against that active scene.
		const renameRequest = {
			projectId,
			expectedRevision: requireNumber(cloned.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(
				requireRecord(cloned.snapshot, "snapshot"),
			),
			sceneId: requireString(created.sceneId, "sceneId"),
			name: "Lifecycle MCP regression renamed",
		};
		const renamePreflight = await harness.callTool(
			"opencut_preflight_lifecycle_mutation",
			{
				...affinity(identity),
				method: "rename_scene",
				request: renameRequest,
			},
		);
		expect(renamePreflight.status).toBe("validated");
		const renamed = await harness.callTool("opencut_rename_scene", {
			...affinity(identity),
			...renameRequest,
			operationId: "mcp-lifecycle-rename-scene",
			preflightFingerprint: requireString(
				renamePreflight.preflightFingerprint,
				"preflightFingerprint",
			),
		});
		expect(renamed).toMatchObject({
			status: "applied",
			operationId: "mcp-lifecycle-rename-scene",
			sceneId: created.sceneId,
			activeSceneId: clonedSceneId,
		});

		// Edit-plan preflight and apply must use the explicit target scene while
		// preserving the clone as the active UI scene. Exercise every bookmark
		// mutation in one atomic plan, then observe the target through the public
		// scene-list query rather than through a browser-only shortcut.
		const bookmarkRevision = requireNumber(renamed.revision, "revision");
		const bookmarkHash = requireProjectContentHash(
			requireRecord(renamed.snapshot, "snapshot"),
		);
		const bookmarkSave = await harness.callTool("opencut_save_project", {
			...affinity(identity),
			projectId,
			sceneId: clonedSceneId,
			operationId: "mcp-non-active-bookmark-save",
			expectedRevision: bookmarkRevision,
			expectedContentHash: bookmarkHash,
		});
		const bookmarkOperations = [
			{
				kind: "add_bookmark",
				bookmarkId: "mcp-non-active-bookmark",
				time: 0,
				note: "draft",
			},
			{
				kind: "update_bookmark",
				bookmarkId: "mcp-non-active-bookmark",
				color: "#22c55e",
				note: "approved",
			},
			{
				kind: "move_bookmark",
				bookmarkId: "mcp-non-active-bookmark",
				time: 8_000,
			},
			{
				kind: "remove_bookmark",
				bookmarkId: "mcp-non-active-bookmark",
			},
			{
				kind: "add_bookmark",
				bookmarkId: "mcp-non-active-bookmark-final",
				time: 12_000,
				color: "#22c55e",
				note: "kept",
			},
		];
		const bookmarkPreflightRequest = {
			contractVersion: 2,
			...affinity(identity),
			preflightId: "mcp-non-active-bookmark-preflight",
			projectId,
			sceneId: requireString(created.sceneId, "created sceneId"),
			expectedRevision: bookmarkRevision,
			expectedProjectContentHash: bookmarkHash,
			expectedWriteVersion: requireNumber(
				bookmarkSave.writeVersion,
				"bookmark writeVersion",
			),
			saveReceiptOperationId: "mcp-non-active-bookmark-save",
			expectedSaveReceiptId: requireString(
				bookmarkSave.receiptId,
				"bookmark save receiptId",
			),
			description: "Exercise bookmark CRUD on a non-active scene",
			operations: bookmarkOperations,
			policy: {
				warningPolicy: "allow",
				providerExecution: "forbidden",
				costPolicy: "require-exact",
			},
		};
		const bookmarkPreflight = await harness.callTool(
			"opencut_preflight_edit_plan",
			bookmarkPreflightRequest,
		);
		expect(bookmarkPreflight).toMatchObject({
			disposition: "evaluated",
			result: {
				status: "validated",
				sourceObservation: { activeSceneId: clonedSceneId },
				noMutationProof: {
					unchanged: true,
					before: { activeSceneId: clonedSceneId },
					after: { activeSceneId: clonedSceneId },
				},
			},
		});
		expect(
			await harness.callTool(
				"opencut_preflight_edit_plan",
				bookmarkPreflightRequest,
			),
		).toMatchObject({
			disposition: "replayed",
			receiptId: bookmarkPreflight.receiptId,
			result: { status: "validated" },
		});
		const bookmarkEvaluation = requireRecord(
			requireRecord(bookmarkPreflight.result, "bookmark preflight result")
				.evaluation,
			"bookmark evaluation",
		);
		const targetSceneId = requireString(created.sceneId, "created sceneId");
		const bookmarkApplyRequest = {
			...affinity(identity),
			projectId,
			sceneId: targetSceneId,
			operationId: "mcp-non-active-bookmark-apply",
			expectedRevision: bookmarkRevision,
			expectedProjectContentHash: bookmarkHash,
			description: "Exercise bookmark CRUD on a non-active scene",
			operations: bookmarkOperations,
			preflight: {
				receiptId: requireString(
					bookmarkPreflight.receiptId,
					"bookmark preflight receiptId",
				),
				planFingerprint: requireString(
					bookmarkEvaluation.planFingerprint,
					"bookmark planFingerprint",
				),
				preflightFingerprint: requireString(
					bookmarkEvaluation.preflightFingerprint,
					"bookmark preflightFingerprint",
				),
				planDiffHash: requireString(
					bookmarkEvaluation.planDiffHash,
					"bookmark planDiffHash",
				),
			},
		};
		const bookmarkApplied = await harness.callTool(
			"opencut_apply_edit_plan",
			bookmarkApplyRequest,
		);
		expect(bookmarkApplied).toMatchObject({
			status: "applied",
			operationId: "mcp-non-active-bookmark-apply",
			snapshot: {
				sceneId: targetSceneId,
				bookmarks: [
					{
						bookmarkId: "mcp-non-active-bookmark-final",
						time: 12_000,
						color: "#22c55e",
						note: "kept",
					},
				],
			},
		});
		const bookmarkAppliedSnapshot = requireRecord(
			bookmarkApplied.snapshot,
			"bookmark applied snapshot",
		);
		expect(
			requireRecords(
				bookmarkAppliedSnapshot.scenes,
				"bookmark applied scenes",
			).find((scene) => scene.sceneId === targetSceneId),
		).toMatchObject({ isActive: false });
		expect(
			requireRecords(
				bookmarkAppliedSnapshot.scenes,
				"bookmark applied scenes",
			).find((scene) => scene.sceneId === clonedSceneId),
		).toMatchObject({ isActive: true });
		const bookmarkScenes = await harness.callTool("opencut_list_scenes", {
			...affinity(identity),
			projectId,
		});
		expect(bookmarkScenes.activeSceneId).toBe(clonedSceneId);
		expect(
			requireRecords(bookmarkScenes.scenes, "bookmark scenes").find(
				(scene) => scene.sceneId === targetSceneId,
			),
		).toMatchObject({
			isActive: false,
			bookmarks: [
				{
					bookmarkId: "mcp-non-active-bookmark-final",
					time: 12_000,
					color: "#22c55e",
					note: "kept",
				},
			],
		});
		expect(
			requireRecords(bookmarkScenes.scenes, "bookmark scenes").find(
				(scene) => scene.sceneId === clonedSceneId,
			),
		).toMatchObject({ isActive: true, bookmarks: [] });
		const bookmarkOperation = requireRecord(
			requireRecord(
				(
					await harness.callTool("opencut_get_operation", {
						operationId: "mcp-non-active-bookmark-apply",
					})
				).operation,
				"bookmark operation",
			).record,
			"bookmark operation record",
		);
		expect(bookmarkOperation).toMatchObject({
			status: "completed",
			sceneId: targetSceneId,
		});
		expect(
			await harness.callTool("opencut_apply_edit_plan", bookmarkApplyRequest),
		).toMatchObject({
			status: "applied",
			durableOperationStatus: "replayed",
			operationRecord: { sceneId: targetSceneId },
		});

		// The main scene cannot be deleted without naming its successor; the
		// refusal surfaces at preflight rather than as an input schema error.
		const deleteMainPreflight = await harness.callTool(
			"opencut_preflight_lifecycle_mutation",
			{
				...affinity(identity),
				method: "delete_scene",
				request: {
					projectId,
					expectedRevision: requireNumber(bookmarkApplied.revision, "revision"),
					expectedProjectContentHash: requireProjectContentHash(
						requireRecord(bookmarkApplied.snapshot, "snapshot"),
					),
					sceneId: requireString(initial.sceneId, "sceneId"),
				},
			},
		);
		expect(deleteMainPreflight).toMatchObject({
			status: "rejected",
			reason: expect.stringContaining("newMainSceneId"),
		});

		// Media-bin mutations persist asset metadata outside the project write;
		// each receipt must still verify against the fresh persisted state.
		let revision = requireNumber(bookmarkApplied.revision, "revision");
		let contentHash = requireProjectContentHash(
			requireRecord(bookmarkApplied.snapshot, "snapshot"),
		);
		const mediaMutation = async (
			tool: string,
			operationId: string,
			params: Record<string, unknown>,
		) => {
			const request = {
				projectId,
				expectedRevision: revision,
				expectedProjectContentHash: contentHash,
				...params,
			};
			const mediaPreflight = await harness.callTool(
				"opencut_preflight_lifecycle_mutation",
				{
					...affinity(identity),
					method: tool.replace(/^opencut_/, ""),
					request,
				},
			);
			expect(mediaPreflight.status).toBe("validated");
			const result = await harness.callTool(tool, {
				...affinity(identity),
				...request,
				operationId,
				preflightFingerprint: requireString(
					mediaPreflight.preflightFingerprint,
					"preflightFingerprint",
				),
			});
			expect(result).toMatchObject({ status: "applied", operationId });
			revision = requireNumber(result.revision, "revision");
			contentHash = requireProjectContentHash(
				requireRecord(result.snapshot, "snapshot"),
			);
			return result;
		};
		const mediaPath = join(directory, "lifecycle-source.mp4");
		await createSyntheticVideo(mediaPath);
		const importedAsset = await mediaMutation(
			"opencut_import_media_asset",
			"mcp-lifecycle-bin-import",
			{ path: mediaPath, assetName: "Lifecycle bin asset" },
		);
		const assetId = requireString(importedAsset.assetId, "assetId");
		await mediaMutation(
			"opencut_rename_media_asset",
			"mcp-lifecycle-bin-rename",
			{
				assetId,
				name: "Lifecycle bin asset renamed",
			},
		);
		const relinkedAsset = await mediaMutation(
			"opencut_relink_media_asset",
			"mcp-lifecycle-bin-relink",
			{ assetId, path: mediaPath },
		);
		expect(relinkedAsset.differences).toEqual([]);
		await mediaMutation(
			"opencut_remove_media_asset",
			"mcp-lifecycle-bin-remove",
			{
				assetId,
				policy: "unused-only",
			},
		);
		expect(
			requireRecords(
				requireRecord(
					await harness.callTool("opencut_get_project", affinity(identity)),
					"project",
				).mediaAssets,
				"mediaAssets",
			).some((asset) => asset.assetId === assetId),
		).toBe(false);

		await harness.callTool("opencut_stop_editor_worker", {});
		await harness.close();
		const restarted = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await restarted.callTool("opencut_start_editor_worker", { projectId });
		const restartedStatus = await restarted.callTool(
			"opencut_connection_status",
			{},
		);
		const restartedIdentity = requireRecord(
			restartedStatus.connectionIdentity,
			"restarted connectionIdentity",
		);
		const restartedScenes = await restarted.callTool("opencut_list_scenes", {
			...affinity(restartedIdentity),
			projectId,
		});
		expect(restartedScenes.activeSceneId).toBe(clonedSceneId);
		expect(
			requireRecords(restartedScenes.scenes, "restarted scenes").find(
				(scene) => scene.sceneId === targetSceneId,
			),
		).toMatchObject({
			isActive: false,
			bookmarks: [
				expect.objectContaining({
					bookmarkId: "mcp-non-active-bookmark-final",
				}),
			],
		});
		expect(
			await restarted.callTool(
				"opencut_preflight_edit_plan",
				bookmarkPreflightRequest,
			),
		).toMatchObject({ disposition: "replayed" });
		expect(
			await restarted.callTool("opencut_apply_edit_plan", bookmarkApplyRequest),
		).toMatchObject({
			status: "applied",
			durableOperationStatus: "replayed",
			operationRecord: { sceneId: targetSceneId },
		});
		await restarted.callTool("opencut_stop_editor_worker", {});
	},
	180_000,
);

integrationTest(
	"persists named treatment foundations and renders transition parity across compound boundaries",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl)
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath)
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		const bridgePort = await availablePort();
		const profileDirectory = join(directory, "named-treatment-profile");
		const receiptDirectory = join(directory, "named-treatment-receipts");
		const outputPath = join(directory, "transition-parity.webm");
		const sources = [
			["red", "color=c=0xd02020:size=320x240:rate=30:duration=2"],
			["green", "color=c=0x20d040:size=320x240:rate=30:duration=2"],
			["blue", "color=c=0x2040d0:size=320x240:rate=30:duration=2"],
		] as const;
		for (const [name, filter] of sources) {
			await createSyntheticVideo(join(directory, `${name}.mp4`), filter);
		}

		const first = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await first.callTool("opencut_start_editor_worker", {});
		const firstStatus = await first.callTool("opencut_connection_status", {});
		const firstIdentity = requireRecord(
			firstStatus.connectionIdentity,
			"connection identity",
		);
		const catalog = await first.callTool("opencut_list_treatments", {
			treatmentId: "simple-media.film-frame",
		});
		expect(catalog).toMatchObject({
			treatments: [
				{
					id: "simple-media.film-frame",
					readiness: { status: "reference-missing" },
				},
			],
		});

		let state = await first.callTool(
			"opencut_get_project",
			affinity(firstIdentity),
		);
		const projectId = requireString(state.projectId, "projectId");
		const elementIds: string[] = [];
		for (const [index, [name]] of sources.entries()) {
			const imported = await first.callTool("opencut_import_media", {
				...affinity(firstIdentity),
				projectId,
				operationId: `named-treatment-import-${name}`,
				expectedRevision: requireNumber(state.revision, "revision"),
				expectedProjectContentHash: requireProjectContentHash(state),
				path: join(directory, `${name}.mp4`),
				startTime: index * 240_000,
				adoptMediaSettings: index === 0,
			});
			elementIds.push(requireString(imported.elementId, "elementId"));
			state = requireRecord(imported.snapshot, "imported snapshot");
			state.revision = imported.revision;
		}
		const sceneId = requireString(state.sceneId, "sceneId");
		const trackId = requireString(
			requireRecords(state.elements, "elements").find(
				(element) => element.elementId === elementIds[0],
			)?.trackId,
			"trackId",
		);
		const saved = await first.callTool("opencut_save_project", {
			...affinity(firstIdentity),
			projectId,
			sceneId,
			operationId: "named-treatment-source-save",
			expectedRevision: requireNumber(state.revision, "revision"),
			expectedContentHash: requireProjectContentHash(state),
		});
		const preflightBase = {
			contractVersion: 2,
			...affinity(firstIdentity),
			projectId,
			sceneId,
			expectedRevision: requireNumber(state.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(state),
			expectedWriteVersion: requireNumber(saved.writeVersion, "writeVersion"),
			saveReceiptOperationId: "named-treatment-source-save",
			expectedSaveReceiptId: requireString(saved.receiptId, "save receiptId"),
			policy: {
				warningPolicy: "allow",
				providerExecution: "forbidden",
				costPolicy: "require-exact",
			},
		};
		const invalidTreatment = await first.callTool(
			"opencut_preflight_edit_plan",
			{
				...preflightBase,
				preflightId: "named-treatment-invalid-range",
				description: "Reject an out-of-range treatment parameter",
				operations: [
					{
						kind: "upsert_effect",
						trackId,
						elementId: elementIds[0],
						effectId: "film-frame-invalid",
						effectType: "simple-media.film-frame",
						params: { mix: 1.01 },
					},
				],
			},
		);
		expect(invalidTreatment).toMatchObject({
			result: { status: "rejected", error: { code: "BOUNDS", path: "mix" } },
		});
		const invalidTransition = await first.callTool(
			"opencut_preflight_edit_plan",
			{
				...preflightBase,
				preflightId: "named-transition-unknown-id",
				description: "Reject an unknown transition ID in Rust",
				operations: [
					{
						kind: "upsert_transition",
						trackId,
						transitionId: "unknown-transition",
						fromElementId: elementIds[0],
						toElementId: elementIds[1],
						transitionType: "cube-spin",
						duration: 60_000,
					},
				],
			},
		);
		expect(invalidTransition).toMatchObject({ result: { status: "rejected" } });

		const operations = [
			{
				kind: "upsert_effect",
				trackId,
				elementId: elementIds[0],
				effectId: "film-frame-foundation",
				effectType: "simple-media.film-frame",
				params: { mix: 0.75 },
				enabled: false,
			},
			{
				kind: "upsert_transition",
				trackId,
				transitionId: "inner-crossfade",
				fromElementId: elementIds[1],
				toElementId: elementIds[2],
				transitionType: "crossfade",
				duration: 60_000,
			},
			{
				kind: "create_compound",
				compoundId: "transition-compound",
				name: "Transition compound",
				elements: elementIds.slice(1).map((elementId) => ({
					trackId,
					elementId,
				})),
				relationshipScope: "element",
				targetTrackId: trackId,
			},
			{
				kind: "upsert_transition",
				trackId,
				transitionId: "outer-crossfade",
				fromElementId: elementIds[0],
				toElementId: "transition-compound",
				transitionType: "crossfade",
				duration: 60_000,
			},
		];
		const preflight = await first.callTool("opencut_preflight_edit_plan", {
			...preflightBase,
			preflightId: "named-treatment-valid-preflight",
			description: "Persist treatment metadata and build transition boundaries",
			operations,
		});
		expect(preflight).toMatchObject({ result: { status: "validated" } });
		const evaluation = requireRecord(
			requireRecord(preflight.result, "preflight result").evaluation,
			"evaluation",
		);
		const applied = await first.callTool("opencut_apply_edit_plan", {
			...affinity(firstIdentity),
			projectId,
			sceneId,
			operationId: "named-treatment-valid-apply",
			expectedRevision: preflightBase.expectedRevision,
			expectedProjectContentHash: preflightBase.expectedProjectContentHash,
			description: "Persist treatment metadata and build transition boundaries",
			operations,
			preflight: {
				receiptId: requireString(preflight.receiptId, "preflight receiptId"),
				planFingerprint: requireString(
					evaluation.planFingerprint,
					"planFingerprint",
				),
				preflightFingerprint: requireString(
					evaluation.preflightFingerprint,
					"preflightFingerprint",
				),
				planDiffHash: requireString(evaluation.planDiffHash, "planDiffHash"),
			},
		});
		expect(applied.status).toBe("applied");
		const appliedSnapshot = requireRecord(applied.snapshot, "applied snapshot");
		const firstElement = requireRecords(
			appliedSnapshot.elements,
			"elements",
		).find((element) => element.elementId === elementIds[0]);
		expect(requireRecords(firstElement?.effects, "effects")).toContainEqual({
			effectId: "film-frame-foundation",
			effectType: "simple-media.film-frame",
			enabled: false,
			params: { mix: 0.75 },
		});
		await first.callTool("opencut_stop_editor_worker", {});
		await first.close();

		const restarted = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await restarted.callTool("opencut_start_editor_worker", { projectId });
		const restartedStatus = await restarted.callTool(
			"opencut_connection_status",
			{},
		);
		const identity = requireRecord(
			restartedStatus.connectionIdentity,
			"restarted identity",
		);
		const reloaded = await restarted.callTool(
			"opencut_get_project",
			affinity(identity),
		);
		const reloadedFirst = requireRecords(reloaded.elements, "elements").find(
			(element) => element.elementId === elementIds[0],
		);
		expect(requireRecords(reloadedFirst?.effects, "effects")).toContainEqual(
			expect.objectContaining({
				effectId: "film-frame-foundation",
				effectType: "simple-media.film-frame",
				params: { mix: 0.75 },
			}),
		);
		const paritySave = await restarted.callTool("opencut_save_project", {
			...affinity(identity),
			projectId,
			sceneId,
			operationId: "named-treatment-parity-save",
			expectedRevision: requireNumber(reloaded.revision, "revision"),
			expectedContentHash: requireProjectContentHash(reloaded),
		});
		const previewBase = {
			...affinity(identity),
			contractVersion: 2,
			projectId,
			sceneId,
			expectedRevision: requireNumber(reloaded.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(reloaded),
			expectedWriteVersion: requireNumber(
				paritySave.writeVersion,
				"writeVersion",
			),
			saveReceiptOperationId: "named-treatment-parity-save",
			expectedSaveReceiptId: requireString(
				paritySave.receiptId,
				"save receiptId",
			),
			canvasSize: { width: 320, height: 240 },
			format: "png",
		};
		const exported = await restarted.callTool(
			"opencut_export_project",
			{
				...affinity(identity),
				projectId,
				operationId: "named-treatment-transition-export",
				expectedRevision: previewBase.expectedRevision,
				expectedProjectContentHash: previewBase.expectedProjectContentHash,
				outputPath,
				format: "webm",
				quality: "very_high",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: false,
				canvasSize: { width: 320, height: 240 },
			},
			5 * 60_000,
		);
		expect(exported.status).toBe("exported");
		for (const [label, ticks] of [
			["compound-boundary", 268_000],
			["nested-simple-boundary", 508_000],
		] as const) {
			const preview = await restarted.callTool(
				"opencut_render_preview_frame",
				{
					...previewBase,
					operationId: `named-treatment-${label}-preview`,
					time: { kind: "media-time", ticks, rounding: "exact" },
				},
				5 * 60_000,
			);
			expect(preview).toMatchObject({ status: "rendered" });
			const previewRgba = await extractRgba(
				requireString(preview.outputPath, "preview outputPath"),
			);
			const exportRgba = await extractRgba(
				outputPath,
				ticks / MEDIA_TICKS_PER_SECOND,
			);
			const parity = rgbaComparisonMetrics(previewRgba, exportRgba);
			assertMetricAtMost({
				label: `${label} preview/export RGBA MAE`,
				actual: parity.meanAbsoluteError,
				maximum: PREVIEW_EXPORT_RGBA_MAE_TOLERANCE,
			});
			assertMetricAtLeast({
				label: `${label} preview/export PSNR`,
				actual: parity.psnrDb,
				minimum: PREVIEW_EXPORT_RGBA_MIN_PSNR_DB,
			});
		}

		const fadeOperations = [
			{
				kind: "upsert_transition",
				trackId,
				transitionId: "outer-crossfade",
				fromElementId: elementIds[0],
				toElementId: "transition-compound",
				transitionType: "fade-through-black",
				duration: 60_000,
			},
		];
		const fadePreflight = await restarted.callTool(
			"opencut_preflight_edit_plan",
			{
				contractVersion: 2,
				...affinity(identity),
				projectId,
				sceneId,
				expectedRevision: previewBase.expectedRevision,
				expectedProjectContentHash: previewBase.expectedProjectContentHash,
				expectedWriteVersion: previewBase.expectedWriteVersion,
				saveReceiptOperationId: previewBase.saveReceiptOperationId,
				expectedSaveReceiptId: previewBase.expectedSaveReceiptId,
				preflightId: "named-treatment-fade-compound-preflight",
				description:
					"Change the compound-boundary transition to fade through black",
				operations: fadeOperations,
				policy: {
					warningPolicy: "allow",
					providerExecution: "forbidden",
					costPolicy: "require-exact",
				},
			},
		);
		expect(fadePreflight).toMatchObject({
			result: { status: "validated" },
		});
		const fadeEvaluation = requireRecord(
			requireRecord(fadePreflight.result, "fade preflight result").evaluation,
			"fade evaluation",
		);
		const fadeApplied = await restarted.callTool("opencut_apply_edit_plan", {
			...affinity(identity),
			projectId,
			sceneId,
			operationId: "named-treatment-fade-compound-apply",
			expectedRevision: previewBase.expectedRevision,
			expectedProjectContentHash: previewBase.expectedProjectContentHash,
			description:
				"Change the compound-boundary transition to fade through black",
			operations: fadeOperations,
			preflight: {
				receiptId: requireString(
					fadePreflight.receiptId,
					"fade preflight receiptId",
				),
				planFingerprint: requireString(
					fadeEvaluation.planFingerprint,
					"fade planFingerprint",
				),
				preflightFingerprint: requireString(
					fadeEvaluation.preflightFingerprint,
					"fade preflightFingerprint",
				),
				planDiffHash: requireString(
					fadeEvaluation.planDiffHash,
					"fade planDiffHash",
				),
			},
		});
		expect(fadeApplied.status).toBe("applied");
		const fadeSnapshot = requireRecord(fadeApplied.snapshot, "fade snapshot");
		const fadeSave = await restarted.callTool("opencut_save_project", {
			...affinity(identity),
			projectId,
			sceneId,
			operationId: "named-treatment-fade-compound-save",
			expectedRevision: requireNumber(fadeApplied.revision, "fade revision"),
			expectedContentHash: requireProjectContentHash(fadeSnapshot),
		});
		const fadeOutputPath = join(directory, "transition-parity-fade.webm");
		const fadePreviewBase = {
			...affinity(identity),
			contractVersion: 2,
			projectId,
			sceneId,
			expectedRevision: requireNumber(fadeApplied.revision, "fade revision"),
			expectedProjectContentHash: requireProjectContentHash(fadeSnapshot),
			expectedWriteVersion: requireNumber(
				fadeSave.writeVersion,
				"fade writeVersion",
			),
			saveReceiptOperationId: "named-treatment-fade-compound-save",
			expectedSaveReceiptId: requireString(
				fadeSave.receiptId,
				"fade save receiptId",
			),
			canvasSize: { width: 320, height: 240 },
			format: "png",
		};
		const fadeExport = await restarted.callTool(
			"opencut_export_project",
			{
				...affinity(identity),
				projectId,
				operationId: "named-treatment-fade-transition-export",
				expectedRevision: fadePreviewBase.expectedRevision,
				expectedProjectContentHash: fadePreviewBase.expectedProjectContentHash,
				outputPath: fadeOutputPath,
				format: "webm",
				quality: "very_high",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: false,
				canvasSize: { width: 320, height: 240 },
			},
			5 * 60_000,
		);
		expect(fadeExport.status).toBe("exported");
		const fadeTicks = 268_000;
		const fadePreview = await restarted.callTool(
			"opencut_render_preview_frame",
			{
				...fadePreviewBase,
				operationId: "named-treatment-compound-fade-preview",
				time: { kind: "media-time", ticks: fadeTicks, rounding: "exact" },
			},
			5 * 60_000,
		);
		expect(fadePreview).toMatchObject({ status: "rendered" });
		const fadeParity = rgbaComparisonMetrics(
			await extractRgba(
				requireString(fadePreview.outputPath, "fade preview outputPath"),
			),
			await extractRgba(fadeOutputPath, fadeTicks / MEDIA_TICKS_PER_SECOND),
		);
		assertMetricAtMost({
			label: "fade compound-boundary preview/export RGBA MAE",
			actual: fadeParity.meanAbsoluteError,
			maximum: PREVIEW_EXPORT_RGBA_MAE_TOLERANCE,
		});
		assertMetricAtLeast({
			label: "fade compound-boundary preview/export PSNR",
			actual: fadeParity.psnrDb,
			minimum: PREVIEW_EXPORT_RGBA_MIN_PSNR_DB,
		});
		await restarted.callTool("opencut_stop_editor_worker", {});
	},
	10 * 60_000,
);

integrationTest(
	"materializes caption layout evidence with bundled fonts at preflight",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl) {
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		}
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath) {
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		}
		const harness = await startMcp({
			baseUrl,
			browserPath,
			bridgePort: await availablePort(),
			profileDirectory: join(directory, "caption-profile"),
			receiptDirectory: join(directory, "caption-receipts"),
		});
		await harness.callTool("opencut_start_editor_worker", {});
		// Preflight and operation ids are durable across runs, so each run
		// names its own.
		const runId = randomBytes(4).toString("hex");
		const status = await harness.callTool("opencut_connection_status", {});
		const identity = requireRecord(
			status.connectionIdentity,
			"connectionIdentity",
		);
		const capabilities = await harness.callTool("opencut_capabilities", {});
		const fonts = requireRecord(capabilities.fonts, "fonts");
		expect(fonts).toMatchObject({
			status: "ready",
			thirdPartyFetch: "blocked",
			presets: [
				{ id: "tiktok-sans-caption", status: "ready" },
				{ id: "montserrat-caption", status: "ready" },
			],
		});
		expect(
			requireRecords(fonts.catalog, "catalog").map((file) => [
				file.family,
				file.style,
				file.license,
				file.sha256,
			]),
		).toEqual([
			[
				"TikTok Sans",
				"normal",
				"OFL-1.1",
				"0e7f0a3e924c9a86478fc6fc2946de2e4ab8fc704ed72ee40434ade94bb9b0c6",
			],
			[
				"Montserrat",
				"normal",
				"OFL-1.1",
				"0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
			],
			[
				"Montserrat",
				"italic",
				"OFL-1.1",
				"51607f316bc020e59f03cbf51543eecffbea501c0b31d73e5b82927c5cca442c",
			],
		]);
		expect(
			requireRecords(fonts.captionStylePresets, "captionStylePresets").map(
				(preset) => preset.id,
			),
		).toEqual([
			"tiktok-classic",
			"tiktok-classic-red",
			"tiktok-karaoke",
			"montserrat-clean",
		]);
		const project = await harness.callTool(
			"opencut_get_project",
			affinity(identity),
		);
		const projectId = requireString(project.projectId, "projectId");
		const sceneId = requireString(project.sceneId, "sceneId");
		const contentHash = requireProjectContentHash(project);
		const saved = await harness.callTool("opencut_save_project", {
			...affinity(identity),
			projectId,
			sceneId,
			operationId: `caption-evidence-save-${runId}`,
			expectedRevision: requireNumber(project.revision, "revision"),
			expectedContentHash: contentHash,
		});
		expect(saved).toMatchObject({ status: "saved", contentHash });
		const preflight = await harness.callTool(
			"opencut_preflight_edit_plan",
			{
				contractVersion: 2,
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: identity,
				preflightId: `caption-evidence-preflight-${runId}`,
				projectId,
				sceneId,
				expectedRevision: requireNumber(project.revision, "revision"),
				expectedProjectContentHash: contentHash,
				expectedWriteVersion: requireNumber(saved.writeVersion, "writeVersion"),
				saveReceiptOperationId: `caption-evidence-save-${runId}`,
				expectedSaveReceiptId: requireString(saved.receiptId, "receiptId"),
				description: "Add a wrapped TikTok Sans caption",
				operations: [
					{
						kind: "insert_captions",
						captions: [
							{
								text: "This is the part of the video where the hook has to land in the first three seconds",
								startTime: 0,
								duration: 240_000,
								speaker: "host",
							},
						],
						// The preset supplies TikTok Sans bold on a black block; the
						// explicit size overrides it.
						style: { preset: "tiktok-classic", fontSize: 6 },
					},
				],
				policy: {
					warningPolicy: "allow",
					providerExecution: "forbidden",
					costPolicy: "require-exact",
				},
			},
			5 * 60_000,
		);
		expect(preflight).toMatchObject({
			disposition: "evaluated",
			result: { status: "validated" },
		});
		const captionLayout = requireRecord(
			requireRecord(preflight.result, "result").captionLayout,
			"captionLayout",
		);
		const fontReadiness = requireRecord(
			captionLayout.fontReadiness,
			"fontReadiness",
		);
		expect(fontReadiness).toMatchObject({
			status: "ready",
			families: ["TikTok Sans"],
		});
		const descriptor = requireRecords(
			fontReadiness.descriptors,
			"descriptors",
		)[0];
		if (!descriptor) throw new Error("expected a font descriptor");
		expect(descriptor).toMatchObject({ family: "TikTok Sans", weight: "bold" });
		const faces = requireRecords(descriptor.matchedFaces, "matchedFaces");
		expect(faces.length).toBeGreaterThan(0);
		for (const face of faces) {
			expect(face).toMatchObject({
				provenance: "bundled-font-bytes",
				family: "TikTok Sans",
				weight: "300 900",
				byteSha256:
					"0e7f0a3e924c9a86478fc6fc2946de2e4ab8fc704ed72ee40434ade94bb9b0c6",
			});
		}
		const [captionEvidence] = requireRecords(
			captionLayout.captions,
			"captions",
		);
		if (!captionEvidence) throw new Error("expected caption evidence");
		const geometry = requireRecord(captionEvidence.geometry, "geometry");
		expect(geometry).toMatchObject({
			version: "opencut.caption-geometry.v1",
			measurement: "opencut.text.measureTextLayout",
			clipped: false,
			safeZone: { inside: true },
		});
		expect(requireNumber(geometry.lineCount, "lineCount")).toBeGreaterThan(1);
		expect(requireRecords(geometry.lines, "lines")).toHaveLength(
			requireNumber(geometry.lineCount, "lineCount"),
		);
		expect(requireRecord(geometry.bubble, "bubble").cornerRadius).toBeNumber();
		// The TikTok preset draws one bubble per wrapped line.
		expect(requireRecords(geometry.lineBubbles, "lineBubbles")).toHaveLength(
			requireNumber(geometry.lineCount, "lineCount"),
		);
		expect(
			requireString(captionLayout.geometrySha256, "geometrySha256"),
		).toMatch(/^[a-f0-9]{64}$/);

		// Apply the preflighted plan, then export the captions as ASS so the
		// styled subset round-trips and the loss report is durable.
		const evaluation = requireRecord(
			requireRecord(preflight.result, "result").evaluation,
			"evaluation",
		);
		const applied = await harness.callTool("opencut_apply_edit_plan", {
			...affinity(identity),
			projectId,
			operationId: `caption-evidence-apply-${runId}`,
			expectedRevision: requireNumber(project.revision, "revision"),
			expectedProjectContentHash: contentHash,
			description: "Add a wrapped TikTok Sans caption",
			operations: [
				{
					kind: "insert_captions",
					captions: [
						{
							text: "This is the part of the video where the hook has to land in the first three seconds",
							startTime: 0,
							duration: 240_000,
							speaker: "host",
						},
					],
					style: { preset: "tiktok-classic", fontSize: 6 },
				},
			],
			preflight: {
				receiptId: requireString(preflight.receiptId, "receiptId"),
				planFingerprint: requireString(
					evaluation.planFingerprint,
					"planFingerprint",
				),
				preflightFingerprint: requireString(
					evaluation.preflightFingerprint,
					"preflightFingerprint",
				),
				planDiffHash: requireString(evaluation.planDiffHash, "planDiffHash"),
			},
		});
		expect(applied.status).toBe("applied");
		const assPath = join(directory, "captions.ass");
		const exported = await harness.callTool("opencut_export_subtitles", {
			...affinity(identity),
			projectId,
			operationId: `caption-evidence-export-ass-${runId}`,
			expectedRevision: requireNumber(applied.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(
				requireRecord(applied.snapshot, "snapshot"),
			),
			outputPath: assPath,
			format: "ass",
		});
		expect(exported).toMatchObject({
			status: "exported",
			format: "ass",
			cueCount: 1,
			lossReport: {
				format: "ass",
				dropped: [
					{ feature: "background.cornerRadius", cueCount: 1 },
					{ feature: "background.padding", cueCount: 1 },
					{ feature: "background.perLine", cueCount: 1 },
					{ feature: "lineHeight", cueCount: 1 },
				],
			},
		});
		const assDocument = await readFile(assPath, "utf8");
		expect(assDocument).toContain("[V4+ Styles]");
		expect(assDocument).toContain("Style: Default,TikTok Sans,");
		// The speaker label rides in the Dialogue Name field.
		expect(assDocument).toContain(
			"Dialogue: 0,0:00:00.00,0:00:02.00,Default,host,0,0,0,,",
		);

		// Restructure the inserted caption: split it at a word boundary and
		// restyle the left half from a preset, all resolved by Rust.
		const appliedSnapshot = requireRecord(applied.snapshot, "snapshot");
		const captionElement = requireRecords(
			appliedSnapshot.elements,
			"elements",
		).find((element) => element.type === "text");
		if (!captionElement) throw new Error("expected the inserted caption");
		expect(requireRecord(captionElement.params, "params")).toMatchObject({
			"caption.speaker": "host",
		});
		const captionTrackId = requireString(captionElement.trackId, "trackId");
		const captionElementId = requireString(
			captionElement.elementId,
			"elementId",
		);
		const restructureOperations = [
			{
				kind: "split_caption",
				trackId: captionTrackId,
				elementId: captionElementId,
				splitIndex: 29,
			},
			{
				// Selected by speaker rather than id, so both halves of the split
				// (which inherit the label) are restyled, with the spoken word lit.
				kind: "restyle_captions",
				trackId: captionTrackId,
				speaker: "host",
				style: {
					preset: "tiktok-classic-red",
					highlight: { enabled: true, color: "#ffd400" },
				},
			},
			{
				kind: "rechunk_captions",
				trackId: captionTrackId,
				maxChars: 14,
			},
		];
		const appliedHash = requireProjectContentHash(appliedSnapshot);
		const savedAfterApply = await harness.callTool("opencut_save_project", {
			...affinity(identity),
			projectId,
			sceneId,
			operationId: `caption-restructure-save-${runId}`,
			expectedRevision: requireNumber(applied.revision, "revision"),
			expectedContentHash: appliedHash,
		});
		expect(savedAfterApply).toMatchObject({
			status: "saved",
			contentHash: appliedHash,
		});
		const restructureRequest = {
			contractVersion: 2,
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: identity,
			preflightId: `caption-restructure-preflight-${runId}`,
			projectId,
			sceneId,
			expectedRevision: requireNumber(applied.revision, "revision"),
			expectedProjectContentHash: appliedHash,
			expectedWriteVersion: requireNumber(
				savedAfterApply.writeVersion,
				"writeVersion",
			),
			saveReceiptOperationId: `caption-restructure-save-${runId}`,
			expectedSaveReceiptId: requireString(
				savedAfterApply.receiptId,
				"receiptId",
			),
			description: "Split, restyle, and rechunk the caption",
			operations: restructureOperations,
			policy: {
				warningPolicy: "allow",
				providerExecution: "forbidden",
				costPolicy: "require-exact",
			},
		};
		const restructurePreflight = await harness.callTool(
			"opencut_preflight_edit_plan",
			restructureRequest,
			5 * 60_000,
		);
		expect(restructurePreflight).toMatchObject({
			disposition: "evaluated",
			result: { status: "validated" },
		});
		const restructureEvaluation = requireRecord(
			requireRecord(restructurePreflight.result, "result").evaluation,
			"evaluation",
		);
		const resolvedRestyle = requireRecords(
			restructureEvaluation.resolvedOperations,
			"resolvedOperations",
		)[1];
		expect(resolvedRestyle).toMatchObject({
			kind: "restyle_captions",
			resolvedParams: {
				fontFamily: "TikTok Sans",
				"background.color": "#ff0000",
				"highlight.enabled": true,
				"highlight.color": "#ffd400",
			},
		});
		// Rust re-segments both halves into word-timed chunks under the budget
		// and allocates ids for the chunks beyond the two existing captions.
		const resolvedRechunk = requireRecords(
			restructureEvaluation.resolvedOperations,
			"resolvedOperations",
		)[2];
		expect(resolvedRechunk).toMatchObject({ kind: "rechunk_captions" });
		const resolvedChunks = requireRecords(
			requireRecord(resolvedRechunk, "rechunk").resolvedChunks,
			"resolvedChunks",
		);
		expect(resolvedChunks.length).toBeGreaterThan(2);
		for (const chunk of resolvedChunks) {
			expect(requireString(chunk.text, "text").length).toBeLessThanOrEqual(14);
			expect(requireNumber(chunk.duration, "duration")).toBeGreaterThan(0);
		}
		expect(
			requireRecords(
				requireRecord(resolvedRechunk, "rechunk").resolvedAllocations,
				"resolvedAllocations",
			),
		).toHaveLength(resolvedChunks.length - 2);
		const restructured = await harness.callTool("opencut_apply_edit_plan", {
			...affinity(identity),
			projectId,
			operationId: `caption-restructure-apply-${runId}`,
			expectedRevision: restructureRequest.expectedRevision,
			expectedProjectContentHash: restructureRequest.expectedProjectContentHash,
			description: restructureRequest.description,
			operations: restructureOperations,
			preflight: {
				receiptId: requireString(restructurePreflight.receiptId, "receiptId"),
				planFingerprint: requireString(
					restructureEvaluation.planFingerprint,
					"planFingerprint",
				),
				preflightFingerprint: requireString(
					restructureEvaluation.preflightFingerprint,
					"preflightFingerprint",
				),
				planDiffHash: requireString(
					restructureEvaluation.planDiffHash,
					"planDiffHash",
				),
			},
		});
		expect(restructured.status).toBe("applied");
		const captionsAfter = requireRecords(
			requireRecord(restructured.snapshot, "snapshot").elements,
			"elements",
		).filter((element) => element.type === "text");
		expect(captionsAfter).toHaveLength(resolvedChunks.length);
		// Every chunk inherits the speaker label and the karaoke highlight from
		// the caption its first word came from.
		for (const caption of captionsAfter) {
			expect(requireRecord(caption.params, "params")).toMatchObject({
				"caption.speaker": "host",
				"highlight.enabled": true,
				"highlight.color": "#ffd400",
			});
		}
		expect(
			requireProjectContentHash(
				requireRecord(restructured.snapshot, "snapshot"),
			),
		).toBe(
			requireString(restructureEvaluation.predictedProjectHash, "predicted"),
		);
	},
	120_000,
);

integrationTest(
	"records structured review evidence and human sign-off through managed Chrome",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl)
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath)
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		const sourcePath = join(directory, "review-source.mp4");
		await createSyntheticVideo(sourcePath);
		const harness = await startMcp({
			baseUrl,
			browserPath,
			bridgePort: await availablePort(),
			profileDirectory: join(directory, "review-profile"),
			receiptDirectory: join(directory, "review-receipts"),
		});
		await harness.callTool("opencut_start_editor_worker", {});
		const connection = await harness.callTool("opencut_connection_status", {});
		const identity = requireRecord(
			connection.connectionIdentity,
			"connection identity",
		);
		const initial = await harness.callTool(
			"opencut_get_project",
			affinity(identity),
		);
		const projectId = requireString(initial.projectId, "projectId");
		const imported = await harness.callTool("opencut_import_media", {
			...affinity(identity),
			projectId,
			operationId: "managed-review-import",
			expectedRevision: requireNumber(initial.revision, "revision"),
			expectedProjectContentHash: requireProjectContentHash(initial),
			path: sourcePath,
			startTime: 0,
			adoptMediaSettings: true,
		});
		const snapshot = requireRecord(imported.snapshot, "imported snapshot");
		const sceneId = requireString(snapshot.sceneId, "sceneId");
		const contentHash = requireProjectContentHash(snapshot);
		const saved = await harness.callTool("opencut_save_project", {
			...affinity(identity),
			projectId,
			sceneId,
			operationId: "managed-review-save",
			expectedRevision: requireNumber(imported.revision, "revision"),
			expectedContentHash: contentHash,
		});
		const evidenceEnvelope = {
			...affinity(identity),
			projectId,
			sceneId,
			expectedRevision: requireNumber(imported.revision, "revision"),
			expectedProjectContentHash: contentHash,
			expectedWriteVersion: requireNumber(saved.writeVersion, "writeVersion"),
			saveReceiptOperationId: "managed-review-save",
			expectedSaveReceiptId: requireString(saved.receiptId, "save receiptId"),
		};
		const frame = await harness.callTool(
			"opencut_render_preview_frame",
			{
				...evidenceEnvelope,
				contractVersion: 2,
				operationId: "managed-review-frame",
				time: { kind: "media-time", ticks: 60_000, rounding: "exact" },
				canvasSize: { width: 160, height: 120 },
				format: "png",
			},
			5 * 60_000,
		);
		expect(frame).toMatchObject({ status: "rendered" });
		const range = await harness.callTool(
			"opencut_render_preview_range",
			{
				...evidenceEnvelope,
				contractVersion: 1,
				operationId: "managed-review-range",
				range: {
					kind: "media-time",
					startTicks: 0,
					endTicksExclusive: MEDIA_TICKS_PER_SECOND,
				},
				canvasSize: { width: 16, height: 16 },
				output: {
					kind: "frame-sequence",
					frameFormat: "png",
					includeAudio: false,
				},
			},
			5 * 60_000,
		);
		expect(range).toMatchObject({
			status: "rendered",
			execution: { status: "succeeded" },
		});
		const outputPath = join(directory, "managed-review.webm");
		const exported = await harness.callTool(
			"opencut_export_project",
			{
				...affinity(identity),
				projectId,
				operationId: "managed-review-export",
				expectedRevision: requireNumber(imported.revision, "revision"),
				expectedProjectContentHash: contentHash,
				outputPath,
				format: "webm",
				quality: "high",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: false,
				canvasSize: { width: 160, height: 120 },
			},
			5 * 60_000,
		);
		expect(exported).toMatchObject({
			status: "exported",
			validation: { status: "validated", fullDecode: true },
		});
		const reviewEnvelope = {
			...affinity(identity),
			projectId,
			sceneId,
			projectContentHash: contentHash,
		};
		const frameTarget = {
			kind: "preview-frame",
			evidenceOperationId: "managed-review-frame",
			evidenceReceiptId: requireString(frame.receiptId, "frame receiptId"),
			artifactSha256: requireString(frame.sha256, "frame sha256"),
		};
		const rangeTarget = {
			kind: "preview-range",
			evidenceOperationId: "managed-review-range",
			evidenceReceiptId: requireString(range.receiptId, "range receiptId"),
			artifactSha256: requireString(range.checksum, "range checksum"),
		};
		const automated = await harness.callTool(
			"opencut_create_review_annotation",
			{
				...reviewEnvelope,
				operationId: "managed-review-annotation",
				annotationId: "managed-review-annotation",
				target: rangeTarget,
				location: {
					kind: "range",
					startTicks: 0,
					endTicksExclusive: MEDIA_TICKS_PER_SECOND,
				},
				region: { x: 0, y: 0, width: 1, height: 1 },
				category: "continuity",
				severity: "warning",
				finding: {
					kind: "automated",
					detector: {
						provider: "managed-review-detector",
						modelId: "continuity-check",
						modelVersion: "1.0.0",
					},
				},
				reviewer: "managed-review-detector",
				notes: "Automated evidence retained separately from human approval.",
			},
		);
		expect(automated).toMatchObject({
			status: "annotation-created",
			annotation: { finding: { kind: "automated" } },
		});
		const cleanCorners = {
			"top-left": "clean",
			"top-right": "clean",
			"bottom-left": "clean",
			"bottom-right": "clean",
		};
		const inspection = await harness.callTool(
			"opencut_record_watermark_inspection",
			{
				...reviewEnvelope,
				operationId: "managed-review-inspection",
				inspectionId: "managed-review-inspection",
				exportEvidence: {
					evidenceOperationId: "managed-review-export",
					evidenceReceiptId: "managed-review-export",
					artifactSha256: requireString(exported.sha256, "export sha256"),
				},
				renderEvidence: [frameTarget, rangeTarget],
				policy: {
					schemaVersion: "opencut.watermark-sampling-policy.v1",
					fullFrameSamples: ["opening", "middle", "ending"],
					corners: ["top-left", "top-right", "bottom-left", "bottom-right"],
					requireFinalExportBytesInspection: true,
					requireHumanReview: true,
				},
				review: { kind: "human", reviewer: "managed-chrome-reviewer" },
				samples: (["opening", "middle", "ending"] as const).map((position) => ({
					position,
					fullFrame: "clean",
					corners: cleanCorners,
				})),
				finalExportBytes: { status: "clean" },
				notes: "Human inspected renderer evidence and final exported bytes.",
			},
		);
		expect(inspection).toMatchObject({
			status: "watermark-inspection-recorded",
			inspection: {
				status: "verified-clean",
				review: { kind: "human" },
				renderEvidence: [{ kind: "preview-frame" }, { kind: "preview-range" }],
			},
		});
		const signoff = await harness.callTool("opencut_sign_off_export_review", {
			...reviewEnvelope,
			operationId: "managed-review-signoff",
			signoffId: "managed-review-signoff",
			inspectionId: "managed-review-inspection",
			exportOperationId: "managed-review-export",
			outputSha256: requireString(exported.sha256, "export sha256"),
			reviewer: "managed-chrome-reviewer",
			notes: "Human final export review approved.",
		});
		expect(signoff).toMatchObject({
			status: "export-review-signed-off",
			signoff: { humanReview: true, unresolvedBlockingFindings: 0 },
			operationRecord: {
				relationships: {
					inspectionId: "managed-review-inspection",
					evidenceOperationId: "managed-review-export",
				},
			},
		});
		await harness.callTool("opencut_stop_editor_worker", {});
	},
	5 * 60_000,
);

integrationTest(
	"drives save, restart replay, and verified export through public MCP tools",
	async () => {
		const baseUrl = process.env.OPENCUT_HEADLESS_INTEGRATION_URL;
		if (!baseUrl) {
			throw new Error("OPENCUT_HEADLESS_INTEGRATION_URL is required");
		}
		const browserPath = process.env.OPENCUT_HEADLESS_BROWSER_PATH;
		if (!browserPath) {
			throw new Error("OPENCUT_HEADLESS_BROWSER_PATH is required");
		}
		const bridgePort = await availablePort();
		const profileDirectory = join(directory, "profile");
		const receiptDirectory = join(directory, "receipts");
		const sourcePath = join(directory, "public-source.mp4");
		await createSyntheticVideo(
			sourcePath,
			"color=c=0x00ff00:size=320x240:rate=30:duration=2,drawbox=x=20+80*t:y=70:w=80:h=100:color=0xff0000:t=fill",
		);
		const sourceHash = createHash("sha256")
			.update(await readFile(sourcePath))
			.digest("hex");

		const first = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
			dropBrowserResponseOperationId: "public-complex-preflight-loss",
		});
		const initialStatus = await first.callTool("opencut_connection_status", {});
		expect(initialStatus).toMatchObject({
			connected: false,
			protocolCompatibility: {
				status: "ready",
				protocolV1Mutation: {
					enabled: false,
					scope: "protocol-bearing-mutations",
				},
			},
		});
		for (const request of [
			{
				operationId: "public-v1-mutation-disabled",
				bridgeProtocolVersion: 1,
			},
			{ operationId: "public-omitted-mutation-disabled" },
		]) {
			const blockedV1Mutation = await first.callTool(
				"opencut_run_export_jobs",
				request,
			);
			expect(blockedV1Mutation).toMatchObject({
				status: "rejected",
				code: "PROTOCOL_V1_MUTATION_DISABLED",
				retryable: false,
				operationId: request.operationId,
				details: {
					configurationFlag: "OPENCUT_ENABLE_PROTOCOL_V1_MUTATION",
					nextAction: expect.stringContaining("bridgeProtocolVersion 2"),
				},
			});
			expect(
				await first.callTool("opencut_get_operation", {
					operationId: request.operationId,
				}),
			).toMatchObject({ operation: null, versions: [] });
		}
		await first.callTool("opencut_start_editor_worker", {});
		const connected = await first.callTool("opencut_connection_status", {});
		expect(connected).toMatchObject({ connected: true });
		const initialIdentity = requireRecord(
			connected.connectionIdentity,
			"connectionIdentity",
		);
		const capabilities = await first.callTool("opencut_capabilities", {});
		const capabilityTools = requireRecord(
			capabilities.tools,
			"capability tools",
		);
		const editPlanOperationVariants = capabilityTools.editPlanOperationVariants;
		if (!Array.isArray(editPlanOperationVariants)) {
			throw new Error("editPlanOperationVariants must be an array");
		}
		for (const variant of [
			"set_key",
			"remove_key",
			"set_track_matte",
			"remove_track_matte",
		]) {
			expect(editPlanOperationVariants).toContain(variant);
		}
		const initial = await first.callTool(
			"opencut_get_project",
			affinity(initialIdentity),
		);
		const projectId = requireString(initial.projectId, "projectId");
		const initialContentHash = requireProjectContentHash(initial);
		const importRequest = {
			...affinity(initialIdentity),
			projectId,
			operationId: "public-media-import",
			expectedRevision: requireNumber(initial.revision, "revision"),
			expectedProjectContentHash: initialContentHash,
			path: sourcePath,
			startTime: 0,
			adoptMediaSettings: true,
		};
		const imported = await first.callTool(
			"opencut_import_media",
			importRequest,
		);
		expect(imported.status).toBe("applied");
		const importedSnapshot = requireRecord(imported.snapshot, "snapshot");
		const importedElementId = requireString(imported.elementId, "elementId");
		const importedElement = requireRecords(
			importedSnapshot.elements,
			"elements",
		).find((element) => element.elementId === importedElementId);
		if (!importedElement) throw new Error("imported video is missing");
		const importedAsset = requireRecords(
			importedSnapshot.mediaAssets,
			"mediaAssets",
		).find((asset) => asset.assetId === imported.assetId);
		expect(
			requireRecord(
				requireRecord(importedAsset?.sourceIdentity, "sourceIdentity")
					.contentHash,
				"contentHash",
			).digest,
		).toBe(sourceHash);

		const importedContentHash = requireProjectContentHash(importedSnapshot);
		const sourceSaveRequest = {
			...affinity(initialIdentity),
			projectId,
			sceneId: requireString(importedSnapshot.sceneId, "sceneId"),
			operationId: "public-preflight-source-save",
			expectedRevision: requireNumber(imported.revision, "revision"),
			expectedContentHash: importedContentHash,
		};
		const sourceSaved = await first.callTool(
			"opencut_save_project",
			sourceSaveRequest,
		);
		expect(sourceSaved).toMatchObject({
			status: "saved",
			projectId,
			contentHash: importedContentHash,
			readbackContentHash: importedContentHash,
			reloadVerified: true,
		});
		const gradeDescription = "Apply the complete realistic color grade";
		const gradeOperations = [
			{
				kind: "set_key",
				trackId: requireString(importedElement.trackId, "trackId"),
				elementId: importedElementId,
				key: {
					type: "chroma",
					keyColor: "#00ff00",
					similarity: 0.2,
					softness: 0.1,
					spillSuppression: 0.8,
					enabled: true,
				},
			},
			{
				kind: "duplicate_track",
				trackId: requireString(importedElement.trackId, "trackId"),
				newTrackId: "public-track-matte-source",
			},
			{
				kind: "set_track_matte",
				trackId: requireString(importedElement.trackId, "trackId"),
				routing: {
					sourceTrackId: "public-track-matte-source",
					mode: "alpha",
					inverted: false,
					enabled: true,
				},
			},
			{
				kind: "set_reframe",
				trackId: requireString(importedElement.trackId, "trackId"),
				elementId: importedElementId,
				mode: "cover",
				focalPoint: { x: 0.62, y: 0.42 },
			},
			{
				kind: "insert_captions",
				captions: [
					{
						text: "EXACT FRAME EVIDENCE",
						startTime: 0,
						duration: 120_000,
					},
				],
				style: {
					fontSize: 7,
					fontWeight: "bold",
					fontStyle: "italic",
					color: "#ffffff",
					background: {
						enabled: true,
						color: "#000000",
						cornerRadius: 4,
						paddingX: 8,
						paddingY: 4,
					},
				},
			},
			{
				kind: "upsert_effect",
				trackId: requireString(importedElement.trackId, "trackId"),
				elementId: importedElementId,
				effectId: "public-realistic-grade",
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
		];
		await expect(
			first.callTool("opencut_preflight_edit_plan", {
				contractVersion: 2,
				...affinity(initialIdentity),
				preflightId: "public-invalid-self-track-matte",
				projectId,
				sceneId: sourceSaveRequest.sceneId,
				expectedRevision: sourceSaveRequest.expectedRevision,
				expectedProjectContentHash: importedContentHash,
				expectedWriteVersion: requireNumber(
					sourceSaved.writeVersion,
					"writeVersion",
				),
				saveReceiptOperationId: sourceSaveRequest.operationId,
				expectedSaveReceiptId: requireString(
					sourceSaved.receiptId,
					"receiptId",
				),
				description: "Reject a self-routed track matte",
				operations: [
					{
						kind: "set_track_matte",
						trackId: requireString(importedElement.trackId, "trackId"),
						routing: {
							sourceTrackId: requireString(importedElement.trackId, "trackId"),
							mode: "luma",
							inverted: false,
							enabled: true,
						},
					},
				],
				policy: {
					warningPolicy: "allow",
					providerExecution: "forbidden",
					costPolicy: "require-exact",
				},
			}),
		).rejects.toThrow();
		const preflightRequest = {
			contractVersion: 2,
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: initialIdentity,
			preflightId: "public-complex-preflight-loss",
			projectId,
			sceneId: sourceSaveRequest.sceneId,
			expectedRevision: sourceSaveRequest.expectedRevision,
			expectedProjectContentHash: importedContentHash,
			expectedWriteVersion: requireNumber(
				sourceSaved.writeVersion,
				"writeVersion",
			),
			saveReceiptOperationId: sourceSaveRequest.operationId,
			expectedSaveReceiptId: requireString(sourceSaved.receiptId, "receiptId"),
			description: gradeDescription,
			operations: gradeOperations,
			policy: {
				warningPolicy: "allow",
				providerExecution: "forbidden",
				costPolicy: "require-exact",
			},
		};
		const preflightProbe = await first.callTool(
			"opencut_preflight_edit_plan",
			{ ...preflightRequest, preflightId: "public-complex-preflight-probe" },
			5 * 60_000,
		);
		expect(preflightProbe).toMatchObject({
			disposition: "evaluated",
			result: {
				status: "validated",
				captionLayout: {
					layoutVersion: "opencut.caption-layout.v1",
					layoutEngine: "browser-canvas-2d",
					geometryVersion: "opencut.caption-geometry.v1",
					measurement: "opencut.text.measureTextLayout",
					fontReadiness: { status: "ready", families: ["Arial"] },
					captions: [
						{
							operationIndex: 4,
							captionIndex: 0,
							elementName: "Caption 1",
							fontDescriptorCss: 'italic bold 16px "Arial"',
							geometry: { lineCount: 1, clipped: false },
						},
					],
				},
			},
		});
		const interruptedPreflightCall = first
			.callTool("opencut_preflight_edit_plan", preflightRequest, 5 * 60_000)
			.then((value) => ({ status: "unexpected-response" as const, value }))
			.catch((error: unknown) => ({ status: "interrupted" as const, error }));
		const preflightDisconnect = await waitForEditorDisconnection(first);
		expect(preflightDisconnect.connected).toBe(false);
		await first.callTool("opencut_stop_editor_worker", {});
		await first.close();
		expect((await interruptedPreflightCall).status).toBe("interrupted");

		const recovery = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
			dropBrowserResponseOperationId: "public-receipt-recovery-audio",
		});
		await recovery.callTool("opencut_start_editor_worker", { projectId });
		const recoveryStatus = await recovery.callTool(
			"opencut_connection_status",
			{},
		);
		const recoveryIdentity = requireRecord(
			recoveryStatus.connectionIdentity,
			"connectionIdentity",
		);
		const recoverySource = await recovery.callTool(
			"opencut_get_project",
			affinity(recoveryIdentity),
		);
		expect(requireProjectContentHash(recoverySource)).toBe(importedContentHash);
		const historyBeforePreflight = await recovery.callTool(
			"opencut_list_operation_history",
			{ projectId, limit: 100 },
		);
		const recoveredPreflight = await recovery.callTool(
			"opencut_preflight_edit_plan",
			preflightRequest,
			5 * 60_000,
		);
		expect(recoveredPreflight).toMatchObject({
			disposition: "replayed",
			result: {
				status: "validated",
				preflightId: preflightRequest.preflightId,
			},
		});
		const recoveredPreflightResult = requireRecord(
			recoveredPreflight.result,
			"recovered preflight result",
		);
		const recoveredNoMutation = requireRecord(
			recoveredPreflightResult.noMutationProof,
			"recovered no-mutation proof",
		);
		expect(recoveredNoMutation.unchanged).toBe(true);
		expect(recoveredNoMutation.before).toEqual(recoveredNoMutation.after);
		const recoveredReceipt = await recovery.callTool(
			"opencut_get_edit_plan_preflight",
			{ receiptId: recoveredPreflight.receiptId, verifyIntegrity: true },
		);
		expect(recoveredReceipt).toMatchObject({
			status: "found",
			receipt: {
				preflightId: preflightRequest.preflightId,
				terminalResult: { status: "validated" },
			},
		});
		await expect(
			recovery.callTool("opencut_preflight_edit_plan", {
				...preflightRequest,
				description: `${gradeDescription} changed`,
			}),
		).rejects.toThrow();

		const historyAfterPreflight = await recovery.callTool(
			"opencut_list_operation_history",
			{ projectId, limit: 100 },
		);
		expect(historyAfterPreflight.entries).toEqual(
			historyBeforePreflight.entries,
		);
		const unchangedAfterPreflight = await recovery.callTool(
			"opencut_get_project",
			affinity(recoveryIdentity),
		);
		expect(requireProjectContentHash(unchangedAfterPreflight)).toBe(
			importedContentHash,
		);
		expect(unchangedAfterPreflight.revision).toBe(recoverySource.revision);
		const recoveredEvaluation = requireRecord(
			recoveredPreflightResult.evaluation,
			"recovered preflight evaluation",
		);
		const editRequestWithoutReceipt = {
			...affinity(recoveryIdentity),
			projectId,
			operationId: "public-observable-grade",
			expectedRevision: requireNumber(recoverySource.revision, "revision"),
			expectedProjectContentHash: importedContentHash,
			description: gradeDescription,
			operations: gradeOperations,
		};
		const missingPreflight = await recovery.callTool(
			"opencut_apply_edit_plan",
			editRequestWithoutReceipt,
		);
		expect(missingPreflight).toMatchObject({
			status: "rejected",
			code: "PREFLIGHT_REQUIRED",
			retryable: false,
			operationId: editRequestWithoutReceipt.operationId,
		});
		const afterMissingPreflight = await recovery.callTool(
			"opencut_get_project",
			affinity(recoveryIdentity),
		);
		expect(requireProjectContentHash(afterMissingPreflight)).toBe(
			importedContentHash,
		);
		expect(afterMissingPreflight.revision).toBe(recoverySource.revision);
		const editRequest = {
			...editRequestWithoutReceipt,
			preflight: {
				receiptId: recoveredPreflight.receiptId,
				planFingerprint: recoveredEvaluation.planFingerprint,
				preflightFingerprint: recoveredEvaluation.preflightFingerprint,
				planDiffHash: recoveredEvaluation.planDiffHash,
			},
		};
		const edited = await recovery.callTool(
			"opencut_apply_edit_plan",
			editRequest,
		);
		expect(edited.status).toBe("applied");
		const editedSnapshot = requireRecord(edited.snapshot, "snapshot");
		const contentHash = requireProjectContentHash(editedSnapshot);
		expect(contentHash).toBe(
			requireString(
				recoveredEvaluation.predictedProjectHash,
				"predicted project hash",
			),
		);
		await expect(
			recovery.callTool("opencut_apply_edit_plan", {
				...editRequest,
				operationId: "public-stale-preflight-reuse",
			}),
		).rejects.toThrow();
		const afterStaleReceipt = await recovery.callTool(
			"opencut_get_project",
			affinity(recoveryIdentity),
		);
		expect(requireProjectContentHash(afterStaleReceipt)).toBe(contentHash);
		const saveRequest = {
			...affinity(recoveryIdentity),
			projectId,
			sceneId: requireString(editedSnapshot.sceneId, "sceneId"),
			operationId: "public-save-barrier",
			expectedRevision: requireNumber(edited.revision, "revision"),
			expectedContentHash: contentHash,
		};
		const saved = await recovery.callTool("opencut_save_project", saveRequest);
		expect(saved).toMatchObject({
			status: "saved",
			projectId,
			contentHash,
			readbackContentHash: contentHash,
			reloadVerified: true,
		});
		const saveReceiptId = requireString(saved.receiptId, "receiptId");
		const writeVersion = requireNumber(saved.writeVersion, "writeVersion");
		const noOpSaved = await recovery.callTool("opencut_save_project", {
			...saveRequest,
			operationId: "public-save-barrier-noop",
		});
		expect(noOpSaved).toMatchObject({
			status: "saved",
			projectId,
			receiptId: saveReceiptId,
			writeVersion,
			contentHash,
			readbackContentHash: contentHash,
			reloadVerified: true,
		});
		const saveReceipt = await recovery.callTool("opencut_get_save_receipt", {
			...affinity(recoveryIdentity),
			operationId: saveRequest.operationId,
		});
		expect(saveReceipt).toMatchObject({
			status: "found",
			receiptId: saveReceiptId,
			writeVersion,
		});

		const audioDescription =
			"Apply an audible source gain through receipt recovery";
		const audioPreflightId = `public-receipt-recovery-audio-preflight-${randomBytes(8).toString("hex")}`;
		const audioOperations = [
			{
				kind: "set_audio",
				trackId: requireString(importedElement.trackId, "trackId"),
				elementId: importedElementId,
				volumeDb: -3,
			},
		];
		const audioPreflight = await recovery.callTool(
			"opencut_preflight_edit_plan",
			{
				contractVersion: 2,
				...affinity(recoveryIdentity),
				preflightId: audioPreflightId,
				projectId,
				sceneId: saveRequest.sceneId,
				expectedRevision: requireNumber(edited.revision, "revision"),
				expectedProjectContentHash: contentHash,
				expectedWriteVersion: writeVersion,
				saveReceiptOperationId: saveRequest.operationId,
				expectedSaveReceiptId: saveReceiptId,
				description: audioDescription,
				operations: audioOperations,
				policy: {
					warningPolicy: "allow",
					providerExecution: "forbidden",
					costPolicy: "require-exact",
				},
			},
			5 * 60_000,
		);
		expect(audioPreflight).toMatchObject({
			result: { status: "validated" },
		});
		const audioEvaluation = requireRecord(
			requireRecord(audioPreflight.result, "audio preflight result").evaluation,
			"audio preflight evaluation",
		);
		const audioRequest = {
			...affinity(recoveryIdentity),
			projectId,
			operationId: "public-receipt-recovery-audio",
			expectedRevision: requireNumber(edited.revision, "revision"),
			expectedProjectContentHash: contentHash,
			description: audioDescription,
			operations: audioOperations,
			preflight: {
				receiptId: audioPreflight.receiptId,
				planFingerprint: audioEvaluation.planFingerprint,
				preflightFingerprint: audioEvaluation.preflightFingerprint,
				planDiffHash: audioEvaluation.planDiffHash,
			},
		};
		const interruptedAudio = await recovery.callTool(
			"opencut_apply_edit_plan",
			audioRequest,
		);
		expect(interruptedAudio).toMatchObject({
			status: "recoverable",
			disposition: "unknown",
		});
		const disconnectedAfterReceipt = await recovery.callTool(
			"opencut_connection_status",
			{},
		);
		expect(disconnectedAfterReceipt.connected).toBe(false);
		await recovery.callTool("opencut_stop_editor_worker", {});
		await recovery.close();
		const second = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await second.callTool("opencut_start_editor_worker", { projectId });
		const restartedStatus = await second.callTool(
			"opencut_connection_status",
			{},
		);
		const restartedIdentity = requireRecord(
			restartedStatus.connectionIdentity,
			"connectionIdentity",
		);
		expect(restartedIdentity.serverInstanceId).not.toBe(
			initialIdentity.serverInstanceId,
		);
		expect(restartedIdentity.editorInstanceId).toBe(
			initialIdentity.editorInstanceId,
		);
		const reloaded = await second.callTool(
			"opencut_get_project",
			affinity(restartedIdentity),
		);
		const audioContentHash = requireProjectContentHash(reloaded);
		expect(audioContentHash).not.toBe(contentHash);
		expect(requireProjectContentHash(reloaded)).toBe(audioContentHash);
		const reloadedElement = requireRecords(reloaded.elements, "elements").find(
			(element) => element.elementId === importedElementId,
		);
		expect(reloadedElement).toMatchObject({
			key: {
				type: "chroma",
				keyColor: "#00ff00",
				similarity: 0.2,
				softness: 0.1,
				spillSuppression: 0.8,
				enabled: true,
			},
			params: { volume: -3 },
			effects: [
				expect.objectContaining({
					effectId: "public-realistic-grade",
					effectType: "color-grade",
				}),
			],
		});
		expect(
			requireRecords(reloaded.tracks, "tracks").find(
				(track) =>
					track.trackId === requireString(importedElement.trackId, "trackId"),
			),
		).toMatchObject({
			trackMatte: {
				sourceTrackId: "public-track-matte-source",
				mode: "alpha",
				inverted: false,
				enabled: true,
			},
		});
		const recoveredAudio = await second.callTool("opencut_apply_edit_plan", {
			...audioRequest,
			...affinity(restartedIdentity),
		});
		expect(recoveredAudio).toMatchObject({
			status: "applied",
			durableOperationStatus: "completed",
			operationDisposition: "applied-verified",
		});
		const recoveredAudioRecord = requireRecord(
			requireRecord(
				(
					await second.callTool("opencut_get_operation", {
						operationId: audioRequest.operationId,
					})
				).operation,
				"audio operation entry",
			).record,
			"audio operation record",
		);
		expect(recoveredAudioRecord).toMatchObject({
			status: "completed",
			contentHashBefore: contentHash,
			contentHashAfter: audioContentHash,
			saveReceipt: { contentHash: audioContentHash, reloadVerified: true },
		});
		const replayed = await second.callTool("opencut_save_project", {
			...saveRequest,
			...affinity(restartedIdentity),
		});
		expect(replayed).toMatchObject({
			status: "saved",
			durableOperationStatus: "replayed",
			receiptId: saveReceiptId,
			writeVersion,
			contentHash,
		});
		const replayedEdit = await second.callTool("opencut_apply_edit_plan", {
			...editRequest,
			...affinity(restartedIdentity),
		});
		expect(replayedEdit).toMatchObject({
			status: "applied",
			durableOperationStatus: "replayed",
			operationDisposition: "applied-verified",
		});
		const afterReplay = await second.callTool(
			"opencut_get_project",
			affinity(restartedIdentity),
		);
		expect(requireProjectContentHash(afterReplay)).toBe(audioContentHash);
		expect(requireNumber(afterReplay.revision, "revision")).toBe(
			requireNumber(reloaded.revision, "restarted revision"),
		);
		expect(requireRecords(afterReplay.elements, "elements")).toHaveLength(
			requireRecords(reloaded.elements, "elements").length,
		);
		expect(
			createHash("sha256")
				.update(await readFile(sourcePath))
				.digest("hex"),
		).toBe(sourceHash);
		await expect(
			second.callTool("opencut_apply_edit_plan", {
				...editRequest,
				...affinity(restartedIdentity),
				description: "Changed input must not reuse the operation ID",
			}),
		).rejects.toThrow();
		const operation = await second.callTool("opencut_get_operation", {
			operationId: editRequest.operationId,
		});
		const operationRecord = requireRecord(
			requireRecord(operation.operation, "operation entry").record,
			"operation record",
		);
		expect(operationRecord).toMatchObject({
			operationId: editRequest.operationId,
			status: "completed",
			disposition: "applied-verified",
			contentHashBefore: importedContentHash,
			contentHashAfter: contentHash,
			actor: { type: "service", id: "opencut-mcp" },
			affectedObjects: expect.arrayContaining([
				{ objectType: "project", objectId: projectId, action: "updated" },
				{
					objectType: "element",
					objectId: importedElementId,
					action: "updated",
				},
			]),
			saveReceipt: {
				projectId,
				contentHash,
				readbackContentHash: contentHash,
				reloadVerified: true,
			},
		});
		expect(operationRecord.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(operationRecord.revisionAfter).toBe(edited.revision);
		const history = await second.callTool("opencut_list_operation_history", {
			projectId,
			limit: 100,
		});
		expect(
			requireRecords(history.entries, "history entries").some(
				(entry) =>
					requireRecord(entry.record, "history record").operationId ===
					editRequest.operationId,
			),
		).toBe(true);

		const audioSaveReceipt = requireRecord(
			recoveredAudioRecord.saveReceipt,
			"audio save receipt",
		);
		const previewRequest = {
			...affinity(restartedIdentity),
			contractVersion: 2,
			operationId: "public-exact-preview",
			projectId,
			sceneId: requireString(reloaded.sceneId, "sceneId"),
			expectedRevision: requireNumber(reloaded.revision, "revision"),
			expectedProjectContentHash: audioContentHash,
			expectedWriteVersion: requireNumber(
				audioSaveReceipt.writeVersion,
				"writeVersion",
			),
			saveReceiptOperationId: requireString(
				audioSaveReceipt.operationId,
				"save operationId",
			),
			expectedSaveReceiptId: requireString(
				audioSaveReceipt.receiptId,
				"save receiptId",
			),
			time: { kind: "media-time", ticks: 60_000, rounding: "exact" },
			canvasSize: { width: 320, height: 240 },
			format: "png",
		} as const;
		const initialPreview = await second.callTool(
			"opencut_render_preview_frame",
			previewRequest,
			5 * 60_000,
		);
		expect(initialPreview).toMatchObject({
			status: "rendered",
			durableOperationStatus: "completed",
		});
		expect(
			requireRecord(
				await second.callTool("opencut_connection_status", {}),
				"preview disconnect status",
			).connected,
		).toBe(true);

		await second.callTool("opencut_stop_editor_worker", {});
		await second.close();
		const third = await startMcp({
			baseUrl,
			browserPath,
			bridgePort,
			profileDirectory,
			receiptDirectory,
		});
		await third.callTool("opencut_start_editor_worker", { projectId });
		const thirdStatus = await third.callTool("opencut_connection_status", {});
		const thirdIdentity = requireRecord(
			thirdStatus.connectionIdentity,
			"connectionIdentity",
		);
		const preview = await third.callTool(
			"opencut_render_preview_frame",
			previewRequest,
			5 * 60_000,
		);
		expect(preview).toMatchObject({
			status: "rendered",
			durableOperationStatus: "replayed",
			projectId,
			sceneId: reloaded.sceneId,
			requestedTicks: 60_000,
			resolvedTicks: 60_000,
			frameIndex: 15,
			ticksPerFrame: 4_000,
			artifact: {
				mimeType: "image/png",
				width: 320,
				height: 240,
			},
			editorState: { unchanged: true },
			sourceVerification: {
				revisionBefore: reloaded.revision,
				revisionAfter: reloaded.revision,
				contentHashBefore: audioContentHash,
				contentHashAfter: audioContentHash,
			},
			renderer: {
				executionIdentity: restartedIdentity,
			},
		});
		expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(preview.pixelRgbaSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(preview.saveReceiptOperationId).toBe(
			previewRequest.saveReceiptOperationId,
		);
		expect(
			requireRecord(preview.saveReceipt, "preview save receipt").operationId,
		).toBe(previewRequest.saveReceiptOperationId);
		const fontReadiness = requireRecord(
			preview.fontReadiness,
			"font readiness",
		);
		const exactCaptionDescriptor = requireRecords(
			fontReadiness.descriptors,
			"font descriptors",
		).find(
			(descriptor) =>
				descriptor.family === "Arial" &&
				descriptor.style === "italic" &&
				descriptor.weight === "bold",
		);
		if (!exactCaptionDescriptor)
			throw new Error(
				`italic bold caption font evidence is missing: ${JSON.stringify(fontReadiness.descriptors)}`,
			);
		const matchedFaces = requireRecords(
			exactCaptionDescriptor.matchedFaces,
			"matched font faces",
		);
		expect(matchedFaces.length).toBeGreaterThan(0);
		const matchedFaceIdentities = matchedFaces.map((face) => {
			const { identitySha256, ...identityFields } = face;
			expect(face.style).toBe("italic");
			expect(face.weight).toBe("700");
			expect(face.stretch).toBe("100%");
			expect(face.provenance).toMatch(
				/^(bundled-font-bytes|font-face-set|system-local-font-face)$/,
			);
			expect(identitySha256).toBe(
				createHash("sha256")
					.update(JSON.stringify(identityFields))
					.digest("hex"),
			);
			return identitySha256;
		});
		expect(exactCaptionDescriptor.matchedFaceIdentities).toEqual(
			matchedFaceIdentities.sort(),
		);
		const durablePreview = await third.callTool("opencut_get_preview_frame", {
			receiptId: requireString(preview.receiptId, "preview receiptId"),
		});
		expect(durablePreview).toMatchObject({
			status: "found",
			receipt: { artifact: { sha256: preview.sha256 } },
		});
		const replayedPreview = await third.callTool(
			"opencut_render_preview_frame",
			previewRequest,
		);
		expect(replayedPreview).toMatchObject({
			status: "rendered",
			durableOperationStatus: "replayed",
			sha256: preview.sha256,
			pixelRgbaSha256: preview.pixelRgbaSha256,
		});
		await expect(
			third.callTool("opencut_render_preview_frame", {
				...previewRequest,
				time: { kind: "frame-index", frameIndex: 16 },
			}),
		).rejects.toThrow();

		const thirdReloaded = await third.callTool(
			"opencut_get_project",
			affinity(thirdIdentity),
		);
		expect(requireProjectContentHash(thirdReloaded)).toBe(audioContentHash);

		const outputPath = join(directory, "public-verified.webm");
		const exported = await third.callTool(
			"opencut_export_project",
			{
				...affinity(thirdIdentity),
				projectId,
				operationId: "public-pinned-export",
				expectedRevision: requireNumber(thirdReloaded.revision, "revision"),
				expectedProjectContentHash: audioContentHash,
				outputPath,
				format: "webm",
				quality: "very_high",
				fps: { numerator: 30, denominator: 1 },
				includeAudio: true,
				canvasSize: { width: 320, height: 240 },
			},
			5 * 60_000,
		);
		expect(exported).toMatchObject({
			status: "exported",
			projectId,
			savedContentHash: audioContentHash,
			validation: {
				status: "validated",
				fullDecode: true,
				video: { width: 320, height: 240, fps: 30 },
				audio: { present: true },
			},
		});
		expect((await stat(outputPath)).size).toBeGreaterThan(0);
		const validation = requireRecord(exported.validation, "validation");
		const samples = requireRecords(validation.frameSamples, "frameSamples");
		expect(samples.map((sample) => sample.position)).toEqual([
			"opening",
			"middle",
			"ending",
		]);
		for (const sample of samples) {
			expect(sample.bytes).toBeGreaterThan(0);
			expect(sample.sha256).toMatch(/^[a-f0-9]{64}$/);
		}
		const videoValidation = requireRecord(validation.video, "validated video");
		for (const field of [
			"codec",
			"profile",
			"level",
			"pixelFormat",
			"colorPrimaries",
			"colorTransfer",
			"colorMatrix",
			"colorRange",
		]) {
			expect(Object.hasOwn(videoValidation, field)).toBe(true);
		}
		const audioValidation = requireRecord(validation.audio, "validated audio");
		expect(audioValidation).toMatchObject({
			present: true,
			codec: "opus",
			fallback: {
				preferredCodec: "opus",
				actualCodec: "opus",
				outcome: "preferred",
			},
		});
		expect(validation.mastering).toMatchObject({
			preview: { chain: "opencut-fixed-mastering-v1" },
			export: { chain: "opencut-fixed-mastering-v1" },
			difference: expect.stringContaining("per rendered buffer"),
		});
		const paritySaveOperationId = "public-parity-source-save";
		const paritySaved = await third.callTool("opencut_save_project", {
			...affinity(thirdIdentity),
			projectId,
			sceneId: previewRequest.sceneId,
			operationId: paritySaveOperationId,
			expectedRevision: previewRequest.expectedRevision,
			expectedContentHash: previewRequest.expectedProjectContentHash,
		});
		expect(paritySaved).toMatchObject({
			status: "saved",
			contentHash: previewRequest.expectedProjectContentHash,
		});
		const paritySourceBinding = {
			expectedWriteVersion: requireNumber(
				paritySaved.writeVersion,
				"parity save writeVersion",
			),
			saveReceiptOperationId: paritySaveOperationId,
			expectedSaveReceiptId: requireString(
				paritySaved.receiptId,
				"parity save receiptId",
			),
		};

		const videoDurationSeconds = requireNumber(
			videoValidation.durationSeconds,
			"export video duration",
		);
		const exportFullPcm = await extractPcmI16(outputPath);
		for (const sample of samples) {
			const position = requireString(sample.position, "sample position");
			const sampleSeconds = requireNumber(
				sample.timeSeconds,
				`${position} sample time`,
			);
			const expectedTicks = Math.round(sampleSeconds * MEDIA_TICKS_PER_SECOND);
			const previewFrame = await third.callTool(
				"opencut_render_preview_frame",
				{
					...previewRequest,
					...affinity(thirdIdentity),
					...paritySourceBinding,
					operationId: `public-parity-frame-${position}`,
					time: {
						kind: "media-time",
						ticks: expectedTicks,
						rounding: "exact",
					},
				},
				5 * 60_000,
			);
			expect(previewFrame).toMatchObject({
				status: "rendered",
				requestedTicks: expectedTicks,
				resolvedTicks: expectedTicks,
			});
			const previewRgba = await extractRgba(
				requireString(previewFrame.outputPath, `${position} preview path`),
			);
			const exportRgba = await extractRgba(
				requireString(sample.path, `${position} export path`),
			);
			const rgbaMetrics = rgbaComparisonMetrics(previewRgba, exportRgba);
			console.log(
				`[parity] ${position} frame t=${sampleSeconds.toFixed(6)}s MAE=${rgbaMetrics.meanAbsoluteError.toFixed(3)} PSNR=${rgbaMetrics.psnrDb.toFixed(2)} dB`,
			);
			assertMetricAtMost({
				label: `${position} frame RGBA MAE`,
				actual: rgbaMetrics.meanAbsoluteError,
				maximum: PREVIEW_EXPORT_RGBA_MAE_TOLERANCE,
			});
			assertMetricAtLeast({
				label: `${position} frame PSNR`,
				actual: rgbaMetrics.psnrDb,
				minimum: PREVIEW_EXPORT_RGBA_MIN_PSNR_DB,
			});

			const { startSeconds, endSeconds } = audioBoundaryWindow({
				position,
				centerSeconds: sampleSeconds,
				durationSeconds: videoDurationSeconds,
			});
			const previewAudioRange = await third.callTool(
				"opencut_render_preview_range",
				{
					...affinity(thirdIdentity),
					contractVersion: 1,
					operationId: `public-parity-audio-${position}`,
					projectId,
					sceneId: previewRequest.sceneId,
					expectedRevision: previewRequest.expectedRevision,
					expectedProjectContentHash: previewRequest.expectedProjectContentHash,
					expectedWriteVersion: paritySourceBinding.expectedWriteVersion,
					saveReceiptOperationId: paritySourceBinding.saveReceiptOperationId,
					expectedSaveReceiptId: paritySourceBinding.expectedSaveReceiptId,
					range: {
						kind: "media-time",
						startTicks: Math.round(startSeconds * MEDIA_TICKS_PER_SECOND),
						endTicksExclusive: Math.round(endSeconds * MEDIA_TICKS_PER_SECOND),
					},
					canvasSize: { width: 16, height: 16 },
					output: {
						kind: "frame-sequence",
						frameFormat: "png",
						includeAudio: true,
					},
				},
				5 * 60_000,
			);
			expect(previewAudioRange).toMatchObject({
				status: "rendered",
				execution: { status: "succeeded" },
			});
			const previewAudio = requireRecord(
				previewAudioRange.audio,
				`${position} preview audio`,
			);
			const actualStartSeconds =
				requireNumber(
					previewAudio.startTicks,
					`${position} preview audio start`,
				) / MEDIA_TICKS_PER_SECOND;
			const actualEndSeconds =
				requireNumber(
					previewAudio.endTicksExclusive,
					`${position} preview audio end`,
				) / MEDIA_TICKS_PER_SECOND;
			const previewAudioPath = requireString(
				previewAudio.path,
				`${position} preview audio path`,
			);
			const previewPcm = await extractPcmI16(previewAudioPath);
			const exportPcm = exportFullPcm.subarray(
				Math.round(actualStartSeconds * PARITY_AUDIO_SAMPLE_RATE) *
					PARITY_AUDIO_CHANNELS,
				Math.round(actualEndSeconds * PARITY_AUDIO_SAMPLE_RATE) *
					PARITY_AUDIO_CHANNELS,
			);
			expect(
				Math.abs(previewPcm.length - exportPcm.length),
			).toBeLessThanOrEqual(
				PARITY_AUDIO_SAMPLE_RATE *
					PARITY_AUDIO_CHANNELS *
					PREVIEW_EXPORT_PCM_SAMPLE_COUNT_TOLERANCE_SECONDS,
			);
			const pcmMetrics = pcmComparisonMetrics(previewPcm, exportPcm);
			console.log(
				`[parity] ${position} audio ${actualStartSeconds.toFixed(3)}-${actualEndSeconds.toFixed(3)}s samples=${previewPcm.length}/${exportPcm.length} lag=${((pcmMetrics.lagFrames / PARITY_AUDIO_SAMPLE_RATE) * 1000).toFixed(2)}ms aligned PCM MAE=${pcmMetrics.meanAbsoluteError.toFixed(1)}`,
			);
			assertMetricAtMost({
				label: `${position} audio alignment lag (seconds)`,
				actual: Math.abs(pcmMetrics.lagFrames) / PARITY_AUDIO_SAMPLE_RATE,
				maximum: PREVIEW_EXPORT_PCM_MAX_LAG_SECONDS,
			});
			assertMetricAtMost({
				label: `${position} audio PCM MAE`,
				actual: pcmMetrics.meanAbsoluteError,
				maximum: PREVIEW_EXPORT_PCM_MAE_TOLERANCE,
			});
			const [previewLoudness, exportLoudness] = await Promise.all([
				measureEbur128(previewAudioPath),
				measureEbur128(outputPath, {
					startSeconds: actualStartSeconds,
					durationSeconds: actualEndSeconds - actualStartSeconds,
				}),
			]);
			console.log(
				`[parity] ${position} audio loudness preview=${previewLoudness.integratedLufs} LUFS / ${previewLoudness.truePeakDbtp} dBTP export=${exportLoudness.integratedLufs} LUFS / ${exportLoudness.truePeakDbtp} dBTP`,
			);
			assertMetricAtMost({
				label: `${position} audio integrated loudness delta`,
				actual: Math.abs(
					previewLoudness.integratedLufs - exportLoudness.integratedLufs,
				),
				maximum: PREVIEW_EXPORT_LOUDNESS_TOLERANCE_LU,
			});
			assertMetricAtMost({
				label: `${position} audio true-peak delta`,
				actual: Math.abs(
					previewLoudness.truePeakDbtp - exportLoudness.truePeakDbtp,
				),
				maximum: PREVIEW_EXPORT_TRUE_PEAK_TOLERANCE_DB,
			});
		}
		const exportMeasurements = requireRecord(
			audioValidation.measurements,
			"export audio measurements",
		);
		expect(exportMeasurements.integratedLufs).not.toBeNull();
		expect(exportMeasurements.truePeakDbtp).not.toBeNull();
		const outerReceipt = await third.callTool("opencut_get_export_receipt", {
			operationId: "public-pinned-export",
		});
		expect(outerReceipt).toMatchObject({
			status: "found",
			receipt: {
				schemaVersion: 1,
				operationId: "public-pinned-export",
				result: {
					status: "exported",
					savedContentHash: audioContentHash,
				},
			},
		});
		const exportOperation = requireRecord(
			requireRecord(
				(
					await third.callTool("opencut_get_operation", {
						operationId: "public-pinned-export",
					})
				).operation,
				"export operation entry",
			).record,
			"export operation record",
		);
		expect(exportOperation).toMatchObject({
			status: "completed",
			contentHashBefore: audioContentHash,
			artifacts: [
				{
					kind: "export",
					state: "verified",
					sha256: exported.sha256,
					bytes: exported.bytesWritten,
				},
			],
			providerProvenance: [
				{
					provider: "opencut-web-renderer",
					artifactHash: exported.sha256,
				},
			],
		});
		// Keep the default milestone comprehensive while allowing issue-focused
		// runs to stop after the complete compositing/replay/export contract.
		if (process.env.OPENCUT_COMPOSITING_E2E_ONLY === "1") {
			await third.callTool("opencut_stop_editor_worker", {});
			return;
		}

		// -----------------------------------------------------------------
		// Issue #20: project, scene, bookmark, track, and media-bin lifecycle
		// on the real imported video. Every mutation chains revision and
		// content hash so each step is ledgered against verified state.
		// -----------------------------------------------------------------
		let lifecycleRevision = requireNumber(thirdReloaded.revision, "revision");
		let lifecycleHash = audioContentHash;
		const lifecycleSceneId = requireString(thirdReloaded.sceneId, "sceneId");
		const lifecycleMutation = async (
			tool: string,
			operationId: string,
			params: Record<string, unknown>,
		) => {
			const request = {
				projectId,
				expectedRevision: lifecycleRevision,
				expectedProjectContentHash: lifecycleHash,
				...params,
			};
			const preflight = await third.callTool(
				"opencut_preflight_lifecycle_mutation",
				{
					...affinity(thirdIdentity),
					method: tool.replace(/^opencut_/, ""),
					request,
				},
			);
			expect(preflight.status).toBe("validated");
			const noMutationProof = requireRecord(
				preflight.noMutationProof,
				"lifecycle no-mutation proof",
			);
			expect(noMutationProof.before).toBe(noMutationProof.after);
			const result = await third.callTool(tool, {
				...affinity(thirdIdentity),
				...request,
				operationId,
				preflightFingerprint: requireString(
					preflight.preflightFingerprint,
					"lifecycle preflight fingerprint",
				),
			});
			expect(result).toMatchObject({ status: "applied", operationId });
			lifecycleRevision = requireNumber(result.revision, "revision");
			lifecycleHash = requireProjectContentHash(
				requireRecord(result.snapshot, "snapshot"),
			);
			return result;
		};
		const lifecycleSave = async (operationId: string) => {
			const saved = await third.callTool("opencut_save_project", {
				...affinity(thirdIdentity),
				projectId,
				sceneId: requireString(
					requireRecord(
						await third.callTool(
							"opencut_get_project",
							affinity(thirdIdentity),
						),
						"project",
					).sceneId,
					"sceneId",
				),
				operationId,
				expectedRevision: lifecycleRevision,
				expectedContentHash: lifecycleHash,
			});
			expect(saved).toMatchObject({
				status: "saved",
				contentHash: lifecycleHash,
			});
			return saved;
		};

		const lifecycleSaved = await lifecycleSave("public-lifecycle-save");
		const scenesBefore = await third.callTool("opencut_list_scenes", {
			...affinity(thirdIdentity),
			projectId,
		});
		const scenesBeforeEntries = requireRecords(scenesBefore.scenes, "scenes");
		expect(scenesBeforeEntries).toHaveLength(1);
		expect(scenesBeforeEntries[0]).toMatchObject({
			sceneId: lifecycleSceneId,
			isMain: true,
			isActive: true,
			bookmarks: [],
		});
		expect(
			requireString(scenesBeforeEntries[0]?.contentHash, "contentHash"),
		).toMatch(/^[a-f0-9]{64}$/);

		// Track and bookmark lifecycle through a preflighted edit plan.
		const lifecycleTracks = requireRecords(
			requireRecord(thirdReloaded, "project").tracks,
			"tracks",
		);
		const lifecycleMainTrackId = lifecycleTracks.find(
			(track) => track.role === "main",
		)?.trackId;
		if (typeof lifecycleMainTrackId !== "string") {
			throw new Error("main track is missing");
		}
		const lifecycleExistingOverlayTrackIds = lifecycleTracks
			.filter((track) => track.role === "overlay")
			.map((track) => requireString(track.trackId, "overlay trackId"));
		const lifecycleOperations = [
			{
				kind: "duplicate_track",
				trackId: lifecycleMainTrackId,
				newTrackId: "lifecycle-copy",
			},
			{
				kind: "duplicate_track",
				trackId: lifecycleMainTrackId,
				newTrackId: "lifecycle-secondary",
			},
			{ kind: "set_main_track", trackId: "lifecycle-copy" },
			{
				kind: "rename_track",
				trackId: "lifecycle-copy",
				name: "Lifecycle copy",
			},
			{
				kind: "reorder_tracks",
				overlayTrackIds: [
					"lifecycle-secondary",
					lifecycleMainTrackId,
					...lifecycleExistingOverlayTrackIds,
				],
			},
			{
				kind: "remove_track",
				trackId: lifecycleMainTrackId,
				occupied: "delete",
			},
			{
				kind: "add_bookmark",
				bookmarkId: "lifecycle-bookmark",
				time: 0,
				note: "hook",
			},
			{ kind: "move_bookmark", bookmarkId: "lifecycle-bookmark", time: 8_000 },
			{
				kind: "update_bookmark",
				bookmarkId: "lifecycle-bookmark",
				color: "#ff0000",
				clear: ["note"],
			},
			{ kind: "remove_bookmark", bookmarkId: "lifecycle-bookmark" },
			{
				kind: "add_bookmark",
				bookmarkId: "lifecycle-bookmark-final",
				time: 8_000,
				color: "#ff0000",
			},
			{
				kind: "instantiate_asset",
				assetId: requireString(imported.assetId, "assetId"),
				elementId: "lifecycle-instance",
				startTime: 0,
			},
		];
		const lifecyclePreflight = await third.callTool(
			"opencut_preflight_edit_plan",
			{
				contractVersion: 2,
				bridgeProtocolVersion: 2,
				expectedConnectionIdentity: thirdIdentity,
				preflightId: "public-lifecycle-preflight",
				projectId,
				sceneId: lifecycleSceneId,
				expectedRevision: lifecycleRevision,
				expectedProjectContentHash: lifecycleHash,
				expectedWriteVersion: requireNumber(
					lifecycleSaved.writeVersion,
					"writeVersion",
				),
				saveReceiptOperationId: "public-lifecycle-save",
				expectedSaveReceiptId: requireString(
					lifecycleSaved.receiptId,
					"receiptId",
				),
				description: "Track, bookmark, and media-bin lifecycle operations",
				operations: lifecycleOperations,
				policy: {
					warningPolicy: "allow",
					providerExecution: "forbidden",
					costPolicy: "require-exact",
				},
			},
			5 * 60_000,
		);
		expect(lifecyclePreflight).toMatchObject({
			disposition: "evaluated",
			result: { status: "validated" },
		});
		const lifecycleEvaluation = requireRecord(
			requireRecord(lifecyclePreflight.result, "result").evaluation,
			"evaluation",
		);
		const lifecycleEdited = await third.callTool("opencut_apply_edit_plan", {
			...affinity(thirdIdentity),
			projectId,
			operationId: "public-lifecycle-edit",
			expectedRevision: lifecycleRevision,
			expectedProjectContentHash: lifecycleHash,
			description: "Track, bookmark, and media-bin lifecycle operations",
			operations: lifecycleOperations,
			preflight: {
				receiptId: lifecyclePreflight.receiptId,
				planFingerprint: lifecycleEvaluation.planFingerprint,
				preflightFingerprint: lifecycleEvaluation.preflightFingerprint,
				planDiffHash: lifecycleEvaluation.planDiffHash,
			},
		});
		expect(lifecycleEdited.status).toBe("applied");
		const lifecycleEditedSnapshot = requireRecord(
			lifecycleEdited.snapshot,
			"snapshot",
		);
		lifecycleRevision = requireNumber(lifecycleEdited.revision, "revision");
		lifecycleHash = requireProjectContentHash(lifecycleEditedSnapshot);
		expect(lifecycleHash).toBe(
			requireString(lifecycleEvaluation.predictedProjectHash, "predicted hash"),
		);
		expect(
			requireRecords(lifecycleEditedSnapshot.tracks, "tracks").find(
				(track) => track.trackId === "lifecycle-copy",
			),
		).toMatchObject({ role: "main", name: "Lifecycle copy" });
		expect(
			requireRecords(lifecycleEditedSnapshot.tracks, "tracks").find(
				(track) => track.trackId === "lifecycle-secondary",
			),
		).toMatchObject({ role: "overlay" });
		expect(
			requireRecords(lifecycleEditedSnapshot.tracks, "tracks").some(
				(track) => track.trackId === lifecycleMainTrackId,
			),
		).toBe(false);
		expect(
			requireRecords(lifecycleEditedSnapshot.bookmarks, "bookmarks"),
		).toEqual([
			{ bookmarkId: "lifecycle-bookmark-final", time: 8_000, color: "#ff0000" },
		]);
		expect(
			requireRecords(lifecycleEditedSnapshot.elements, "elements").find(
				(element) => element.elementId === "lifecycle-instance",
			),
		).toMatchObject({ type: "video", mediaId: imported.assetId });
		await lifecycleSave("public-lifecycle-save-tracks");

		// Scene lifecycle.
		const created = await lifecycleMutation(
			"opencut_create_scene",
			"public-lifecycle-create-scene",
			{ name: "Lifecycle scene", activate: false },
		);
		const createdSceneId = requireString(created.sceneId, "sceneId");
		expect(created.activeSceneId).toBe(lifecycleSceneId);
		const cloned = await lifecycleMutation(
			"opencut_clone_scene",
			"public-lifecycle-clone-scene",
			{ sceneId: lifecycleSceneId, name: "Lifecycle clone", activate: true },
		);
		const clonedSceneId = requireString(cloned.sceneId, "sceneId");
		expect(cloned.activeSceneId).toBe(clonedSceneId);
		const clonedSnapshot = requireRecord(cloned.snapshot, "snapshot");
		expect(clonedSnapshot.sceneId).toBe(clonedSceneId);
		expect(
			requireRecords(clonedSnapshot.elements, "elements").some(
				(element) => element.elementId === "lifecycle-instance",
			),
		).toBe(false);
		expect(requireRecords(clonedSnapshot.bookmarks, "bookmarks")).toHaveLength(
			1,
		);
		expect(
			requireRecords(clonedSnapshot.bookmarks, "bookmarks")[0]?.bookmarkId,
		).not.toBe("lifecycle-bookmark-final");

		// Issue #54: target the empty, non-active scene through the public
		// edit-plan boundary while the real-video clone remains selected.
		const nonActiveSaved = await lifecycleSave(
			"public-lifecycle-non-active-save",
		);
		const nonActiveBookmarkOperations = [
			{
				kind: "add_bookmark",
				bookmarkId: "lifecycle-non-active-bookmark",
				time: 16_000,
				note: "alternate cut",
			},
		];
		const nonActivePreflightRequest = {
			contractVersion: 2,
			...affinity(thirdIdentity),
			preflightId: "public-lifecycle-non-active-preflight",
			projectId,
			sceneId: createdSceneId,
			expectedRevision: lifecycleRevision,
			expectedProjectContentHash: lifecycleHash,
			expectedWriteVersion: requireNumber(
				nonActiveSaved.writeVersion,
				"non-active writeVersion",
			),
			saveReceiptOperationId: "public-lifecycle-non-active-save",
			expectedSaveReceiptId: requireString(
				nonActiveSaved.receiptId,
				"non-active save receiptId",
			),
			description: "Add a bookmark to the non-active lifecycle scene",
			operations: nonActiveBookmarkOperations,
			policy: {
				warningPolicy: "allow",
				providerExecution: "forbidden",
				costPolicy: "require-exact",
			},
		};
		const nonActivePreflight = await third.callTool(
			"opencut_preflight_edit_plan",
			nonActivePreflightRequest,
			5 * 60_000,
		);
		expect(nonActivePreflight).toMatchObject({
			disposition: "evaluated",
			result: {
				status: "validated",
				sourceObservation: { activeSceneId: clonedSceneId },
				noMutationProof: {
					unchanged: true,
					before: { activeSceneId: clonedSceneId },
					after: { activeSceneId: clonedSceneId },
				},
			},
		});
		const nonActiveEvaluation = requireRecord(
			requireRecord(nonActivePreflight.result, "non-active preflight result")
				.evaluation,
			"non-active evaluation",
		);
		const nonActiveApplyRequest = {
			...affinity(thirdIdentity),
			projectId,
			sceneId: createdSceneId,
			operationId: "public-lifecycle-non-active-bookmark",
			expectedRevision: lifecycleRevision,
			expectedProjectContentHash: lifecycleHash,
			description: "Add a bookmark to the non-active lifecycle scene",
			operations: nonActiveBookmarkOperations,
			preflight: {
				receiptId: requireString(
					nonActivePreflight.receiptId,
					"non-active preflight receiptId",
				),
				planFingerprint: requireString(
					nonActiveEvaluation.planFingerprint,
					"non-active planFingerprint",
				),
				preflightFingerprint: requireString(
					nonActiveEvaluation.preflightFingerprint,
					"non-active preflightFingerprint",
				),
				planDiffHash: requireString(
					nonActiveEvaluation.planDiffHash,
					"non-active planDiffHash",
				),
			},
		};
		const nonActiveApplied = await third.callTool(
			"opencut_apply_edit_plan",
			nonActiveApplyRequest,
		);
		expect(nonActiveApplied).toMatchObject({
			status: "applied",
			operationId: "public-lifecycle-non-active-bookmark",
			snapshot: {
				sceneId: createdSceneId,
				bookmarks: [
					{
						bookmarkId: "lifecycle-non-active-bookmark",
						time: 16_000,
						note: "alternate cut",
					},
				],
			},
			operationRecord: { sceneId: createdSceneId },
		});
		lifecycleRevision = requireNumber(nonActiveApplied.revision, "revision");
		lifecycleHash = requireProjectContentHash(
			requireRecord(nonActiveApplied.snapshot, "non-active snapshot"),
		);
		const nonActiveScenes = await third.callTool("opencut_list_scenes", {
			...affinity(thirdIdentity),
			projectId,
		});
		expect(nonActiveScenes.activeSceneId).toBe(clonedSceneId);
		expect(
			requireRecords(nonActiveScenes.scenes, "non-active scenes").find(
				(scene) => scene.sceneId === createdSceneId,
			),
		).toMatchObject({
			isActive: false,
			bookmarks: [
				expect.objectContaining({
					bookmarkId: "lifecycle-non-active-bookmark",
				}),
			],
		});
		expect(
			await third.callTool("opencut_apply_edit_plan", nonActiveApplyRequest),
		).toMatchObject({
			status: "applied",
			durableOperationStatus: "replayed",
			operationRecord: { sceneId: createdSceneId },
		});
		await lifecycleMutation(
			"opencut_rename_scene",
			"public-lifecycle-rename-scene",
			{
				sceneId: createdSceneId,
				name: "Lifecycle scene renamed",
			},
		);
		await lifecycleMutation(
			"opencut_set_main_scene",
			"public-lifecycle-set-main-scene",
			{ sceneId: createdSceneId },
		);
		await lifecycleMutation(
			"opencut_reorder_scenes",
			"public-lifecycle-reorder",
			{
				sceneIds: [createdSceneId, clonedSceneId, lifecycleSceneId],
			},
		);
		const switched = await lifecycleMutation(
			"opencut_switch_scene",
			"public-lifecycle-switch-scene",
			{ sceneId: lifecycleSceneId },
		);
		expect(switched.activeSceneId).toBe(lifecycleSceneId);
		const scenesAfter = await third.callTool("opencut_list_scenes", {
			...affinity(thirdIdentity),
			projectId,
		});
		expect(
			requireRecords(scenesAfter.scenes, "scenes").map((scene) => [
				scene.sceneId,
				scene.name,
				scene.isMain,
				scene.isActive,
			]),
		).toEqual([
			[createdSceneId, "Lifecycle scene renamed", true, false],
			[clonedSceneId, "Lifecycle clone", false, false],
			[
				lifecycleSceneId,
				requireString(thirdReloaded.sceneName, "sceneName"),
				false,
				true,
			],
		]);
		// Deleting the main scene without naming its successor is refused at
		// preflight, so no fingerprint exists to apply it with.
		const deletedMainRejected = await third.callTool(
			"opencut_preflight_lifecycle_mutation",
			{
				...affinity(thirdIdentity),
				method: "delete_scene",
				request: {
					projectId,
					expectedRevision: lifecycleRevision,
					expectedProjectContentHash: lifecycleHash,
					sceneId: createdSceneId,
				},
			},
		);
		expect(deletedMainRejected).toMatchObject({
			status: "rejected",
			reason: expect.stringContaining("newMainSceneId"),
		});
		await lifecycleMutation(
			"opencut_delete_scene",
			"public-lifecycle-delete-scene",
			{
				sceneId: createdSceneId,
				newMainSceneId: lifecycleSceneId,
			},
		);
		await lifecycleMutation(
			"opencut_delete_scene",
			"public-lifecycle-delete-clone",
			{ sceneId: clonedSceneId },
		);
		const scenesFinal = await third.callTool("opencut_list_scenes", {
			...affinity(thirdIdentity),
			projectId,
		});
		expect(requireRecords(scenesFinal.scenes, "scenes")).toHaveLength(1);
		expect(scenesFinal).toMatchObject({
			activeSceneId: lifecycleSceneId,
			mainSceneId: lifecycleSceneId,
		});

		// Media-bin lifecycle.
		const binImport = await lifecycleMutation(
			"opencut_import_media_asset",
			"public-lifecycle-bin-import",
			{ path: sourcePath, assetName: "Bin copy" },
		);
		const binAssetId = requireString(binImport.assetId, "assetId");
		expect(binAssetId).not.toBe(imported.assetId);
		const usages = await third.callTool("opencut_list_media_usages", {
			...affinity(thirdIdentity),
			projectId,
		});
		expect(requireRecords(usages.usages, "usages")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					assetId: imported.assetId,
					elementId: "lifecycle-instance",
					kind: "source",
				}),
			]),
		);
		expect(usages.unusedAssetIds).toEqual([binAssetId]);
		await lifecycleMutation(
			"opencut_rename_media_asset",
			"public-lifecycle-bin-rename",
			{ assetId: binAssetId, name: "Bin copy renamed" },
		);
		const relinkPreflight = await third.callTool(
			"opencut_preflight_media_relink",
			{
				...affinity(thirdIdentity),
				projectId,
				assetId: binAssetId,
				path: sourcePath,
				expectedRevision: lifecycleRevision,
				expectedProjectContentHash: lifecycleHash,
			},
		);
		expect(relinkPreflight).toMatchObject({
			status: "validated",
			compatible: true,
			differences: [],
			usageCount: 0,
			revision: lifecycleRevision,
		});
		const relinked = await lifecycleMutation(
			"opencut_relink_media_asset",
			"public-lifecycle-bin-relink",
			{ assetId: binAssetId, path: sourcePath },
		);
		expect(relinked.differences).toEqual([]);
		const removeReferenced = await third.callTool(
			"opencut_preflight_lifecycle_mutation",
			{
				...affinity(thirdIdentity),
				method: "remove_media_asset",
				request: {
					projectId,
					expectedRevision: lifecycleRevision,
					expectedProjectContentHash: lifecycleHash,
					assetId: requireString(imported.assetId, "assetId"),
					policy: "unused-only",
				},
			},
		);
		expect(removeReferenced.status).toBe("rejected");
		await lifecycleMutation(
			"opencut_remove_media_asset",
			"public-lifecycle-bin-remove",
			{ assetId: binAssetId, policy: "unused-only" },
		);
		expect(
			requireRecords(
				requireRecord(
					await third.callTool("opencut_get_project", affinity(thirdIdentity)),
					"project",
				).mediaAssets,
				"mediaAssets",
			).some((asset) => asset.assetId === binAssetId),
		).toBe(false);
		await lifecycleSave("public-lifecycle-save-media");

		// Project lifecycle.
		const projectPreflight = requireRecord(
			requireRecords(
				requireRecord(
					await third.callTool(
						"opencut_list_projects",
						affinity(thirdIdentity),
					),
					"project list",
				).projects,
				"projects",
			).find((candidate) => candidate.projectId === projectId)?.persistence,
			"project persistence",
		);
		const preflightProjectLifecycle = async (
			method: "rename_project" | "duplicate_project" | "delete_project",
			request: Record<string, unknown>,
		) => {
			const result = await third.callTool(
				"opencut_preflight_lifecycle_mutation",
				{ ...affinity(thirdIdentity), method, request },
			);
			expect(result.status).toBe("validated");
			return requireString(
				result.preflightFingerprint,
				"project lifecycle preflight fingerprint",
			);
		};
		const renameProjectRequest = {
			projectId,
			name: "Lifecycle renamed project",
			expectedTargetContentHash: requireString(
				projectPreflight.contentHash,
				"target content hash",
			),
			expectedTargetWriteVersion: requireNumber(
				projectPreflight.writeVersion,
				"target write version",
			),
		};
		const renamedProject = await third.callTool("opencut_rename_project", {
			...affinity(thirdIdentity),
			...renameProjectRequest,
			operationId: "public-lifecycle-rename-project",
			preflightFingerprint: await preflightProjectLifecycle(
				"rename_project",
				renameProjectRequest,
			),
		});
		expect(renamedProject).toMatchObject({
			status: "renamed",
			projectId,
			renamedProjectId: projectId,
			name: "Lifecycle renamed project",
			persistence: {
				status: "verified",
				projectId,
				contentHashProjectionVersion: 3,
			},
		});
		lifecycleRevision = requireNumber(renamedProject.revision, "revision");
		lifecycleHash = requireProjectContentHash(
			requireRecord(renamedProject.snapshot, "snapshot"),
		);
		const sourceProjectBeforeDuplicate = await third.callTool(
			"opencut_get_project",
			affinity(thirdIdentity),
		);
		const renamedPersistence = requireRecord(
			renamedProject.persistence,
			"renamed persistence",
		);
		const duplicateProjectRequest = {
			projectId,
			name: "Lifecycle duplicate",
			expectedTargetContentHash: requireString(
				renamedPersistence.contentHash,
				"renamed content hash",
			),
			expectedTargetWriteVersion: requireNumber(
				renamedPersistence.writeVersion,
				"renamed write version",
			),
		};
		const duplicatePreflightFingerprint = await preflightProjectLifecycle(
			"duplicate_project",
			duplicateProjectRequest,
		);
		const duplicatedProject = await third.callTool(
			"opencut_duplicate_project",
			{
				...affinity(thirdIdentity),
				...duplicateProjectRequest,
				operationId: "public-lifecycle-duplicate-project",
				preflightFingerprint: duplicatePreflightFingerprint,
			},
		);
		expect(duplicatedProject).toMatchObject({
			status: "duplicated",
			projectId,
			sourceProjectId: projectId,
			name: "Lifecycle duplicate",
			persistence: {
				status: "verified",
				contentHashProjectionVersion: 3,
			},
		});
		const duplicateProjectId = requireString(
			duplicatedProject.duplicateProjectId,
			"duplicateProjectId",
		);
		expect(duplicatedProject).toMatchObject({
			mediaIdentity: "shared",
			mediaBytes: "copied",
			persistence: { projectId: duplicateProjectId },
		});
		expect(duplicateProjectId).not.toBe(projectId);
		const projectsAfterDuplicate = await third.callTool(
			"opencut_list_projects",
			affinity(thirdIdentity),
		);
		expect(
			requireRecords(projectsAfterDuplicate.projects, "projects").map(
				(project) => project.projectId,
			),
		).toEqual(expect.arrayContaining([projectId, duplicateProjectId]));
		const replayedDuplicate = await third.callTool(
			"opencut_duplicate_project",
			{
				...affinity(thirdIdentity),
				...duplicateProjectRequest,
				operationId: "public-lifecycle-duplicate-project",
				preflightFingerprint: duplicatePreflightFingerprint,
			},
		);
		// The ledger answers a repeated operation from its durable record, so
		// the original result comes back unchanged under a replayed disposition.
		expect(replayedDuplicate).toMatchObject({
			status: "duplicated",
			durableOperationStatus: "replayed",
			duplicateProjectId,
		});
		const deleteProjectRequest = {
			projectId,
			fallbackProjectId: duplicateProjectId,
			expectedTargetContentHash: requireString(
				renamedPersistence.contentHash,
				"renamed content hash",
			),
			expectedTargetWriteVersion: requireNumber(
				renamedPersistence.writeVersion,
				"renamed write version",
			),
		};
		const deletedProject = await third.callTool("opencut_delete_project", {
			...affinity(thirdIdentity),
			...deleteProjectRequest,
			operationId: "public-lifecycle-delete-project",
			preflightFingerprint: await preflightProjectLifecycle(
				"delete_project",
				deleteProjectRequest,
			),
		});
		expect(deletedProject).toMatchObject({
			status: "deleted",
			projectId: duplicateProjectId,
			activeProjectId: duplicateProjectId,
			deletedProjectId: projectId,
			fallback: "opened-existing",
			recoverability: "irreversible",
			persistence: {
				status: "deleted-verified",
				projectId,
			},
		});
		const duplicateSnapshot = await third.callTool(
			"opencut_get_project",
			affinity(thirdIdentity),
		);
		expect(duplicateSnapshot.projectId).toBe(duplicateProjectId);
		for (const [collection, identity] of [
			["scenes", "sceneId"],
			["tracks", "trackId"],
			["elements", "elementId"],
			["bookmarks", "bookmarkId"],
		] as const) {
			const sourceIds = new Set(
				requireRecords(
					sourceProjectBeforeDuplicate[collection],
					collection,
				).map((item) => requireString(item[identity], identity)),
			);
			const duplicateIds = requireRecords(
				duplicateSnapshot[collection],
				collection,
			).map((item) => requireString(item[identity], identity));
			expect(duplicateIds).toHaveLength(sourceIds.size);
			expect(duplicateIds.every((id) => !sourceIds.has(id))).toBe(true);
		}
		expect(
			requireRecords(duplicateSnapshot.mediaAssets, "mediaAssets")
				.map((asset) => requireString(asset.assetId, "assetId"))
				.sort(),
		).toEqual(
			requireRecords(sourceProjectBeforeDuplicate.mediaAssets, "mediaAssets")
				.map((asset) => requireString(asset.assetId, "assetId"))
				.sort(),
		);
		expect(
			requireRecords(
				(await third.callTool("opencut_list_projects", affinity(thirdIdentity)))
					.projects,
				"projects",
			).some((project) => project.projectId === projectId),
		).toBe(false);
		const lifecycleHistory = await third.callTool(
			"opencut_list_operation_history",
			{ projectId, limit: 100 },
		);
		const lifecycleOperationIds = new Set(
			requireRecords(lifecycleHistory.entries, "entries").map((entry) =>
				requireString(
					requireRecord(entry.record, "record").operationId,
					"operationId",
				),
			),
		);
		for (const operationId of [
			"public-lifecycle-edit",
			"public-lifecycle-create-scene",
			"public-lifecycle-non-active-bookmark",
			"public-lifecycle-delete-clone",
			"public-lifecycle-bin-import",
			"public-lifecycle-bin-remove",
			"public-lifecycle-rename-project",
			"public-lifecycle-duplicate-project",
			"public-lifecycle-delete-project",
		]) {
			expect(lifecycleOperationIds.has(operationId)).toBe(true);
		}
		await third.callTool("opencut_stop_editor_worker", {});
	},
	20 * 60_000,
);

function affinity(identity: Record<string, unknown>) {
	return { bridgeProtocolVersion: 2, expectedConnectionIdentity: identity };
}

async function startMcp(options: {
	baseUrl: string;
	browserPath: string;
	bridgePort: number;
	profileDirectory: string;
	receiptDirectory: string;
	dropBrowserResponseOperationId?: string;
}): Promise<McpStdioHarness> {
	const harness = new McpStdioHarness(options);
	processes.push(harness);
	await harness.start();
	return harness;
}

async function waitForEditorDisconnection(
	harness: McpStdioHarness,
	timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await harness.callTool("opencut_connection_status", {});
		if (status.connected === false) return status;
		await delay(50);
	}
	throw new Error("timed out waiting for the faulted editor to disconnect");
}

class McpStdioHarness {
	private child: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private outputBuffer = "";
	private diagnostics = "";
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(
		private options: {
			baseUrl: string;
			browserPath: string;
			bridgePort: number;
			profileDirectory: string;
			receiptDirectory: string;
			dropBrowserResponseOperationId?: string;
		},
	) {}

	async start(): Promise<void> {
		this.child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
			cwd: import.meta.dir,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				OPENCUT_ENABLE_PROTOCOL_V1_MUTATION: undefined,
				OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
				OPENCUT_BRIDGE_PORT: String(this.options.bridgePort),
				OPENCUT_HEADLESS_EDITOR_URL: this.options.baseUrl,
				OPENCUT_HEADLESS_BROWSER_PATH: this.options.browserPath,
				OPENCUT_HEADLESS_PROFILE_DIR: this.options.profileDirectory,
				OPENCUT_HEADLESS_CONNECTION_TIMEOUT_MS: "90000",
				OPENCUT_RECEIPT_DIR: this.options.receiptDirectory,
				...(this.options.dropBrowserResponseOperationId
					? {
							OPENCUT_TEST_DROP_BROWSER_RESPONSE_OPERATION_ID:
								this.options.dropBrowserResponseOperationId,
						}
					: {}),
			},
		});
		this.child.stdout.on("data", (chunk) => this.readOutput(String(chunk)));
		this.child.stderr.on("data", (chunk) => {
			this.diagnostics += String(chunk);
		});
		this.child.once("exit", (code) => {
			for (const pending of this.pending.values()) {
				pending.reject(
					new Error(
						`MCP server exited with ${String(code)}: ${this.diagnostics.slice(-4000)}`,
					),
				);
			}
			this.pending.clear();
		});
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "opencut-public-integration", version: "1.0.0" },
		});
		this.notify("notifications/initialized", {});
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		timeoutMs = 90_000,
	): Promise<Record<string, unknown>> {
		const result = requireRecord(
			await this.request("tools/call", { name, arguments: args }, timeoutMs),
			`${name} result`,
		);
		if (result.isError === true) {
			throw new Error(`${name} failed: ${JSON.stringify(result)}`);
		}
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			(item) =>
				item &&
				typeof item === "object" &&
				(item as Record<string, unknown>).type === "text",
		) as Record<string, unknown> | undefined;
		if (typeof text?.text !== "string") {
			throw new Error(`${name} returned no JSON text content`);
		}
		return requireRecord(JSON.parse(text.text), `${name} payload`);
	}

	private async persistDiagnostics(
		childPid: number | undefined,
	): Promise<void> {
		const diagnosticsDirectory =
			process.env.OPENCUT_INTEGRATION_DIAGNOSTICS_DIR;
		if (!diagnosticsDirectory || !this.diagnostics) return;
		await mkdir(diagnosticsDirectory, { recursive: true });
		await appendFile(
			join(diagnosticsDirectory, `mcp-stderr-${process.pid}.log`),
			`
===== MCP server ${childPid ?? "?"} =====
${this.diagnostics}`,
		);
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = null;
		await this.persistDiagnostics(child.pid);
		const exited = new Promise<void>((resolve) => {
			if (hasExited(child)) resolve();
			else child.once("exit", () => resolve());
		});
		child.stdin.end();
		child.kill("SIGTERM");
		await Promise.race([exited, delay(5_000)]);
		if (!hasExited(child)) {
			child.kill("SIGKILL");
			await Promise.race([exited, delay(2_000)]);
		}
		if (!hasExited(child)) {
			throw new Error("MCP server process did not stop");
		}
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 30_000,
	): Promise<unknown> {
		const child = this.child;
		if (!child) throw new Error("MCP server is not running");
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`${method} timed out: ${this.diagnostics.slice(-4000)}`),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	private readOutput(chunk: string): void {
		this.outputBuffer += chunk;
		for (;;) {
			const newline = this.outputBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.outputBuffer.slice(0, newline).trim();
			this.outputBuffer = this.outputBuffer.slice(newline + 1);
			if (!line) continue;
			let message: Record<string, unknown>;
			try {
				message = requireRecord(JSON.parse(line), "JSON-RPC response");
			} catch (error) {
				this.diagnostics += `\nstdout parse error: ${String(error)}: ${line}`;
				continue;
			}
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(
					new Error(
						`JSON-RPC error for ${message.id}: ${JSON.stringify(message.error)}`,
					),
				);
			} else {
				pending.resolve(message.result);
			}
		}
	}
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function removeTemporaryDirectory(path: string): Promise<void> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			const code =
				error && typeof error === "object" && "code" in error
					? (error as { code?: string }).code
					: null;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
				throw error;
			}
			await delay(100);
		}
	}
	throw lastError;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate a bridge port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

async function createSyntheticVideo(
	outputPath: string,
	videoSource = "testsrc2=size=320x240:rate=30:duration=2",
): Promise<void> {
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
				videoSource,
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

async function extractRgba(path: string, seconds?: number): Promise<Buffer> {
	const ffmpeg =
		process.env.OPENCUT_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
	return new Promise((resolve, reject) => {
		const output: Buffer[] = [];
		let diagnostics = "";
		const child = spawn(
			ffmpeg,
			[
				"-v",
				"error",
				...(seconds === undefined ? [] : ["-ss", seconds.toFixed(6)]),
				"-i",
				path,
				"-frames:v",
				"1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgba",
				"pipe:1",
			],
			{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => {
			diagnostics += String(chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve(Buffer.concat(output));
			else reject(new Error(`ffmpeg RGBA extraction failed: ${diagnostics}`));
		});
	});
}

function rgbaComparisonMetrics(
	left: Buffer,
	right: Buffer,
): {
	meanAbsoluteError: number;
	psnrDb: number;
} {
	if (left.byteLength !== right.byteLength || left.byteLength === 0) {
		throw new Error("RGBA buffers must have equal nonzero lengths");
	}
	let absoluteTotal = 0;
	let squaredTotal = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		const delta = left[index]! - right[index]!;
		absoluteTotal += Math.abs(delta);
		squaredTotal += delta * delta;
	}
	const meanSquaredError = squaredTotal / left.byteLength;
	return {
		meanAbsoluteError: absoluteTotal / left.byteLength,
		psnrDb:
			meanSquaredError === 0
				? Number.POSITIVE_INFINITY
				: 10 * Math.log10((255 * 255) / meanSquaredError),
	};
}

async function extractPcmI16(
	path: string,
	sampleRate = PARITY_AUDIO_SAMPLE_RATE,
): Promise<Int16Array> {
	const ffmpeg =
		process.env.OPENCUT_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
	return new Promise((resolve, reject) => {
		const output: Buffer[] = [];
		let diagnostics = "";
		const child = spawn(
			ffmpeg,
			[
				"-v",
				"error",
				"-i",
				path,
				"-map",
				"0:a:0",
				"-ac",
				String(PARITY_AUDIO_CHANNELS),
				"-ar",
				String(sampleRate),
				"-f",
				"s16le",
				"-acodec",
				"pcm_s16le",
				"pipe:1",
			],
			{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => {
			diagnostics += String(chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`ffmpeg PCM extraction failed: ${diagnostics}`));
				return;
			}
			const bytes = Buffer.concat(output);
			if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
				reject(
					new Error("decoded PCM must contain complete non-empty i16 samples"),
				);
				return;
			}
			const copy = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			);
			resolve(new Int16Array(copy));
		});
	});
}

function pcmComparisonMetrics(
	before: Int16Array,
	after: Int16Array,
): { lagFrames: number; comparedFrames: number; meanAbsoluteError: number } {
	// The decoded export is aligned to the preview mix before the sample-wise
	// comparison. Every candidate lag compares the same central span of the
	// preview (one search window trimmed from each end) so shrinking overlap can
	// never lower the error, and ties within 2% resolve to the smallest lag: the
	// fixture tone is periodic, so equally good lags recur every period and the
	// smallest alias is the conservative report. The lag is bounded separately.
	const channels = PARITY_AUDIO_CHANNELS;
	const beforeFrames = Math.floor(before.length / channels);
	const afterFrames = Math.floor(after.length / channels);
	const maxLag = Math.round(
		PREVIEW_EXPORT_PCM_LAG_SEARCH_SECONDS * PARITY_AUDIO_SAMPLE_RATE,
	);
	const start = maxLag;
	const end = beforeFrames - maxLag;
	const comparedFrames = end - start;
	if (comparedFrames <= 0) throw new Error("audio comparison window is empty");
	const candidates: Array<{ lagFrames: number; meanAbsoluteError: number }> =
		[];
	for (let lag = -maxLag; lag <= maxLag; lag += 1) {
		if (start + lag < 0 || end + lag > afterFrames) continue;
		let absoluteTotal = 0;
		for (let frame = start; frame < end; frame += 1) {
			const beforeIndex = frame * channels;
			const afterIndex = (frame + lag) * channels;
			for (let channel = 0; channel < channels; channel += 1) {
				absoluteTotal += Math.abs(
					before[beforeIndex + channel]! - after[afterIndex + channel]!,
				);
			}
		}
		candidates.push({
			lagFrames: lag,
			meanAbsoluteError: absoluteTotal / (comparedFrames * channels),
		});
	}
	if (candidates.length === 0)
		throw new Error("decoded export does not cover the audio comparison span");
	const minimum = Math.min(
		...candidates.map((candidate) => candidate.meanAbsoluteError),
	);
	const best = candidates
		.filter((candidate) => candidate.meanAbsoluteError <= minimum * 1.02)
		.sort(
			(left, right) => Math.abs(left.lagFrames) - Math.abs(right.lagFrames),
		)[0]!;
	return { ...best, comparedFrames };
}

function assertMetricAtMost({
	label,
	actual,
	maximum,
}: {
	label: string;
	actual: number;
	maximum: number;
}): void {
	if (actual > maximum) {
		throw new Error(`${label} ${actual} exceeds tolerance ${maximum}`);
	}
}

function assertMetricAtLeast({
	label,
	actual,
	minimum,
}: {
	label: string;
	actual: number;
	minimum: number;
}): void {
	if (actual < minimum) {
		throw new Error(`${label} ${actual} is below tolerance ${minimum}`);
	}
}

function audioBoundaryWindow({
	position,
	centerSeconds,
	durationSeconds,
}: {
	position: string;
	centerSeconds: number;
	durationSeconds: number;
}): { startSeconds: number; endSeconds: number } {
	const windowSeconds = Math.min(
		AUDIO_BOUNDARY_WINDOW_SECONDS,
		durationSeconds,
	);
	if (position === "opening") {
		return { startSeconds: 0, endSeconds: windowSeconds };
	}
	if (position === "ending") {
		return {
			startSeconds: Math.max(0, durationSeconds - windowSeconds),
			endSeconds: durationSeconds,
		};
	}
	const startSeconds = Math.max(
		0,
		Math.min(
			durationSeconds - windowSeconds,
			centerSeconds - windowSeconds / 2,
		),
	);
	return { startSeconds, endSeconds: startSeconds + windowSeconds };
}

async function measureEbur128(
	path: string,
	range?: { startSeconds: number; durationSeconds: number },
): Promise<{
	integratedLufs: number;
	truePeakDbtp: number;
}> {
	const ffmpeg =
		process.env.OPENCUT_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
	return new Promise((resolve, reject) => {
		let diagnostics = "";
		const child = spawn(
			ffmpeg,
			[
				"-hide_banner",
				"-nostats",
				...(range ? ["-ss", range.startSeconds.toFixed(6)] : []),
				"-i",
				path,
				...(range ? ["-t", range.durationSeconds.toFixed(6)] : []),
				"-map",
				"0:a:0",
				"-filter_complex",
				"ebur128=peak=true",
				"-f",
				"null",
				"-",
			],
			{ windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
		);
		child.stderr.on("data", (chunk) => {
			diagnostics += String(chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`ffmpeg ebur128 analysis failed: ${diagnostics}`));
				return;
			}
			const summary = diagnostics.slice(diagnostics.lastIndexOf("Summary:"));
			const integrated =
				/Integrated loudness:\s*[\s\S]*?I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/i.exec(
					summary,
				)?.[1];
			const truePeak =
				/True peak:\s*[\s\S]*?Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/i.exec(
					summary,
				)?.[1];
			if (!integrated || !truePeak) {
				reject(new Error("ffmpeg ebur128 summary is incomplete"));
				return;
			}
			resolve({
				integratedLufs: Number(integrated),
				truePeakDbtp: Number(truePeak),
			});
		});
	});
}

function requireProjectContentHash(value: Record<string, unknown>): string {
	const identity = requireRecord(value.contentIdentity, "contentIdentity");
	if (identity.status !== "hashed") {
		throw new Error(`project content identity is ${String(identity.status)}`);
	}
	return requireString(
		requireRecord(identity.hash, "content hash").digest,
		"content digest",
	);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireRecords(
	value: unknown,
	name: string,
): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map((entry) => requireRecord(entry, name));
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number") throw new Error(`${name} must be a number`);
	return value;
}
