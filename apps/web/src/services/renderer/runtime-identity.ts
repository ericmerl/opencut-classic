import wasmPackageMetadata from "opencut-wasm/package.json";

export const SELECTED_COMPOSITOR_BACKEND = "opencut-wasm-webgl" as const;
export const OPENCUT_WASM_PACKAGE_VERSION = wasmPackageMetadata.version;
