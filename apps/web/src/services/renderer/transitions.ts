import type { Transform } from "@/rendering";
import type { ClipTransitionType } from "@/timeline";

export interface ResolvedTransitionVisual {
	transform: Transform;
	opacity: number;
	wipeProgress?: number;
}

function clampProgress(progress: number): number {
	return Math.min(1, Math.max(0, progress));
}

export function applyClipTransition({
	type,
	phase,
	progress: requestedProgress,
	canvasWidth,
	transform,
	opacity,
}: {
	type: ClipTransitionType;
	phase: "in" | "out";
	progress: number;
	canvasWidth: number;
	transform: Transform;
	opacity: number;
}): ResolvedTransitionVisual {
	const progress = clampProgress(requestedProgress);
	const nextTransform: Transform = {
		...transform,
		position: { ...transform.position },
	};

	if (type === "crossfade") {
		return {
			transform: nextTransform,
			opacity: opacity * (phase === "in" ? progress : 1 - progress),
		};
	}
	if (type === "fade-through-black") {
		const multiplier =
			phase === "in"
				? Math.max(0, progress * 2 - 1)
				: Math.max(0, 1 - progress * 2);
		return { transform: nextTransform, opacity: opacity * multiplier };
	}
	if (type === "slide") {
		nextTransform.position.x +=
			phase === "in" ? canvasWidth * (1 - progress) : -canvasWidth * progress;
		return { transform: nextTransform, opacity };
	}
	if (type === "wipe") {
		return {
			transform: nextTransform,
			opacity,
			...(phase === "in" ? { wipeProgress: progress } : {}),
		};
	}

	if (type === "zoom") {
		const scale = phase === "in" ? 0.8 + progress * 0.2 : 1 + progress * 0.15;
		nextTransform.scaleX *= scale;
		nextTransform.scaleY *= scale;
		return {
			transform: nextTransform,
			opacity: opacity * (phase === "in" ? progress : 1 - progress),
		};
	}
	throw new Error(`unknown transition ID: ${String(type)}`);
}
