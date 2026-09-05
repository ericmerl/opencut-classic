import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface NativeCatalogModule {
	mediaTreatmentCatalog(): Record<string, unknown>;
	transitionCatalog(): Record<string, unknown>;
}

let native: NativeCatalogModule | undefined;

function nativeCatalogModule(): NativeCatalogModule {
	native ??=
		require("../../../rust/wasm/pkg-node/opencut_wasm.js") as NativeCatalogModule;
	return native;
}

export function readMediaTreatmentCatalog(
	treatmentId?: string,
): Record<string, unknown> {
	const catalog = nativeCatalogModule().mediaTreatmentCatalog();
	if (treatmentId === undefined) return catalog;
	const treatments = requireRecords(catalog.treatments, "treatments").filter(
		(treatment) => treatment.id === treatmentId,
	);
	if (treatments.length === 0) {
		throw new Error(`unknown treatment ID: ${treatmentId}`);
	}
	return { ...catalog, treatments };
}

export function readTransitionCatalog(
	transitionId?: string,
): Record<string, unknown> {
	const catalog = nativeCatalogModule().transitionCatalog();
	if (transitionId === undefined) return catalog;
	const transitions = requireRecords(catalog.transitions, "transitions").filter(
		(transition) => transition.id === transitionId,
	);
	if (transitions.length === 0) {
		throw new Error(`unknown transition ID: ${transitionId}`);
	}
	return { ...catalog, transitions };
}

function requireRecords(value: unknown, name: string): Record<string, unknown>[] {
	if (
		!Array.isArray(value) ||
		!value.every(
			(item) => item !== null && typeof item === "object" && !Array.isArray(item),
		)
	) {
		throw new Error(`native ${name} catalog is invalid`);
	}
	return value as Record<string, unknown>[];
}
