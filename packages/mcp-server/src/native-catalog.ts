import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface NativeCatalogModule {
	mediaTreatmentCatalog(): Record<string, unknown>;
	transitionCatalog(): Record<string, unknown>;
	findMediaTreatment(treatmentId: string): NativeCatalogLookup;
	findTransition(transitionId: string): NativeCatalogLookup;
}

type NativeCatalogLookup =
	| { status: "found"; catalog: Record<string, unknown> }
	| { status: "unknown"; reason: string };

let native: NativeCatalogModule | undefined;

function nativeCatalogModule(): NativeCatalogModule {
	native ??=
		require("../../../rust/wasm/pkg-node/opencut_wasm.js") as NativeCatalogModule;
	return native;
}

export function readMediaTreatmentCatalog(
	treatmentId?: string,
): Record<string, unknown> {
	if (treatmentId === undefined)
		return nativeCatalogModule().mediaTreatmentCatalog();
	return requireFound(nativeCatalogModule().findMediaTreatment(treatmentId));
}

export function readTransitionCatalog(
	transitionId?: string,
): Record<string, unknown> {
	if (transitionId === undefined)
		return nativeCatalogModule().transitionCatalog();
	return requireFound(nativeCatalogModule().findTransition(transitionId));
}

function requireFound(lookup: NativeCatalogLookup): Record<string, unknown> {
	if (lookup.status === "unknown") throw new Error(lookup.reason);
	return lookup.catalog;
}
