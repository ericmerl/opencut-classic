import * as opencutWasm from "opencut-wasm";
import type { CaptionStylePreset } from "opencut-wasm";
import type { SubtitleStyleOverrides } from "./types";

/**
 * The reusable caption presets, as Rust defines them. Cached after the first
 * read because the table is static for a build. The namespace import keeps
 * the table a call-time dependency, so a runtime without the export fails
 * here with a clear message instead of at module link time.
 */
let cachedPresets: CaptionStylePreset[] | null = null;

export function listCaptionStylePresets(): CaptionStylePreset[] {
	if (!cachedPresets) {
		const read = (
			opencutWasm as {
				captionStylePresets?: () => { presets: CaptionStylePreset[] };
			}
		).captionStylePresets;
		if (typeof read !== "function") {
			throw new Error(
				"the native runtime does not export caption style presets",
			);
		}
		cachedPresets = read().presets;
	}
	return cachedPresets;
}

/**
 * Expands `style.preset` exactly as the Rust evaluator does: the preset's
 * style with every explicit field of `style` applied on top, nested
 * background and placement merged field by field. Throws for an unknown
 * preset so the browser never substitutes a style the plan did not name.
 */
export function applyCaptionStylePreset(
	style: SubtitleStyleOverrides | undefined,
): SubtitleStyleOverrides | undefined {
	if (!style) return undefined;
	const resolve = (
		opencutWasm as {
			resolveCaptionStyle?: (options: {
				style: SubtitleStyleOverrides;
			}) =>
				| { status: "resolved"; style: SubtitleStyleOverrides }
				| { status: "rejected"; reason: string };
		}
	).resolveCaptionStyle;
	if (typeof resolve !== "function") {
		throw new Error("the native runtime does not resolve caption styles");
	}
	const response = resolve({ style: stripUndefinedDeep(style) });
	if (response.status === "rejected") throw new Error(response.reason);
	return stripUndefinedDeep(response.style);
}

/** Removes undefined fields so the value crosses the WASM boundary cleanly. */
function stripUndefinedDeep<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
