import type { ParamValues } from "@/params";
import type { Transform } from "@/rendering";

export type ReframeMode = "contain" | "cover" | "stretch";

export interface NormalizedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ReframeConfig {
	mode: ReframeMode;
	crop: NormalizedRect;
	focalPoint: { x: number; y: number };
	targetRect: NormalizedRect;
}

export interface ReframeGeometry {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
	sourceRect: NormalizedRect;
}

export const DEFAULT_REFRAME: ReframeConfig = {
	mode: "contain",
	crop: { x: 0, y: 0, width: 1, height: 1 },
	focalPoint: { x: 0.5, y: 0.5 },
	targetRect: { x: 0, y: 0, width: 1, height: 1 },
};

const MIN_NORMALIZED_SIZE = 0.001;

export function buildReframeFromParams({
	params,
}: {
	params: ParamValues;
}): ReframeConfig {
	return sanitizeReframe({
		mode: readMode(params["reframe.mode"]),
		crop: {
			x: readNumber(params["reframe.cropX"], 0),
			y: readNumber(params["reframe.cropY"], 0),
			width: readNumber(params["reframe.cropWidth"], 1),
			height: readNumber(params["reframe.cropHeight"], 1),
		},
		focalPoint: {
			x: readNumber(params["reframe.focalX"], 0.5),
			y: readNumber(params["reframe.focalY"], 0.5),
		},
		targetRect: {
			x: readNumber(params["reframe.targetX"], 0),
			y: readNumber(params["reframe.targetY"], 0),
			width: readNumber(params["reframe.targetWidth"], 1),
			height: readNumber(params["reframe.targetHeight"], 1),
		},
	});
}

export function computeReframeGeometry({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	transform,
	reframe,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: Transform;
	reframe: ReframeConfig;
}): ReframeGeometry {
	const safe = sanitizeReframe(reframe);
	const target = {
		x: safe.targetRect.x * canvasWidth,
		y: safe.targetRect.y * canvasHeight,
		width: safe.targetRect.width * canvasWidth,
		height: safe.targetRect.height * canvasHeight,
	};
	let sourceRect = safe.crop;
	let baseWidth = target.width;
	let baseHeight = target.height;

	if (safe.mode === "cover") {
		sourceRect = coverSourceRect({
			crop: safe.crop,
			focalPoint: safe.focalPoint,
			sourceWidth,
			sourceHeight,
			targetWidth: target.width,
			targetHeight: target.height,
		});
	} else if (safe.mode === "contain") {
		const croppedWidth = sourceWidth * safe.crop.width;
		const croppedHeight = sourceHeight * safe.crop.height;
		const scale = Math.min(
			target.width / croppedWidth,
			target.height / croppedHeight,
		);
		baseWidth = croppedWidth * scale;
		baseHeight = croppedHeight * scale;
	}

	const scaledWidth = baseWidth * transform.scaleX;
	const scaledHeight = baseHeight * transform.scaleY;
	return {
		centerX: target.x + target.width / 2 + transform.position.x,
		centerY: target.y + target.height / 2 + transform.position.y,
		width: Math.abs(scaledWidth),
		height: Math.abs(scaledHeight),
		rotationDegrees: transform.rotate,
		flipX: scaledWidth < 0,
		flipY: scaledHeight < 0,
		sourceRect,
	};
}

export function sanitizeReframe(reframe: ReframeConfig): ReframeConfig {
	return {
		mode: readMode(reframe.mode),
		crop: sanitizeRect(reframe.crop),
		focalPoint: {
			x: clamp(reframe.focalPoint.x, 0, 1),
			y: clamp(reframe.focalPoint.y, 0, 1),
		},
		targetRect: sanitizeRect(reframe.targetRect),
	};
}

function coverSourceRect({
	crop,
	focalPoint,
	sourceWidth,
	sourceHeight,
	targetWidth,
	targetHeight,
}: {
	crop: NormalizedRect;
	focalPoint: { x: number; y: number };
	sourceWidth: number;
	sourceHeight: number;
	targetWidth: number;
	targetHeight: number;
}): NormalizedRect {
	const sourceAspect =
		(sourceWidth * crop.width) / (sourceHeight * crop.height);
	const targetAspect = targetWidth / targetHeight;
	if (sourceAspect > targetAspect) {
		const width = (crop.height * sourceHeight * targetAspect) / sourceWidth;
		return {
			x: clamp(focalPoint.x - width / 2, crop.x, crop.x + crop.width - width),
			y: crop.y,
			width,
			height: crop.height,
		};
	}
	const height = (crop.width * sourceWidth) / (targetAspect * sourceHeight);
	return {
		x: crop.x,
		y: clamp(focalPoint.y - height / 2, crop.y, crop.y + crop.height - height),
		width: crop.width,
		height,
	};
}

function sanitizeRect(rect: NormalizedRect): NormalizedRect {
	const x = clamp(rect.x, 0, 1 - MIN_NORMALIZED_SIZE);
	const y = clamp(rect.y, 0, 1 - MIN_NORMALIZED_SIZE);
	return {
		x,
		y,
		width: clamp(rect.width, MIN_NORMALIZED_SIZE, 1 - x),
		height: clamp(rect.height, MIN_NORMALIZED_SIZE, 1 - y),
	};
}

function readMode(value: unknown): ReframeMode {
	return value === "cover" || value === "stretch" ? value : "contain";
}

function readNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
