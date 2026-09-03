const CAPTION_FONT_PRESETS = [
	{
		id: "default-caption",
		descriptors: [
			'normal 400 16px "Arial"',
			'normal 700 16px "Arial"',
			'italic 700 16px "Arial"',
		],
	},
] as const;

export async function readRuntimeCapabilities() {
	const { readRenderEnvironment } =
		await import("@/services/renderer/render-environment");
	const [fonts, renderer] = await Promise.all([
		readFontReadiness(),
		readRenderEnvironment(),
	]);
	return {
		status:
			fonts.status === "ready" && renderer.status === "ready"
				? "ready"
				: renderer.status === "unavailable"
					? "unavailable"
					: "degraded",
		reason: renderer.reason,
		compositorBackend: renderer.backend,
		wasmPackageVersion: renderer.wasmPackageVersion,
		browser: navigator.userAgent,
		renderer,
		fonts,
		timelineTranscription: {
			status: "ready",
			reason:
				"The browser-local Whisper provider is bundled; models are selected and loaded on demand.",
			model: {
				status: "unknown",
				id: null,
				version: null,
				reason: "No model is selected until a transcription request is made.",
			},
		},
	};
}

async function readFontReadiness() {
	if (!document.fonts) {
		return {
			status: "unavailable",
			reason: "The browser FontFaceSet API is unavailable.",
			presets: CAPTION_FONT_PRESETS.map((preset) => ({
				...preset,
				status: "unknown",
				missingDescriptors: [...preset.descriptors],
			})),
		};
	}
	try {
		await Promise.race([
			document.fonts.ready,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("font readiness timed out")), 5_000),
			),
		]);
		const presets = await Promise.all(
			CAPTION_FONT_PRESETS.map(async (preset) => {
				await Promise.all(
					preset.descriptors.map((descriptor) =>
						document.fonts.load(descriptor),
					),
				);
				const missingDescriptors = preset.descriptors.filter(
					(descriptor) => !document.fonts.check(descriptor),
				);
				return {
					id: preset.id,
					descriptors: [...preset.descriptors],
					status: missingDescriptors.length === 0 ? "ready" : "degraded",
					missingDescriptors,
				};
			}),
		);
		const ready = presets.every((preset) => preset.status === "ready");
		return {
			status: ready ? "ready" : "degraded",
			reason: ready
				? null
				: "One or more named caption font faces are unavailable.",
			presets,
		};
	} catch (error) {
		return {
			status: "degraded",
			reason:
				error instanceof Error ? error.message : "Font readiness probe failed.",
			presets: CAPTION_FONT_PRESETS.map((preset) => ({
				...preset,
				status: "unknown",
				missingDescriptors: [...preset.descriptors],
			})),
		};
	}
}
