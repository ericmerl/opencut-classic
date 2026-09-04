import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId } from "./utils";

/**
 * Storage version 33 declares `key` on visual elements and `trackMatte` on
 * tracks as canonical optional fields. No backfill is necessary: absence means
 * no key or route, so this additive migration preserves every stored byte of
 * project data other than the version marker.
 */
export function transformProjectV32ToV33({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}
	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version >= 33) {
		return { project, skipped: true, reason: "already v33" };
	}
	if (version !== 32) {
		return { project, skipped: true, reason: "not v32" };
	}
	return { project: { ...project, version: 33 }, skipped: false };
}
