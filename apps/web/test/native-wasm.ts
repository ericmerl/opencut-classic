import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The Node-target WASM package, loaded on first use. Test files that replace
 * `opencut-wasm` with a hand-written mock delegate Rust-owned decisions here
 * instead of re-implementing them.
 */
let nativeModule: Record<string, (options?: unknown) => unknown> | undefined;
export function nativeWasm(): Record<string, (options?: unknown) => unknown> {
	nativeModule ??=
		require("../../../rust/wasm/pkg-node/opencut_wasm.js") as Record<
			string,
			(options?: unknown) => unknown
		>;
	return nativeModule;
}
