/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type {
	CapabilitySnapshot,
	EditPlanEvaluation,
	ProjectSnapshot,
	SourceBinding,
} from "opencut-wasm";
import { canonicalSerialize } from "./project-content-hash";
import {
	diffProjectSnapshots,
	verifyEditPlanEvaluationIntegrity,
} from "./edit-plan-evaluation-integrity";

describe("edit-plan evaluation integrity", () => {
	test("accepts only prediction evidence that recomputes exactly", async () => {
		const before = await fullFixture();
		const predictedAfter = structuredClone(before);
		predictedAfter.project.name = "Changed by native plan";
		const evaluation = await buildEvaluation({ before, predictedAfter });

		expect(
			await verifyEditPlanEvaluationIntegrity({
				evaluation,
				expectedSource: evaluation.source,
				expectedOperations: evaluation.resolvedOperations,
			}),
		).toBeNull();
		expect(evaluation.changedObjects).toEqual([
			expect.objectContaining({
				objectType: "project",
				objectId: "canonical-project",
				fieldPath: "project.name",
				before: before.project.name,
				after: predictedAfter.project.name,
			}),
		]);
	});

	test("rejects tampered prediction, diff, source, and capability evidence", async () => {
		const before = await fullFixture();
		const evaluation = await buildEvaluation({
			before,
			predictedAfter: before,
		});
		const cases: Array<[string, EditPlanEvaluation]> = [
			["prediction", { ...evaluation, predictedProjectHash: "0".repeat(64) }],
			[
				"diff",
				{
					...evaluation,
					changedObjects: [
						{
							objectType: "project",
							objectId: "canonical-project",
							fieldPath: "project.name",
							before: "wrong",
							after: "wrong",
						},
					],
				},
			],
			[
				"source",
				{ ...evaluation, source: { ...evaluation.source, sceneId: "other" } },
			],
			[
				"capability",
				{
					...evaluation,
					requirements: {
						...evaluation.requirements,
						cost: { status: "unavailable", reason: "tampered" },
					},
				},
			],
		];

		for (const [name, candidate] of cases) {
			const error = await verifyEditPlanEvaluationIntegrity({
				evaluation: candidate,
				expectedSource: evaluation.source,
				expectedOperations: evaluation.resolvedOperations,
			});
			expect(error, name).not.toBeNull();
		}
	});
});

async function buildEvaluation({
	before,
	predictedAfter,
}: {
	before: ProjectSnapshot;
	predictedAfter: ProjectSnapshot;
}): Promise<EditPlanEvaluation> {
	const beforeHash = await hash(before);
	const predictedHash = await hash(predictedAfter);
	const capability: CapabilitySnapshot = {
		hash: "",
		editPlanReady: true,
		providerExecution: "forbidden",
		cost: { status: "not-applicable" },
	};
	capability.hash = await hash({
		editPlanReady: true,
		providerExecution: "forbidden",
		cost: capability.cost,
	});
	const source: SourceBinding = {
		connectionIdentity: {
			serverInstanceId: "server",
			editorInstanceId: "editor",
			editorSessionId: "session",
			connectionGeneration: 1,
			bridgeProtocolVersion: 2,
		},
		projectId: "project",
		sceneId: before.project.activeSceneId,
		sessionRevision: 3,
		canonicalProjectHash: beforeHash,
		durableWriteVersion: 8,
		saveReceiptId: "receipt",
		saveOperationId: "save",
	};
	const changedObjects = diffProjectSnapshots({
		before,
		after: predictedAfter,
	});
	const planDiffHash = await hash({
		predictedProjectHash: predictedHash,
		changedObjects,
		timingConsequences: [],
		rippleExpansion: [],
		relationshipExpansion: [],
	});
	const summary = (snapshotHash: string) => ({
		canonicalHash: snapshotHash,
		trackCount: 7,
		elementCount: 8,
		transitionCount: 1,
		durationTicks: 120000,
	});
	return {
		schemaVersion: "opencut.edit-plan-preflight.v2",
		source,
		planFingerprint: "a".repeat(64),
		preflightFingerprint: "b".repeat(64),
		planDiffHash,
		predictedProjectHash: predictedHash,
		beforeSummary: summary(beforeHash),
		predictedAfterSummary: summary(predictedHash),
		before,
		predictedAfter,
		resolvedOperations: [],
		resolvedIds: [],
		changedObjects,
		timingConsequences: [],
		rippleExpansion: [],
		relationshipExpansion: [],
		warnings: [],
		requirements: capability,
		cost: capability.cost,
	};
}

async function fullFixture(): Promise<ProjectSnapshot> {
	return Bun.file(
		new URL(
			"../../../../rust/crates/edit-plan/tests/fixtures/full-project-content-v1.json",
			import.meta.url,
		),
	).json();
}

async function hash(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalSerialize(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
