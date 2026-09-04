/// <reference types="bun" />

import { expect, mock, test } from "bun:test";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
	parseTimecode: () => 0,
	roundToFrame: ({ time }: { time: number }) => time,
	snappedSeekTime: ({ time }: { time: number }) => time,
}));
mock.module("./canvas-utils", () => ({
	createCanvasSurface: ({
		width,
		height,
	}: {
		width: number;
		height: number;
	}) => ({
		canvas: { width, height },
		context: {},
	}),
}));
mock.module("./compositor/wasm-compositor", () => ({
	wasmCompositor: {
		ensureInitialized: () => undefined,
		getCanvas: () => ({}),
	},
}));

const { DEFAULT_FPS } = await import("@/fps/defaults");
const { CanvasRenderer } = await import("./canvas-renderer");
const { buildFrameDescriptor } = await import("./compositor/frame-descriptor");
const { buildScene } = await import("./scene-builder");
const { RootNode } = await import("./nodes/root-node");
const { VideoNode } = await import("./nodes/video-node");
const { ColorNode } = await import("./nodes/color-node");
const { TrackNode } = await import("./nodes/track-node");

test("frame descriptors carry normalized chroma controls to the shared compositor", async () => {
	const root = new RootNode({ duration: 100 });
	const renderer = new CanvasRenderer({
		width: 2,
		height: 2,
		fps: DEFAULT_FPS,
	});
	const video = new VideoNode({
		url: "blob:source",
		file: new File([], "source.mp4"),
		mediaId: "source",
		duration: 100,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: {
			position: { x: 0, y: 0 },
			scaleX: 1,
			scaleY: 1,
			rotate: 0,
		},
		opacity: 1,
		key: {
			type: "chroma",
			keyColor: "#00ff00",
			similarity: 0.2,
			softness: 0.1,
			spillSuppression: 0.5,
			enabled: true,
		},
	});
	video.resolved = {
		localTime: 0,
		transform: video.params.transform,
		opacity: 1,
		effectPasses: [],
		source: renderer.getOutputCanvas(),
		sourceWidth: 2,
		sourceHeight: 2,
	};
	root.add(video);
	const { frame } = await buildFrameDescriptor({ node: root, renderer });
	expect(frame.items[0]).toMatchObject({
		type: "layer",
		key: {
			type: "chroma",
			keyColor: [0, 1, 0],
			similarity: 0.2,
			softness: 0.1,
			spillSuppression: 0.5,
		},
	});
});

test("track matte routing remains distinct in the shared frame descriptor", async () => {
	const root = new RootNode({ duration: 100 });
	const source = new TrackNode({ trackId: "matte-source" });
	source.add(new ColorNode({ color: "#808080" }));
	const destination = new TrackNode({
		trackId: "foreground",
		trackMatte: {
			sourceTrackId: "matte-source",
			mode: "luma",
			inverted: true,
			enabled: true,
		},
	});
	destination.add(new ColorNode({ color: "#ff0000" }));
	root.add(source);
	root.add(destination);
	const renderer = new CanvasRenderer({
		width: 2,
		height: 2,
		fps: DEFAULT_FPS,
	});
	const { frame } = await buildFrameDescriptor({ node: root, renderer });
	expect(frame.items).toMatchObject([
		{ type: "track", trackId: "matte-source", items: [{}] },
		{
			type: "track",
			trackId: "foreground",
			matte: { sourceTrackId: "matte-source", mode: "luma", inverted: true },
			items: [{}],
		},
	]);
});

test("scene construction groups visual tracks by stable routing identity", () => {
	const root = buildScene({
		canvasSize: { width: 2, height: 2 },
		mediaAssets: [],
		duration: 100,
		background: { type: "color", color: "transparent" },
		tracks: {
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [
				{
					id: "source",
					name: "Matte",
					type: "graphic",
					hidden: false,
					elements: [],
				},
				{
					id: "destination",
					name: "Foreground",
					type: "video",
					muted: false,
					hidden: false,
					trackMatte: {
						sourceTrackId: "source",
						mode: "alpha",
						inverted: false,
						enabled: true,
					},
					elements: [],
				},
			],
			audio: [],
		},
	});
	expect(root.children).toHaveLength(2);
	const destination = root.children[0];
	const source = root.children[1];
	if (!(destination instanceof TrackNode) || !(source instanceof TrackNode)) {
		throw new Error("track matte scene nodes are missing");
	}
	expect(destination.params.trackId).toBe("destination");
	expect(destination.params.trackMatte).toMatchObject({
		sourceTrackId: "source",
		mode: "alpha",
	});
	expect(source.params.trackId).toBe("source");
});
