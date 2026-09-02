import type { JsonValue } from "./operation-ledger-schema";

export interface CompositeProviderEvent {
	state: "prepared" | "committed" | "verified";
	provider: string;
	modelId?: string;
	modelVersion?: string;
	artifact?: {
		sha256: string;
		bytes?: number;
		mimeType?: string;
		path?: string;
	};
	metadata?: Record<string, JsonValue>;
}

export type CompositeOperationObserver = (
	event: CompositeProviderEvent,
) => Promise<void>;
