import type { SceneTracks } from "@/timeline";
import { bundledFaceEvidence, ensureBundledFonts } from "@/fonts/bundled-fonts";
import { sha256Bytes } from "./preview-render-common";

const FONT_READY_TIMEOUT_MS = 30_000;

export type FontFaceProvenance =
	| "bundled-font-bytes"
	| "font-face-set"
	| "system-local-font-face";

export interface FontDescriptorRequest {
	family: string;
	style: string;
	weight: string;
	stretch: string;
	css: string;
}

export interface FontReadinessEvidence {
	status: "ready";
	families: string[];
	descriptors: Array<
		FontDescriptorRequest & {
			identitySha256: string;
			matchedFaceIdentities: string[];
			matchedFaces: FontFaceEvidence[];
		}
	>;
	descriptorsSha256: string;
}

/** Readiness for every font descriptor the given scene tracks reference. */
export function waitForFonts(
	tracks: SceneTracks | readonly SceneTracks[],
): Promise<FontReadinessEvidence> {
	return waitForFontDescriptors(
		collectFontDescriptors(Array.isArray(tracks) ? tracks : [tracks]),
	);
}

/**
 * The one readiness procedure every receipt shares: register the bundled
 * faces, load and check each descriptor, then record the exact loaded faces
 * that match it. Preview, export, comparison, and caption preflight all call
 * this so their evidence is comparable.
 */
export async function waitForFontDescriptors(
	requested: readonly FontDescriptorRequest[],
): Promise<FontReadinessEvidence> {
	if (!document.fonts) throw new Error("font readiness API is unavailable");
	await ensureBundledFonts();
	const loadedByDescriptor = await Promise.race([
		Promise.all([
			document.fonts.ready.then(() => [] as FontFace[]),
			...requested.map((descriptor) => document.fonts.load(descriptor.css)),
		]),
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("font readiness timed out")),
				FONT_READY_TIMEOUT_MS,
			),
		),
	]);
	const descriptors = [];
	for (const [index, descriptor] of requested.entries()) {
		if (!document.fonts.check(descriptor.css)) {
			throw new Error(`font failed readiness verification: ${descriptor.css}`);
		}
		const loadedForDescriptor = loadedByDescriptor[index + 1] ?? [];
		let matchingFaces = exactFontFaces({
			faces: [...loadedForDescriptor, ...document.fonts],
			descriptor,
			provenance: "font-face-set",
		});
		if (matchingFaces.length === 0) {
			// Probe that the family is installed locally, but never add the probe
			// face to the document: `local(family)` resolves to the regular file,
			// and registering it under bold or italic descriptors would make every
			// later canvas draw use regular glyphs without synthesis. Style and
			// weight resolution stays with the platform font matcher, which is
			// exactly what the export path uses.
			const localFace = new FontFace(
				descriptor.family,
				`local(${JSON.stringify(descriptor.family)})`,
				{
					style: descriptor.style,
					weight: descriptor.weight,
					stretch: descriptor.stretch,
				},
			);
			await localFace.load();
			matchingFaces = exactFontFaces({
				faces: [localFace],
				descriptor,
				provenance: "system-local-font-face",
			});
		}
		if (matchingFaces.length === 0) {
			throw new Error(
				`no exact loaded face matches persisted font descriptor: ${descriptor.css}`,
			);
		}
		const matchedFaces = await Promise.all(
			matchingFaces.map(async (face) => ({
				...face,
				identitySha256: await sha256Bytes(
					new TextEncoder().encode(JSON.stringify(face)),
				),
			})),
		);
		matchedFaces.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
		const matchedFaceIdentities = matchedFaces
			.map(({ identitySha256 }) => identitySha256)
			.sort((left, right) => left.localeCompare(right));
		const identitySha256 = await sha256Bytes(
			new TextEncoder().encode(JSON.stringify(descriptor)),
		);
		descriptors.push({
			...descriptor,
			identitySha256,
			matchedFaceIdentities,
			matchedFaces,
		});
	}
	return {
		status: "ready",
		families: [...new Set(requested.map(({ family }) => family))].sort(),
		descriptors,
		descriptorsSha256: await sha256Bytes(
			new TextEncoder().encode(JSON.stringify(descriptors)),
		),
	};
}

/** The descriptor a text element's font params request, in readiness form. */
export function fontDescriptorFromParams(params: {
	fontFamily?: unknown;
	fontStyle?: unknown;
	fontWeight?: unknown;
	fontStretch?: unknown;
}): FontDescriptorRequest {
	const family =
		typeof params.fontFamily === "string" && params.fontFamily
			? params.fontFamily
			: "Arial";
	const style =
		typeof params.fontStyle === "string" ? params.fontStyle : "normal";
	const weight =
		typeof params.fontWeight === "string" ||
		typeof params.fontWeight === "number"
			? String(params.fontWeight)
			: "normal";
	const stretch =
		typeof params.fontStretch === "string" ? params.fontStretch : "normal";
	const escapedFamily = family.replaceAll('"', '\\"');
	const css = `${style} ${weight} ${stretch === "normal" ? "" : `${stretch} `}16px "${escapedFamily}"`;
	return { family, style, weight, stretch, css };
}

function collectFontDescriptors(
	trackSets: readonly SceneTracks[],
): FontDescriptorRequest[] {
	const values = new Map<string, FontDescriptorRequest>();
	const add = (params: {
		fontFamily?: unknown;
		fontStyle?: unknown;
		fontWeight?: unknown;
		fontStretch?: unknown;
	}) => {
		const descriptor = fontDescriptorFromParams(params);
		values.set(JSON.stringify(descriptor), descriptor);
	};
	const visit = (sceneTracks: SceneTracks) => {
		for (const track of [
			sceneTracks.main,
			...sceneTracks.overlay,
			...sceneTracks.audio,
		]) {
			for (const element of track.elements) {
				if (element.type === "text") add(element.params);
				if ("masks" in element) {
					for (const mask of element.masks ?? []) {
						if (mask.type === "text") add(mask.params);
					}
				}
				if (element.type === "compound") visit(element.tracks);
			}
		}
	};
	for (const tracks of trackSets) visit(tracks);
	return [...values.values()].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function normalizeFontFamily(value: string): string {
	return value.trim().replace(/^['"]|['"]$/g, "");
}

function exactFontFaces({
	faces,
	descriptor,
	provenance,
}: {
	faces: FontFace[];
	descriptor: {
		family: string;
		style: string;
		weight: string;
		stretch: string;
	};
	provenance: "font-face-set" | "system-local-font-face";
}) {
	const unique = new Map<string, Omit<FontFaceEvidence, "identitySha256">>();
	for (const face of faces) {
		if (
			face.status !== "loaded" ||
			normalizeFontFamily(face.family).toLocaleLowerCase() !==
				normalizeFontFamily(descriptor.family).toLocaleLowerCase() ||
			normalizeFontStyle(face.style) !== normalizeFontStyle(descriptor.style) ||
			!axisCovers(
				normalizeFontWeight(face.weight),
				normalizeFontWeight(descriptor.weight),
			) ||
			!axisCovers(
				normalizeFontStretch(face.stretch),
				normalizeFontStretch(descriptor.stretch),
			)
		) {
			continue;
		}
		// A face registered from bundled bytes carries its byte hash so the
		// receipt proves which audited file rendered the text.
		const bundled = provenance === "font-face-set" ? bundledFaceEvidence(face) : null;
		const evidence = {
			provenance: bundled ? ("bundled-font-bytes" as const) : provenance,
			family: normalizeFontFamily(face.family),
			style: normalizeFontStyle(face.style),
			weight: normalizeFontWeight(face.weight),
			stretch: normalizeFontStretch(face.stretch),
			unicodeRange: face.unicodeRange,
			featureSettings: face.featureSettings,
			display: face.display,
			...(bundled ? { byteSha256: bundled.byteSha256 } : {}),
		};
		unique.set(JSON.stringify(evidence), evidence);
	}
	return [...unique.values()];
}

export type FontFaceEvidence = {
	provenance: FontFaceProvenance;
	family: string;
	style: string;
	weight: string;
	stretch: string;
	unicodeRange: string;
	featureSettings: string;
	display: string;
	byteSha256?: string;
	identitySha256: string;
};

/**
 * A variable face declares an axis as a range ("300 900", "75% 125%"), so it
 * matches every single value inside that range; a static face must match the
 * requested value exactly.
 */
function axisCovers(faceValue: string, requestedValue: string): boolean {
	const requested = Number.parseFloat(requestedValue);
	const parts = faceValue.split(/\s+/).filter(Boolean);
	if (parts.length === 2) {
		const [low, high] = parts.map((part) => Number.parseFloat(part));
		return (
			Number.isFinite(low) &&
			Number.isFinite(high) &&
			Number.isFinite(requested) &&
			requested >= Math.min(low, high) &&
			requested <= Math.max(low, high)
		);
	}
	return faceValue === requestedValue;
}

function normalizeFontStyle(value: string): string {
	return value.trim().toLocaleLowerCase() || "normal";
}

function normalizeFontWeight(value: string): string {
	const normalized = value.trim().toLocaleLowerCase();
	if (normalized === "normal") return "400";
	if (normalized === "bold") return "700";
	return normalized;
}

function normalizeFontStretch(value: string): string {
	const normalized = value.trim().toLocaleLowerCase();
	const named: Record<string, string> = {
		"ultra-condensed": "50%",
		"extra-condensed": "62.5%",
		condensed: "75%",
		"semi-condensed": "87.5%",
		normal: "100%",
		"semi-expanded": "112.5%",
		expanded: "125%",
		"extra-expanded": "150%",
		"ultra-expanded": "200%",
	};
	return named[normalized] ?? normalized;
}
