import type { SceneTracks } from "@/timeline";
import { sha256Bytes } from "./preview-render-common";

const FONT_READY_TIMEOUT_MS = 30_000;

export async function waitForFonts(tracks: SceneTracks): Promise<{
	status: "ready";
	families: string[];
	descriptors: Array<{
		family: string;
		style: string;
		weight: string;
		stretch: string;
		css: string;
		identitySha256: string;
		matchedFaceIdentities: string[];
		matchedFaces: Array<{
			provenance: "font-face-set" | "system-local-font-face";
			family: string;
			style: string;
			weight: string;
			stretch: string;
			unicodeRange: string;
			featureSettings: string;
			display: string;
			identitySha256: string;
		}>;
	}>;
	descriptorsSha256: string;
}> {
	if (!document.fonts) throw new Error("font readiness API is unavailable");
	const requested = collectFontDescriptors(tracks);
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
			document.fonts.add(localFace);
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

function collectFontDescriptors(tracks: SceneTracks): Array<{
	family: string;
	style: string;
	weight: string;
	stretch: string;
	css: string;
}> {
	const values = new Map<
		string,
		{
			family: string;
			style: string;
			weight: string;
			stretch: string;
			css: string;
		}
	>();
	const add = (params: {
		fontFamily?: unknown;
		fontStyle?: unknown;
		fontWeight?: unknown;
		fontStretch?: unknown;
	}) => {
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
		const descriptor = { family, style, weight, stretch, css };
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
	visit(tracks);
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
			normalizeFontWeight(face.weight) !==
				normalizeFontWeight(descriptor.weight) ||
			normalizeFontStretch(face.stretch) !==
				normalizeFontStretch(descriptor.stretch)
		) {
			continue;
		}
		const evidence = {
			provenance,
			family: normalizeFontFamily(face.family),
			style: normalizeFontStyle(face.style),
			weight: normalizeFontWeight(face.weight),
			stretch: normalizeFontStretch(face.stretch),
			unicodeRange: face.unicodeRange,
			featureSettings: face.featureSettings,
			display: face.display,
		};
		unique.set(JSON.stringify(evidence), evidence);
	}
	return [...unique.values()];
}

type FontFaceEvidence = {
	provenance: "font-face-set" | "system-local-font-face";
	family: string;
	style: string;
	weight: string;
	stretch: string;
	unicodeRange: string;
	featureSettings: string;
	display: string;
	identitySha256: string;
};

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
