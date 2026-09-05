import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let harness: McpStdioHarness;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-media-foundation-"));
	harness = new McpStdioHarness(root, await availablePort());
	await harness.start();
});

afterEach(async () => {
	await harness.close();
	await rm(root, { recursive: true, force: true });
});

test("discovers the Rust-owned model capability catalog without provider execution", async () => {
	const listed = record(await harness.request("tools/list", {}));
	const names = records(listed.tools).map((tool) => tool.name);
	expect(names).toContain("opencut_get_media_capability_catalog");

	const result = await harness.call("opencut_get_media_capability_catalog", {});
	expect(result).toMatchObject({
		schemaVersion: "opencut.media-capability-catalog.v1",
		catalogVersion: 1,
		providerExecution: "forbidden",
		cost: { status: "not-incurred", amount: 0 },
	});
	const tasks = records(result.tasks);
	expect(tasks.map((task) => task.taskId)).toEqual([
		"opencut.task.subject-tracking.v1",
		"opencut.task.audio-cleanup.v1",
		"opencut.task.stem-separation.v1",
		"opencut.task.voice-activity-detection.v1",
	]);
	expect(tasks.map((task) => record(task.requirements).requestKind)).toEqual([
		"subject-tracking",
		"audio-cleanup",
		"stem-separation",
		"voice-activity-detection",
	]);
	for (const task of tasks) {
		expect(task).toMatchObject({
			requirements: {
				contractVersion: "opencut.provider-task-requirements.v1",
				durableJobType: "provider",
				sourceIdentity: ["assetId", "contentSha256", "bytes", "durationTicks"],
				provenanceIdentity: [
					"providerId",
					"adapterId",
					"adapterVersion",
					"modelId",
					"modelVersion",
					"modelSha256",
					"runtime",
					"device",
					"semanticInputHash",
				],
				deterministicCacheRequired: true,
				cpuFallbackRequired: true,
			},
			readiness: { status: "acquisition-required", canExecute: false },
			modelRequirement: {
				ownerApprovalRequired: false,
				requiredIdentity: ["modelId", "version", "sha256", "source", "license"],
			},
		});
		expect(record(task.requirements).semanticInputContract).toMatch(
			/^opencut\..+-request\.v1$/,
		);
		expect(record(record(task.requirements).optionRequirements).kind).toBe(
			record(task.requirements).requestKind,
		);
	}
	expect(record(tasks[0]!.modelRequirement).selectedModel).toMatchObject({
		modelId: "facebook/sam2.1-hiera-small",
		modelVersion: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
		artifact: {
			sha256:
				"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
		},
		license: { spdx: "Apache-2.0" },
	});
	const capabilities = await harness.call("opencut_capabilities", {});
	expect(capabilities.mediaFoundation).toMatchObject({
		schemaVersion: "opencut.media-capability-catalog.v1",
		providerExecution: "forbidden",
		tasks: tasks.map((task) => ({
			taskId: task.taskId,
			readiness: {
				status: "acquisition-required",
				canExecute: false,
			},
		})),
	});
	expect(capabilities.providers).toMatchObject({
		audioCleanup: {
			status: "unavailable",
			canExecute: false,
			artifact: {
				status: "missing",
				sha256:
					"147bfb866bac8264603546e035bf283370e716ed2f4b7412d308d2bcee88304f",
			},
			model: { modelId: "speechbrain/metricgan-plus-voicebank" },
		},
		subjectTracking: {
			status: "unavailable",
			canExecute: false,
			artifact: {
				status: "missing",
				sha256:
					"0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
			},
			model: { modelId: "facebook/sam2.1-hiera-small" },
		},
		stemSeparation: { status: "unavailable", canExecute: false },
		voiceActivityDetection: { status: "unavailable", canExecute: false },
	});
	const blockedCleanup = await harness.call("opencut_clean_audio", {
		...mutation("media-foundation:block-cleanup"),
		projectId: "project-1",
		expectedProjectContentHash: "f".repeat(64),
		expectedRevision: 0,
		trackId: "track-1",
		elementId: "clip-1",
	});
	expect(blockedCleanup).toMatchObject({
		status: "rejected",
		code: "APPROVED_MODEL_NOT_READY",
		providerExecution: "forbidden",
	});
	const blockedTracking = await harness.call("opencut_track_subject", {
		...mutation("media-foundation:block-tracking"),
		projectId: "project-1",
		expectedProjectContentHash: "f".repeat(64),
		expectedRevision: 0,
		trackId: "track-1",
		elementId: "clip-1",
	});
	expect(blockedTracking).toMatchObject({
		status: "rejected",
		code: "SUBJECT_TRACKER_NOT_READY",
		providerExecution: "forbidden",
	});
});

test("persists canonical reusable tracking data and reads it after restart", async () => {
	const created = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:create:tracking-1"),
		analysis: trackingAnalysis(),
	});
	expect(created).toMatchObject({
		status: "created",
		durableOperationStatus: "completed",
		analysis: {
			schemaVersion: "opencut.media-analysis.v1",
			analysisId: "tracking-1",
			taskId: "opencut.task.subject-tracking.v1",
			provenance: {
				origin: "external-result",
				approvalStatus: "unverified",
				adapterVersion: "1.0.0",
				model: {
					id: "fixture-tracker",
					version: "1.0.0",
					sha256: "c".repeat(64),
					license: "fixture-only",
					source: "https://example.invalid/fixture-tracker",
				},
				lifecycleEvents: [
					{ sequence: 1, attempt: 1, kind: "submitted" },
					{ sequence: 2, attempt: 1, kind: "started" },
					{ sequence: 3, attempt: 1, kind: "progress" },
					{ sequence: 4, attempt: 2, kind: "retried" },
					{ sequence: 5, attempt: 2, kind: "started" },
					{ sequence: 6, attempt: 2, kind: "progress" },
					{ sequence: 7, attempt: 2, kind: "completed" },
				],
				cost: { status: "not-incurred", amount: 0 },
				outputArtifacts: [],
			},
			payload: {
				kind: "subject-tracking",
				subjects: [
					{
						subjectId: "person-1",
						samples: [
							{ sampleId: "sample-start", sourceTimeTicks: 0 },
							{ sampleId: "sample-end", sourceTimeTicks: 240_000 },
						],
						corrections: [
							{
								correctionId: "correction-middle",
								sourceTimeTicks: 120_000,
							},
						],
					},
				],
			},
		},
	});
	const analysis = record(created.analysis);
	expect(analysis.semanticInputHash).toBe(
		"f7d05b3e312172f6e244b6a155dce8665f2634a4b76c72af22a2fbaa1569bb3e",
	);
	expect(analysis.cacheIdentity).toBe(
		"acca8b9ed6ea01415f7adce59bb20e0a1467cfb1362824085af98e9759918c88",
	);
	expect(analysis.contentHash).toMatch(/^[a-f0-9]{64}$/);

	const sameInputs = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:create:tracking-2"),
		analysis: { ...trackingAnalysis(), analysisId: "tracking-2" },
	});
	const secondAnalysis = record(sameInputs.analysis);
	expect(secondAnalysis.semanticInputHash).toBe(analysis.semanticInputHash);
	expect(secondAnalysis.cacheIdentity).toBe(analysis.cacheIdentity);
	expect(secondAnalysis.contentHash).not.toBe(analysis.contentHash);

	const alternateExecution = trackingAnalysis();
	alternateExecution.analysisId = "tracking-3";
	alternateExecution.provenance.runtime = "fixture-runtime-v2";
	alternateExecution.provenance.device = "cuda";
	const alternateExecutionResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:create:tracking-3"),
			analysis: alternateExecution,
		},
	);
	expect(record(alternateExecutionResult.analysis).semanticInputHash).toBe(
		analysis.semanticInputHash,
	);
	expect(record(alternateExecutionResult.analysis).cacheIdentity).not.toBe(
		analysis.cacheIdentity,
	);

	const read = await harness.call("opencut_get_media_analysis", {
		analysisId: "tracking-1",
	});
	expect(read).toEqual({
		status: "found",
		analysis: created.analysis,
		serverInstanceId: read.serverInstanceId,
		bridgeProtocolVersion: null,
		connectionIdentity: null,
	});

	await harness.close();
	harness = new McpStdioHarness(root, await availablePort());
	await harness.start();
	const restarted = await harness.call("opencut_get_media_analysis", {
		analysisId: "tracking-1",
	});
	expect(restarted.analysis).toEqual(created.analysis);

	const replayed = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:create:tracking-1"),
		analysis: trackingAnalysis(),
	});
	expect(replayed).toMatchObject({
		status: "created",
		durableOperationStatus: "replayed",
		analysis: created.analysis,
	});
});

test("serializes concurrent creates for one durable analysis identity", async () => {
	const analysis = { ...trackingAnalysis(), analysisId: "tracking-concurrent" };
	const [left, right] = await Promise.all([
		harness.call("opencut_create_media_analysis", {
			...mutation("media-analysis:create:concurrent-left"),
			analysis,
		}),
		harness.call("opencut_create_media_analysis", {
			...mutation("media-analysis:create:concurrent-right"),
			analysis,
		}),
	]);
	const results = [left, right].sort((a, b) =>
		String(a.status).localeCompare(String(b.status)),
	);
	expect(results.map((result) => result.status)).toEqual([
		"created",
		"rejected",
	]);
	expect(results[1]).toMatchObject({
		code: "MEDIA_ANALYSIS_ID_REUSED",
		operationDisposition: "not-applied",
	});
	const stored = await harness.call("opencut_get_media_analysis", {
		analysisId: "tracking-concurrent",
	});
	expect(stored).toMatchObject({ status: "found" });
});

test("deterministically plans ordered audio post and VAD-derived ducking", async () => {
	const created = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:create:vad-1"),
		analysis: voiceActivityAnalysis(),
	});
	const analysis = record(created.analysis);
	const request = {
		analysisId: "vad-1",
		expectedAnalysisContentHash: analysis.contentHash,
		currentSource: {
			assetId: "asset-audio-1",
			contentSha256: "d".repeat(64),
			durationTicks: 240_000,
		},
		graph: audioGraph(),
		ducking: {
			targetTrackId: "music-track",
			reductionDb: -12,
			attackTicks: 12_000,
			releaseTicks: 24_000,
		},
	};
	const first = await harness.call("opencut_plan_audio_post", request);
	expect(first).toMatchObject({
		status: "planned",
		providerExecution: "forbidden",
		plan: {
			schemaVersion: "opencut.audio-post-plan.v1",
			analysisId: "vad-1",
			analysisContentHash: analysis.contentHash,
			graph: {
				schemaVersion: "opencut.audio-processing-graph.v1",
				stages: [
					{ scope: { kind: "clip", clipId: "dialogue-clip" } },
					{ scope: { kind: "track", trackId: "dialogue-track" } },
					{ scope: { kind: "master" } },
				],
			},
			ducking: {
				targetTrackId: "music-track",
				overlapPolicy: "merge",
				envelopes: [
					{
						sourceRangeIds: ["speech-1"],
						startTicks: 48_000,
						speechStartTicks: 60_000,
						speechEndTicks: 120_000,
						endTicks: 144_000,
						gainDb: -12,
					},
					{
						sourceRangeIds: ["speech-2"],
						startTicks: 168_000,
						speechStartTicks: 180_000,
						speechEndTicks: 216_000,
						endTicks: 240_000,
						gainDb: -12,
					},
				],
			},
		},
	});
	const plan = record(first.plan);
	expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);

	const reversed = audioGraph();
	reversed.stages.reverse();
	for (const stage of reversed.stages) stage.processors.reverse();
	const second = await harness.call("opencut_plan_audio_post", {
		...request,
		graph: reversed,
	});
	expect(record(second.plan).planHash).toBe(plan.planHash);
	expect(record(second.plan).graph).toEqual(plan.graph);

	const merged = await harness.call("opencut_plan_audio_post", {
		...request,
		ducking: {
			...request.ducking,
			attackTicks: 60_000,
			releaseTicks: 60_000,
		},
	});
	expect(record(record(merged.plan).ducking).envelopes).toEqual([
		{
			sourceRangeIds: ["speech-1", "speech-2"],
			startTicks: 0,
			speechStartTicks: 60_000,
			speechEndTicks: 216_000,
			endTicks: 240_000,
			gainDb: -12,
			confidence: 0.88,
		},
	]);
});

test("fails closed for unknown tasks, malformed results, incompatible attachments, and stale identity", async () => {
	const unknown = await harness.call("opencut_get_media_capability_catalog", {
		taskIds: ["opencut.task.unknown.v1"],
	});
	expect(unknown).toMatchObject({
		status: "rejected",
		code: "UNKNOWN_MEDIA_TASK_ID",
	});

	const malformedBox = trackingAnalysis();
	malformedBox.payload.subjects[0]!.samples[0]!.box.width = 2;
	const malformed = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:reject:malformed-box"),
		analysis: { ...malformedBox, analysisId: "tracking-malformed" },
	});
	expect(malformed).toMatchObject({
		status: "rejected",
		code: "MALFORMED_TRACKING_BOX",
		operationDisposition: "not-applied",
	});

	const tooManyTrackingSamples = trackingAnalysis();
	tooManyTrackingSamples.analysisId = "tracking-too-many-samples";
	tooManyTrackingSamples.payload.subjects[0]!.samples.splice(1, 0, {
		sampleId: "sample-middle",
		sourceTimeTicks: 120_000,
		box: { x: 0.15, y: 0.2, width: 0.3, height: 0.5 },
		confidence: 0.93,
		occlusion: "visible",
	});
	const tooManyTrackingSamplesResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:tracking-sample-bound"),
			analysis: tooManyTrackingSamples,
		},
	);
	expect(tooManyTrackingSamplesResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const tooManyTrackedSubjects = trackingAnalysis();
	tooManyTrackedSubjects.analysisId = "tracking-too-many-subjects";
	const secondSubject = structuredClone(
		tooManyTrackedSubjects.payload.subjects[0]!,
	);
	secondSubject.subjectId = "person-2";
	tooManyTrackedSubjects.payload.subjects.push(secondSubject);
	const tooManyTrackedSubjectsResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:tracking-subject-bound"),
			analysis: tooManyTrackedSubjects,
		},
	);
	expect(tooManyTrackedSubjectsResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const mismatchedTrackingCoverage = trackingAnalysis();
	mismatchedTrackingCoverage.analysisId = "tracking-coverage-mismatch";
	mismatchedTrackingCoverage.semanticInputs.range = {
		startTicks: 0,
		endTicks: 120_000,
	};
	const mismatchedTrackingCoverageResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:tracking-coverage"),
			analysis: mismatchedTrackingCoverage,
		},
	);
	expect(mismatchedTrackingCoverageResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const mismatchedVadChannel = voiceActivityAnalysis();
	mismatchedVadChannel.analysisId = "vad-channel-mismatch";
	mismatchedVadChannel.payload.channel = "dialogue";
	const mismatchedVadChannelResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:vad-channel-mismatch"),
			analysis: mismatchedVadChannel,
		},
	);
	expect(mismatchedVadChannelResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const shortVadRange = voiceActivityAnalysis();
	shortVadRange.analysisId = "vad-short-range";
	shortVadRange.payload.ranges.find(
		(range) => range.rangeId === "speech-1",
	)!.endTicks = 66_000;
	const shortVadRangeResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:vad-minimum-duration"),
			analysis: shortVadRange,
		},
	);
	expect(shortVadRangeResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const vadOutsideRequestedRange = voiceActivityAnalysis();
	vadOutsideRequestedRange.analysisId = "vad-outside-requested-range";
	vadOutsideRequestedRange.semanticInputs.range = {
		startTicks: 120_000,
		endTicks: 240_000,
	};
	const vadOutsideRequestedRangeResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:vad-requested-range"),
			analysis: vadOutsideRequestedRange,
		},
	);
	expect(vadOutsideRequestedRangeResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const vadCorrectionOutsideRequestedRange = voiceActivityAnalysis();
	vadCorrectionOutsideRequestedRange.analysisId =
		"vad-correction-outside-requested-range";
	vadCorrectionOutsideRequestedRange.semanticInputs.range = {
		startTicks: 60_000,
		endTicks: 240_000,
	};
	vadCorrectionOutsideRequestedRange.payload.corrections = [
		{
			correctionId: "correction-outside-request",
			action: "upsert",
			rangeId: "speech-outside-request",
			range: {
				rangeId: "speech-outside-request",
				startTicks: 12_000,
				endTicks: 36_000,
				confidence: 1,
			},
			note: "This correction is outside the hashed request range.",
		},
	];
	const vadCorrectionOutsideRequestedRangeResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:vad-correction-requested-range"),
			analysis: vadCorrectionOutsideRequestedRange,
		},
	);
	expect(vadCorrectionOutsideRequestedRangeResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_SEMANTIC_INPUTS",
		operationDisposition: "not-applied",
	});

	const incompleteLifecycle = trackingAnalysis();
	incompleteLifecycle.analysisId = "tracking-incomplete-lifecycle";
	incompleteLifecycle.provenance.lifecycleEvents = [
		{
			sequence: 1,
			attempt: 1,
			kind: "completed",
			occurredAt: "2026-09-05T00:00:01.000Z",
		},
	];
	const incompleteLifecycleResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:incomplete-lifecycle"),
			analysis: incompleteLifecycle,
		},
	);
	expect(incompleteLifecycleResult).toMatchObject({
		status: "rejected",
		code: "INVALID_PROVIDER_LIFECYCLE",
		operationDisposition: "not-applied",
	});

	const invalidRetryLifecycle = trackingAnalysis();
	invalidRetryLifecycle.analysisId = "tracking-invalid-retry-lifecycle";
	invalidRetryLifecycle.provenance.lifecycleEvents = [
		...invalidRetryLifecycle.provenance.lifecycleEvents.slice(0, 3),
		{
			sequence: 4,
			attempt: 2,
			kind: "retried",
			occurredAt: "2026-09-05T00:00:03.000Z",
		},
		{
			sequence: 5,
			attempt: 2,
			kind: "completed",
			occurredAt: "2026-09-05T00:00:04.000Z",
		},
	];
	const invalidRetryLifecycleResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:invalid-retry-lifecycle"),
			analysis: invalidRetryLifecycle,
		},
	);
	expect(invalidRetryLifecycleResult).toMatchObject({
		status: "rejected",
		code: "INVALID_PROVIDER_LIFECYCLE",
		operationDisposition: "not-applied",
	});

	const incompatible = trackingAnalysis();
	incompatible.payload.attachments[0]!.subjectId = "missing-subject";
	const incompatibleResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:incompatible-attachment"),
			analysis: { ...incompatible, analysisId: "tracking-incompatible" },
		},
	);
	expect(incompatibleResult).toMatchObject({
		status: "rejected",
		code: "INCOMPATIBLE_ATTACHMENT",
		operationDisposition: "not-applied",
	});

	const staleAttachment = trackingAnalysis();
	staleAttachment.payload.attachments[0]!.sourceContentSha256 = "b".repeat(64);
	const staleAttachmentResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:stale-attachment"),
			analysis: { ...staleAttachment, analysisId: "tracking-stale" },
		},
	);
	expect(staleAttachmentResult).toMatchObject({
		status: "rejected",
		code: "STALE_SOURCE_IDENTITY",
		operationDisposition: "not-applied",
	});

	const falselyApproved = trackingAnalysis();
	falselyApproved.provenance.approvalStatus = "approved";
	const unavailableModel = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:reject:model-approval"),
		analysis: {
			...falselyApproved,
			analysisId: "tracking-unavailable-model",
		},
	});
	expect(unavailableModel).toMatchObject({
		status: "rejected",
		code: "MODEL_APPROVAL_REQUIRED",
		operationDisposition: "not-applied",
	});

	const overlapping = voiceActivityAnalysis();
	overlapping.analysisId = "vad-overlap";
	overlapping.payload.ranges[1]!.endTicks = 200_000;
	const overlapResult = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:reject:overlap"),
		analysis: overlapping,
	});
	expect(overlapResult).toMatchObject({
		status: "rejected",
		code: "MALFORMED_ACTIVITY_RANGES",
		operationDisposition: "not-applied",
	});

	const vadForDuplicateCorrection = voiceActivityAnalysis();
	const duplicateCorrectionTarget = {
		...vadForDuplicateCorrection,
		analysisId: "vad-duplicate-correction-target",
		payload: {
			...vadForDuplicateCorrection.payload,
			corrections: [
				{
					correctionId: "correction-speech-1-earlier",
					action: "upsert" as const,
					rangeId: "speech-1",
					range: {
						rangeId: "speech-1",
						startTicks: 60_000,
						endTicks: 108_000,
						confidence: 1,
					},
					note: "Correct the first range.",
				},
				{
					correctionId: "correction-speech-1-later",
					action: "remove" as const,
					rangeId: "speech-1",
					range: null,
					note: "A second correction for the same source range is ambiguous.",
				},
			],
		},
	};
	const duplicateCorrectionResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:duplicate-correction-target"),
			analysis: duplicateCorrectionTarget,
		},
	);
	expect(duplicateCorrectionResult).toMatchObject({
		status: "rejected",
		code: "MALFORMED_ACTIVITY_CORRECTION",
		operationDisposition: "not-applied",
	});

	const vadUnknownRemoval = voiceActivityAnalysis();
	vadUnknownRemoval.analysisId = "vad-unknown-removal";
	vadUnknownRemoval.payload.corrections = [
		{
			correctionId: "remove-missing-range",
			action: "remove",
			rangeId: "missing-range",
			range: null,
			note: "Cannot remove a range that was never detected.",
		},
	];
	const vadUnknownRemovalResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:vad-unknown-removal"),
			analysis: vadUnknownRemoval,
		},
	);
	expect(vadUnknownRemovalResult).toMatchObject({
		status: "rejected",
		code: "MALFORMED_ACTIVITY_CORRECTION",
		operationDisposition: "not-applied",
	});

	const backwardLifecycle = trackingAnalysis();
	backwardLifecycle.analysisId = "tracking-backward-lifecycle";
	backwardLifecycle.provenance.lifecycleEvents[1]!.occurredAt =
		"2026-09-04T23:59:59.999Z";
	const backwardLifecycleResult = await harness.call(
		"opencut_create_media_analysis",
		{
			...mutation("media-analysis:reject:backward-lifecycle"),
			analysis: backwardLifecycle,
		},
	);
	expect(backwardLifecycleResult).toMatchObject({
		status: "rejected",
		code: "INVALID_PROVIDER_LIFECYCLE",
		operationDisposition: "not-applied",
	});

	const created = await harness.call("opencut_create_media_analysis", {
		...mutation("media-analysis:create:vad-stale-plan"),
		analysis: { ...voiceActivityAnalysis(), analysisId: "vad-stale-plan" },
	});
	const stalePlan = await harness.call("opencut_plan_audio_post", {
		analysisId: "vad-stale-plan",
		expectedAnalysisContentHash: record(created.analysis).contentHash,
		currentSource: {
			assetId: "asset-audio-1",
			contentSha256: "f".repeat(64),
			durationTicks: 240_000,
		},
		graph: audioGraph(),
		ducking: {
			targetTrackId: "music-track",
			reductionDb: -12,
			attackTicks: 12_000,
			releaseTicks: 24_000,
		},
	});
	expect(stalePlan).toMatchObject({
		status: "rejected",
		code: "STALE_SOURCE_IDENTITY",
	});

	for (const analysisId of [
		"tracking-malformed",
		"tracking-too-many-samples",
		"tracking-too-many-subjects",
		"tracking-coverage-mismatch",
		"tracking-incomplete-lifecycle",
		"tracking-invalid-retry-lifecycle",
		"tracking-backward-lifecycle",
		"tracking-incompatible",
		"tracking-stale",
		"tracking-unavailable-model",
		"vad-overlap",
		"vad-duplicate-correction-target",
		"vad-unknown-removal",
		"vad-channel-mismatch",
		"vad-short-range",
		"vad-outside-requested-range",
		"vad-correction-outside-requested-range",
	]) {
		expect(
			await harness.call("opencut_get_media_analysis", { analysisId }),
		).toMatchObject({ status: "not-found", analysisId });
	}
});

class McpStdioHarness {
	private child: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private buffer = "";
	private diagnostics = "";
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(
		private readonly stateDirectory: string,
		private readonly port: number,
	) {}

	async start(): Promise<void> {
		this.child = spawn(process.execPath, [join(import.meta.dir, "index.ts")], {
			cwd: join(import.meta.dir, "../../.."),
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				OPENCUT_BRIDGE_TOKEN: randomBytes(32).toString("hex"),
				OPENCUT_BRIDGE_PORT: String(this.port),
				OPENCUT_RECEIPT_DIR: this.stateDirectory,
				OPENCUT_MEDIA_ANALYSIS_DIR: join(this.stateDirectory, "media-analysis"),
				OPENCUT_HEADLESS_EDITOR_URL: undefined,
				OPENCUT_AUDIO_CLEANER_COMMAND: undefined,
				OPENCUT_MATTE_PRODUCER_COMMAND: undefined,
				OPENCUT_SUBJECT_TRACKER_COMMAND: undefined,
			},
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.read(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.diagnostics += chunk;
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
			clientInfo: { name: "media-foundation-test", version: "1" },
		});
		this.notify("notifications/initialized", {});
	}

	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this.child) throw new Error("MCP server is not running");
		const id = this.nextId++;
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	async call(
		name: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const response = record(
			await this.request("tools/call", { name, arguments: args }),
		);
		if (response.isError === true) {
			throw new Error(`${name} failed: ${JSON.stringify(response)}`);
		}
		const text = records(response.content).find(
			(item) => item.type === "text",
		)?.text;
		if (typeof text !== "string") throw new Error(`${name} returned no text`);
		return record(JSON.parse(text));
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
		await exited;
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = record(JSON.parse(line));
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			if (message.error)
				pending.reject(new Error(JSON.stringify(message.error)));
			else pending.resolve(message.result);
		}
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected object");
	}
	return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error("expected array");
	return value.map(record);
}

async function availablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

function mutation(operationId: string) {
	return {
		bridgeProtocolVersion: 2,
		expectedConnectionIdentity: {
			serverInstanceId: "media-test-server",
			editorInstanceId: "media-test-editor",
			editorSessionId: "media-test-session",
			connectionGeneration: 1,
		},
		operationId,
	};
}

function trackingAnalysis() {
	return {
		schemaVersion: "opencut.media-analysis.v1",
		analysisId: "tracking-1",
		projectId: "project-1",
		sceneId: "scene-1",
		taskId: "opencut.task.subject-tracking.v1",
		source: {
			assetId: "asset-video-1",
			mediaKind: "video",
			durationTicks: 240_000,
			contentSha256: "a".repeat(64),
			bytes: 1_024,
		},
		semanticInputs: {
			kind: "subject-tracking" as const,
			sampling: { intervalTicks: 120_000, maxSamples: 2 },
			prompt: "person",
			initialBox: null,
			maxSubjects: 1,
			range: { startTicks: 0, endTicks: 240_000 },
		},
		provenance: {
			origin: "external-result",
			approvalStatus: "unverified",
			providerId: "fixture-provider",
			adapterId: "fixture-adapter-v1",
			adapterVersion: "1.0.0",
			model: {
				id: "fixture-tracker",
				version: "1.0.0",
				sha256: "c".repeat(64),
				license: "fixture-only",
				source: "https://example.invalid/fixture-tracker",
			},
			runtime: "fixture-runtime",
			device: "cpu",
			warnings: ["Fixture provenance is not an approved production model."],
			fallbackReason: null,
			lifecycleEvents: [
				{
					sequence: 1,
					attempt: 1,
					kind: "submitted" as const,
					occurredAt: "2026-09-05T00:00:00.000Z",
				},
				{
					sequence: 2,
					attempt: 1,
					kind: "started" as const,
					occurredAt: "2026-09-05T00:00:01.000Z",
				},
				{
					sequence: 3,
					attempt: 1,
					kind: "progress" as const,
					occurredAt: "2026-09-05T00:00:02.000Z",
				},
				{
					sequence: 4,
					attempt: 2,
					kind: "retried" as const,
					occurredAt: "2026-09-05T00:00:03.000Z",
				},
				{
					sequence: 5,
					attempt: 2,
					kind: "started" as const,
					occurredAt: "2026-09-05T00:00:04.000Z",
				},
				{
					sequence: 6,
					attempt: 2,
					kind: "progress" as const,
					occurredAt: "2026-09-05T00:00:05.000Z",
				},
				{
					sequence: 7,
					attempt: 2,
					kind: "completed" as const,
					occurredAt: "2026-09-05T00:00:06.000Z",
				},
			] as Array<{
				sequence: number;
				attempt: number;
				kind: "submitted" | "started" | "progress" | "retried" | "completed";
				occurredAt: string;
			}>,
			cost: { status: "not-incurred" as const, amount: 0, currency: null },
			outputArtifacts: [],
		},
		payload: {
			kind: "subject-tracking",
			coverage: { startTicks: 0, endTicks: 240_000 },
			subjects: [
				{
					subjectId: "person-1",
					label: "Primary person",
					samples: [
						{
							sampleId: "sample-end",
							sourceTimeTicks: 240_000,
							box: { x: 0.2, y: 0.2, width: 0.3, height: 0.5 },
							confidence: 0.91,
							occlusion: "visible",
						},
						{
							sampleId: "sample-start",
							sourceTimeTicks: 0,
							box: { x: 0.1, y: 0.2, width: 0.3, height: 0.5 },
							confidence: 0.95,
							occlusion: "visible",
						},
					],
					corrections: [
						{
							correctionId: "correction-middle",
							sourceTimeTicks: 120_000,
							box: { x: 0.15, y: 0.2, width: 0.3, height: 0.5 },
							note: "Manual midpoint correction",
						},
					],
				},
			],
			attachments: [
				{
					attachmentId: "reframe-attachment-1",
					kind: "reframe",
					targetId: "clip-1",
					subjectId: "person-1",
					sourceContentSha256: "a".repeat(64),
				},
			],
		},
	};
}

function voiceActivityAnalysis() {
	return {
		schemaVersion: "opencut.media-analysis.v1",
		analysisId: "vad-1",
		projectId: "project-1",
		sceneId: "scene-1",
		taskId: "opencut.task.voice-activity-detection.v1",
		source: {
			assetId: "asset-audio-1",
			mediaKind: "audio",
			durationTicks: 240_000,
			contentSha256: "d".repeat(64),
			bytes: 2_048,
		},
		semanticInputs: {
			kind: "voice-activity-detection" as const,
			channel: "mix",
			threshold: 0.6,
			minimumDurationTicks: 12_000,
			paddingTicks: 0,
			range: { startTicks: 0, endTicks: 240_000 },
		},
		provenance: {
			origin: "external-result",
			approvalStatus: "unverified",
			providerId: "fixture-vad-provider",
			adapterId: "fixture-vad-adapter-v1",
			adapterVersion: "1.0.0",
			model: {
				id: "fixture-vad",
				version: "1.0.0",
				sha256: "e".repeat(64),
				license: "fixture-only",
				source: "https://example.invalid/fixture-vad",
			},
			runtime: "fixture-runtime",
			device: "cpu",
			warnings: ["Fixture provenance is not an approved production model."],
			fallbackReason: null,
			lifecycleEvents: [
				{
					sequence: 1,
					attempt: 1,
					kind: "submitted" as const,
					occurredAt: "2026-09-05T00:00:00.000Z",
				},
				{
					sequence: 2,
					attempt: 1,
					kind: "started" as const,
					occurredAt: "2026-09-05T00:00:01.000Z",
				},
				{
					sequence: 3,
					attempt: 1,
					kind: "progress" as const,
					occurredAt: "2026-09-05T00:00:02.000Z",
				},
				{
					sequence: 4,
					attempt: 1,
					kind: "completed" as const,
					occurredAt: "2026-09-05T00:00:03.000Z",
				},
			] as Array<{
				sequence: number;
				attempt: number;
				kind: "submitted" | "started" | "progress" | "retried" | "completed";
				occurredAt: string;
			}>,
			cost: { status: "not-incurred" as const, amount: 0, currency: null },
			outputArtifacts: [],
		},
		payload: {
			kind: "voice-activity",
			channel: "mix",
			ranges: [
				{
					rangeId: "speech-2",
					startTicks: 180_000,
					endTicks: 216_000,
					confidence: 0.88,
				},
				{
					rangeId: "speech-1",
					startTicks: 60_000,
					endTicks: 120_000,
					confidence: 0.96,
				},
			],
			corrections: [] as Array<{
				correctionId: string;
				action: "upsert" | "remove";
				rangeId: string;
				range: {
					rangeId: string;
					startTicks: number;
					endTicks: number;
					confidence: number;
				} | null;
				note: string;
			}>,
		},
	};
}

function audioGraph() {
	return {
		schemaVersion: "opencut.audio-processing-graph.v1",
		stages: [
			{
				scope: { kind: "master" as const },
				processors: [
					{
						nodeId: "master-limiter",
						order: 0,
						enabled: true,
						processor: {
							kind: "limiter" as const,
							ceilingDb: -1,
							releaseMs: 80,
						},
					},
				],
			},
			{
				scope: { kind: "track" as const, trackId: "dialogue-track" },
				processors: [
					{
						nodeId: "track-compressor",
						order: 1,
						enabled: true,
						processor: {
							kind: "compressor" as const,
							thresholdDb: -18,
							ratio: 3,
							attackMs: 10,
							releaseMs: 100,
							makeupGainDb: 2,
						},
					},
					{
						nodeId: "track-de-esser",
						order: 0,
						enabled: true,
						processor: {
							kind: "de-esser" as const,
							frequencyHz: 6_000,
							thresholdDb: -24,
							ratio: 4,
						},
					},
				],
			},
			{
				scope: { kind: "clip" as const, clipId: "dialogue-clip" },
				processors: [
					{
						nodeId: "clip-high-pass",
						order: 0,
						enabled: true,
						processor: {
							kind: "equalizer" as const,
							bands: [
								{
									bandId: "high-pass",
									kind: "high-pass" as const,
									frequencyHz: 80,
									gainDb: 0,
									q: 0.7,
								},
							],
						},
					},
				],
			},
		],
	};
}
