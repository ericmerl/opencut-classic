import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { browserRequestFingerprint } from "./browser-operation-receipt-contract";

describe("browser operation receipt canonical fingerprints", () => {
	test("matches both cross-runtime canonical projection digests", async () => {
		const fixtures = [
			[
				"rust-authored-project-v2.json",
				"2648107f8035791b951903b65c1899847dcd8aeaae5f5141737426922348106b",
			],
			[
				"js-adapter-project-v2.json",
				"62a26c353c0751924733f40f476425a0bf9a3722c42975a32bebbd7a8d966554",
			],
		] as const;
		for (const [name, digest] of fixtures) {
			const text = (
				await Bun.file(
					join(
						import.meta.dir,
						"../../../rust/crates/canonical-json/tests/fixtures",
						name,
					),
				).text()
			).replace(/\r?\n$/, "");
			expect(browserRequestFingerprint(JSON.parse(text))).toBe(digest);
		}
	});

	test("rejects values the browser canonical serializer cannot fingerprint", () => {
		expect(() =>
			browserRequestFingerprint({ value: Number.MAX_SAFE_INTEGER + 1 }),
		).toThrow("unsafe integer");
		expect(() =>
			browserRequestFingerprint({ value: "invalid-\ud800" }),
		).toThrow("invalid Unicode");
	});
});
