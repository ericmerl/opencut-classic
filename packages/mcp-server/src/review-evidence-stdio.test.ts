import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportReceiptStore } from "./export-receipts";
import { Database } from "bun:sqlite";
import {
	ReviewEvidenceStore,
	type ReviewAnnotationRecord,
	type WatermarkInspectionRecord,
} from "./review-evidence-store";

const REVIEW_TOOL_NAMES = [
	"opencut_create_review_annotation",
	"opencut_get_review_annotation",
	"opencut_list_review_annotations",
	"opencut_update_review_annotation_status",
	"opencut_record_watermark_inspection",
	"opencut_get_watermark_inspection",
	"opencut_sign_off_export_review",
] as const;

let directory: string;
let harness: ReviewStdioHarness;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "opencut-review-stdio-"));
	harness = new ReviewStdioHarness(directory);
	await harness.start();
});

afterEach(async () => {
	await harness.close();
	await rm(directory, { recursive: true, force: true });
});

test("advertises the structured review tools through public MCP stdio", async () => {
	const response = requireRecord(await harness.request("tools/list", {}));
	const names = requireRecords(response.tools, "tools").map(
		(tool) => tool.name,
	);

	for (const name of REVIEW_TOOL_NAMES) expect(names).toContain(name);
});

test("creates and reads a human annotation tied to a hash-locked export", async () => {
	const exportEvidence = await seedExportReceipt(directory, "review-export-1");
	const created = await harness.callTool("opencut_create_review_annotation", {
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "review-server-1",
			editorInstanceId: "review-editor-1",
			editorSessionId: "review-session-1",
			connectionGeneration: 1,
		},
		operationId: "create-review-annotation-1",
		annotationId: "annotation-1",
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		target: {
			kind: "export",
			evidenceOperationId: "review-export-1",
			evidenceReceiptId: "review-export-1",
			artifactSha256: exportEvidence.outputSha256,
		},
		location: { kind: "time", ticks: 120_000 },
		region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
		category: "watermark",
		severity: "blocking",
		finding: { kind: "human" },
		reviewer: "reviewer-1",
		notes: "Logo visible in lower corner",
	});
	expect(created).toMatchObject({
		status: "annotation-created",
		annotation: {
			annotationId: "annotation-1",
			versionId: "annotation-1:1",
			version: 1,
			status: "open",
			finding: { kind: "human" },
			target: { artifactSha256: exportEvidence.outputSha256 },
		},
		operationDisposition: "applied-verified",
		operationRecord: {
			affectedObjects: [
				{
					objectType: "review-annotation",
					objectId: "annotation-1:1",
					action: "created",
				},
			],
			relationships: {
				evidenceOperationId: "review-export-1",
				annotationId: "annotation-1",
			},
		},
	});

	const found = await harness.callTool("opencut_get_review_annotation", {
		annotationId: "annotation-1",
	});
	expect(found).toMatchObject({
		status: "found",
		annotation: created.annotation,
	});
});

test("stably paginates immutable annotation versions across restart", async () => {
	const store = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await store.readiness();
	for (let index = 1; index <= 3; index += 1) {
		await store.appendAnnotation(annotationRecord(index));
	}
	store.close();

	const firstPage = await harness.callTool("opencut_list_review_annotations", {
		projectId: "project-1",
		limit: 2,
	});
	expect(
		requireRecords(firstPage.annotations, "annotations").map(versionId),
	).toEqual(["annotation-3:1", "annotation-2:1"]);
	expect(firstPage.nextCursor).toMatch(/^[1-9]\d*$/);

	await harness.close();
	harness = new ReviewStdioHarness(directory);
	await harness.start();
	const secondPage = await harness.callTool("opencut_list_review_annotations", {
		projectId: "project-1",
		limit: 2,
		cursor: firstPage.nextCursor,
	});
	expect(
		requireRecords(secondPage.annotations, "annotations").map(versionId),
	).toEqual(["annotation-1:1"]);
	expect(secondPage.nextCursor).toBeNull();
});

test("resolves an annotation by appending a linked immutable version", async () => {
	const exportEvidence = await seedExportReceipt(directory, "review-export-1");
	const store = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await store.readiness();
	const original = annotationRecord(1);
	await store.appendAnnotation({
		...original,
		target: {
			...original.target,
			artifactSha256: exportEvidence.outputSha256,
		},
	});
	store.close();

	const updated = await harness.callTool(
		"opencut_update_review_annotation_status",
		{
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: {
				serverInstanceId: "review-server-1",
				editorInstanceId: "review-editor-1",
				editorSessionId: "review-session-1",
				connectionGeneration: 1,
			},
			operationId: "resolve-review-annotation-1",
			annotationId: "annotation-1",
			expectedVersionId: "annotation-1:1",
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: "b".repeat(64),
			status: "resolved",
			reviewer: "reviewer-2",
			notes: "Removed in repair",
			resolutionOperationId: "repair-operation-1",
		},
	);
	expect(updated).toMatchObject({
		status: "annotation-status-updated",
		annotation: {
			annotationId: "annotation-1",
			versionId: "annotation-1:2",
			version: 2,
			previousVersionId: "annotation-1:1",
			status: "resolved",
			resolutionOperationId: "repair-operation-1",
		},
		operationRecord: {
			affectedObjects: [
				{
					objectType: "review-annotation",
					objectId: "annotation-1:2",
					action: "updated",
				},
			],
			relationships: {
				annotationId: "annotation-1",
				supersedesAnnotationVersionId: "annotation-1:1",
				resolutionOperationId: "repair-operation-1",
			},
		},
	});
	const firstVersion = await harness.callTool("opencut_get_review_annotation", {
		annotationId: "annotation-1",
		version: 1,
	});
	expect(firstVersion.annotation).toMatchObject({
		versionId: "annotation-1:1",
		status: "open",
		resolutionOperationId: null,
	});
});

test("records and reads complete human watermark evidence for final export bytes", async () => {
	const exportEvidence = await seedExportReceipt(
		directory,
		"watermark-export-1",
	);
	const cleanCorners = {
		"top-left": "clean",
		"top-right": "clean",
		"bottom-left": "clean",
		"bottom-right": "clean",
	};
	const recorded = await harness.callTool(
		"opencut_record_watermark_inspection",
		{
			bridgeProtocolVersion: 2,
			expectedConnectionIdentity: {
				serverInstanceId: "review-server-1",
				editorInstanceId: "review-editor-1",
				editorSessionId: "review-session-1",
				connectionGeneration: 1,
			},
			operationId: "record-watermark-inspection-1",
			inspectionId: "inspection-1",
			projectId: "project-1",
			sceneId: "scene-1",
			projectContentHash: "b".repeat(64),
			exportEvidence: {
				evidenceOperationId: "watermark-export-1",
				evidenceReceiptId: "watermark-export-1",
				artifactSha256: exportEvidence.outputSha256,
			},
			renderEvidence: [],
			policy: {
				schemaVersion: "opencut.watermark-sampling-policy.v1",
				fullFrameSamples: ["opening", "middle", "ending"],
				corners: ["top-left", "top-right", "bottom-left", "bottom-right"],
				requireFinalExportBytesInspection: true,
				requireHumanReview: true,
			},
			review: { kind: "human", reviewer: "reviewer-1" },
			samples: [
				{ position: "opening", fullFrame: "clean", corners: cleanCorners },
				{ position: "middle", fullFrame: "clean", corners: cleanCorners },
				{ position: "ending", fullFrame: "clean", corners: cleanCorners },
			],
			finalExportBytes: { status: "clean" },
			notes: "Inspected all samples and final exported bytes",
		},
	);
	expect(recorded).toMatchObject({
		status: "watermark-inspection-recorded",
		inspection: {
			inspectionId: "inspection-1",
			status: "verified-clean",
			policy: { requireHumanReview: true },
			finalExportBytes: {
				artifactSha256: exportEvidence.outputSha256,
				status: "clean",
			},
			samples: exportEvidence.sampleSha256s.map((artifactSha256, index) => ({
				position: ["opening", "middle", "ending"][index],
				artifactSha256,
			})),
		},
		operationRecord: {
			affectedObjects: [
				{
					objectType: "watermark-inspection",
					objectId: "inspection-1",
					action: "inspected",
				},
			],
		},
	});
	const found = await harness.callTool("opencut_get_watermark_inspection", {
		inspectionId: "inspection-1",
	});
	expect(found).toMatchObject({
		status: "found",
		inspection: recorded.inspection,
	});
});

test("rejects final sign-off when only automated watermark review exists", async () => {
	const exportEvidence = await seedExportReceipt(directory, "signoff-export-1");
	const store = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await store.readiness();
	await store.appendWatermarkInspection(
		watermarkInspectionRecord(exportEvidence, "automated"),
	);
	store.close();

	const result = await harness.callTool("opencut_sign_off_export_review", {
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "review-server-1",
			editorInstanceId: "review-editor-1",
			editorSessionId: "review-session-1",
			connectionGeneration: 1,
		},
		operationId: "signoff-automated-review",
		signoffId: "signoff-1",
		inspectionId: "inspection-1",
		exportOperationId: "signoff-export-1",
		outputSha256: exportEvidence.outputSha256,
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		reviewer: "reviewer-1",
		notes: "Attempted final review",
	});
	expect(result).toMatchObject({
		status: "rejected",
		code: "HUMAN_REVIEW_REQUIRED",
		operationDisposition: "not-applied",
	});
});

test("blocks unresolved findings and durably replays human final sign-off", async () => {
	const exportEvidence = await seedExportReceipt(directory, "signoff-export-1");
	const store = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await store.readiness();
	await store.appendWatermarkInspection(
		watermarkInspectionRecord(exportEvidence, "human"),
	);
	const blocking = annotationRecord(1);
	await store.appendAnnotation({
		...blocking,
		target: {
			...blocking.target,
			evidenceOperationId: "signoff-export-1",
			evidenceReceiptId: "signoff-export-1",
			artifactSha256: exportEvidence.outputSha256,
		},
		severity: "blocking",
	});
	store.close();
	const common = {
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "review-server-1",
			editorInstanceId: "review-editor-1",
			editorSessionId: "review-session-1",
			connectionGeneration: 1,
		},
		signoffId: "signoff-1",
		inspectionId: "inspection-1",
		exportOperationId: "signoff-export-1",
		outputSha256: exportEvidence.outputSha256,
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		reviewer: "reviewer-1",
		notes: "Human final review complete",
	};
	const blocked = await harness.callTool("opencut_sign_off_export_review", {
		...common,
		operationId: "signoff-blocked-review",
	});
	expect(blocked).toMatchObject({
		status: "rejected",
		code: "UNRESOLVED_BLOCKING_FINDINGS",
		operationDisposition: "not-applied",
	});

	const resolver = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await resolver.readiness();
	await resolver.appendAnnotation({
		...blocking,
		versionId: "annotation-1:2",
		version: 2,
		previousVersionId: "annotation-1:1",
		operationId: "seed-resolution-1",
		createdAt: "2026-09-04T12:20:00.000Z",
		target: {
			...blocking.target,
			evidenceOperationId: "signoff-export-1",
			evidenceReceiptId: "signoff-export-1",
			artifactSha256: exportEvidence.outputSha256,
		},
		severity: "blocking",
		status: "resolved",
		resolutionOperationId: "repair-operation-1",
	});
	resolver.close();
	const request = { ...common, operationId: "signoff-human-review" };
	const signed = await harness.callTool(
		"opencut_sign_off_export_review",
		request,
	);
	expect(signed).toMatchObject({
		status: "export-review-signed-off",
		signoff: {
			signoffId: "signoff-1",
			inspectionId: "inspection-1",
			exportOperationId: "signoff-export-1",
			reviewer: "reviewer-1",
			status: "signed-off",
		},
		operationRecord: {
			affectedObjects: [
				{
					objectType: "export-review-signoff",
					objectId: "signoff-1",
					action: "created",
				},
			],
			relationships: {
				inspectionId: "inspection-1",
				signoffId: "signoff-1",
				evidenceOperationId: "signoff-export-1",
			},
		},
	});

	await harness.close();
	harness = new ReviewStdioHarness(directory);
	await harness.start();
	const replayed = await harness.callTool(
		"opencut_sign_off_export_review",
		request,
	);
	expect(replayed).toMatchObject({
		durableOperationStatus: "replayed",
		signoff: signed.signoff,
	});
	const changed = await harness.callTool("opencut_sign_off_export_review", {
		...request,
		notes: "Changed after durable completion",
	});
	expect(changed).toMatchObject({
		status: "rejected",
		code: "OPERATION_ID_REUSED",
		operationId: "signoff-human-review",
	});
}, 30_000);

test("fails closed through stdio when durable review evidence is tampered", async () => {
	const store = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await store.readiness();
	await store.appendAnnotation(annotationRecord(1));
	store.close();
	const attacker = new Database(
		join(directory, "review-evidence", "review-evidence.sqlite"),
	);
	attacker.exec("DROP TRIGGER review_annotations_no_update");
	attacker
		.query(
			"UPDATE review_annotations SET record_json='{}' WHERE version_id='annotation-1:1'",
		)
		.run();
	attacker.close(false);

	const result = await harness.callTool(
		"opencut_get_review_annotation",
		{ annotationId: "annotation-1" },
		3_000,
	);
	expect(result).toMatchObject({
		status: "integrity-failed",
		code: "REVIEW_EVIDENCE_INTEGRITY_FAILED",
	});
	const listed = await harness.callTool(
		"opencut_list_review_annotations",
		{ projectId: "project-1", limit: 10 },
		3_000,
	);
	expect(listed).toMatchObject({
		status: "integrity-failed",
		code: "REVIEW_EVIDENCE_INTEGRITY_FAILED",
	});
});

test("fails closed through stdio when durable watermark evidence is tampered", async () => {
	const exportEvidence = await seedExportReceipt(directory, "signoff-export-1");
	const store = new ReviewEvidenceStore(join(directory, "review-evidence"));
	await store.readiness();
	await store.appendWatermarkInspection(
		watermarkInspectionRecord(exportEvidence, "human"),
	);
	store.close();
	const attacker = new Database(
		join(directory, "review-evidence", "review-evidence.sqlite"),
	);
	attacker.exec("DROP TRIGGER watermark_inspections_no_update");
	attacker
		.query(
			"UPDATE watermark_inspections SET record_json='{}' WHERE inspection_id='inspection-1'",
		)
		.run();
	attacker.close(false);

	const result = await harness.callTool(
		"opencut_get_watermark_inspection",
		{ inspectionId: "inspection-1" },
		3_000,
	);
	expect(result).toMatchObject({
		status: "integrity-failed",
		code: "REVIEW_EVIDENCE_INTEGRITY_FAILED",
	});
});

class ReviewStdioHarness {
	private child: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private outputBuffer = "";
	private diagnostics = "";
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(private readonly stateDirectory: string) {}

	async start(): Promise<void> {
		this.child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
			cwd: join(import.meta.dir, "../../.."),
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
				OPENCUT_BRIDGE_PORT: "32997",
				OPENCUT_RECEIPT_DIR: this.stateDirectory,
				OPENCUT_HEADLESS_EDITOR_URL: undefined,
				OPENCUT_AUDIO_CLEANER_COMMAND: undefined,
				OPENCUT_MATTE_PRODUCER_COMMAND: undefined,
				OPENCUT_SUBJECT_TRACKER_COMMAND: undefined,
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
						`MCP server exited with ${String(code)}: ${this.diagnostics.slice(-2_000)}`,
					),
				);
			}
			this.pending.clear();
		});
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "review-evidence-test", version: "1.0.0" },
		});
		this.notify("notifications/initialized", {});
	}

	request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 30_000,
	): Promise<unknown> {
		if (!this.child) throw new Error("MCP server is not running");
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`${method} timed out: ${this.diagnostics.slice(-2_000)}`),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject,
			});
			this.child!.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		timeoutMs = 30_000,
	): Promise<Record<string, unknown>> {
		const result = requireRecord(
			await this.request("tools/call", { name, arguments: args }, timeoutMs),
		);
		if (result.isError === true) {
			throw new Error(`${name} failed: ${JSON.stringify(result)}`);
		}
		const content = requireRecords(result.content, `${name} content`);
		const text = content.find((entry) => entry.type === "text");
		if (typeof text?.text !== "string") {
			throw new Error(`${name} returned no JSON text content`);
		}
		return requireRecord(JSON.parse(text.text));
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = null;
		const exited = new Promise<void>((resolve) => {
			if (child.exitCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		child.stdin.end();
		child.kill("SIGTERM");
		await Promise.race([
			exited,
			new Promise((resolve) => setTimeout(resolve, 2_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
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
			const message = requireRecord(JSON.parse(line));
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(JSON.stringify(message.error)));
			} else {
				pending.resolve(message.result);
			}
		}
	}
}

function requireRecords(
	value: unknown,
	name: string,
): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map((entry) => requireRecord(entry));
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object");
	}
	return value as Record<string, unknown>;
}

async function seedExportReceipt(
	stateDirectory: string,
	operationId: string,
): Promise<{ outputSha256: string; sampleSha256s: string[] }> {
	const outputPath = join(stateDirectory, `${operationId}.webm`);
	const outputBytes = Buffer.from("final exported bytes");
	await writeFile(outputPath, outputBytes);
	const outputSha256 = sha256(outputBytes);
	const frameSamples = [];
	const sampleSha256s: string[] = [];
	for (const [index, position] of ["opening", "middle", "ending"].entries()) {
		const path = join(stateDirectory, `${operationId}-${position}.png`);
		const bytes = Buffer.from(`${position} frame bytes`);
		await writeFile(path, bytes);
		const sampleSha256 = sha256(bytes);
		sampleSha256s.push(sampleSha256);
		frameSamples.push({
			position,
			frameIndex: index * 30,
			timeSeconds: index,
			path,
			bytes: bytes.byteLength,
			sha256: sampleSha256,
		});
	}
	const receipts = new ExportReceiptStore(stateDirectory);
	await receipts.write({
		schemaVersion: 1,
		operationId,
		fingerprint: "c".repeat(64),
		createdAt: "2026-09-04T12:00:00.000Z",
		result: {
			status: "exported",
			projectId: "project-1",
			sceneId: "scene-1",
			savedContentHash: "b".repeat(64),
			outputPath,
			bytesWritten: outputBytes.byteLength,
			sha256: outputSha256,
			validation: {
				status: "validated",
				frameSamples,
			},
		},
		inspection: {
			status: "pending",
			outputSha256,
			reviewer: null,
			notes: null,
			inspectedAt: null,
		},
	});
	return { outputSha256, sampleSha256s };
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function annotationRecord(index: number): ReviewAnnotationRecord {
	return {
		schemaVersion: "opencut.review-annotation.v1",
		annotationId: `annotation-${index}`,
		versionId: `annotation-${index}:1`,
		version: 1,
		previousVersionId: null,
		operationId: `seed-annotation-${index}`,
		projectId: "project-1",
		sceneId: "scene-1",
		createdAt: `2026-09-04T12:00:0${index}.000Z`,
		target: {
			kind: "export",
			evidenceOperationId: "review-export-1",
			evidenceReceiptId: "review-export-1",
			artifactSha256: "a".repeat(64),
			projectContentHash: "b".repeat(64),
		},
		location: { kind: "time", ticks: index * 120_000 },
		region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
		category: "watermark",
		severity: "warning",
		status: "open",
		finding: { kind: "human" },
		reviewer: "reviewer-1",
		notes: `Finding ${index}`,
		resolutionOperationId: null,
		replacementEvidence: null,
		bookmarkId: null,
	};
}

function watermarkInspectionRecord(
	exportEvidence: { outputSha256: string; sampleSha256s: string[] },
	reviewKind: "human" | "automated",
): WatermarkInspectionRecord {
	const corners = {
		"top-left": "clean",
		"top-right": "clean",
		"bottom-left": "clean",
		"bottom-right": "clean",
	} as const;
	return {
		schemaVersion: "opencut.watermark-inspection.v1",
		inspectionId: "inspection-1",
		operationId: "seed-inspection-1",
		projectId: "project-1",
		sceneId: "scene-1",
		projectContentHash: "b".repeat(64),
		createdAt: "2026-09-04T12:10:00.000Z",
		exportEvidence: {
			kind: "export",
			evidenceOperationId: "signoff-export-1",
			evidenceReceiptId: "signoff-export-1",
			artifactSha256: exportEvidence.outputSha256,
			projectContentHash: "b".repeat(64),
		},
		renderEvidence: [],
		policy: {
			schemaVersion: "opencut.watermark-sampling-policy.v1",
			fullFrameSamples: ["opening", "middle", "ending"],
			corners: ["top-left", "top-right", "bottom-left", "bottom-right"],
			requireFinalExportBytesInspection: true,
			requireHumanReview: true,
		},
		review:
			reviewKind === "human"
				? { kind: "human", reviewer: "reviewer-1" }
				: {
						kind: "automated",
						reviewer: "detector-service",
						detector: {
							provider: "local-detector",
							modelId: "watermark-net",
							modelVersion: "2026-09-04",
						},
					},
		samples: (["opening", "middle", "ending"] as const).map(
			(position, index) => ({
				position,
				artifactSha256: exportEvidence.sampleSha256s[index]!,
				fullFrame: "clean" as const,
				corners,
			}),
		),
		finalExportBytes: {
			artifactSha256: exportEvidence.outputSha256,
			status: "clean",
		},
		status: "verified-clean",
		notes: "Inspection complete",
	};
}

function versionId(value: Record<string, unknown>): unknown {
	return value.versionId;
}
