/**
 * Fonts that ship with the editor and are served from its own origin. Every
 * file is pinned by SHA-256 so a face can only be registered when its bytes are
 * exactly the audited ones, and the same hash is reported as matched-face
 * provenance wherever a receipt records font readiness. The managed editor
 * never fetches these families from a third-party host.
 */
export interface BundledFontFile {
	family: string;
	path: string;
	style: "normal" | "italic";
	/** CSS font-weight descriptor; a range for a variable face. */
	weight: string;
	/** CSS font-stretch descriptor; a range for a variable face. */
	stretch: string;
	sha256: string;
	license: "OFL-1.1";
	licensePath: string;
}

export const BUNDLED_FONT_FILES: readonly BundledFontFile[] = [
	{
		family: "TikTok Sans",
		path: "/fonts/bundled/tiktok-sans/TikTokSans[opsz,slnt,wdth,wght].ttf",
		style: "normal",
		weight: "300 900",
		stretch: "75% 125%",
		sha256: "0e7f0a3e924c9a86478fc6fc2946de2e4ab8fc704ed72ee40434ade94bb9b0c6",
		license: "OFL-1.1",
		licensePath: "/fonts/bundled/tiktok-sans/OFL.txt",
	},
	{
		family: "Montserrat",
		path: "/fonts/bundled/montserrat/Montserrat[wght].ttf",
		style: "normal",
		weight: "100 900",
		stretch: "100%",
		sha256: "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
		license: "OFL-1.1",
		licensePath: "/fonts/bundled/montserrat/OFL.txt",
	},
	{
		family: "Montserrat",
		path: "/fonts/bundled/montserrat/Montserrat-Italic[wght].ttf",
		style: "italic",
		weight: "100 900",
		stretch: "100%",
		sha256: "51607f316bc020e59f03cbf51543eecffbea501c0b31d73e5b82927c5cca442c",
		license: "OFL-1.1",
		licensePath: "/fonts/bundled/montserrat/OFL.txt",
	},
];

export const BUNDLED_FONT_FAMILIES: ReadonlySet<string> = new Set(
	BUNDLED_FONT_FILES.map((file) => file.family),
);

export function isBundledFontFamily(family: string): boolean {
	return BUNDLED_FONT_FAMILIES.has(family);
}

export interface BundledFontRegistration {
	file: BundledFontFile;
	face: FontFace;
	byteSha256: string;
}

const registrations = new Map<FontFace, BundledFontRegistration>();
let registrationPromise: Promise<BundledFontRegistration[]> | null = null;

/**
 * Registers every bundled face with the document once and resolves with the
 * registrations. Outside a browser it resolves with no registrations, and a
 * byte-hash mismatch fails the whole registration rather than serving a face
 * the audit never saw.
 */
export function ensureBundledFonts(): Promise<BundledFontRegistration[]> {
	registrationPromise ??= registerBundledFonts().catch((error) => {
		registrationPromise = null;
		throw error;
	});
	return registrationPromise;
}

/** Byte-hash provenance for a face the document loaded from bundled bytes. */
export function bundledFaceEvidence(
	face: FontFace,
): { byteSha256: string; path: string } | null {
	const registration = registrations.get(face);
	return registration
		? { byteSha256: registration.byteSha256, path: registration.file.path }
		: null;
}

async function registerBundledFonts(): Promise<BundledFontRegistration[]> {
	if (
		typeof document === "undefined" ||
		typeof FontFace === "undefined" ||
		!document.fonts
	) {
		return [];
	}
	const loaded = await Promise.all(
		BUNDLED_FONT_FILES.map(async (file) => {
			const response = await fetch(file.path);
			if (!response.ok) {
				throw new Error(
					`bundled font ${file.path} is unavailable (${response.status})`,
				);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			const byteSha256 = await sha256Hex(bytes);
			if (byteSha256 !== file.sha256) {
				throw new Error(
					`bundled font ${file.path} bytes do not match the audited hash`,
				);
			}
			const face = new FontFace(file.family, bytes, {
				style: file.style,
				weight: file.weight,
				stretch: file.stretch,
				display: "block",
			});
			await face.load();
			return { file, face, byteSha256 };
		}),
	);
	for (const registration of loaded) {
		document.fonts.add(registration.face);
		registrations.set(registration.face, registration);
	}
	return loaded;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copied = new Uint8Array(bytes.byteLength);
	copied.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
