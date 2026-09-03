import {
	PROJECT_SAVE_RECEIPT_IDENTITY_VERSION,
	type CurrentProjectSaveReceiptIdentity,
	type ProjectContentProjectionVersion,
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
}): CurrentProjectSaveReceiptIdentity {
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

export function readProjectSaveReceiptProjectionVersion(
	identity: ProjectSaveReceiptIdentity,
): ProjectContentProjectionVersion | null {
	if (identity.version === 1) return 1;
	return identity.version === PROJECT_SAVE_RECEIPT_IDENTITY_VERSION &&
		(identity.contentHashProjectionVersion === 1 ||
			identity.contentHashProjectionVersion === 2)
		? identity.contentHashProjectionVersion
		: null;
}
