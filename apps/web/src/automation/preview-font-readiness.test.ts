/// <reference types="bun" />

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

interface FakeDescriptors {
	style?: string;
	weight?: string;
	stretch?: string;
}

class FakeFontFace {
	readonly family: string;
	readonly style: string;
	readonly weight: string;
	readonly stretch: string;
	readonly unicodeRange = "U+0-10FFFF";
	readonly featureSettings = "normal";
	readonly display = "auto";
	status = "loaded";

	constructor(family: string, _source: unknown, descriptors: FakeDescriptors = {}) {
		this.family = family;
		this.style = descriptors.style ?? "normal";
		this.weight = descriptors.weight ?? "normal";
		this.stretch = descriptors.stretch ?? "normal";
	}

	async load(): Promise<this> {
		return this;
	}
}

const bundledFace = new FakeFontFace("TikTok Sans", null, {
	style: "normal",
	weight: "300 900",
	stretch: "75% 125%",
});
const BUNDLED_SHA256 = "a".repeat(64);

mock.module("@/fonts/bundled-fonts", () => ({
	ensureBundledFonts: async () => [],
	bundledFaceEvidence: (face: unknown) =>
		face === bundledFace
			? { byteSha256: BUNDLED_SHA256, path: "/fonts/bundled/tiktok-sans.ttf" }
			: null,
}));

const { waitForFontDescriptors } = await import("./preview-font-readiness");

describe("font readiness evidence", () => {
	beforeAll(() => {
		const fonts = {
			ready: Promise.resolve(),
			load: async () => [] as FakeFontFace[],
			check: () => true,
			[Symbol.iterator]: function* () {
				yield bundledFace;
			},
		};
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { fonts },
		});
		Object.defineProperty(globalThis, "FontFace", {
			configurable: true,
			value: FakeFontFace,
		});
	});
	afterAll(() => {
		Reflect.deleteProperty(globalThis, "document");
		Reflect.deleteProperty(globalThis, "FontFace");
	});

	test("a variable bundled face matches a single weight and reports its byte hash", async () => {
		const result = await waitForFontDescriptors([
			{
				family: "TikTok Sans",
				style: "normal",
				weight: "700",
				stretch: "normal",
				css: 'normal 700 16px "TikTok Sans"',
			},
		]);

		expect(result.families).toEqual(["TikTok Sans"]);
		const [descriptor] = result.descriptors;
		if (!descriptor) throw new Error("expected one descriptor");
		expect(descriptor.matchedFaces).toHaveLength(1);
		const [face] = descriptor.matchedFaces;
		if (!face) throw new Error("expected one face");
		expect(face).toMatchObject({
			provenance: "bundled-font-bytes",
			family: "TikTok Sans",
			weight: "300 900",
			stretch: "75% 125%",
			byteSha256: BUNDLED_SHA256,
		});
		const { identitySha256, ...identity } = face;
		expect(identitySha256).toBe(
			createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
		);
		expect(descriptor.matchedFaceIdentities).toEqual([identitySha256]);
	});

	test("a weight outside the variable range falls back to the local probe", async () => {
		const result = await waitForFontDescriptors([
			{
				family: "TikTok Sans",
				style: "normal",
				weight: "200",
				stretch: "normal",
				css: 'normal 200 16px "TikTok Sans"',
			},
		]);

		const face = result.descriptors[0]?.matchedFaces[0];
		if (!face) throw new Error("expected a probe face");
		expect(face.provenance).toBe("system-local-font-face");
		expect(face.weight).toBe("200");
		expect("byteSha256" in face).toBe(false);
	});
});
