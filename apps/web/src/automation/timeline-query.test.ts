/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
	resolveTimeMapSourceTime: ({
		clipTime,
		timeMap,
	}: {
		clipTime: number;
		timeMap: { segments: Array<Record<string, number | string>> };
	}) => {
		const segment = timeMap.segments.find(
			(candidate) =>
				clipTime >= Number(candidate.timelineStart) &&
				clipTime <= Number(candidate.timelineEnd),
		);
		if (!segment) return undefined;
		if (segment.kind === "hold") return segment.sourceTime;
		const elapsed = clipTime - Number(segment.timelineStart);
		const duration =
			Number(segment.timelineEnd) - Number(segment.timelineStart);
		const position = elapsed / duration;
		const delta =
			duration *
			(Number(segment.startRate) * position +
				0.5 *
					(Number(segment.endRate) - Number(segment.startRate)) *
					position *
					position);
		return Math.round(
			Number(segment.sourceStart) +
				(segment.direction === "reverse" ? -delta : delta),
		);
	},
	sliceTimeMap: () => undefined,
}));

const { mediaTime } = await import("@/wasm");
const { queryTimelineSnapshot } = await import("./timeline-query");
type AutomationProjectSnapshot = import("./types").AutomationProjectSnapshot;

const ticks = (value: number) => mediaTime({ ticks: value });

function buildSnapshot(): AutomationProjectSnapshot {
	const elements = [
		{ elementId: "a", startTime: 0, duration: 100 },
		{ elementId: "b", startTime: 100, duration: 80 },
		{ elementId: "c", startTime: 160, duration: 80 },
		{ elementId: "d", startTime: 300, duration: 50 },
	].map(({ elementId, startTime, duration }) => ({
		trackId: "main",
		elementId,
		type: "video",
		name: `${elementId}.mp4`,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: mediaTime({ ticks: duration }),
		params: {},
		mediaId: `media-${elementId}`,
	}));
	return {
		projectId: "project-1",
		projectName: "Timeline query",
		projectVersion: 31,
		sceneId: "scene-1",
		sceneName: "Main scene",
		revision: 7,
		contentIdentity: {
			status: "hashed",
			hash: {
				algorithm: "SHA-256",
				projection: "opencut-project-content",
				projectionVersion: 1,
				digest: "a".repeat(64),
			},
		},
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		tracks: [
			{
				trackId: "main",
				name: "Main",
				type: "video",
				role: "main",
			},
		],
		transitions: [
			{
				transitionId: "transition-1",
				trackId: "main",
				fromElementId: "a",
				toElementId: "b",
				type: "crossfade",
				duration: mediaTime({ ticks: 20 }),
				valid: true,
			},
		],
		mediaAssets: [],
		scenes: [],
		bookmarks: [],
		elements,
	};
}

describe("timeline query", () => {
	test("reads canonical source times and boundary policies for a durable time map", () => {
		const snapshot = buildSnapshot();
		snapshot.elements[0]!.duration = ticks(120);
		snapshot.elements[0]!.trimStart = ticks(10);
		snapshot.elements[0]!.sourceDuration = ticks(200);
		snapshot.elements[0]!.retime = {
			rate: 1,
			maintainPitch: true,
			mode: "time-map",
			timeMap: {
				schemaVersion: "opencut.time-map.v1",
				frameInterpolation: { requested: "nearest", fallback: "nearest" },
				audioPolicy: { maintainPitch: true, hold: "mute" },
				segments: [
					{
						kind: "speed",
						timelineStart: 0,
						timelineEnd: 60,
						sourceStart: 0,
						startRate: 1,
						endRate: 1,
						direction: "forward",
					},
					{
						kind: "hold",
						timelineStart: 60,
						timelineEnd: 120,
						sourceTime: 60,
						frameIdentity: "source-frame:70",
					},
				],
			},
		};
		const result = queryTimelineSnapshot({
			snapshot,
			request: { projectId: "project-1", expectedRevision: 7 },
		});
		expect(result.status).toBe("queried");
		if (result.status !== "queried") return;
		expect(result.tracks[0]?.elements[0]).toMatchObject({
			retime: { mode: "time-map" },
			sourceTimeReadback: [
				{ clipTime: 0, timelineTime: 0, sourceTime: 0, absoluteSourceTime: 10 },
				{
					clipTime: 60,
					timelineTime: 60,
					sourceTime: 60,
					absoluteSourceTime: 70,
				},
				{
					clipTime: 120,
					timelineTime: 120,
					sourceTime: 60,
					absoluteSourceTime: 70,
				},
			],
			mappingPolicy: {
				trim: "slice-time-map",
				split: "slice-and-rebase-time-map",
				timelineAnchored: ["keyframe", "transition", "caption"],
				sourceMapped: ["tracker", "matte", "video-decoder", "audio"],
			},
		});
	});

	test("reports ordered elements, cuts, gaps, overlaps, and transitions", () => {
		const result = queryTimelineSnapshot({
			snapshot: buildSnapshot(),
			request: { projectId: "project-1", expectedRevision: 7 },
		});

		expect(result.status).toBe("queried");
		if (result.status !== "queried") return;
		const track = result.tracks[0];
		expect(track?.elements.map((element) => element.elementId)).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
		expect(track?.gaps).toEqual([
			{ startTime: ticks(240), endTime: ticks(300), duration: ticks(60) },
		]);
		expect(track?.overlaps).toEqual([
			{
				firstElementId: "b",
				secondElementId: "c",
				startTime: ticks(160),
				endTime: ticks(180),
				duration: ticks(20),
			},
		]);
		expect(track?.relationships).toEqual([
			{
				fromElementId: "a",
				toElementId: "b",
				kind: "cut",
				fromEndTime: ticks(100),
				toStartTime: ticks(100),
				duration: ticks(0),
				transition: {
					transitionId: "transition-1",
					type: "crossfade",
					duration: ticks(20),
					valid: true,
				},
			},
			{
				fromElementId: "b",
				toElementId: "c",
				kind: "overlap",
				fromEndTime: ticks(180),
				toStartTime: ticks(160),
				duration: ticks(20),
			},
			{
				fromElementId: "c",
				toElementId: "d",
				kind: "gap",
				fromEndTime: ticks(240),
				toStartTime: ticks(300),
				duration: ticks(60),
			},
		]);
	});

	test("clips coverage to a requested range", () => {
		const result = queryTimelineSnapshot({
			snapshot: buildSnapshot(),
			request: {
				projectId: "project-1",
				expectedRevision: 7,
				startTime: 210,
				endTime: 320,
				trackIds: ["main"],
				elementTypes: ["video"],
			},
		});

		expect(result.status).toBe("queried");
		if (result.status !== "queried") return;
		expect(
			result.tracks[0]?.elements.map((element) => element.elementId),
		).toEqual(["c", "d"]);
		expect(result.tracks[0]?.gaps).toEqual([
			{ startTime: ticks(240), endTime: ticks(300), duration: ticks(60) },
		]);
	});

	test("rejects stale revisions and unknown tracks", () => {
		expect(
			queryTimelineSnapshot({
				snapshot: buildSnapshot(),
				request: { projectId: "project-1", expectedRevision: 6 },
			}),
		).toEqual({
			status: "conflict",
			projectId: "project-1",
			sceneId: "scene-1",
			expectedRevision: 6,
			actualRevision: 7,
		});
		expect(
			queryTimelineSnapshot({
				snapshot: buildSnapshot(),
				request: {
					projectId: "project-1",
					expectedRevision: 7,
					trackIds: ["missing"],
				},
			}),
		).toEqual({
			status: "rejected",
			projectId: "project-1",
			sceneId: "scene-1",
			reason: "unknown trackIds: missing",
		});
	});
});
