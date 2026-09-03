import {
	PROJECT_SAVE_RECEIPT_IDENTITY_VERSION,
	type ProjectSaveReceiptBinding,
	type ProjectSaveReceiptIdentity,
} from "./types";

export function buildSaveReceiptId({
	projectId,
	writeVersion,
	contentHash,
}: {
	projectId: string;
	writeVersion: number;
	contentHash: string;
}): string {
	return `save:${projectId}:${writeVersion}:${contentHash}`;
}

export function buildProjectSaveReceiptIdentity({
	projectId,
	writeVersion,
	binding,
}: {
	projectId: string;
	writeVersion: number;
	binding: ProjectSaveReceiptBinding;
}): ProjectSaveReceiptIdentity {
	return {
		version: PROJECT_SAVE_RECEIPT_IDENTITY_VERSION,
		...binding,
		receiptId: buildSaveReceiptId({
			projectId,
			writeVersion,
			contentHash: binding.contentHash,
		}),
	};
}
