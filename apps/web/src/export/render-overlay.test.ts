import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import type { MediaTime } from "@/wasm";

mock.module("@/wasm", () => ({ TICKS_PER_SECOND: 120_000 }));

const { resolveExportRenderOverlay } = await import("./render-overlay");

describe("immutable export render overlays", () => {
	test("resolves canvas, safe zones, layout, reframe, captions, tracks, cover, and frame schedule", () => {
		const source = tracks();
		const before = JSON.stringify(source);
		const result = resolveExportRenderOverlay({
			tracks: source,
			sourceCanvasSize: { width: 1920, height: 1080 },
			sourceFps: { numerator: 30, denominator: 1 },
			format: "mp4",
			videoCodec: "avc",
			quality: "high",
			includeAudio: true,
			overlay: {
				version: 1,
				canvasSize: { width: 1080, height: 1920 },
				safeZones: [
					{ id: "subject", x: 0.1, y: 0.1, width: 0.8, height: 0.6 },
					{ id: "caption", x: 0.1, y: 0.72, width: 0.8, height: 0.18 },
				],
				tracks: { exclude: ["graphic-track"] },
				elements: [
					{
						elementId: "video-1",
						layout: {
							positionX: 12,
							scaleX: 1.2,
							targetSafeZoneId: "subject",
						},
						reframe: { mode: "cover" },
						subjectSafeFocalPolicy: {
							kind: "safe-zone-center",
							safeZoneId: "subject",
						},
					},
				],
				captions: {
					mode: "on",
					trackIds: ["caption-track"],
					style: {
						fontFamily: "TikTok Sans",
						fontWeight: "bold",
						backgroundPerLine: true,
						highlightEnabled: true,
						highlightColor: "#ffcc00",
					},
					positionSafeZoneId: "caption",
				},
				coverFrame: {
					kind: "media-time",
					ticks: 60_000,
					rounding: "exact",
				},
			},
		});

		expect(JSON.stringify(source)).toBe(before);
		expect(result.tracks.overlay.map((track) => track.id)).toEqual([
			"caption-track",
		]);
		const video = result.tracks.main.elements[0]!;
		expect(video.params).toMatchObject({
			"transform.positionX": 12,
			"transform.scaleX": 1.2,
			"reframe.mode": "cover",
			"reframe.targetX": 0.1,
			"reframe.targetY": 0.1,
			"reframe.targetWidth": 0.8,
			"reframe.targetHeight": 0.6,
			"reframe.focalX": 0.5,
			"reframe.focalY": 0.4,
		});
		const caption = result.tracks.overlay[0]!.elements[0]!;
		expect(caption.params).toMatchObject({
			fontFamily: "TikTok Sans",
			fontWeight: "bold",
			"background.perLine": true,
			"highlight.enabled": true,
			"highlight.color": "#ffcc00",
			"transform.positionX": 0,
		});
		expect(caption.params["transform.positionY"]).toBeCloseTo(595.2);
		expect(result.specification).toMatchObject({
			canvasSize: { width: 1080, height: 1920 },
			tracks: {
				includedTrackIds: ["main-track", "caption-track", "audio-track"],
				excludedTrackIds: ["graphic-track"],
			},
			coverFrame: { frameIndex: 15, resolvedTicks: 60_000 },
			output: { format: "mp4", videoCodec: "avc", includeAudio: true },
			frameSchedule: {
				durationTicks: 240_000,
				ticksPerFrame: 4_000,
				frameCount: 60,
				firstFrameTicks: 0,
				lastFrameTicks: 236_000,
			},
		});
	});

	test("captions-off excludes only the selected caption tracks", () => {
		const result = resolveExportRenderOverlay({
			tracks: tracks(),
			sourceCanvasSize: { width: 1920, height: 1080 },
			sourceFps: { numerator: 30, denominator: 1 },
			format: "webm",
			videoCodec: "vp9",
			quality: "medium",
			includeAudio: false,
			overlay: {
				version: 1,
				captions: { mode: "off", trackIds: ["caption-track"] },
			},
		});
		expect(result.tracks.overlay.map((track) => track.id)).toEqual([
			"graphic-track",
		]);
		expect(result.specification.captions).toMatchObject({
			mode: "off",
			trackIds: ["caption-track"],
		});
	});

	test("captions-off can remove selected elements without dropping their track", () => {
		const source = tracks();
		const captionTrack = source.overlay[0]!;
		if (captionTrack.type !== "text") throw new Error("expected text track");
		captionTrack.elements.push({
			id: "caption-2",
			name: "Second caption",
			type: "text",
			duration: mt(120_000),
			startTime: mt(120_000),
			trimStart: mt(0),
			trimEnd: mt(0),
			params: { content: "Still here" },
		});
		const result = resolveExportRenderOverlay({
			tracks: source,
			sourceCanvasSize: { width: 1920, height: 1080 },
			sourceFps: { numerator: 30, denominator: 1 },
			format: "webm",
			videoCodec: "vp9",
			quality: "medium",
			includeAudio: false,
			overlay: {
				version: 1,
				captions: { mode: "off", elementIds: ["caption-1"] },
			},
		});
		const renderedCaptions = result.tracks.overlay.find(
			(track) => track.id === "caption-track",
		);
		expect(renderedCaptions?.elements.map((element) => element.id)).toEqual([
			"caption-2",
		]);
		expect(result.specification.captions.elementIds).toEqual(["caption-1"]);
		expect(source.overlay[0]!.elements).toHaveLength(2);
	});

	test("fails closed for dangling overlay references and unsupported codecs", () => {
		const base = {
			tracks: tracks(),
			sourceCanvasSize: { width: 1920, height: 1080 },
			sourceFps: { numerator: 30, denominator: 1 },
			quality: "high" as const,
			includeAudio: true,
		};
		expect(() =>
			resolveExportRenderOverlay({
				...base,
				format: "mp4",
				videoCodec: "vp9",
			}),
		).toThrow("video codec vp9 is not supported for mp4");
		expect(() =>
			resolveExportRenderOverlay({
				...base,
				format: "mp4",
				videoCodec: "avc",
				overlay: {
					version: 1,
					elements: [{ elementId: "missing" }],
				},
			}),
		).toThrow("export overlay element not found: missing");
	});
});

function tracks(): SceneTracks {
	return {
		main: {
			id: "main-track",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				{
					id: "video-1",
					name: "Video",
					type: "video",
					mediaId: "media-1",
					duration: mt(240_000),
					startTime: mt(0),
					trimStart: mt(0),
					trimEnd: mt(0),
					params: {},
				},
			],
		},
		overlay: [
			{
				id: "caption-track",
				name: "Captions",
				type: "text",
				hidden: false,
				elements: [
					{
						id: "caption-1",
						name: "Caption",
						type: "text",
						duration: mt(120_000),
						startTime: mt(0),
						trimStart: mt(0),
						trimEnd: mt(0),
						params: { content: "Hello" },
					},
				],
			},
			{
				id: "graphic-track",
				name: "Graphics",
				type: "graphic",
				hidden: false,
				elements: [],
			},
		],
		audio: [
			{
				id: "audio-track",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [],
			},
		],
	};
}

function mt(ticks: number): MediaTime {
	return ticks as MediaTime;
}
