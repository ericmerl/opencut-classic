import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { captionLayoutEvidenceSchema } from "./edit-plan-preflight-contract";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function face() {
	const identity = {
		provenance: "bundled-font-bytes",
		family: "TikTok Sans",
		style: "normal",
		weight: "300 900",
		stretch: "75% 125%",
		unicodeRange: "U+0-10FFFF",
		featureSettings: "normal",
		display: "block",
		byteSha256: "0".repeat(64),
	};
	return { ...identity, identitySha256: digest(JSON.stringify(identity)) };
}

function evidence() {
	const matchedFace = face();
	const descriptorBase = {
		family: "TikTok Sans",
		style: "normal",
		weight: "bold",
		stretch: "normal",
		css: 'normal bold 16px "TikTok Sans"',
	};
	const rect = { left: 108, top: 1700, width: 864, height: 120 };
	return {
		layoutVersion: "opencut.caption-layout.v1",
		layoutEngine: "browser-canvas-2d",
		geometryVersion: "opencut.caption-geometry.v1",
		measurement: "opencut.text.measureTextLayout",
		fontReadiness: {
			status: "ready",
			families: ["TikTok Sans"],
			descriptors: [
				{
					...descriptorBase,
					identitySha256: digest(JSON.stringify(descriptorBase)),
					matchedFaceIdentities: [matchedFace.identitySha256],
					matchedFaces: [matchedFace],
				},
			],
			descriptorsSha256: "1".repeat(64),
		},
		captions: [
			{
				operationIndex: 0,
				captionIndex: 0,
				elementName: "Caption 1",
				fontDescriptorCss: descriptorBase.css,
				geometry: {
					version: "opencut.caption-geometry.v1",
					measurement: "opencut.text.measureTextLayout",
					canvas: { width: 1080, height: 1920 },
					position: { x: 0, y: 812 },
					lineCount: 2,
					lines: [0, 1].map((index) => ({
						index,
						text: `line ${index + 1}`,
						width: 400,
						ascent: 40,
						descent: 12,
						anchorY: 1740 + index * 60,
						box: { left: 340, top: 1700 + index * 60, width: 400, height: 52 },
					})),
					block: rect,
					bubble: { ...rect, cornerRadius: 12 },
					visual: rect,
					overflow: { left: 0, top: 0, right: 0, bottom: 0 },
					clipped: false,
					safeZone: {
						rect: { left: 108, top: 96, width: 864, height: 1728 },
						inside: true,
						overflow: { left: 0, top: 0, right: 0, bottom: 0 },
					},
				},
			},
		],
		geometrySha256: "2".repeat(64),
	};
}

describe("caption layout evidence contract", () => {
	test("accepts complete browser-materialized evidence", () => {
		expect(captionLayoutEvidenceSchema.parse(evidence())).toEqual(
			JSON.parse(JSON.stringify(evidence())),
		);
	});

	test("rejects evidence measured by anything but the renderer's function", () => {
		const value = evidence();
		value.measurement = "opencut.text.measureTextBlock";
		expect(() => captionLayoutEvidenceSchema.parse(value)).toThrow();
	});

	test("rejects geometry with missing lines or unknown fields", () => {
		const missingLines = evidence();
		missingLines.captions[0]!.geometry.lines = [];
		expect(() => captionLayoutEvidenceSchema.parse(missingLines)).toThrow();

		const extraField = evidence() as Record<string, unknown>;
		extraField.notes = "unexpected";
		expect(() => captionLayoutEvidenceSchema.parse(extraField)).toThrow();
	});

	test("rejects a bundled face without its byte hash", () => {
		const value = evidence();
		const [descriptor] = value.fontReadiness.descriptors;
		const stripped = { ...descriptor!.matchedFaces[0]! } as Record<
			string,
			unknown
		>;
		stripped.byteSha256 = "not-a-digest";
		descriptor!.matchedFaces = [stripped as never];
		expect(() => captionLayoutEvidenceSchema.parse(value)).toThrow();
	});
});
