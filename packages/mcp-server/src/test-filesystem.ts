import { rm } from "node:fs/promises";

export async function removeTestDirectory(path: string): Promise<void> {
	await rm(path, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 50,
	});
}
