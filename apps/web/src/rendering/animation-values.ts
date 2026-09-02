import type { ElementAnimations } from "@/animation/types";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { sanitizeReframe, type ReframeConfig, type Transform } from "./index";

export function resolveTransformAtTime({
	baseTransform,
	animations,
	localTime,
}: {
	baseTransform: Transform;
	animations: ElementAnimations | undefined;
	localTime: number;
}): Transform {
	const safeLocalTime = Math.max(0, localTime);
	return {
		position: {
			x: resolveAnimationPathValueAtTime({
				animations,
				propertyPath: "transform.positionX",
				localTime: safeLocalTime,
				fallbackValue: baseTransform.position.x,
			}),
			y: resolveAnimationPathValueAtTime({
				animations,
				propertyPath: "transform.positionY",
				localTime: safeLocalTime,
				fallbackValue: baseTransform.position.y,
			}),
		},
		scaleX: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "transform.scaleX",
			localTime: safeLocalTime,
			fallbackValue: baseTransform.scaleX,
		}),
		scaleY: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "transform.scaleY",
			localTime: safeLocalTime,
			fallbackValue: baseTransform.scaleY,
		}),
		rotate: resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "transform.rotate",
			localTime: safeLocalTime,
			fallbackValue: baseTransform.rotate,
		}),
	};
}

export function resolveReframeAtTime({
	baseReframe,
	animations,
	localTime,
}: {
	baseReframe: ReframeConfig;
	animations: ElementAnimations | undefined;
	localTime: number;
}): ReframeConfig {
	const safeLocalTime = Math.max(0, localTime);
	const resolve = (propertyPath: string, fallbackValue: number) =>
		resolveAnimationPathValueAtTime({
			animations,
			propertyPath,
			localTime: safeLocalTime,
			fallbackValue,
		});
	return sanitizeReframe({
		mode: baseReframe.mode,
		crop: {
			x: resolve("reframe.cropX", baseReframe.crop.x),
			y: resolve("reframe.cropY", baseReframe.crop.y),
			width: resolve("reframe.cropWidth", baseReframe.crop.width),
			height: resolve("reframe.cropHeight", baseReframe.crop.height),
		},
		focalPoint: {
			x: resolve("reframe.focalX", baseReframe.focalPoint.x),
			y: resolve("reframe.focalY", baseReframe.focalPoint.y),
		},
		targetRect: {
			x: resolve("reframe.targetX", baseReframe.targetRect.x),
			y: resolve("reframe.targetY", baseReframe.targetRect.y),
			width: resolve("reframe.targetWidth", baseReframe.targetRect.width),
			height: resolve("reframe.targetHeight", baseReframe.targetRect.height),
		},
	});
}
