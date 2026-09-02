import { createHash } from "node:crypto";
import type { JsonValue, OperationCheckpoint } from "./operation-ledger";

const TRANSIENT_REQUEST_KEYS = new Set([
	"url",
	"ticketUrl",
	"uploadUrl",
	"downloadUrl",
	"expectedConnectionIdentity",
	"operationReceiptBinding",
]);

export const BROWSER_RECEIPT_CHECKPOINT_PREFIX = "browser-receipt-contract:";

export interface BrowserOperationReceiptContract {
	version: 1;
	outerOperationId: string;
	outerToolName: string;
	outerRequestFingerprint: string;
	role: "direct-terminal" | "composite-step";
	stepId: string;
	browserMethod: string;
	browserRequestFingerprint: string;
}

export function browserRequestFingerprint(request: unknown): string {
	return createHash("sha256")
		.update(stableSerialize(stripTransientRequest(request)))
		.digest("hex");
}

export function browserReceiptCheckpoint(
	operationId: string,
	contract: BrowserOperationReceiptContract,
): OperationCheckpoint {
	return {
		checkpointId: `${BROWSER_RECEIPT_CHECKPOINT_PREFIX}${operationId}:${contract.stepId}`,
		kind: "editor",
		state: "prepared",
		recordedAt: new Date().toISOString(),
		metadata: {
			...contract,
		},
	};
}

export function readBrowserReceiptContract(
	checkpoints: OperationCheckpoint[],
	operationId: string,
	stepId?: string,
): BrowserOperationReceiptContract | null {
	const checkpoint = checkpoints.find(
		(candidate) =>
			candidate.checkpointId.startsWith(
				`${BROWSER_RECEIPT_CHECKPOINT_PREFIX}${operationId}:`,
			) &&
			(!stepId || candidate.metadata.stepId === stepId),
	);
	const metadata = checkpoint?.metadata;
	return metadata &&
		metadata.version === 1 &&
		typeof metadata.outerOperationId === "string" &&
		typeof metadata.outerToolName === "string" &&
		typeof metadata.outerRequestFingerprint === "string" &&
		(metadata.role === "direct-terminal" || metadata.role === "composite-step") &&
		typeof metadata.stepId === "string" &&
		typeof metadata.browserMethod === "string" &&
		typeof metadata.browserRequestFingerprint === "string"
		? (metadata as unknown as BrowserOperationReceiptContract)
		: null;
}

function stripTransientRequest(value: unknown): JsonValue {
	if (Array.isArray(value)) return value.map(stripTransientRequest);
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([key]) => !TRANSIENT_REQUEST_KEYS.has(key))
				.sort(([left], [right]) => compareOrdinal(left, right))
				.map(([key, child]) => [key, stripTransientRequest(child)]),
		);
	}
	throw new Error("browser operation request is outside the strict JSON domain");
}

function stableSerialize(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => compareOrdinal(left, right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function compareOrdinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
