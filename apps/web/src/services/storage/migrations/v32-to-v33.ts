import { StorageMigration, type StorageMigrationRunArgs } from "./base";
import type { MigrationResult, ProjectRecord } from "./transformers/types";
import { transformProjectV32ToV33 } from "./transformers/v32-to-v33";

export class V32toV33Migration extends StorageMigration {
	from = 32;
	to = 33;

	async run({
		project,
	}: StorageMigrationRunArgs): Promise<MigrationResult<ProjectRecord>> {
		return transformProjectV32ToV33({ project });
	}
}
