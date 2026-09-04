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
		const read = (opencutWasm as { captionStylePresets?: () => { presets: CaptionStylePreset[] } })
			.captionStylePresets;
		if (typeof read !== "function") {
			throw new Error("the native runtime does not export caption style presets");
		}
		cachedPresets = read().presets;
	}
	return cachedPresets;
}

/**
 * Expands `style.preset` into the concrete style Rust defines for it, with
 * every explicit override in `style` applied on top. Nested background and
 * placement objects merge field by field so an override can change one colour
 * without restating the preset's padding. Throws for an unknown preset so the
 * browser never silently substitutes a style the plan did not name.
 */
export function applyCaptionStylePreset(
	style: SubtitleStyleOverrides | undefined,
): SubtitleStyleOverrides | undefined {
	if (!style?.preset) return style;
	const preset = listCaptionStylePresets().find(
		(candidate) => candidate.id === style.preset,
	);
	if (!preset) throw new Error(`unknown caption style preset: ${style.preset}`);
	const { preset: _id, ...overrides } = style;
	const base = preset.style as SubtitleStyleOverrides;
	return {
		...stripUndefined(base),
		...stripUndefined(overrides),
		...(base.background || overrides.background
			? {
					background: {
						...(base.background ?? { enabled: false, color: "transparent" }),
						...stripUndefined(overrides.background ?? {}),
					},
				}
			: {}),
		...(base.placement || overrides.placement
			? {
					placement: {
						...stripUndefined(base.placement ?? {}),
						...stripUndefined(overrides.placement ?? {}),
					},
				}
			: {}),
	};
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}
