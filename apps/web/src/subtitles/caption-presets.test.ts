/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";

const presets = [
	{
		id: "tiktok-classic",
		description: "Bold white TikTok Sans on a black block.",
		style: {
			fontSize: 6,
			fontFamily: "TikTok Sans",
			color: "#ffffff",
			background: {
				enabled: true,
				color: "#000000",
				cornerRadius: 8,
				paddingX: 16,
				paddingY: 8,
			},
			textAlign: "center",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			placement: { verticalAlign: "bottom", marginVerticalRatio: 0.12 },
		},
	},
];
mock.module("opencut-wasm", () => ({
	captionStylePresets: () => ({ presets }),
}));

const { applyCaptionStylePreset, listCaptionStylePresets } =
	await import("./caption-presets");

describe("caption style presets", () => {
	test("lists the Rust-defined presets", () => {
		expect(listCaptionStylePresets().map((preset) => preset.id)).toEqual([
			"tiktok-classic",
		]);
	});

	test("passes styles without a preset through untouched", () => {
		const style = { fontFamily: "Montserrat", fontSize: 4 };
		expect(applyCaptionStylePreset(style)).toBe(style);
		expect(applyCaptionStylePreset(undefined)).toBeUndefined();
	});

	test("expands a preset and lets explicit fields win, merging nested objects", () => {
		expect(
			applyCaptionStylePreset({
				preset: "tiktok-classic",
				color: "#ffff00",
				background: { enabled: true, color: "#ff0000" },
				placement: { verticalAlign: "top" },
			}),
		).toEqual({
			fontSize: 6,
			fontFamily: "TikTok Sans",
			color: "#ffff00",
			textAlign: "center",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			background: {
				enabled: true,
				color: "#ff0000",
				cornerRadius: 8,
				paddingX: 16,
				paddingY: 8,
			},
			placement: { verticalAlign: "top", marginVerticalRatio: 0.12 },
		});
	});

	test("rejects an unknown preset instead of substituting a style", () => {
		expect(() => applyCaptionStylePreset({ preset: "nope" })).toThrow(
			"unknown caption style preset: nope",
		);
	});
});
