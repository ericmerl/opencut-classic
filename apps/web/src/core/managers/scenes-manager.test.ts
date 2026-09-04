/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline";

// The manager reaches the renderer and the native runtime through the storage
// service, neither of which this suite exercises.
mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	formatTimecode: () => "00:00",
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("@/services/renderer/canvas-renderer", () => ({
	CanvasRenderer: class {},
}));
mock.module("@/services/renderer/scene-builder", () => ({
	buildScene: () => ({}),
}));

const { ScenesManager } = await import("./scenes-manager");
type ScenesManagerInstance = InstanceType<typeof ScenesManager>;

describe("ScenesManager.setScenes", () => {
	test("carries the switched active scene into the project state", () => {
		const { manager, getProject } = createManager();
		manager.initializeScenes({
			scenes: [scene("a", true), scene("b", false)],
			currentSceneId: "a",
		});

		manager.setScenes({ scenes: manager.getScenes(), activeSceneId: "b" });

		expect(manager.getActiveScene().id).toBe("b");
		expect(getProject().currentSceneId).toBe("b");
	});

	test("keeps the project's active scene when no switch is requested", () => {
		const { manager, getProject } = createManager();
		manager.initializeScenes({
			scenes: [scene("a", true), scene("b", false)],
			currentSceneId: "b",
		});

		manager.setScenes({
			scenes: manager.getScenes().map((entry) => ({ ...entry })),
		});

		expect(manager.getActiveScene().id).toBe("b");
		expect(getProject().currentSceneId).toBe("b");
	});
});

function createManager(): {
	manager: ScenesManagerInstance;
	getProject: () => TProject;
} {
	let project = buildProject();
	const editor = {
		project: {
			getActive: () => project,
			setActiveProject: ({ project: next }: { project: TProject }) => {
				project = next;
			},
		},
		save: { markDirty: () => {} },
	} as unknown as EditorCore;
	return { manager: new ScenesManager(editor), getProject: () => project };
}

function scene(id: string, isMain: boolean): TScene {
	return {
		id,
		name: id,
		isMain,
		tracks: {
			main: {
				id: `${id}-main`,
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [],
			audio: [],
		},
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

function buildProject(): TProject {
	return {
		metadata: {
			id: "project-1",
			name: "Project",
			duration: 0,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		scenes: [],
		currentSceneId: "a",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: "#000000" },
		},
		version: 1,
	} as unknown as TProject;
}
