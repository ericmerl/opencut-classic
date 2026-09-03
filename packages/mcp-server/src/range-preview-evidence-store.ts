import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import {
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { stableSerialize } from "./matte-generation-data";
import { requireNativeFrameSchedule } from "./native-frame-schedule";
import type { PreviewRangeLimits } from "./range-preview-config";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024;
const RECORD_LOCK_WAIT_MS = 30_000;

export interface PreviewRangeFrameArtifact {
	ordinal: number;
	frameIndex: number;
	timelineTicks: number;
	outputTicks: number;
	durationTicks: number;
	path: string;
	bytes: number;
	pngSha256: string;
	pixelRgbaSha256: string;
	width: number;
	height: number;
	mimeType: "image/png";
}

export interface PreviewRangeAudioArtifact {
	path: string;
	bytes: number;
	sha256: string;
	mimeType: "audio/wav";
	codec: "pcm-s16le";
	sampleRate: 44_100;
	channels: 2;
	startTicks: number;
	endTicksExclusive: number;
}

export interface PreviewRangeRecord {
	schemaVersion: "opencut.preview-range-receipt.v1";
	receiptId: string;
	jobId: string;
	jobType: "preview-range";
	jobSchemaVersion: 1;
	operationId: string;
	inputFingerprint: string;
	semanticInputHash: string;
	capabilitySnapshotHash: string;
	createdAt: string;
	updatedAt: string;
	projectId: string;
	sceneId: string;
	revision: number;
	contentHash: string;
	writeVersion: number;
	saveReceiptId: string;
	includeAudio: boolean;
	canvasSize: { width: number; height: number };
	providerPolicy: {
		provider: "local-browser";
		networkAccess: "local-bridge-only";
	};
	rendererPolicy: {
		provider: "opencut-web-renderer";
		pipeline: "editor-native-exact-frame-sequence";
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
		phase: "preparing" | "rendering" | "audio" | "finalizing" | "complete";
		completed: number;
		total: number | null;
		heartbeatAt: string;
		cancellationRequestedAt: string | null;
		cancellationObservedAt: string | null;
		progressUnits: "frames";
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
	schedule: Record<string, unknown> | null;
	scheduleSha256: string | null;
	codec: {
		frames: "image/png";
		audio: "pcm-s16le" | null;
	};
	frames: PreviewRangeFrameArtifact[];
	audio: PreviewRangeAudioArtifact | null;
	evidence: Record<string, unknown> | null;
	operationLedgerId: string;
	checksum: string | null;
}

interface Session {
	operationId: string;
	expiresAt: number;
}

export class RangePreviewEvidenceStore {
	readonly directory: string;
	private readonly recordsDirectory: string;
	private readonly artifactsDirectory: string;
	private readonly locksDirectory: string;
	private readonly tickets = new Map<string, Session>();
	private locks = new Map<string, Promise<void>>();
	private uploadLocks = new Map<string, Promise<void>>();

	constructor(
		directory: string,
		private port: number,
		private limits: PreviewRangeLimits,
	) {
		this.directory = resolve(directory);
		this.recordsDirectory = join(this.directory, "records");
		this.artifactsDirectory = join(this.directory, "artifacts");
		this.locksDirectory = join(this.directory, "locks");
	}

	async readiness(): Promise<void> {
		await Promise.all([
			mkdir(this.recordsDirectory, { recursive: true }),
			mkdir(this.artifactsDirectory, { recursive: true }),
			mkdir(this.locksDirectory, { recursive: true }),
		]);
	}

	async createSession(input: {
		operationId: string;
		inputFingerprint: string;
		semanticInputHash: string;
		projectId: string;
		sceneId: string;
		revision: number;
		contentHash: string;
		writeVersion: number;
		saveReceiptId: string;
		includeAudio: boolean;
		canvasSize: { width: number; height: number };
		capabilitySnapshotHash: string;
		requiredWasmSha256: string | null;
	}): Promise<{ baseUrl: string; record: PreviewRangeRecord }> {
		await this.readiness();
		const record = await this.withRecordLock(input.operationId, async () => {
			const prior = await this.getByOperation(input.operationId);
			if (prior && prior.inputFingerprint !== input.inputFingerprint) {
				throw new Error(
					"operationId was already used for a different preview range",
				);
			}
			const now = new Date().toISOString();
			const candidate: PreviewRangeRecord = prior ?? {
				schemaVersion: "opencut.preview-range-receipt.v1",
				receiptId: `preview-range:${input.operationId}`,
				jobId: `preview-range:${input.operationId}`,
				jobType: "preview-range",
				jobSchemaVersion: 1,
				operationId: input.operationId,
				inputFingerprint: input.inputFingerprint,
				semanticInputHash: input.semanticInputHash,
				capabilitySnapshotHash: input.capabilitySnapshotHash,
				createdAt: now,
				updatedAt: now,
				projectId: input.projectId,
				sceneId: input.sceneId,
				revision: input.revision,
				contentHash: input.contentHash,
				writeVersion: input.writeVersion,
				saveReceiptId: input.saveReceiptId,
				includeAudio: input.includeAudio,
				canvasSize: input.canvasSize,
				providerPolicy: {
					provider: "local-browser",
					networkAccess: "local-bridge-only",
				},
				rendererPolicy: {
					provider: "opencut-web-renderer",
					pipeline: "editor-native-exact-frame-sequence",
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
					progressUnits: "frames",
					etaConfidence: "unavailable",
				},
				checkpoints: [{ name: "prepared", at: now, completed: 0, total: null }],
				logs: [
					{
						level: "info",
						at: now,
						message: "inline preview-range attempt prepared",
					},
				],
				diagnostics: [],
				provenance: null,
				attachmentTransaction: null,
				schedule: null,
				scheduleSha256: null,
				codec: {
					frames: "image/png",
					audio: input.includeAudio ? "pcm-s16le" : null,
				},
				frames: [],
				audio: null,
				evidence: null,
				operationLedgerId: input.operationId,
				checksum: null,
			};
			if (!prior) await this.write(candidate);
			return candidate;
		});
		this.removeExpiredTickets();
		const token = randomBytes(32).toString("hex");
		this.tickets.set(token, {
			operationId: input.operationId,
			expiresAt: Date.now() + 30 * 60_000,
		});
		return {
			baseUrl: `http://127.0.0.1:${this.port}/preview-range/${token}`,
			record,
		};
	}

	hasTicket(token: string): boolean {
		this.removeExpiredTickets();
		return this.tickets.has(token);
	}

	async status(token: string): Promise<Record<string, unknown>> {
		this.removeExpiredTickets();
		const session = this.tickets.get(token);
		if (!session) throw new Error("Expired or invalid preview-range ticket");
		await this.readiness();
		let record = await this.loadRecordMetadata(
			this.recordPath(session.operationId),
			session.operationId,
		);
		if (!record) throw new Error("Preview-range session disappeared");
		if (
			record.execution.cancellationRequestedAt !== null &&
			record.execution.cancellationObservedAt === null
		) {
			record = await this.mutate(
				session.operationId,
				(current) => {
					if (isTerminal(current.execution.status)) return current;
					const now = new Date().toISOString();
					return {
						...current,
						updatedAt: now,
						checkpoints: appendCheckpoint(
							current,
							"cancellation-observed",
							now,
						),
						execution: {
							...current.execution,
							cancellationObservedAt: now,
							heartbeatAt: now,
						},
					};
				},
				true,
			);
			if (!record) throw new Error("Preview-range session disappeared");
		}
		return progressResponse(record);
	}

	async receive(
		token: string,
		part: string,
		request: Request,
	): Promise<Record<string, unknown>> {
		this.removeExpiredTickets();
		const session = this.tickets.get(token);
		if (!session) throw new Error("Expired or invalid preview-range ticket");
		if (part === "manifest")
			return this.serializeUpload(session.operationId, () =>
				this.receiveManifest(session.operationId, request),
			);
		if (part === "audio")
			return this.serializeUpload(session.operationId, () =>
				this.receiveAudio(session.operationId, request),
			);
		const match = /^frames\/(\d+)$/.exec(part);
		if (match)
			return this.serializeUpload(session.operationId, () =>
				this.receiveFrame(session.operationId, Number(match[1]), request),
			);
		throw new Error("Unknown preview-range upload part");
	}

	async cancel(operationId: string): Promise<PreviewRangeRecord | null> {
		return this.mutate(operationId, (record) => {
			if (
				["cancelled", "succeeded", "failed"].includes(record.execution.status)
			)
				return record;
			const now = new Date().toISOString();
			return {
				...record,
				updatedAt: now,
				checkpoints: appendCheckpoint(record, "cancellation-requested", now),
				execution: {
					...record.execution,
					status: "cancelling",
					cancellationRequestedAt:
						record.execution.cancellationRequestedAt ?? now,
					heartbeatAt: now,
				},
			};
		});
	}

	async finalize(
		operationId: string,
		status: "rendered" | "cancelled",
		evidence: Record<string, unknown>,
	): Promise<PreviewRangeRecord> {
		return this.serializeUpload(operationId, async () => {
			const result = await this.mutate(operationId, (record) => {
				if (!record.schedule || record.execution.total === null)
					throw new Error("preview range has no verified frame schedule");
				const cancelled =
					status === "cancelled" ||
					record.execution.cancellationRequestedAt !== null;
				if (!cancelled && record.frames.length !== record.execution.total)
					throw new Error(
						"preview range completed without every scheduled frame",
					);
				if (!cancelled && record.includeAudio && !record.audio)
					throw new Error("preview range completed without requested audio");
				const now = new Date().toISOString();
				const next: PreviewRangeRecord = {
					...record,
					updatedAt: now,
					evidence,
					attempt: { ...record.attempt, completedAt: now },
					checkpoints: appendCheckpoint(record, "terminal", now),
					logs: [
						...record.logs,
						{
							level: "info",
							at: now,
							message: cancelled
								? "preview-range attempt cancelled"
								: "preview-range attempt succeeded",
						},
					],
					provenance: evidence,
					execution: {
						...record.execution,
						status: cancelled ? "cancelled" : "succeeded",
						phase: "complete",
						heartbeatAt: now,
						cancellationObservedAt: cancelled
							? (record.execution.cancellationObservedAt ?? now)
							: record.execution.cancellationObservedAt,
					},
					checksum: null,
				};
				return { ...next, checksum: checksum(next) };
			});
			if (!result)
				throw new Error("preview range record disappeared during finalization");
			this.dropTicketsFor(operationId);
			return result;
		});
	}

	async fail(operationId: string, reason: string): Promise<void> {
		await this.serializeUpload(operationId, async () => {
			await this.mutate(operationId, (record) => {
				const now = new Date().toISOString();
				const cancelled = record.execution.cancellationRequestedAt !== null;
				const next: PreviewRangeRecord = {
					...record,
					updatedAt: now,
					evidence: cancelled ? { cancellation: reason } : { failure: reason },
					attempt: { ...record.attempt, completedAt: now },
					checkpoints: appendCheckpoint(record, "terminal", now),
					logs: [
						...record.logs,
						{ level: cancelled ? "info" : "error", at: now, message: reason },
					],
					diagnostics: cancelled
						? record.diagnostics
						: [
								...record.diagnostics,
								{ code: "RENDER_FAILED", at: now, detail: reason },
							],
					execution: {
						...record.execution,
						status: cancelled ? "cancelled" : "failed",
						phase: "complete",
						heartbeatAt: now,
						cancellationObservedAt: cancelled
							? (record.execution.cancellationObservedAt ?? now)
							: record.execution.cancellationObservedAt,
					},
					checksum: null,
				};
				return { ...next, checksum: checksum(next) };
			});
			this.dropTicketsFor(operationId);
		});
	}

	async get(receiptId: string): Promise<PreviewRangeRecord | null> {
		if (!receiptId.startsWith("preview-range:")) return null;
		return this.getByOperation(receiptId.slice("preview-range:".length));
	}

	async getByOperation(
		operationId: string,
	): Promise<PreviewRangeRecord | null> {
		await this.readiness();
		const path = this.recordPath(operationId);
		return this.loadVerifiedRecord(path, operationId);
	}

	async list(input: { projectId?: string; sceneId?: string; limit: number }) {
		await this.readiness();
		const names = await readdir(this.recordsDirectory);
		const values: PreviewRangeRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const record = await this.loadVerifiedRecord(
				join(this.recordsDirectory, name),
			);
			if (!record) continue;
			if (input.projectId && record.projectId !== input.projectId) continue;
			if (input.sceneId && record.sceneId !== input.sceneId) continue;
			values.push(record);
		}
		values.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
		return {
			receipts: values.slice(0, input.limit),
			hasMore: values.length > input.limit,
		};
	}

	private async receiveManifest(operationId: string, request: Request) {
		const bytes = await readBoundedBody(request, MAX_MANIFEST_BYTES);
		if (bytes.byteLength === 0)
			throw new Error("preview range manifest size is invalid");
		const schedule = JSON.parse(new TextDecoder().decode(bytes)) as Record<
			string,
			unknown
		>;
		const { frameCount } = requireNativeFrameSchedule({
			schedule,
			limits: this.limits,
		});
		const scheduleSha256 = sha256(
			new TextEncoder().encode(stableSerialize(schedule)),
		);
		const record = await this.mutate(operationId, (current) => {
			assertAcceptingUploads(current);
			if (current.scheduleSha256 && current.scheduleSha256 !== scheduleSha256)
				throw new Error(
					"preview range schedule changed after rendering started",
				);
			const now = new Date().toISOString();
			return {
				...current,
				updatedAt: now,
				schedule,
				scheduleSha256,
				checkpoints: appendCheckpoint(current, "manifest-verified", now, {
					completed: 0,
					total: frameCount,
				}),
				execution: {
					...current.execution,
					phase: "rendering",
					total: frameCount,
					heartbeatAt: now,
				},
			};
		});
		return progressResponse(record!);
	}

	private async receiveFrame(
		operationId: string,
		ordinal: number,
		request: Request,
	) {
		const source = await this.getByOperation(operationId);
		if (!source) throw new Error("preview range record disappeared");
		if (!source.schedule || !Array.isArray(source.schedule.frames))
			throw new Error("preview range manifest must be uploaded before frames");
		const scheduled = source.schedule.frames[ordinal];
		if (!scheduled || typeof scheduled !== "object" || Array.isArray(scheduled))
			throw new Error("preview range frame ordinal is outside the schedule");
		const expectedPixels = source.canvasSize.width * source.canvasSize.height;
		const perFrameLimit = Math.min(
			MAX_FRAME_BYTES,
			expectedPixels * 4 + 1024 * 1024,
		);
		const bytes = await readBoundedBody(request, perFrameLimit);
		if (bytes.byteLength === 0)
			throw new Error("preview range frame size is invalid");
		const image = sharp(bytes, { limitInputPixels: expectedPixels });
		const metadata = await image.metadata();
		if (metadata.format !== "png" || !metadata.width || !metadata.height)
			throw new Error("preview range frame is not a decodable PNG");
		if (
			metadata.width !== source.canvasSize.width ||
			metadata.height !== source.canvasSize.height
		)
			throw new Error(
				"preview range frame dimensions do not match the request",
			);
		const rgba = await image.clone().ensureAlpha().raw().toBuffer();
		const pngSha256 = sha256(bytes);
		const pixelRgbaSha256 = sha256(rgba);
		const expectedPixelHash = request.headers.get(
			"x-opencut-pixel-rgba-sha256",
		);
		if (expectedPixelHash && expectedPixelHash !== pixelRgbaSha256)
			throw new Error("preview range browser/server pixel hashes disagree");
		const priorArtifact = source.frames.find(
			(frame) => frame.ordinal === ordinal,
		);
		if (priorArtifact) {
			if (
				priorArtifact.pngSha256 !== pngSha256 ||
				priorArtifact.pixelRgbaSha256 !== pixelRgbaSha256
			)
				throw new Error(
					"preview range frame ordinal was reused with different bytes",
				);
			return { ...progressResponse(source), artifact: priorArtifact };
		}
		if (artifactBytes(source) + bytes.byteLength > MAX_SESSION_BYTES)
			throw new Error("preview range session artifact quota exceeded");
		const artifactPath = await this.publishArtifact(bytes, pngSha256, ".png");
		const record = await this.mutate(operationId, (current) => {
			assertAcceptingUploads(current);
			if (!current.schedule || !Array.isArray(current.schedule.frames))
				throw new Error(
					"preview range manifest must be uploaded before frames",
				);
			if (
				metadata.width !== current.canvasSize.width ||
				metadata.height !== current.canvasSize.height
			)
				throw new Error(
					"preview range frame dimensions do not match the request",
				);
			const scheduled = current.schedule.frames[ordinal];
			if (
				!scheduled ||
				typeof scheduled !== "object" ||
				Array.isArray(scheduled)
			)
				throw new Error("preview range frame ordinal is outside the schedule");
			const item = scheduled as Record<string, unknown>;
			const artifact: PreviewRangeFrameArtifact = {
				ordinal,
				frameIndex: integerField(item, "frameIndex"),
				timelineTicks: integerField(item, "timelineTicks"),
				outputTicks: integerField(item, "outputTicks"),
				durationTicks: integerField(item, "durationTicks"),
				path: artifactPath,
				bytes: bytes.byteLength,
				pngSha256,
				pixelRgbaSha256,
				width: metadata.width!,
				height: metadata.height!,
				mimeType: "image/png",
			};
			const prior = current.frames.find((frame) => frame.ordinal === ordinal);
			if (prior && stableSerialize(prior) !== stableSerialize(artifact))
				throw new Error(
					"preview range frame ordinal was reused with different bytes",
				);
			const frames = prior
				? current.frames
				: [...current.frames, artifact].sort(
						(left, right) => left.ordinal - right.ordinal,
					);
			const now = new Date().toISOString();
			return {
				...current,
				updatedAt: now,
				frames,
				checkpoints: appendCheckpoint(current, `frame-${ordinal}`, now, {
					completed: frames.length,
					total: current.execution.total,
				}),
				execution: {
					...current.execution,
					completed: frames.length,
					heartbeatAt: now,
				},
			};
		});
		return {
			...progressResponse(record!),
			artifact: record!.frames.find((frame) => frame.ordinal === ordinal),
		};
	}

	private async receiveAudio(operationId: string, request: Request) {
		const source = await this.getByOperation(operationId);
		if (!source?.includeAudio || !source.schedule)
			throw new Error("preview range audio was not requested or scheduled");
		const bytes = await readBoundedBody(request, MAX_AUDIO_BYTES);
		if (bytes.byteLength < 44)
			throw new Error("preview range WAV size is invalid");
		const text = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
		if (!text.startsWith("RIFF") || text.slice(8, 12) !== "WAVE")
			throw new Error("preview range audio is not PCM WAV");
		const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (
			wav.getUint16(20, true) !== 1 ||
			wav.getUint16(22, true) !== 2 ||
			wav.getUint32(24, true) !== 44_100 ||
			wav.getUint16(34, true) !== 16 ||
			wav.getUint32(40, true) + 44 !== bytes.byteLength
		)
			throw new Error(
				"preview range audio must be stereo 44.1kHz PCM s16le WAV",
			);
		const startTicks = headerInteger(request, "x-opencut-audio-start-ticks");
		const endTicksExclusive = headerInteger(
			request,
			"x-opencut-audio-end-ticks-exclusive",
		);
		const sampleFrames = wav.getUint32(40, true) / 4;
		if (
			endTicksExclusive <= startTicks ||
			Math.abs(
				sampleFrames * 120_000 - (endTicksExclusive - startTicks) * 44_100,
			) > 120_000
		)
			throw new Error(
				"preview range WAV duration does not match its provenance",
			);
		const scheduledStart = integerField(source.schedule, "resolvedStartTicks");
		const scheduledEnd = integerField(
			source.schedule,
			"resolvedEndTicksExclusive",
		);
		if (startTicks !== scheduledStart || endTicksExclusive > scheduledEnd)
			throw new Error(
				"preview range audio provenance is outside the scheduled range",
			);
		const digest = sha256(bytes);
		if (source.audio) {
			if (source.audio.sha256 !== digest)
				throw new Error("preview range audio was reused with different bytes");
			return { ...progressResponse(source), audio: source.audio };
		}
		if (artifactBytes(source) + bytes.byteLength > MAX_SESSION_BYTES)
			throw new Error("preview range session artifact quota exceeded");
		const artifactPath = await this.publishArtifact(bytes, digest, ".wav");
		const record = await this.mutate(operationId, (current) => {
			assertAcceptingUploads(current);
			if (!current.includeAudio || !current.schedule)
				throw new Error("preview range audio was not requested or scheduled");
			const scheduledStart = integerField(
				current.schedule,
				"resolvedStartTicks",
			);
			const scheduledEnd = integerField(
				current.schedule,
				"resolvedEndTicksExclusive",
			);
			if (startTicks !== scheduledStart || endTicksExclusive > scheduledEnd)
				throw new Error(
					"preview range audio provenance is outside the scheduled range",
				);
			const now = new Date().toISOString();
			return {
				...current,
				updatedAt: now,
				audio: {
					path: artifactPath,
					bytes: bytes.byteLength,
					sha256: digest,
					mimeType: "audio/wav",
					codec: "pcm-s16le",
					sampleRate: 44_100,
					channels: 2,
					startTicks,
					endTicksExclusive,
				},
				checkpoints: appendCheckpoint(current, "audio-verified", now),
				execution: { ...current.execution, phase: "audio", heartbeatAt: now },
			};
		});
		return { ...progressResponse(record!), audio: record!.audio };
	}

	private async mutate(
		operationId: string,
		change: (record: PreviewRangeRecord) => PreviewRangeRecord,
		metadataOnly = false,
	): Promise<PreviewRangeRecord | null> {
		let result: PreviewRangeRecord | null = null;
		const prior = this.locks.get(operationId) ?? Promise.resolve();
		const next = prior
			.catch(() => undefined)
			.then(() =>
				this.withRecordLock(operationId, async () => {
					const current = metadataOnly
						? await this.loadRecordMetadata(
								this.recordPath(operationId),
								operationId,
							)
						: await this.getByOperation(operationId);
					if (!current) return;
					result = change(current);
					await this.write(result);
				}),
			);
		this.locks.set(operationId, next);
		try {
			await next;
			return result;
		} finally {
			if (this.locks.get(operationId) === next) this.locks.delete(operationId);
		}
	}

	private async serializeUpload<T>(
		operationId: string,
		action: () => Promise<T>,
	): Promise<T> {
		let result: T | undefined;
		const prior = this.uploadLocks.get(operationId) ?? Promise.resolve();
		const next = prior
			.catch(() => undefined)
			.then(async () => {
				result = await action();
			});
		this.uploadLocks.set(operationId, next);
		try {
			await next;
			return result as T;
		} finally {
			if (this.uploadLocks.get(operationId) === next)
				this.uploadLocks.delete(operationId);
		}
	}

	private async withRecordLock<T>(
		operationId: string,
		action: () => Promise<T>,
	): Promise<T> {
		const lockName = createHash("sha256").update(operationId).digest("hex");
		const lockPath = join(this.locksDirectory, `${lockName}.sqlite`);
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

	private async write(record: PreviewRangeRecord): Promise<void> {
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

	private async publishArtifact(
		bytes: Uint8Array,
		digest: string,
		suffix: string,
	): Promise<string> {
		const output = join(this.artifactsDirectory, `${digest}${suffix}`);
		if (await stat(output).catch(() => null)) return output;
		const temporary = join(
			this.artifactsDirectory,
			`.${digest}.${randomBytes(8).toString("hex")}.tmp`,
		);
		await writeFile(temporary, bytes, { flag: "wx" });
		try {
			await link(temporary, output).catch(
				async (error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				},
			);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
		return output;
	}

	private async verifyArtifacts(record: PreviewRangeRecord): Promise<void> {
		for (const frame of record.frames) {
			const bytes = await readFile(frame.path);
			if (sha256(bytes) !== frame.pngSha256 || bytes.byteLength !== frame.bytes)
				throw new Error("preview range frame artifact integrity check failed");
			const rgba = await sharp(bytes, {
				limitInputPixels: frame.width * frame.height,
			})
				.ensureAlpha()
				.raw()
				.toBuffer();
			if (sha256(rgba) !== frame.pixelRgbaSha256)
				throw new Error("preview range decoded pixels failed integrity check");
		}
		if (record.audio) {
			const bytes = await readFile(record.audio.path);
			if (
				sha256(bytes) !== record.audio.sha256 ||
				bytes.byteLength !== record.audio.bytes
			)
				throw new Error("preview range audio artifact integrity check failed");
		}
	}

	private async loadVerifiedRecord(
		path: string,
		expectedOperationId?: string,
	): Promise<PreviewRangeRecord | null> {
		const record = await this.loadRecordMetadata(path, expectedOperationId);
		if (!record) return null;
		await this.verifyArtifacts(record);
		return record;
	}

	private async loadRecordMetadata(
		path: string,
		expectedOperationId?: string,
	): Promise<PreviewRangeRecord | null> {
		const bytes = await readFile(path).catch(() => null);
		if (!bytes) return null;
		const record = JSON.parse(bytes.toString("utf8")) as PreviewRangeRecord;
		if (
			(typeof expectedOperationId === "string" &&
				record.operationId !== expectedOperationId) ||
			resolve(path) !== resolve(this.recordPath(record.operationId))
		)
			throw new Error("preview range record identity mismatch");
		if (isTerminal(record.execution.status)) {
			if (!record.checksum)
				throw new Error("preview range terminal receipt has no checksum");
			if (record.checksum !== checksum({ ...record, checksum: null }))
				throw new Error("preview range receipt checksum mismatch");
		}
		return record;
	}

	private recordPath(operationId: string): string {
		return join(
			this.recordsDirectory,
			`${sha256(new TextEncoder().encode(operationId))}.json`,
		);
	}

	private removeExpiredTickets(): void {
		const now = Date.now();
		for (const [token, session] of this.tickets)
			if (session.expiresAt <= now) this.tickets.delete(token);
	}

	private dropTicketsFor(operationId: string): void {
		for (const [token, session] of this.tickets)
			if (session.operationId === operationId) this.tickets.delete(token);
	}
}

function progressResponse(record: PreviewRangeRecord): Record<string, unknown> {
	return {
		status: "accepted",
		completed: record.execution.completed,
		total: record.execution.total,
		cancellationRequested: record.execution.cancellationRequestedAt !== null,
	};
}

function artifactBytes(record: PreviewRangeRecord): number {
	return (
		record.frames.reduce((total, frame) => total + frame.bytes, 0) +
		(record.audio?.bytes ?? 0)
	);
}

async function readBoundedBody(
	request: Request,
	maximumBytes: number,
): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximumBytes)
				throw new Error("preview range upload exceeds its byte limit");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function integerField(value: Record<string, unknown>, field: string): number {
	const result = value[field];
	if (!Number.isSafeInteger(result))
		throw new Error(`preview range ${field} is invalid`);
	return Number(result);
}

function headerInteger(request: Request, name: string): number {
	const value = Number(request.headers.get(name));
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`preview range ${name} header is invalid`);
	return value;
}

function isTerminal(
	status: PreviewRangeRecord["execution"]["status"],
): boolean {
	return (
		status === "cancelled" || status === "succeeded" || status === "failed"
	);
}

function assertAcceptingUploads(record: PreviewRangeRecord): void {
	if (isTerminal(record.execution.status))
		throw new Error("preview range is already terminal");
}

function isSqliteBusy(error: unknown): boolean {
	return (
		(error as { code?: unknown } | null)?.code === "SQLITE_BUSY" ||
		(error as { errno?: unknown } | null)?.errno === 5 ||
		(error instanceof Error && /database is locked/i.test(error.message))
	);
}

function appendCheckpoint(
	record: PreviewRangeRecord,
	name: string,
	at: string,
	override?: { completed: number; total: number | null },
): PreviewRangeRecord["checkpoints"] {
	return [
		...record.checkpoints,
		{
			name,
			at,
			completed: override?.completed ?? record.execution.completed,
			total: override?.total ?? record.execution.total,
		},
	];
}

function checksum(record: PreviewRangeRecord): string {
	return createHash("sha256").update(stableSerialize(record)).digest("hex");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
