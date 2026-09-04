import { generateUUID } from "@/utils/id";
import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

/**
 * Storage version 32 gives every scene bookmark a stable `id` so bookmarks can
 * be addressed by identity rather than by frame time. Existing bookmarks keep
 * every other field; a bookmark that already carries a non-empty string id is
 * left unchanged so the migration is idempotent.
 */
export function transformProjectV31ToV32({
	project,
	generateId = generateUUID,
}: {
	project: ProjectRecord;
	generateId?: () => string;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}

	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version >= 32) {
		return { project, skipped: true, reason: "already v32" };
	}
	if (version !== 31) {
		return { project, skipped: true, reason: "not v31" };
	}

	return {
		project: {
			...migrateProject({ project, generateId }),
			version: 32,
		},
		skipped: false,
	};
}

function migrateProject({
	project,
	generateId,
}: {
	project: ProjectRecord;
	generateId: () => string;
}): ProjectRecord {
	const nextProject = { ...project };
	if (Array.isArray(project.scenes)) {
		nextProject.scenes = project.scenes.map((scene) =>
			migrateScene({ scene, generateId }),
		);
	}
	return nextProject;
}

function migrateScene({
	scene,
	generateId,
}: {
	scene: unknown;
	generateId: () => string;
}): unknown {
	if (!isRecord(scene) || !Array.isArray(scene.bookmarks)) {
		return scene;
	}
	return {
		...scene,
		bookmarks: scene.bookmarks.map((bookmark) => {
			if (!isRecord(bookmark)) return bookmark;
			const existing =
				typeof bookmark.id === "string" && bookmark.id.length > 0
					? bookmark.id
					: null;
			// Migrations are additive: never rewrite an identity already present in
			// persisted data, even when an older/ad-hoc record contains duplicates.
			const id = existing ?? generateId();
			return { ...bookmark, id };
		}),
	};
}
