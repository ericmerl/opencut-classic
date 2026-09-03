import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import {
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { stableSerialize } from "./matte-generation-data";
import {
	RangePreviewEvidenceStore,
	type PreviewRangeRecord,
} from "./range-preview-evidence-store";
import type { PreviewRangeLimits } from "./range-preview-config";

const RECORD_LOCK_WAIT_MS = 30_000;
const MAX_COMPARISON_ARTIFACT_BYTES = 256 * 1024 * 1024;

export interface ComparisonSourceBinding {
	revision: number;
	projectContentHash: string;
	projectionName: "opencut-project-content";
	projectionVersion: 1 | 2;
	writeVersion: number;
	saveReceiptOperationId: string;
	saveReceiptId: string;
}

export interface ComparisonFrameResult {
	metrics: Record<string, unknown>;
	regions: Record<string, unknown>;
	diffRgba: Uint8Array;
}

export interface ComparisonNativeAdapter {
	compareRgba(input: {
		before: Uint8Array;
		after: Uint8Array;
		width: number;
		height: number;
		pixelTolerance: number;
		maxRegions: number;
	}): ComparisonFrameResult;
	composeRgba(input: {
		before: Uint8Array;
		after: Uint8Array;
		width: number;
		height: number;
		mode: "side-by-side" | "wipe";
		wipePosition?: number;
	}): { width: number; height: number; rgba: Uint8Array };
	aggregateFrameMetrics(
		metrics: Array<Record<string, unknown>>,
	): Record<string, unknown>;
	comparePcmI16(input: {
		before: Int16Array;
		after: Int16Array;
		channels: number;
		sampleRate: number;
		sampleTolerance: number;
	}): Record<string, unknown>;
}

export interface ComparisonFrameArtifact {
	ordinal: number;
	frameIndex: number;
	timelineTicks: number;
	before: ImageArtifact;
	after: ImageArtifact;
	diff: ImageArtifact;
	comparison: ImageArtifact;
	metrics: Record<string, unknown>;
	regions: Record<string, unknown>;
}

export interface ImageArtifact {
	path: string;
	bytes: number;
	pngSha256: string;
	pixelRgbaSha256: string;
	width: number;
	height: number;
	mimeType: "image/png";
}

export interface ComparisonRecord {
	schemaVersion: "opencut.comparison-receipt.v1";
	receiptId: string;
	jobId: string;
	jobType: "comparison";
	jobSchemaVersion: 1;
	operationId: string;
	inputFingerprint: string;
	semanticInputHash: string;
	capabilitySnapshotHash: string;
	createdAt: string;
	updatedAt: string;
	projectId: string;
	sceneId: string;
	before: ComparisonSourceBinding;
	after: ComparisonSourceBinding;
	range: Record<string, unknown>;
	canvasSize: { width: number; height: number };
	normalization: {
		canvas: "none";
		color: "none";
		fonts: "exact";
		timing: "shared-schedule";
	};
	output: {
		frameFormat: "png";
		comparison: "side-by-side" | "wipe";
		wipePosition?: number;
		includeAudio: boolean;
	};
	pixelTolerance: number;
	audioSampleTolerance: number;
	providerPolicy: {
		provider: "local-browser";
		networkAccess: "local-bridge-only";
	};
	rendererPolicy: {
		provider: "opencut-web-renderer";
		pipeline: "editor-native-before-after-comparison";
		requiredWasmSha256: string | null;
	};
	priority: "normal";
	resourceClass: "local-compositor";
	concurrencyGroup: "opencut-compositor";
	scheduledFor: null;
	attemptPolicy: {
		maximumAttempts: 1;
		retryableErrorClasses: [];
		boundedBackoffMs: 0;
	};
	attempt: { number: 1; startedAt: string; completedAt: string | null };
	execution: {
		mode: "inline";
		status: "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
		phase:
			| "preparing"
			| "rendering-before"
			| "rendering-after"
			| "comparing"
			| "complete";
		completed: number;
		total: number | null;
		heartbeatAt: string;
		cancellationRequestedAt: string | null;
		cancellationObservedAt: string | null;
		progressUnits: "frame-pairs";
		etaConfidence: "unavailable";
	};
	checkpoints: Array<{
		name: string;
		at: string;
		completed: number;
		total: number | null;
	}>;
	logs: Array<{ level: "info" | "error"; at: string; message: string }>;
	diagnostics: Array<{ code: string; at: string; detail: string }>;
	provenance: Record<string, unknown> | null;
	attachmentTransaction: null;
	captures: {
		before: { operationId: string; receiptId: string };
		after: { operationId: string; receiptId: string };
	};
	schedule: Record<string, unknown> | null;
	scheduleSha256: string | null;
	frames: ComparisonFrameArtifact[];
	aggregateMetrics: Record<string, unknown> | null;
	audioMetrics: Record<string, unknown> | null;
	operationHistory: {
		beforeSaveOperationId: string;
		afterSaveOperationId: string;
		comparisonOperationId: string;
	};
	evidence: Record<string, unknown> | null;
	checksum: string | null;
}

export interface CreateComparisonSessionInput {
	operationId: string;
	inputFingerprint: string;
	semanticInputHash: string;
	capabilitySnapshotHash: string;
	requiredWasmSha256: string | null;
	projectId: string;
	sceneId: string;
	before: ComparisonSourceBinding;
	after: ComparisonSourceBinding;
	range: Record<string, unknown>;
	canvasSize: { width: number; height: number };
	normalization: ComparisonRecord["normalization"];
	output: ComparisonRecord["output"];
	pixelTolerance: number;
	audioSampleTolerance: number;
}

export class ComparisonEvidenceStore {
	readonly directory: string;
	readonly captures: RangePreviewEvidenceStore;
	private readonly recordsDirectory: string;
	private readonly artifactsDirectory: string;
	private readonly locksDirectory: string;
	private readonly locks = new Map<string, Promise<void>>();
	private readonly captureParents = new Map<
		string,
		{ operationId: string; side: "before" | "after" }
	>();

	constructor(
		directory: string,
		port: number,
		limits: PreviewRangeLimits,
		private native: ComparisonNativeAdapter,
	) {
		this.directory = resolve(directory);
		this.recordsDirectory = join(this.directory, "records");
		this.artifactsDirectory = join(this.directory, "artifacts");
		this.locksDirectory = join(this.directory, "locks");
		this.captures = new RangePreviewEvidenceStore(
			join(this.directory, "captures"),
			port,
			limits,
			"comparison-capture",
		);
	}

	async readiness(): Promise<void> {
		await Promise.all([
			mkdir(this.recordsDirectory, { recursive: true }),
			mkdir(this.artifactsDirectory, { recursive: true }),
			mkdir(this.locksDirectory, { recursive: true }),
			this.captures.readiness(),
		]);
	}

	async createSession(input: CreateComparisonSessionInput): Promise<{
		beforeBaseUrl: string;
		afterBaseUrl: string;
		record: ComparisonRecord;
	}> {
		await this.readiness();
		const record = await this.withRecordLock(input.operationId, async () => {
			const prior = await this.getByOperation(input.operationId);
			if (prior && prior.inputFingerprint !== input.inputFingerprint)
				throw new Error(
					"operationId was already used for a different comparison",
				);
			if (prior) return prior;
			const now = new Date().toISOString();
			const candidate: ComparisonRecord = {
				schemaVersion: "opencut.comparison-receipt.v1",
				receiptId: `comparison:${input.operationId}`,
				jobId: `comparison:${input.operationId}`,
				jobType: "comparison",
				jobSchemaVersion: 1,
				operationId: input.operationId,
				inputFingerprint: input.inputFingerprint,
				semanticInputHash: input.semanticInputHash,
				capabilitySnapshotHash: input.capabilitySnapshotHash,
				createdAt: now,
				updatedAt: now,
				projectId: input.projectId,
				sceneId: input.sceneId,
				before: input.before,
				after: input.after,
				range: input.range,
				canvasSize: input.canvasSize,
				normalization: input.normalization,
				output: input.output,
				pixelTolerance: input.pixelTolerance,
				audioSampleTolerance: input.audioSampleTolerance,
				providerPolicy: {
					provider: "local-browser",
					networkAccess: "local-bridge-only",
				},
				rendererPolicy: {
					provider: "opencut-web-renderer",
					pipeline: "editor-native-before-after-comparison",
					requiredWasmSha256: input.requiredWasmSha256,
				},
				priority: "normal",
				resourceClass: "local-compositor",
				concurrencyGroup: "opencut-compositor",
				scheduledFor: null,
				attemptPolicy: {
					maximumAttempts: 1,
					retryableErrorClasses: [],
					boundedBackoffMs: 0,
				},
				attempt: { number: 1, startedAt: now, completedAt: null },
				execution: {
					mode: "inline",
					status: "running",
					phase: "preparing",
					completed: 0,
					total: null,
					heartbeatAt: now,
					cancellationRequestedAt: null,
					cancellationObservedAt: null,
					progressUnits: "frame-pairs",
					etaConfidence: "unavailable",
				},
				checkpoints: [{ name: "prepared", at: now, completed: 0, total: null }],
				logs: [
					{
						level: "info",
						at: now,
						message: "inline comparison attempt prepared",
					},
				],
				diagnostics: [],
				provenance: null,
				attachmentTransaction: null,
				captures: {
					before: {
						operationId: childOperation(input.operationId, "before"),
						receiptId: `preview-range:${childOperation(input.operationId, "before")}`,
					},
					after: {
						operationId: childOperation(input.operationId, "after"),
						receiptId: `preview-range:${childOperation(input.operationId, "after")}`,
					},
				},
				schedule: null,
				scheduleSha256: null,
				frames: [],
				aggregateMetrics: null,
				audioMetrics: null,
				operationHistory: {
					beforeSaveOperationId: input.before.saveReceiptOperationId,
					afterSaveOperationId: input.after.saveReceiptOperationId,
					comparisonOperationId: input.operationId,
				},
				evidence: null,
				checksum: null,
			};
			await this.write(candidate);
			return candidate;
		});
		const [before, after] = await Promise.all([
			this.createCapture(record, "before"),
			this.createCapture(record, "after"),
		]);
		this.captureParents.set(captureToken(before.baseUrl), {
			operationId: record.operationId,
			side: "before",
		});
		this.captureParents.set(captureToken(after.baseUrl), {
			operationId: record.operationId,
			side: "after",
		});
		return {
			beforeBaseUrl: before.baseUrl,
			afterBaseUrl: after.baseUrl,
			record,
		};
	}

	hasCaptureTicket(token: string): boolean {
		return this.captures.hasTicket(token);
	}

	async statusCapture(token: string): Promise<Record<string, unknown>> {
		const progress = await this.captures.status(token);
		await this.syncParentProgress(token);
		return progress;
	}

	async receiveCapture(
		token: string,
		part: string,
		request: Request,
	): Promise<Record<string, unknown>> {
		const progress = await this.captures.receive(token, part, request);
		await this.syncParentProgress(token);
		return progress;
	}

	async finalize(
		operationId: string,
		status: "rendered" | "cancelled",
		evidence: Record<string, unknown>,
	): Promise<ComparisonRecord> {
		const parent = await this.getByOperation(operationId);
		if (!parent)
			throw new Error("comparison receipt disappeared before finalization");
		if (isTerminal(parent.execution.status)) return parent;
		const sideEvidence = requireSideEvidence(evidence);
		if (status === "cancelled" || parent.execution.cancellationRequestedAt) {
			await Promise.all([
				this.captures.fail(
					parent.captures.before.operationId,
					"comparison cancelled",
				),
				this.captures.fail(
					parent.captures.after.operationId,
					"comparison cancelled",
				),
			]);
			return this.finishCancelled(parent, evidence);
		}
		const [before, after] = await Promise.all([
			this.captures.finalize(
				parent.captures.before.operationId,
				status,
				sideEvidence.before,
			),
			this.captures.finalize(
				parent.captures.after.operationId,
				status,
				sideEvidence.after,
			),
		]);
		assertCapturePair(before, after);
		const frames: ComparisonFrameArtifact[] = [];
		for (let ordinal = 0; ordinal < before.frames.length; ordinal++) {
			const left = before.frames[ordinal]!;
			const right = after.frames[ordinal]!;
			const [leftBytes, rightBytes] = await Promise.all([
				readFile(left.path),
				readFile(right.path),
			]);
			const [leftRgba, rightRgba] = await Promise.all([
				decodeRgba(leftBytes, left.width, left.height),
				decodeRgba(rightBytes, right.width, right.height),
			]);
			const comparison = this.native.compareRgba({
				before: leftRgba,
				after: rightRgba,
				width: left.width,
				height: left.height,
				pixelTolerance: parent.pixelTolerance,
				maxRegions: 1_024,
			});
			const composite = this.native.composeRgba({
				before: leftRgba,
				after: rightRgba,
				width: left.width,
				height: left.height,
				mode: parent.output.comparison,
				wipePosition: parent.output.wipePosition,
			});
			const [diffArtifact, comparisonArtifact] = await Promise.all([
				this.publishRgba(
					operationId,
					comparison.diffRgba,
					left.width,
					left.height,
				),
				this.publishRgba(
					operationId,
					composite.rgba,
					composite.width,
					composite.height,
				),
			]);
			const priorBytes = frames.reduce(
				(total, frame) => total + frame.diff.bytes + frame.comparison.bytes,
				0,
			);
			if (
				priorBytes + diffArtifact.bytes + comparisonArtifact.bytes >
				MAX_COMPARISON_ARTIFACT_BYTES
			)
				throw new Error("comparison artifact quota exceeded");
			frames.push({
				ordinal,
				frameIndex: left.frameIndex,
				timelineTicks: left.timelineTicks,
				before: sourceImageArtifact(left),
				after: sourceImageArtifact(right),
				diff: diffArtifact,
				comparison: comparisonArtifact,
				metrics: comparison.metrics,
				regions: comparison.regions,
			});
		}
		const audioMetrics = parent.output.includeAudio
			? await this.compareAudio(before, after, parent.audioSampleTolerance)
			: null;
		const result = await this.mutate(operationId, (current) => {
			if (isTerminal(current.execution.status)) return current;
			const now = new Date().toISOString();
			if (
				current.execution.status === "cancelling" ||
				current.execution.cancellationRequestedAt !== null
			) {
				return cancelledRecord(current, evidence, now);
			}
			const next: ComparisonRecord = {
				...current,
				updatedAt: now,
				schedule: before.schedule,
				scheduleSha256: before.scheduleSha256,
				frames,
				aggregateMetrics: this.native.aggregateFrameMetrics(
					frames.map((frame) => frame.metrics),
				),
				audioMetrics,
				evidence,
				provenance: evidence,
				attempt: { ...current.attempt, completedAt: now },
				checkpoints: [
					...current.checkpoints,
					{
						name: "terminal",
						at: now,
						completed: frames.length,
						total: frames.length,
					},
				],
				logs: [
					...current.logs,
					{ level: "info", at: now, message: "comparison attempt succeeded" },
				],
				execution: {
					...current.execution,
					status: "succeeded",
					phase: "complete",
					completed: frames.length,
					total: frames.length,
					heartbeatAt: now,
				},
				checksum: null,
			};
			return withChecksum(next);
		});
		if (result.execution.status !== "succeeded") {
			await this.removeOperationArtifacts(operationId);
		}
		return result;
	}

	async cancel(operationId: string): Promise<ComparisonRecord | null> {
		const parent = await this.mutate(operationId, (current) => {
			if (isTerminal(current.execution.status)) return current;
			const now = new Date().toISOString();
			return {
				...current,
				updatedAt: now,
				checkpoints: [
					...current.checkpoints,
					{
						name: "cancellation-requested",
						at: now,
						completed: current.execution.completed,
						total: current.execution.total,
					},
				],
				execution: {
					...current.execution,
					status: "cancelling",
					cancellationRequestedAt:
						current.execution.cancellationRequestedAt ?? now,
					heartbeatAt: now,
				},
			};
		});
		if (parent)
			await Promise.all([
				this.captures.cancel(parent.captures.before.operationId),
				this.captures.cancel(parent.captures.after.operationId),
			]);
		return parent;
	}

	async fail(operationId: string, reason: string): Promise<void> {
		const parent = await this.getByOperation(operationId);
		if (!parent || isTerminal(parent.execution.status)) return;
		await Promise.all(
			[
				parent.captures.before.operationId,
				parent.captures.after.operationId,
			].map(async (childId) => {
				const child = await this.captures.getByOperation(childId);
				if (child && !isCaptureTerminal(child.execution.status))
					await this.captures.fail(childId, reason);
			}),
		);
		const result = await this.mutate(operationId, (current) => {
			if (isTerminal(current.execution.status)) return current;
			const now = new Date().toISOString();
			const cancelled = current.execution.cancellationRequestedAt !== null;
			return withChecksum({
				...current,
				updatedAt: now,
				attempt: { ...current.attempt, completedAt: now },
				logs: [
					...current.logs,
					{ level: cancelled ? "info" : "error", at: now, message: reason },
				],
				diagnostics: cancelled
					? current.diagnostics
					: [
							...current.diagnostics,
							{ code: "COMPARISON_FAILED", at: now, detail: reason },
						],
				execution: {
					...current.execution,
					status: cancelled ? "cancelled" : "failed",
					phase: "complete",
					heartbeatAt: now,
					cancellationObservedAt: cancelled
						? now
						: current.execution.cancellationObservedAt,
				},
				checksum: null,
			});
		});
		if (result.execution.status !== "succeeded") {
			await this.removeOperationArtifacts(operationId);
		}
	}

	get(receiptId: string): Promise<ComparisonRecord | null> {
		return receiptId.startsWith("comparison:")
			? this.getByOperation(receiptId.slice("comparison:".length))
			: Promise.resolve(null);
	}

	async getByOperation(operationId: string): Promise<ComparisonRecord | null> {
		await this.readiness();
		const bytes = await readFile(this.recordPath(operationId)).catch(
			() => null,
		);
		if (!bytes) return null;
		const record = JSON.parse(bytes.toString("utf8")) as ComparisonRecord;
		if (record.operationId !== operationId)
			throw new Error("comparison receipt identity mismatch");
		if (isTerminal(record.execution.status)) {
			if (
				!record.checksum ||
				record.checksum !== checksum({ ...record, checksum: null })
			)
				throw new Error("comparison receipt checksum mismatch");
			await this.verifyArtifacts(record);
			await this.verifyCaptureLinks(record);
		}
		return record;
	}

	async list(input: { projectId?: string; sceneId?: string; limit: number }) {
		await this.readiness();
		const records: ComparisonRecord[] = [];
		for (const name of await readdir(this.recordsDirectory)) {
			if (!name.endsWith(".json")) continue;
			const raw = JSON.parse(
				(await readFile(join(this.recordsDirectory, name))).toString("utf8"),
			) as ComparisonRecord;
			const record = await this.getByOperation(raw.operationId);
			if (!record) continue;
			if (input.projectId && record.projectId !== input.projectId) continue;
			if (input.sceneId && record.sceneId !== input.sceneId) continue;
			records.push(record);
		}
		records.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
		return {
			receipts: records.slice(0, input.limit),
			hasMore: records.length > input.limit,
		};
	}

	private createCapture(record: ComparisonRecord, side: "before" | "after") {
		const source = record[side];
		return this.captures.createSession({
			operationId: record.captures[side].operationId,
			operationLedgerId: record.operationId,
			inputFingerprint: sha256Text(
				stableSerialize({ parent: record.inputFingerprint, side }),
			),
			semanticInputHash: sha256Text(
				stableSerialize({ parent: record.semanticInputHash, side, source }),
			),
			projectId: record.projectId,
			sceneId: record.sceneId,
			revision: source.revision,
			contentHash: source.projectContentHash,
			writeVersion: source.writeVersion,
			saveReceiptId: source.saveReceiptId,
			includeAudio: record.output.includeAudio,
			canvasSize: record.canvasSize,
			capabilitySnapshotHash: record.capabilitySnapshotHash,
			requiredWasmSha256: record.rendererPolicy.requiredWasmSha256,
		});
	}

	private async syncParentProgress(token: string): Promise<void> {
		const binding = this.captureParents.get(token);
		if (!binding) return;
		const parent = await this.getByOperation(binding.operationId);
		if (!parent || isTerminal(parent.execution.status)) return;
		const [before, after] = await Promise.all([
			this.captures.getByOperation(parent.captures.before.operationId),
			this.captures.getByOperation(parent.captures.after.operationId),
		]);
		if (!before || !after) return;
		await this.mutate(parent.operationId, (current) => {
			if (isTerminal(current.execution.status)) return current;
			const total =
				before.execution.total !== null &&
				after.execution.total !== null &&
				before.execution.total === after.execution.total
					? before.execution.total
					: null;
			const completed = Math.min(
				before.execution.completed,
				after.execution.completed,
			);
			const sideComplete = (side: PreviewRangeRecord) =>
				side.execution.total !== null &&
				side.execution.completed >= side.execution.total &&
				(!current.output.includeAudio || side.audio !== null);
			const phase = !sideComplete(before)
				? "rendering-before"
				: !sideComplete(after)
					? "rendering-after"
					: "comparing";
			const now = new Date().toISOString();
			return {
				...current,
				updatedAt: now,
				execution: {
					...current.execution,
					phase,
					completed,
					total,
					heartbeatAt: now,
				},
			};
		});
	}

	private async compareAudio(
		before: PreviewRangeRecord,
		after: PreviewRangeRecord,
		sampleTolerance: number,
	) {
		if (!before.audio || !after.audio)
			throw new Error(
				"comparison completed without both requested audio artifacts",
			);
		if (
			before.audio.sampleRate !== after.audio.sampleRate ||
			before.audio.channels !== after.audio.channels ||
			before.audio.startTicks !== after.audio.startTicks ||
			before.audio.endTicksExclusive !== after.audio.endTicksExclusive
		)
			throw new Error(
				"comparison audio requires identical timing and PCM format",
			);
		const [left, right] = await Promise.all([
			readFile(before.audio.path),
			readFile(after.audio.path),
		]);
		return {
			changed: before.audio.sha256 !== after.audio.sha256,
			beforeSha256: before.audio.sha256,
			afterSha256: after.audio.sha256,
			metrics: this.native.comparePcmI16({
				before: pcmSamples(left),
				after: pcmSamples(right),
				channels: before.audio.channels,
				sampleRate: before.audio.sampleRate,
				sampleTolerance: sampleTolerance,
			}),
		};
	}

	private async finishCancelled(
		parent: ComparisonRecord,
		evidence: Record<string, unknown>,
	) {
		const result = await this.mutate(parent.operationId, (current) => {
			if (isTerminal(current.execution.status)) return current;
			const now = new Date().toISOString();
			return cancelledRecord(current, evidence, now);
		});
		if (result.execution.status !== "succeeded") {
			await this.removeOperationArtifacts(parent.operationId);
		}
		return result;
	}

	private async publishRgba(
		operationId: string,
		rgba: Uint8Array,
		width: number,
		height: number,
	): Promise<ImageArtifact> {
		if (rgba.byteLength !== width * height * 4)
			throw new Error("comparison native RGBA output has the wrong size");
		const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
			.png()
			.toBuffer();
		const pngSha256 = sha256(png);
		const pixelRgbaSha256 = sha256(rgba);
		const path = await this.publishArtifact(
			operationId,
			png,
			pngSha256,
			".png",
		);
		return {
			path,
			bytes: png.byteLength,
			pngSha256,
			pixelRgbaSha256,
			width,
			height,
			mimeType: "image/png",
		};
	}

	private async publishArtifact(
		operationId: string,
		bytes: Uint8Array,
		digest: string,
		suffix: string,
	) {
		const operationDirectory = this.operationArtifactsDirectory(operationId);
		await mkdir(operationDirectory, { recursive: true });
		const output = join(operationDirectory, `${digest}${suffix}`);
		if (await stat(output).catch(() => null)) return output;
		const temporary = join(
			operationDirectory,
			`.${digest}.${randomBytes(8).toString("hex")}.tmp`,
		);
		await writeFile(temporary, bytes, { flag: "wx" });
		try {
			await link(temporary, output).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
		return output;
	}

	private operationArtifactsDirectory(operationId: string): string {
		const target = resolve(this.artifactsDirectory, sha256Text(operationId));
		if (dirname(target) !== this.artifactsDirectory) {
			throw new Error("comparison artifact directory escaped its storage root");
		}
		return target;
	}

	private async removeOperationArtifacts(operationId: string): Promise<void> {
		await rm(this.operationArtifactsDirectory(operationId), {
			recursive: true,
			force: true,
		});
	}

	private async verifyArtifacts(record: ComparisonRecord) {
		for (const frame of record.frames) {
			for (const artifact of [frame.diff, frame.comparison]) {
				const bytes = await readFile(artifact.path);
				if (
					bytes.byteLength !== artifact.bytes ||
					sha256(bytes) !== artifact.pngSha256
				)
					throw new Error("comparison artifact integrity check failed");
				const rgba = await decodeRgba(bytes, artifact.width, artifact.height);
				if (sha256(rgba) !== artifact.pixelRgbaSha256)
					throw new Error("comparison decoded pixels failed integrity check");
			}
		}
	}

	private async verifyCaptureLinks(record: ComparisonRecord) {
		if (record.execution.status !== "succeeded") return;
		const [before, after] = await Promise.all([
			this.captures.getByOperation(record.captures.before.operationId),
			this.captures.getByOperation(record.captures.after.operationId),
		]);
		if (!before || !after)
			throw new Error("comparison source capture is missing");
		assertCapturePair(before, after);
		if (
			before.receiptId !== record.captures.before.receiptId ||
			after.receiptId !== record.captures.after.receiptId ||
			record.frames.length !== before.frames.length ||
			record.frames.some(
				(frame, index) =>
					stableSerialize(frame.before) !==
						stableSerialize(sourceImageArtifact(before.frames[index]!)) ||
					stableSerialize(frame.after) !==
						stableSerialize(sourceImageArtifact(after.frames[index]!)),
			)
		)
			throw new Error("comparison source capture linkage is invalid");
	}

	private async mutate(
		operationId: string,
		change: (record: ComparisonRecord) => ComparisonRecord,
	): Promise<ComparisonRecord> {
		let result: ComparisonRecord | null = null;
		const prior = this.locks.get(operationId) ?? Promise.resolve();
		const next = prior
			.catch(() => undefined)
			.then(() =>
				this.withRecordLock(operationId, async () => {
					const current = await this.getByOperation(operationId);
					if (!current) return;
					result = change(current);
					await this.write(result);
				}),
			);
		this.locks.set(operationId, next);
		try {
			await next;
			if (!result) throw new Error("comparison receipt disappeared");
			return result as ComparisonRecord;
		} finally {
			if (this.locks.get(operationId) === next) this.locks.delete(operationId);
		}
	}

	private async withRecordLock<T>(
		operationId: string,
		action: () => Promise<T>,
	): Promise<T> {
		const lockPath = join(
			this.locksDirectory,
			`${sha256Text(operationId)}.sqlite`,
		);
		const deadline = Date.now() + RECORD_LOCK_WAIT_MS;
		while (true) {
			const database = new Database(lockPath, { create: true, strict: true });
			try {
				database.exec("PRAGMA busy_timeout=0");
				database.exec("BEGIN IMMEDIATE");
			} catch (error) {
				database.close();
				if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
				await Bun.sleep(10 + Math.floor(Math.random() * 20));
				continue;
			}
			try {
				const result = await action();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					database.exec("ROLLBACK");
				} catch {}
				throw error;
			} finally {
				database.close();
			}
		}
	}

	private async write(record: ComparisonRecord) {
		const path = this.recordPath(record.operationId);
		const temporary = join(
			dirname(path),
			`.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
		);
		await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx" });
		try {
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}

	private recordPath(operationId: string) {
		return join(this.recordsDirectory, `${sha256Text(operationId)}.json`);
	}
}

function requireSideEvidence(value: Record<string, unknown>): {
	before: Record<string, unknown>;
	after: Record<string, unknown>;
} {
	if (!isRecord(value.before) || !isRecord(value.after))
		throw new Error("comparison browser evidence is missing side bindings");
	return { before: value.before, after: value.after };
}

function assertCapturePair(
	before: PreviewRangeRecord,
	after: PreviewRangeRecord,
) {
	if (
		before.execution.status !== "succeeded" ||
		after.execution.status !== "succeeded" ||
		!before.schedule ||
		!after.schedule ||
		before.scheduleSha256 !== after.scheduleSha256 ||
		stableSerialize(before.schedule) !== stableSerialize(after.schedule) ||
		before.frames.length !== after.frames.length
	)
		throw new Error(
			"comparison captures do not share one complete frame schedule",
		);
	for (let index = 0; index < before.frames.length; index++) {
		const left = before.frames[index]!;
		const right = after.frames[index]!;
		if (
			left.ordinal !== right.ordinal ||
			left.frameIndex !== right.frameIndex ||
			left.timelineTicks !== right.timelineTicks ||
			left.outputTicks !== right.outputTicks ||
			left.durationTicks !== right.durationTicks ||
			left.width !== right.width ||
			left.height !== right.height
		)
			throw new Error(
				"comparison frame pair timing or dimensions do not match",
			);
	}
}

function childOperation(operationId: string, side: "before" | "after") {
	return `${operationId}:comparison:${side}`;
}

function captureToken(baseUrl: string): string {
	const token = baseUrl.split("/").at(-1);
	if (!token) throw new Error("comparison capture URL has no ticket");
	return token;
}

function sourceImageArtifact(
	artifact: PreviewRangeRecord["frames"][number],
): ImageArtifact {
	return {
		path: artifact.path,
		bytes: artifact.bytes,
		pngSha256: artifact.pngSha256,
		pixelRgbaSha256: artifact.pixelRgbaSha256,
		width: artifact.width,
		height: artifact.height,
		mimeType: artifact.mimeType,
	};
}

async function decodeRgba(bytes: Uint8Array, width: number, height: number) {
	return new Uint8Array(
		await sharp(bytes, { limitInputPixels: width * height })
			.ensureAlpha()
			.raw()
			.toBuffer(),
	);
}

function pcmSamples(bytes: Uint8Array): Int16Array {
	if (bytes.byteLength < 44 || (bytes.byteLength - 44) % 2 !== 0)
		throw new Error("comparison PCM WAV bytes are invalid");
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset + 44,
		bytes.byteLength - 44,
	);
	const result = new Int16Array((bytes.byteLength - 44) / 2);
	for (let index = 0; index < result.length; index++)
		result[index] = view.getInt16(index * 2, true);
	return result;
}

function withChecksum(record: ComparisonRecord): ComparisonRecord {
	return { ...record, checksum: checksum({ ...record, checksum: null }) };
}

function checksum(record: ComparisonRecord) {
	return sha256Text(stableSerialize(record));
}

function sha256(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function cancelledRecord(
	record: ComparisonRecord,
	evidence: Record<string, unknown>,
	now: string,
): ComparisonRecord {
	return withChecksum({
		...record,
		updatedAt: now,
		evidence,
		provenance: evidence,
		attempt: { ...record.attempt, completedAt: now },
		checkpoints: [
			...record.checkpoints,
			{
				name: "terminal",
				at: now,
				completed: record.execution.completed,
				total: record.execution.total,
			},
		],
		logs: [
			...record.logs,
			{ level: "info", at: now, message: "comparison attempt cancelled" },
		],
		execution: {
			...record.execution,
			status: "cancelled",
			phase: "complete",
			heartbeatAt: now,
			cancellationObservedAt: now,
		},
		checksum: null,
	});
}

function isTerminal(status: ComparisonRecord["execution"]["status"]) {
	return (
		status === "cancelled" || status === "succeeded" || status === "failed"
	);
}

function isCaptureTerminal(status: PreviewRangeRecord["execution"]["status"]) {
	return (
		status === "cancelled" || status === "succeeded" || status === "failed"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSqliteBusy(error: unknown) {
	return (
		(error as { code?: unknown } | null)?.code === "SQLITE_BUSY" ||
		(error as { errno?: unknown } | null)?.errno === 5 ||
		(error instanceof Error && /database is locked/i.test(error.message))
	);
}
