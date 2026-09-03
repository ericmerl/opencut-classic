import {
	OPENCUT_WASM_PACKAGE_VERSION,
	SELECTED_COMPOSITOR_BACKEND,
} from "./runtime-identity";
import { wasmCompositor } from "./compositor/wasm-compositor";

export interface RenderEnvironmentIdentity {
	status: "ready" | "degraded" | "unavailable";
	reason: string | null;
	compositor: typeof SELECTED_COMPOSITOR_BACKEND;
	backend: "webgpu" | "webgl2" | "unknown";
	pinnedBackend: "webgpu";
	backendMatchesPin: boolean;
	rendererClass: "software" | "hardware" | "unknown";
	adapterMatchesClass: boolean | null;
	adapter: {
		vendor: string;
		architecture: string;
		device: string;
		description: string;
		isFallbackAdapter: boolean | null;
	} | null;
	surfaceFormat: "bgra8unorm" | "rgba8unorm" | "unknown";
	browser: string;
	wasmPackageVersion: string;
}

let identityPromise: Promise<RenderEnvironmentIdentity> | null = null;

export function readRenderEnvironment(): Promise<RenderEnvironmentIdentity> {
	identityPromise ??= inspectRenderEnvironment();
	return identityPromise;
}

async function inspectRenderEnvironment(): Promise<RenderEnvironmentIdentity> {
	const configured = readConfiguredEnvironment();
	try {
		wasmCompositor.ensureInitialized({ width: 1, height: 1 });
		const canvas = wasmCompositor.getCanvas();
		const backend = detectBackend(canvas);
		const adapter = await readAdapter(configured.rendererClass);
		const backendMatchesPin = backend === configured.pinnedBackend;
		const adapterMatchesClass = matchAdapterClass(
			adapter,
			configured.rendererClass,
		);
		const classMatchesPin =
			configured.rendererClass === "unknown" || adapterMatchesClass === true;
		const ready = backendMatchesPin && classMatchesPin && adapter !== null;
		return {
			status: ready ? "ready" : "degraded",
			reason: ready
				? null
				: !backendMatchesPin
					? `Selected compositor backend ${backend} does not match pinned backend ${configured.pinnedBackend}.`
					: !classMatchesPin
						? `Selected adapter does not match declared ${configured.rendererClass} renderer class.`
						: "The selected WebGPU adapter identity is unavailable.",
			compositor: SELECTED_COMPOSITOR_BACKEND,
			backend,
			pinnedBackend: configured.pinnedBackend,
			backendMatchesPin,
			rendererClass: configured.rendererClass,
			adapterMatchesClass,
			adapter,
			surfaceFormat:
				backend === "webgpu"
					? readPreferredCanvasFormat()
					: backend === "webgl2"
						? "rgba8unorm"
						: "unknown",
			browser: navigator.userAgent,
			wasmPackageVersion: OPENCUT_WASM_PACKAGE_VERSION,
		};
	} catch (error) {
		const gpuInitializationError = (
			globalThis as typeof globalThis & {
				__opencutGpuInitialization?: { error: string | null };
			}
		).__opencutGpuInitialization?.error;
		return unavailable(
			gpuInitializationError ??
				(error instanceof Error
					? error.message
					: "Compositor initialization failed."),
			configured,
		);
	}
}

function unavailable(
	reason: string,
	configured: ReturnType<typeof readConfiguredEnvironment>,
): RenderEnvironmentIdentity {
	return {
		status: "unavailable",
		reason,
		compositor: SELECTED_COMPOSITOR_BACKEND,
		backend: "unknown",
		pinnedBackend: configured.pinnedBackend,
		backendMatchesPin: false,
		rendererClass: configured.rendererClass,
		adapterMatchesClass: null,
		adapter: null,
		surfaceFormat: "unknown",
		browser: navigator.userAgent,
		wasmPackageVersion: OPENCUT_WASM_PACKAGE_VERSION,
	};
}

function matchAdapterClass(
	adapter: RenderEnvironmentIdentity["adapter"],
	rendererClass: RenderEnvironmentIdentity["rendererClass"],
): boolean | null {
	if (rendererClass === "unknown" || adapter === null) return null;
	const identity = [
		adapter.vendor,
		adapter.architecture,
		adapter.device,
		adapter.description,
	]
		.join(" ")
		.toLowerCase();
	const isSoftware =
		adapter.isFallbackAdapter === true || identity.includes("swiftshader");
	return rendererClass === "software" ? isSoftware : !isSoftware;
}

function readConfiguredEnvironment(): {
	rendererClass: RenderEnvironmentIdentity["rendererClass"];
	pinnedBackend: "webgpu";
} {
	const params = new URL(window.location.href).searchParams;
	const configuredClass = params.get("automationRendererClass");
	const rendererClass: RenderEnvironmentIdentity["rendererClass"] =
		configuredClass === "software" || configuredClass === "hardware"
			? configuredClass
			: "unknown";
	return {
		rendererClass,
		pinnedBackend: "webgpu" as const,
	};
}

function detectBackend(
	canvas: HTMLCanvasElement,
): RenderEnvironmentIdentity["backend"] {
	const getContext = canvas.getContext.bind(canvas) as (
		contextId: string,
	) => unknown;
	try {
		if (getContext("webgpu")) return "webgpu";
	} catch {}
	try {
		if (getContext("webgl2")) return "webgl2";
	} catch {}
	return "unknown";
}

async function readAdapter(
	rendererClass: RenderEnvironmentIdentity["rendererClass"],
): Promise<RenderEnvironmentIdentity["adapter"]> {
	const gpu = (navigator as unknown as { gpu?: unknown }).gpu as
		| {
				requestAdapter(options?: {
					powerPreference?: "high-performance";
					forceFallbackAdapter?: boolean;
				}): Promise<{
					info?: Partial<{
						vendor: string;
						architecture: string;
						device: string;
						description: string;
					}>;
					isFallbackAdapter?: boolean;
				} | null>;
				getPreferredCanvasFormat?(): string;
		  }
		| undefined;
	if (!gpu) return null;
	const adapter = await gpu.requestAdapter({
		powerPreference: "high-performance",
		...(rendererClass === "software" ? { forceFallbackAdapter: true } : {}),
	});
	if (!adapter) return null;
	return {
		vendor: adapter.info?.vendor ?? "unknown",
		architecture: adapter.info?.architecture ?? "unknown",
		device: adapter.info?.device ?? "unknown",
		description: adapter.info?.description ?? "unknown",
		isFallbackAdapter:
			typeof adapter.isFallbackAdapter === "boolean"
				? adapter.isFallbackAdapter
				: null,
	};
}

function readPreferredCanvasFormat(): "bgra8unorm" | "rgba8unorm" | "unknown" {
	const gpu = (
		navigator as Navigator & {
			gpu?: { getPreferredCanvasFormat?(): string };
		}
	).gpu;
	const format = gpu?.getPreferredCanvasFormat?.();
	return format === "bgra8unorm" || format === "rgba8unorm"
		? format
		: "unknown";
}
