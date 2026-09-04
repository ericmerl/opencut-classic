import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	link,
	mkdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	ExportReceiptRecord,
	ExportReceiptStore,
} from "./export-receipts";
import { stableSerialize } from "./matte-generation-data";

export const QC_CHECK_IDS = [
	"container",
	"codec",
	"dimensions",
	"fps",
	"duration",
	"full-decode",
	"streams",
	"hashes",
	"black-frames",
	"frozen-frames",
	"caption-clipping",
	"caption-safe-zones",
	"colour-properties",
	"audio-loudness",
	"audio-peak",
	"audio-clipping",
	"audio-channels",
	"audio-sample-rate",
	"audio-silence",
	"audio-sync",
	"watermark-inspection",
	"platform-limits",
] as const;

export type QcCheckId = (typeof QC_CHECK_IDS)[number];
export type QcOutcome = "pass" | "warn" | "fail";

export interface ExportQcPolicy {
	version: 1;
	checks?: Partial<
		Record<QcCheckId, { enabled?: boolean; severity?: "warn" | "fail" }>
	>;
	thresholds?: {
		fpsTolerance?: number;
		durationToleranceSeconds?: number;
		maxBlackDurationSeconds?: number;
		maxFrozenDurationSeconds?: number;
		maxCaptionOverflowPixels?: number;
		integratedLufsMin?: number;
		integratedLufsMax?: number;
		maxTruePeakDbtp?: number;
		clippingThresholdDbtp?: number;
		allowedChannels?: number[];
		minimumSampleRate?: number;
		maxSilenceDurationSeconds?: number;
		maxAvSyncOffsetSeconds?: number;
		maxAvDurationDeltaSeconds?: number;
	};
	platform?: {
		name: string;
		maxBytes?: number;
		maxDurationSeconds?: number;
		minWidth?: number;
		maxWidth?: number;
		minHeight?: number;
		maxHeight?: number;
		maxFps?: number;
		aspectRatio?: number;
		aspectRatioTolerance?: number;
	};
}

export interface QcEvidenceArtifact {
	path: string;
	bytes: number;
	sha256: string;
}

export interface ExportQcFinding {
	checkId: QcCheckId;
	status: QcOutcome;
	message: string;
	timestampSeconds: number | null;
	region: { left: number; top: number; width: number; height: number } | null;
	threshold: Record<string, unknown> | null;
	measured: Record<string, unknown> | null;
	evidenceArtifacts: QcEvidenceArtifact[];
}

export interface ExportQcReport {
	schemaVersion: 1;
	qcReceiptId: string;
	exportOperationId: string;
	evaluatedAt: string;
	overall: QcOutcome;
	policy: ExportQcPolicy;
	checks: Array<{
		checkId: QcCheckId;
		status: QcOutcome;
		findingCount: number;
	}>;
	findings: ExportQcFinding[];
}

interface StoredQcReport {
	schemaVersion: 1;
	operationId: string;
	fingerprint: string;
	report: ExportQcReport;
}

const DEFAULT_THRESHOLDS: Required<NonNullable<ExportQcPolicy["thresholds"]>> =
	{
		fpsTolerance: 0.02,
		durationToleranceSeconds: 0.1,
		maxBlackDurationSeconds: 0.5,
		maxFrozenDurationSeconds: 2,
		maxCaptionOverflowPixels: 0,
		integratedLufsMin: -24,
		integratedLufsMax: -12,
		maxTruePeakDbtp: -1,
		clippingThresholdDbtp: 0,
		allowedChannels: [1, 2],
		minimumSampleRate: 44_100,
		maxSilenceDurationSeconds: 2,
		maxAvSyncOffsetSeconds: 0.05,
		maxAvDurationDeltaSeconds: 0.1,
	};

const WARNING_CHECKS = new Set<QcCheckId>([
	"black-frames",
	"frozen-frames",
	"caption-clipping",
	"caption-safe-zones",
	"audio-loudness",
	"audio-peak",
	"audio-clipping",
	"audio-silence",
	"audio-sync",
	"watermark-inspection",
]);

export class ExportQcService {
	readonly directory: string;

	constructor(
		private receipts: ExportReceiptStore,
		directory = join(receipts.directory, "qc"),
	) {
		this.directory = resolve(directory);
	}

	async evaluate(input: {
		operationId: string;
		exportOperationId: string;
		policy: ExportQcPolicy;
	}): Promise<{
		status: "evaluated" | "replayed";
		reportPath: string;
		report: ExportQcReport;
	}> {
		const fingerprint = sha256(stableSerialize(input));
		const existing = await this.readStored(input.operationId);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new Error(
					"operationId was already used for a different QC request",
				);
			}
			await verifyReportEvidence(existing.report);
			return {
				status: "replayed",
				reportPath: this.reportPath(input.operationId),
				report: existing.report,
			};
		}
		const receipt = await this.receipts.get(input.exportOperationId);
		if (!receipt) {
			throw new Error(`export receipt not found: ${input.exportOperationId}`);
		}
		const report = await evaluateReceipt({
			qcReceiptId: input.operationId,
			receipt,
			policy: resolvePolicy(input.policy),
		});
		const stored: StoredQcReport = {
			schemaVersion: 1,
			operationId: input.operationId,
			fingerprint,
			report,
		};
		await mkdir(this.directory, { recursive: true });
		const path = this.reportPath(input.operationId);
		const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
		await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
			flag: "wx",
		});
		try {
			await link(temporary, path);
			await unlink(temporary);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			const raced = await this.readStored(input.operationId);
			if (!raced || raced.fingerprint !== fingerprint) throw error;
			return { status: "replayed", reportPath: path, report: raced.report };
		}
		return { status: "evaluated", reportPath: path, report };
	}

	async get(operationId: string): Promise<ExportQcReport | null> {
		return (await this.readStored(operationId))?.report ?? null;
	}

	async verify(operationId: string): Promise<ExportQcReport> {
		const report = await this.get(operationId);
		if (!report) throw new Error(`QC report not found: ${operationId}`);
		await verifyReportEvidence(report);
		return report;
	}

	reportPath(operationId: string): string {
		return join(this.directory, `${sha256(operationId)}.json`);
	}

	private async readStored(
		operationId: string,
	): Promise<StoredQcReport | null> {
		const path = this.reportPath(operationId);
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) return null;
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new Error(`durable QC report is invalid: ${path}`);
		}
		if (
			!isRecord(value) ||
			value.schemaVersion !== 1 ||
			value.operationId !== operationId ||
			typeof value.fingerprint !== "string" ||
			!isRecord(value.report)
		) {
			throw new Error("durable QC report is incomplete");
		}
		return value as unknown as StoredQcReport;
	}
}

async function evaluateReceipt({
	qcReceiptId,
	receipt,
	policy,
}: {
	qcReceiptId: string;
	receipt: ExportReceiptRecord;
	policy: ExportQcPolicy;
}): Promise<ExportQcReport> {
	const result = receipt.result;
	const validation = record(result.validation);
	const video = record(validation?.video);
	const audio = record(validation?.audio);
	const audioMeasurements = record(audio?.measurements);
	const resolved = record(result.resolvedRenderSpecification);
	const output = record(resolved?.output);
	const frameSchedule = record(resolved?.frameSchedule);
	const captions = record(resolved?.captions);
	const artifacts = readEvidenceArtifacts(validation);
	const thresholds = { ...DEFAULT_THRESHOLDS, ...policy.thresholds };
	const findings: ExportQcFinding[] = [];
	const emit = (
		checkId: QcCheckId,
		passed: boolean,
		message: string,
		details: Partial<
			Omit<ExportQcFinding, "checkId" | "status" | "message">
		> = {},
	) => {
		const configured = policy.checks?.[checkId];
		const enabled = configured?.enabled !== false;
		const status: QcOutcome =
			!enabled || passed
				? "pass"
				: (configured?.severity ??
					(WARNING_CHECKS.has(checkId) ? "warn" : "fail"));
		findings.push({
			checkId,
			status,
			message: enabled ? message : "check disabled by policy",
			timestampSeconds: details.timestampSeconds ?? null,
			region: details.region ?? null,
			threshold: details.threshold ?? null,
			measured: details.measured ?? null,
			evidenceArtifacts: details.evidenceArtifacts ?? [],
		});
	};

	const requestedContainer = string(result.container);
	const formatName = string(validation?.formatName);
	emit(
		"container",
		!!requestedContainer && containerMatches(requestedContainer, formatName),
		`container is ${formatName ?? "unavailable"}`,
		{ measured: { requested: requestedContainer, actual: formatName } },
	);
	const requestedCodec = string(output?.videoCodec);
	const actualCodec = string(video?.codec);
	emit(
		"codec",
		codecMatches(requestedCodec, actualCodec),
		`video codec is ${actualCodec ?? "unavailable"}`,
		{ measured: { requested: requestedCodec, actual: actualCodec } },
	);
	const expectedCanvas = record(resolved?.canvasSize);
	const width = number(video?.width);
	const height = number(video?.height);
	emit(
		"dimensions",
		width === number(expectedCanvas?.width) &&
			height === number(expectedCanvas?.height),
		`dimensions are ${width ?? "?"}x${height ?? "?"}`,
		{
			measured: {
				expectedWidth: number(expectedCanvas?.width),
				expectedHeight: number(expectedCanvas?.height),
				width,
				height,
			},
		},
	);
	const fps = number(video?.fps);
	const fpsNumerator = number(record(output?.fps)?.numerator);
	const fpsDenominator = number(record(output?.fps)?.denominator);
	const expectedFps =
		fpsNumerator !== null && fpsDenominator
			? fpsNumerator / fpsDenominator
			: null;
	emit(
		"fps",
		fps !== null &&
			expectedFps !== null &&
			Math.abs(fps - expectedFps) <= thresholds.fpsTolerance,
		`frame rate is ${fps ?? "unavailable"}`,
		{
			threshold: { tolerance: thresholds.fpsTolerance },
			measured: { expected: expectedFps, actual: fps },
		},
	);
	const duration = number(validation?.durationSeconds);
	const durationTicks = number(frameSchedule?.durationTicks);
	const expectedDuration =
		durationTicks !== null ? durationTicks / 120_000 : null;
	emit(
		"duration",
		duration !== null &&
			expectedDuration !== null &&
			Math.abs(duration - expectedDuration) <=
				thresholds.durationToleranceSeconds,
		`duration is ${duration ?? "unavailable"} seconds`,
		{
			threshold: { toleranceSeconds: thresholds.durationToleranceSeconds },
			measured: { expectedSeconds: expectedDuration, actualSeconds: duration },
		},
	);
	emit(
		"full-decode",
		validation?.fullDecode === true,
		validation?.fullDecode === true
			? "full decode completed"
			: "full decode evidence is unavailable",
	);
	const includeAudio = output?.includeAudio === true;
	emit(
		"streams",
		!!video && (audio?.present === true) === includeAudio,
		"requested video/audio stream presence matches readback",
		{
			measured: {
				videoPresent: !!video,
				audioRequested: includeAudio,
				audioPresent: audio?.present === true,
			},
		},
	);
	const outputArtifact = fileIdentityFromResult(result);
	const verifiedArtifacts = [outputArtifact, ...artifacts].filter(
		(value): value is QcEvidenceArtifact => value !== null,
	);
	let hashesMatch = verifiedArtifacts.length > 0;
	for (const artifact of verifiedArtifacts) {
		hashesMatch &&= await fileMatches(artifact);
	}
	emit(
		"hashes",
		hashesMatch,
		"output and evidence hashes match durable receipts",
		{
			measured: { verifiedFileCount: verifiedArtifacts.length },
			evidenceArtifacts: verifiedArtifacts,
		},
	);

	emitTemporalCheck({
		emit,
		checkId: "black-frames",
		segments: temporalSegments(video?.blackSegments),
		available: Array.isArray(video?.blackSegments),
		maximum: thresholds.maxBlackDurationSeconds,
		artifacts,
	});
	emitTemporalCheck({
		emit,
		checkId: "frozen-frames",
		segments: temporalSegments(video?.frozenSegments),
		available: Array.isArray(video?.frozenSegments),
		maximum: thresholds.maxFrozenDurationSeconds,
		artifacts,
	});

	const geometries = Array.isArray(captions?.geometry)
		? captions.geometry.filter(isRecord)
		: [];
	const resolvedCaptionElementIds = Array.isArray(captions?.elementIds)
		? captions.elementIds
		: null;
	const hasResolvedCaptionElements = resolvedCaptionElementIds !== null;
	const expectedCaptionCount = resolvedCaptionElementIds?.length ?? 0;
	const captionGeometryComplete =
		string(captions?.mode) === "off" ||
		(hasResolvedCaptionElements && geometries.length === expectedCaptionCount);
	const clipped = geometries.filter(
		(entry) => record(entry.geometry)?.clipped === true,
	);
	const clippingOverflow = clipped.map((entry) =>
		maximumOverflow(record(record(entry.geometry)?.overflow)),
	);
	emit(
		"caption-clipping",
		captionGeometryComplete &&
			clippingOverflow.every(
				(value) => value <= thresholds.maxCaptionOverflowPixels,
			),
		!captionGeometryComplete
			? "renderer-native caption geometry is incomplete"
			: clipped.length
				? `${clipped.length} caption layouts clip the canvas`
				: "captions fit the canvas",
		{
			timestampSeconds: firstCaptionTimestamp(clipped),
			region: firstCaptionRegion(clipped),
			threshold: { maxOverflowPixels: thresholds.maxCaptionOverflowPixels },
			measured: {
				expectedCaptionCount,
				measuredCaptionCount: geometries.length,
				clippedCount: clipped.length,
				maximumOverflowPixels: Math.max(0, ...clippingOverflow),
			},
			evidenceArtifacts: artifacts,
		},
	);
	const captionMode = string(captions?.mode);
	const unsafe = geometries.filter(
		(entry) => record(record(entry.geometry)?.safeZone)?.inside !== true,
	);
	const hasCaptionSafeZone =
		captionMode === "off" ||
		(captionGeometryComplete &&
			geometries.every((entry) => typeof entry.safeZoneId === "string"));
	emit(
		"caption-safe-zones",
		hasCaptionSafeZone && unsafe.length === 0,
		unsafe.length
			? `${unsafe.length} caption layouts leave their safe zone`
			: hasCaptionSafeZone
				? "captions fit their safe zones"
				: "captions do not declare a safe zone",
		{
			timestampSeconds: firstCaptionTimestamp(unsafe),
			region: firstCaptionRegion(unsafe),
			measured: {
				expectedCaptionCount,
				captionCount: geometries.length,
				unsafeCount: unsafe.length,
				hasDeclaredSafeZone: hasCaptionSafeZone,
			},
			evidenceArtifacts: artifacts,
		},
	);
	const colourValues = {
		primaries: string(video?.colorPrimaries),
		transfer: string(video?.colorTransfer),
		matrix: string(video?.colorMatrix),
		range: string(video?.colorRange),
		pixelFormat: string(video?.pixelFormat),
	};
	emit(
		"colour-properties",
		Object.values(colourValues).every((value) => value !== null),
		"colour and pixel-format properties are recorded",
		{ measured: colourValues },
	);

	if (!includeAudio) {
		for (const checkId of [
			"audio-loudness",
			"audio-peak",
			"audio-clipping",
			"audio-channels",
			"audio-sample-rate",
			"audio-silence",
			"audio-sync",
		] as const)
			emit(checkId, true, "audio was not requested", {
				measured: { applicable: false },
			});
	} else {
		const lufs = number(audioMeasurements?.integratedLufs);
		emit(
			"audio-loudness",
			lufs !== null &&
				lufs >= thresholds.integratedLufsMin &&
				lufs <= thresholds.integratedLufsMax,
			`integrated loudness is ${lufs ?? "unavailable"} LUFS`,
			{
				threshold: {
					minimumLufs: thresholds.integratedLufsMin,
					maximumLufs: thresholds.integratedLufsMax,
				},
				measured: { integratedLufs: lufs },
			},
		);
		const peak = number(audioMeasurements?.truePeakDbtp);
		emit(
			"audio-peak",
			peak !== null && peak <= thresholds.maxTruePeakDbtp,
			`true peak is ${peak ?? "unavailable"} dBTP`,
			{
				threshold: { maximumDbtp: thresholds.maxTruePeakDbtp },
				measured: { truePeakDbtp: peak },
			},
		);
		emit(
			"audio-clipping",
			peak !== null && peak < thresholds.clippingThresholdDbtp,
			peak !== null && peak >= thresholds.clippingThresholdDbtp
				? "audio reaches the clipping threshold"
				: "audio stays below the clipping threshold",
			{
				threshold: { clippingDbtp: thresholds.clippingThresholdDbtp },
				measured: { truePeakDbtp: peak },
			},
		);
		const channels = number(audio?.channels);
		emit(
			"audio-channels",
			channels !== null && thresholds.allowedChannels.includes(channels),
			`audio has ${channels ?? "unavailable"} channels`,
			{
				threshold: { allowedChannels: thresholds.allowedChannels },
				measured: { channels },
			},
		);
		const sampleRate = number(audio?.sampleRate);
		emit(
			"audio-sample-rate",
			sampleRate !== null && sampleRate >= thresholds.minimumSampleRate,
			`audio sample rate is ${sampleRate ?? "unavailable"} Hz`,
			{
				threshold: { minimumHz: thresholds.minimumSampleRate },
				measured: { sampleRate },
			},
		);
		emitTemporalCheck({
			emit,
			checkId: "audio-silence",
			segments: temporalSegments(audioMeasurements?.silenceSegments),
			available: Array.isArray(audioMeasurements?.silenceSegments),
			maximum: thresholds.maxSilenceDurationSeconds,
			artifacts: [],
		});
		const startOffset = number(audioMeasurements?.startOffsetSeconds);
		const durationDelta = number(audioMeasurements?.durationDeltaSeconds);
		emit(
			"audio-sync",
			startOffset !== null &&
				durationDelta !== null &&
				Math.abs(startOffset) <= thresholds.maxAvSyncOffsetSeconds &&
				Math.abs(durationDelta) <= thresholds.maxAvDurationDeltaSeconds,
			"audio/video timing offsets are within policy",
			{
				threshold: {
					maxStartOffsetSeconds: thresholds.maxAvSyncOffsetSeconds,
					maxDurationDeltaSeconds: thresholds.maxAvDurationDeltaSeconds,
				},
				measured: {
					startOffsetSeconds: startOffset,
					durationDeltaSeconds: durationDelta,
				},
			},
		);
	}

	emit(
		"watermark-inspection",
		receipt.inspection.status === "verified-clean",
		`watermark inspection is ${receipt.inspection.status}`,
		{
			measured: {
				status: receipt.inspection.status,
				reviewer: receipt.inspection.reviewer,
			},
		},
	);
	const platformViolations = platformLimitViolations({
		platform: policy.platform,
		bytes: outputArtifact?.bytes ?? null,
		duration,
		width,
		height,
		fps,
	});
	emit(
		"platform-limits",
		platformViolations.length === 0,
		platformViolations.length
			? platformViolations.join("; ")
			: "platform limits are satisfied",
		{
			threshold: policy.platform ?? null,
			measured: {
				bytes: outputArtifact?.bytes ?? null,
				durationSeconds: duration,
				width,
				height,
				fps,
			},
		},
	);

	const checks = QC_CHECK_IDS.map((checkId) => {
		const matching = findings.filter((finding) => finding.checkId === checkId);
		return {
			checkId,
			status: worstOutcome(matching.map((finding) => finding.status)),
			findingCount: matching.length,
		};
	});
	return {
		schemaVersion: 1,
		qcReceiptId,
		exportOperationId: receipt.operationId,
		evaluatedAt: new Date().toISOString(),
		overall: worstOutcome(checks.map((check) => check.status)),
		policy,
		checks,
		findings,
	};
}

function resolvePolicy(policy: ExportQcPolicy): ExportQcPolicy {
	return {
		version: 1,
		checks: Object.fromEntries(
			QC_CHECK_IDS.map((id) => [
				id,
				{
					enabled: policy.checks?.[id]?.enabled ?? true,
					severity:
						policy.checks?.[id]?.severity ??
						(WARNING_CHECKS.has(id) ? "warn" : "fail"),
				},
			]),
		) as ExportQcPolicy["checks"],
		thresholds: { ...DEFAULT_THRESHOLDS, ...policy.thresholds },
		...(policy.platform ? { platform: { ...policy.platform } } : {}),
	};
}

function emitTemporalCheck({
	emit,
	checkId,
	segments,
	available,
	maximum,
	artifacts,
}: {
	emit: (
		checkId: QcCheckId,
		passed: boolean,
		message: string,
		details?: Partial<Omit<ExportQcFinding, "checkId" | "status" | "message">>,
	) => void;
	checkId: "black-frames" | "frozen-frames" | "audio-silence";
	segments: Array<{
		startSeconds: number;
		endSeconds: number;
		durationSeconds: number;
	}>;
	available: boolean;
	maximum: number;
	artifacts: QcEvidenceArtifact[];
}) {
	const violating = segments.filter(
		(segment) => segment.durationSeconds > maximum,
	);
	emit(
		checkId,
		available && violating.length === 0,
		!available
			? "temporal signal analysis is unavailable"
			: violating.length
				? `${violating.length} temporal segments exceed policy`
				: "no temporal segments exceed policy",
		{
			timestampSeconds: violating[0]?.startSeconds ?? null,
			threshold: { maximumDurationSeconds: maximum },
			measured: {
				segmentCount: segments.length,
				maximumDurationSeconds: Math.max(
					0,
					...segments.map((segment) => segment.durationSeconds),
				),
			},
			evidenceArtifacts: artifacts,
		},
	);
}

async function verifyReportEvidence(report: ExportQcReport): Promise<void> {
	const artifacts = new Map<string, QcEvidenceArtifact>();
	for (const finding of report.findings) {
		for (const artifact of finding.evidenceArtifacts)
			artifacts.set(artifact.path, artifact);
	}
	for (const artifact of artifacts.values()) {
		if (!(await fileMatches(artifact)))
			throw new Error(`QC evidence changed or is missing: ${artifact.path}`);
	}
}

function readEvidenceArtifacts(
	validation: Record<string, unknown> | null,
): QcEvidenceArtifact[] {
	const values = [
		...(Array.isArray(validation?.frameSamples) ? validation.frameSamples : []),
		...(isRecord(validation?.coverFrame) ? [validation.coverFrame] : []),
	];
	return values
		.map(fileIdentity)
		.filter((value): value is QcEvidenceArtifact => value !== null);
}

function fileIdentityFromResult(
	result: Record<string, unknown>,
): QcEvidenceArtifact | null {
	return fileIdentity({
		path: result.outputPath,
		bytes: result.bytesWritten,
		sha256: result.sha256,
	});
}

function fileIdentity(value: unknown): QcEvidenceArtifact | null {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		typeof value.bytes !== "number" ||
		typeof value.sha256 !== "string"
	)
		return null;
	return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

async function fileMatches(identity: QcEvidenceArtifact): Promise<boolean> {
	const info = await stat(identity.path).catch(() => null);
	return (
		!!info?.isFile() &&
		info.size === identity.bytes &&
		(await hashFile(identity.path)) === identity.sha256
	);
}

function temporalSegments(value: unknown): Array<{
	startSeconds: number;
	endSeconds: number;
	durationSeconds: number;
}> {
	return Array.isArray(value)
		? value
				.filter(isRecord)
				.map((segment) => ({
					startSeconds: number(segment.startSeconds) ?? Number.NaN,
					endSeconds: number(segment.endSeconds) ?? Number.NaN,
					durationSeconds: number(segment.durationSeconds) ?? Number.NaN,
				}))
				.filter((segment) => Object.values(segment).every(Number.isFinite))
		: [];
}

function firstCaptionTimestamp(
	values: Record<string, unknown>[],
): number | null {
	const ticks = number(values[0]?.startTicks);
	return ticks === null ? null : ticks / 120_000;
}

function firstCaptionRegion(
	values: Record<string, unknown>[],
): ExportQcFinding["region"] {
	const visual = record(record(values[0]?.geometry)?.visual);
	const left = number(visual?.left);
	const top = number(visual?.top);
	const width = number(visual?.width);
	const height = number(visual?.height);
	return left === null || top === null || width === null || height === null
		? null
		: { left, top, width, height };
}

function maximumOverflow(value: Record<string, unknown> | null): number {
	return Math.max(
		0,
		...["left", "top", "right", "bottom"].map(
			(key) => number(value?.[key]) ?? 0,
		),
	);
}

function platformLimitViolations({
	platform,
	bytes,
	duration,
	width,
	height,
	fps,
}: {
	platform: ExportQcPolicy["platform"];
	bytes: number | null;
	duration: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
}): string[] {
	if (!platform) return [];
	const violations: string[] = [];
	if (
		platform.maxBytes !== undefined &&
		(bytes === null || bytes > platform.maxBytes)
	)
		violations.push("file size exceeds maximum");
	if (
		platform.maxDurationSeconds !== undefined &&
		(duration === null || duration > platform.maxDurationSeconds)
	)
		violations.push("duration exceeds maximum");
	if (
		platform.minWidth !== undefined &&
		(width === null || width < platform.minWidth)
	)
		violations.push("width is below minimum");
	if (
		platform.maxWidth !== undefined &&
		(width === null || width > platform.maxWidth)
	)
		violations.push("width exceeds maximum");
	if (
		platform.minHeight !== undefined &&
		(height === null || height < platform.minHeight)
	)
		violations.push("height is below minimum");
	if (
		platform.maxHeight !== undefined &&
		(height === null || height > platform.maxHeight)
	)
		violations.push("height exceeds maximum");
	if (platform.maxFps !== undefined && (fps === null || fps > platform.maxFps))
		violations.push("frame rate exceeds maximum");
	if (platform.aspectRatio !== undefined) {
		const ratio = width !== null && height ? width / height : null;
		if (
			ratio === null ||
			Math.abs(ratio - platform.aspectRatio) >
				(platform.aspectRatioTolerance ?? 0.01)
		)
			violations.push("aspect ratio is outside tolerance");
	}
	return violations;
}

function worstOutcome(values: QcOutcome[]): QcOutcome {
	return values.includes("fail")
		? "fail"
		: values.includes("warn")
			? "warn"
			: "pass";
}

function codecMatches(
	requested: string | null,
	actual: string | null,
): boolean {
	return requested === "avc"
		? actual === "h264" || actual === "avc"
		: requested === "vp9"
			? actual === "vp9"
			: false;
}

function containerMatches(
	requested: string | null,
	actual: string | null,
): boolean {
	if (!requested || !actual) return false;
	const names = new Set(actual.split(","));
	return requested === "mp4"
		? names.has("mp4") || names.has("mov")
		: requested === "webm" && names.has("webm");
}

function record(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
