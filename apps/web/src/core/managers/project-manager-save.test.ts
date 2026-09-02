/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline";
import type { PersistedProjectWriteRecord } from "@/services/storage/types";

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

const { storageService } = await import("@/services/storage/service");
const { ProjectManager } = await import("./project-manager");
type ProjectManagerInstance = InstanceType<typeof ProjectManager>;

const originalSaveProject = storageService.saveProject;

afterEach(() => {
	storageService.saveProject = originalSaveProject;
});

describe("ProjectManager project persistence", () => {
	test("returns the identity of the exact persisted project state", async () => {
		const project = buildProject();
		const scenes = [{ ...project.scenes[0]!, name: "Edited scene" }];
		const persistedProjects: TProject[] = [];
		storageService.saveProject = async ({ project: value }) => {
			persistedProjects.push(value);
			return storageWrite(1);
		};
		const { manager } = createManager({ project, scenes });

		const write = await manager.saveCurrentProject();
		if (!write) throw new Error("Expected an active project write");

		expect(write).toMatchObject({
			projectId: "project-1",
			storageSchemaVersion: 1,
			writeVersion: 1,
		});
		expect(Number.isNaN(Date.parse(write.persistedAt))).toBe(false);
		expect(persistedProjects[0]?.scenes).toEqual(scenes);
		expect(manager.getActive().scenes).toEqual(scenes);
		expect(manager.getActive().metadata.updatedAt.toISOString()).toBe(
			write.persistedAt,
		);
	});

	test("propagates storage failure and keeps the prior active state", async () => {
		const project = buildProject();
		const scenes = [{ ...project.scenes[0]!, name: "Unsaved scene" }];
		const failure = new Error("IndexedDB commit failed");
		storageService.saveProject = async () => {
			throw failure;
		};
		const { manager } = createManager({ project, scenes });

		await expect(manager.saveCurrentProject()).rejects.toBe(failure);
		expect(manager.getActive()).toBe(project);
		expect(manager.getActive().scenes[0]?.name).toBe("Main scene");
	});

	test("does not merge a completed write over newer same-project state", async () => {
		const project = buildProject();
		const writePending = deferred<PersistedProjectWriteRecord>();
		storageService.saveProject = async () => writePending.promise;
		const { manager, setScenes } = createManager({
			project,
			scenes: project.scenes,
		});
		const saving = manager.saveCurrentProject();
		await yieldMicrotasks();

		const newerProject: TProject = {
			...project,
			settings: {
				...project.settings,
				background: { type: "color", color: "#123456" },
			},
		};
		const newerScenes = [{ ...project.scenes[0]!, name: "Newer live scene" }];
		manager.setActiveProject({ project: newerProject });
		setScenes(newerScenes);
		writePending.resolve(storageWrite(1));

		await saving;
		expect(manager.getActive()).toBe(newerProject);
		expect(manager.getActive().settings.background).toEqual({
			type: "color",
			color: "#123456",
		});
		expect(manager.getActive().metadata.updatedAt).toBe(
			project.metadata.updatedAt,
		);
	});

	test("does not merge a completed write when scenes changed in place", async () => {
		const project = buildProject();
		const writePending = deferred<PersistedProjectWriteRecord>();
		storageService.saveProject = async () => writePending.promise;
		const { manager, setScenes } = createManager({
			project,
			scenes: project.scenes,
		});
		const saving = manager.saveCurrentProject();
		await yieldMicrotasks();

		setScenes([{ ...project.scenes[0]!, name: "Newer scene state" }]);
		writePending.resolve(storageWrite(1));

		await saving;
		expect(manager.getActive()).toBe(project);
		expect(manager.getActive().metadata.updatedAt).toBe(
			project.metadata.updatedAt,
		);
	});

	test("does not reactivate a project after switching during its write", async () => {
		const project = buildProject();
		const writePending = deferred<PersistedProjectWriteRecord>();
		storageService.saveProject = async () => writePending.promise;
		const { manager } = createManager({ project, scenes: project.scenes });
		const saving = manager.saveCurrentProject();
		await yieldMicrotasks();

		const replacement: TProject = {
			...buildProject(),
			metadata: { ...buildProject().metadata, id: "project-2" },
		};
		manager.setActiveProject({ project: replacement });
		writePending.resolve(storageWrite(1));

		const receipt = await saving;
		expect(receipt?.projectId).toBe("project-1");
		expect(manager.getActive()).toBe(replacement);
		expect(manager.getActive().metadata.id).toBe("project-2");
	});
});

function createManager({
	project,
	scenes,
}: {
	project: TProject;
	scenes: TScene[];
}): { manager: ProjectManagerInstance; setScenes: (scenes: TScene[]) => void } {
	let currentScenes = scenes;
	const editor = {
		scenes: { getScenes: () => currentScenes },
	} as unknown as EditorCore;
	const manager = new ProjectManager(editor);
	manager.setActiveProject({ project });
	return {
		manager,
		setScenes: (nextScenes) => {
			currentScenes = nextScenes;
		},
	};
}

function buildProject(): TProject {
	const scene = {
		id: "scene-1",
		name: "Main scene",
		isMain: true,
		tracks: {
			main: {
				id: "main-track",
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
		createdAt: new Date("2026-09-02T00:00:00.000Z"),
		updatedAt: new Date("2026-09-02T00:00:00.000Z"),
	} as TScene;
	return {
		metadata: {
			id: "project-1",
			name: "Persistence test",
			duration: 0 as TProject["metadata"]["duration"],
			createdAt: new Date("2026-09-02T00:00:00.000Z"),
			updatedAt: new Date("2026-09-02T00:00:00.000Z"),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function yieldMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function storageWrite(writeVersion: number): PersistedProjectWriteRecord {
	return {
		projectId: "project-1",
		storageSchemaVersion: 1,
		writeVersion,
		snapshotAt: "2026-09-02T12:00:00.100Z",
		completedAt: "2026-09-02T12:00:00.200Z",
	};
}
