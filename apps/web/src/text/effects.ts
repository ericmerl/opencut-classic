import * as nativeWasm from "opencut-wasm";
import type {
	ResolvedTextEffectGeometry,
	TextOutline,
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
	const outline: TextOutline = {
		color: readString({
			params,
			key: "outline.color",
			fallback: contract.outline.default.color,
		}),
		width: readNumber({
			params,
			key: "outline.width",
			fallback: contract.outline.default.width,
		}),
		join: readOutlineJoin({
			params,
			key: "outline.join",
			fallback: contract.outline.default.join,
		}),
	};
	const shadow: TextShadow = {
		color: readString({
			params,
			key: "shadow.color",
			fallback: contract.shadow.default.color,
		}),
		offsetX: readNumber({
			params,
			key: "shadow.offsetX",
			fallback: contract.shadow.default.offsetX,
		}),
		offsetY: readNumber({
			params,
			key: "shadow.offsetY",
			fallback: contract.shadow.default.offsetY,
		}),
		blur: readNumber({
			params,
			key: "shadow.blur",
			fallback: contract.shadow.default.blur,
		}),
	};
	return resolveTextEffectStyle({ outline, shadow, canvasHeight });
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

function readString({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: string;
}): string {
	const value = params[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function readNumber({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${key} must be a finite number`);
	}
	return value;
}

function readOutlineJoin({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: TextOutline["join"];
}): TextOutline["join"] {
	const value = params[key];
	if (value === undefined) return fallback;
	if (value !== "round" && value !== "bevel" && value !== "miter") {
		throw new Error(`${key} is invalid`);
	}
	return value;
}
