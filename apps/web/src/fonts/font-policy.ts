/**
 * Whether this editor may fetch fonts from third-party hosts at run time. The
 * managed editor that the MCP server launches must not: every face it renders
 * has to come from bundled bytes or the local system so receipts can name
 * the exact face. The interactive editor keeps the Google Fonts catalog.
 */
export type ThirdPartyFontFetchPolicy = "allowed" | "blocked";

let policy: ThirdPartyFontFetchPolicy = "allowed";

export function setThirdPartyFontFetchPolicy(
	next: ThirdPartyFontFetchPolicy,
): void {
	policy = next;
}

export function thirdPartyFontFetchPolicy(): ThirdPartyFontFetchPolicy {
	return policy;
}

export function canFetchThirdPartyFonts(): boolean {
	return policy === "allowed";
}
