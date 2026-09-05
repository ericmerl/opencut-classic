import { createRequire } from "node:module";
import type {
	MediaTreatmentCatalog,
	MediaTreatmentLookupResponse,
	TransitionCatalog,
	TransitionLookupResponse,
} from "../../../rust/wasm/pkg-node/opencut_wasm.js";

const require = createRequire(import.meta.url);

interface NativeCatalogModule {
	mediaTreatmentCatalog(): MediaTreatmentCatalog;
	transitionCatalog(): TransitionCatalog;
	findMediaTreatment(treatmentId: string): MediaTreatmentLookupResponse;
	findTransition(transitionId: string): TransitionLookupResponse;
}

type NativeCatalogLookup<Catalog> =
	| { status: "found"; catalog: Catalog }
	| { status: "unknown"; reason: string };

let native: NativeCatalogModule | undefined;

function nativeCatalogModule(): NativeCatalogModule {
	native ??=
		require("../../../rust/wasm/pkg-node/opencut_wasm.js") as NativeCatalogModule;
	return native;
}

export function readMediaTreatmentCatalog(
	treatmentId?: string,
): MediaTreatmentCatalog {
	if (treatmentId === undefined)
		return nativeCatalogModule().mediaTreatmentCatalog();
	return requireFound(nativeCatalogModule().findMediaTreatment(treatmentId));
}

export function readTransitionCatalog(
	transitionId?: string,
): TransitionCatalog {
	if (transitionId === undefined)
		return nativeCatalogModule().transitionCatalog();
	return requireFound(nativeCatalogModule().findTransition(transitionId));
}

function requireFound<Catalog>(lookup: NativeCatalogLookup<Catalog>): Catalog {
	if (lookup.status === "unknown") throw new Error(lookup.reason);
	return lookup.catalog;
}
