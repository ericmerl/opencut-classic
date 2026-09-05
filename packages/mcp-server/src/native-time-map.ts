import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../../rust/wasm/pkg-node/opencut_wasm.js") as {
	evaluateTimeMap(options: unknown): Record<string, unknown>;
};

export function evaluateTimeMap(input: unknown): Record<string, unknown> {
	return native.evaluateTimeMap(input);
}
