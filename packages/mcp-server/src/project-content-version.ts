export const CURRENT_PROJECT_CONTENT_PROJECTION_VERSION = 3 as const;

export type ProjectContentProjectionVersion = 1 | 2 | 3;

export function readPersistedProjectContentProjectionVersion(
	value: unknown,
): ProjectContentProjectionVersion | null {
	if (value === undefined) return 1;
	return value === 1 || value === 2 || value === 3 ? value : null;
}

export function isProjectContentProjectionVersion(
	value: unknown,
): value is ProjectContentProjectionVersion {
	return value === 1 || value === 2 || value === 3;
}
