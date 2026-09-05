import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	evaluateTimeMap(options: unknown): Record<string, unknown>;
	mapTimeMapTrackingSamples(
		options: unknown,
	):
		| { samples: Array<{ time: number; box: Record<string, number> }> }
		| undefined;
};

export function evaluateTimeMap(input: unknown): Record<string, unknown> {
	return native.evaluateTimeMap(input);
}

export function mapTimeMapTrackingSamples(input: unknown) {
	return native.mapTimeMapTrackingSamples(input);
}
