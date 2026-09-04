/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";

const stylesheetLinks: string[] = [];
mock.module("@/fonts/bundled-fonts", () => ({
	ensureBundledFonts: async () => [],
	isBundledFontFamily: (family: string) => family === "TikTok Sans",
}));

const { loadFullFont } = await import("./google-fonts");
const { setThirdPartyFontFetchPolicy, thirdPartyFontFetchPolicy } =
	await import("./font-policy");

describe("third-party font fetch policy", () => {
	afterEach(() => {
		setThirdPartyFontFetchPolicy("allowed");
		stylesheetLinks.length = 0;
		Reflect.deleteProperty(globalThis, "document");
	});

	test("defaults to allowed", () => {
		expect(thirdPartyFontFetchPolicy()).toBe("allowed");
	});

	test("a blocked editor never appends a Google Fonts stylesheet", async () => {
		installDocument();
		setThirdPartyFontFetchPolicy("blocked");
		await loadFullFont({ family: "Anton" });
		expect(stylesheetLinks).toEqual([]);
	});

	test("a bundled family never reaches the Google Fonts path either way", async () => {
		installDocument();
		await loadFullFont({ family: "TikTok Sans" });
		expect(stylesheetLinks).toEqual([]);
	});

	test("an allowed editor still fetches the catalog family", async () => {
		installDocument();
		await loadFullFont({ family: "Oswald" });
		expect(stylesheetLinks).toHaveLength(1);
		expect(stylesheetLinks[0]).toContain("fonts.googleapis.com/css2?family=Oswald");
	});
});

function installDocument(): void {
	const link = {
		rel: "",
		href: "",
		addEventListener: (event: string, handler: () => void) => {
			if (event === "load") queueMicrotask(handler);
		},
	};
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => link,
			head: {
				appendChild: (element: { href: string }) => {
					stylesheetLinks.push(element.href);
				},
			},
			fonts: { load: async () => [] },
		},
	});
}
