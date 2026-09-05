/// <reference types="bun" />

import { describe, expect, mock, test } from "bun:test";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120000,
	lastFrameTime: () => 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
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
	wasmCompositor: {},
}));

const { registerDefaultEffects } = await import("@/effects");
const { DEFAULT_FPS } = await import("@/fps/defaults");
const { mediaTime } = await import("@/wasm");
const { CanvasRenderer } = await import("./canvas-renderer");
const { buildFrameDescriptor } = await import("./compositor/frame-descriptor");
const { buildScene } = await import("./scene-builder");
const { resolveRenderTree } = await import("./resolve");
const { CompoundNode } = await import("./nodes/compound-node");
const { EffectLayerNode } = await import("./nodes/effect-layer-node");
const { ColorNode } = await import("./nodes/color-node");
const { RootNode } = await import("./nodes/root-node");

describe("compound render node", () => {
	test("builds nested timeline elements beneath a compound node", () => {
		const root = buildScene({
			canvasSize: { width: 1080, height: 1920 },
			mediaAssets: [],
			duration: 200,
			background: { type: "color", color: "transparent" },
			tracks: {
				main: {
					id: "main",
					name: "Main",
					type: "video",
					muted: false,
					hidden: false,
					elements: [
						{
							id: "compound",
							name: "Compound",
							type: "compound",
							startTime: mediaTime({ ticks: 0 }),
							duration: mediaTime({ ticks: 200 }),
							trimStart: mediaTime({ ticks: 0 }),
							trimEnd: mediaTime({ ticks: 0 }),
							params: {},
							tracks: {
								main: {
									id: "nested-main",
									name: "Nested main",
									type: "video",
									muted: false,
									hidden: false,
									elements: [],
								},
								overlay: [
									{
										id: "nested-text",
										name: "Nested text",
										type: "text",
										hidden: false,
										elements: [
											{
												id: "text",
												name: "Text",
												type: "text",
												startTime: mediaTime({ ticks: 0 }),
												duration: mediaTime({ ticks: 200 }),
												trimStart: mediaTime({ ticks: 0 }),
												trimEnd: mediaTime({ ticks: 0 }),
												params: { content: "Nested" },
											},
										],
									},
								],
								audio: [],
							},
						},
					],
				},
				overlay: [],
				audio: [],
			},
		});
		expect(root.children[0]).toBeInstanceOf(CompoundNode);
		expect(root.children[0]?.children).toHaveLength(1);
	});

	test("resolves children in compound-local source time and clips the group", async () => {
		registerDefaultEffects();
		const root = new RootNode({ duration: 500 });
		const compound = new CompoundNode({
			timeOffset: 100,
			duration: 50,
			trimStart: 20,
		});
		const effect = new EffectLayerNode({
			effectType: "color-grade",
			effectParams: { contrast: 12 },
			timeOffset: 20,
			duration: 10,
		});
		compound.add(effect);
		root.add(compound);
		const renderer = new CanvasRenderer({
			width: 1080,
			height: 1920,
			fps: DEFAULT_FPS,
		});

		await resolveRenderTree({ node: root, renderer, time: 100 });
		expect(compound.resolved).toEqual({ active: true, opacity: 1 });
		expect(effect.resolved?.passes.length).toBeGreaterThan(0);
		expect(
			(await buildFrameDescriptor({ node: root, renderer })).frame.items,
		).toHaveLength(1);

		await resolveRenderTree({ node: root, renderer, time: 99 });
		expect(compound.resolved).toEqual({ active: false, opacity: 1 });
		expect(
			(await buildFrameDescriptor({ node: root, renderer })).frame.items,
		).toHaveLength(0);
	});

	test("applies a supported boundary transition to the compound as a group", async () => {
		const root = new RootNode({ duration: 500 });
		const compound = new CompoundNode({
			timeOffset: 100,
			duration: 100,
			trimStart: 0,
			transitionIn: {
				id: "compound-crossfade",
				type: "crossfade",
				duration: mediaTime({ ticks: 20 }),
				fromElementId: "prior",
			},
		});
		compound.add(new ColorNode({ color: "#ff0000" }));
		root.add(compound);
		const renderer = new CanvasRenderer({
			width: 320,
			height: 180,
			fps: DEFAULT_FPS,
		});

		await resolveRenderTree({ node: root, renderer, time: 110 });
		expect(compound.resolved).toEqual({ active: true, opacity: 0.5 });
		const descriptor = await buildFrameDescriptor({ node: root, renderer });
		expect(descriptor.frame.items).toEqual([
			expect.objectContaining({ type: "layer", opacity: 0.5 }),
		]);
	});
});
