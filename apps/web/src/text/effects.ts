import * as nativeWasm from "opencut-wasm";
import type {
	ResolvedTextEffectBounds,
	ResolvedTextEffectGeometry,
	TextOutline,
	TextEffectExtents,
	TextEffectRect,
	TextShadow,
	TextStyleContract,
} from "opencut-wasm";
import type { ParamValues } from "@/params";

let cachedContract: TextStyleContract | null = null;

/** Rust-owned defaults and ranges used by UI controls and legacy elements. */
export function getTextStyleContract(): TextStyleContract {
	cachedContract ??= nativeWasm.textStyleContract();
	return cachedContract;
}

export function resolveTextEffects({
	params,
	canvasHeight,
}: {
	params: ParamValues;
	canvasHeight: number;
}): ResolvedTextEffectGeometry {
	const contract = getTextStyleContract();
	return resolveTextEffectParams({
		params,
		pixelsPerUnit: canvasHeight / contract.scaleReference,
	});
}

export function resolveTextEffectParams({
	params,
	pixelsPerUnit,
}: {
	params: ParamValues;
	pixelsPerUnit: number;
}): ResolvedTextEffectGeometry {
	const response = nativeWasm.resolveTextEffectParams({
		params,
		pixelsPerUnit,
	});
	if (response.status === "rejected") throw new Error(response.reason);
	return response.geometry;
}

export function resolveTextEffectStyle({
	outline,
	shadow,
	canvasHeight,
}: {
	outline?: TextOutline;
	shadow?: TextShadow;
	canvasHeight: number;
}): ResolvedTextEffectGeometry {
	const contract = getTextStyleContract();
	const response = nativeWasm.resolveTextEffectGeometry({
		outline: outline ?? contract.outline.default,
		shadow: shadow ?? contract.shadow.default,
		pixelsPerUnit: canvasHeight / contract.scaleReference,
	});
	if (response.status === "rejected") {
		throw new Error(response.reason);
	}
	return response.geometry;
}

export function resolveTextEffectBounds({
	text,
	baseVisual,
	extents,
}: {
	text: TextEffectRect;
	baseVisual: TextEffectRect;
	extents: TextEffectExtents;
}): ResolvedTextEffectBounds {
	const response = nativeWasm.resolveTextEffectBounds({
		text,
		baseVisual,
		extents,
	});
	if (response.status === "rejected") throw new Error(response.reason);
	return response.bounds;
}
