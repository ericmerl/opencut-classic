import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import type { TTimelineViewState } from "@/project/types";
import type { BlendMode, Transform } from "@/rendering";
import { ZERO_MEDIA_TIME } from "@/wasm";
import type { TextElement } from "./types";

const defaultTransform: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

const defaultOpacity = 1;
const defaultBlendMode: BlendMode = "normal";
const defaultVolume = 0;

const defaultTextLetterSpacing = 0;
const defaultTextLineHeight = 1.2;

const defaultTextBackground = {
	enabled: false,
	color: "#000000",
	perLine: false,
	cornerRadius: 0,
	paddingX: 30,
	paddingY: 42,
	offsetX: 0,
	offsetY: 0,
};

const defaultTextHighlight = {
	enabled: false,
	color: "#ffd400",
};

// Outline and shadow geometry are fractions of the font size; Rust
// (`edit-plan` default_text_params) declares the same defaults and bounds.
const defaultTextOutline = {
	enabled: false,
	color: "#000000",
	width: 0.08,
};

const defaultTextShadow = {
	enabled: false,
	color: "#000000",
	offsetX: 0.04,
	offsetY: 0.04,
	blur: 0.08,
};

const defaultTextElement: Omit<TextElement, "id"> = {
	type: "text",
	name: "Text",
	duration: DEFAULT_NEW_ELEMENT_DURATION,
	startTime: ZERO_MEDIA_TIME,
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
	params: {
		content: "Default text",
		fontSize: 15,
		fontFamily: "Arial",
		color: "#ffffff",
		textAlign: "center",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		letterSpacing: defaultTextLetterSpacing,
		lineHeight: defaultTextLineHeight,
		"background.enabled": defaultTextBackground.enabled,
		"background.color": defaultTextBackground.color,
		"background.perLine": defaultTextBackground.perLine,
		"background.cornerRadius": defaultTextBackground.cornerRadius,
		"background.paddingX": defaultTextBackground.paddingX,
		"background.paddingY": defaultTextBackground.paddingY,
		"background.offsetX": defaultTextBackground.offsetX,
		"background.offsetY": defaultTextBackground.offsetY,
		"highlight.enabled": defaultTextHighlight.enabled,
		"highlight.color": defaultTextHighlight.color,
		"outline.enabled": defaultTextOutline.enabled,
		"outline.color": defaultTextOutline.color,
		"outline.width": defaultTextOutline.width,
		"shadow.enabled": defaultTextShadow.enabled,
		"shadow.color": defaultTextShadow.color,
		"shadow.offsetX": defaultTextShadow.offsetX,
		"shadow.offsetY": defaultTextShadow.offsetY,
		"shadow.blur": defaultTextShadow.blur,
		"transform.positionX": defaultTransform.position.x,
		"transform.positionY": defaultTransform.position.y,
		"transform.scaleX": defaultTransform.scaleX,
		"transform.scaleY": defaultTransform.scaleY,
		"transform.rotate": defaultTransform.rotate,
		opacity: defaultOpacity,
		blendMode: defaultBlendMode,
	},
};

const defaultTimelineViewState: TTimelineViewState = {
	zoomLevel: 1,
	scrollLeft: 0,
	playheadTime: ZERO_MEDIA_TIME,
};

export const DEFAULTS = {
	element: {
		transform: defaultTransform,
		opacity: defaultOpacity,
		blendMode: defaultBlendMode,
		volume: defaultVolume,
	},
	text: {
		letterSpacing: defaultTextLetterSpacing,
		lineHeight: defaultTextLineHeight,
		background: defaultTextBackground,
		highlight: defaultTextHighlight,
		outline: defaultTextOutline,
		shadow: defaultTextShadow,
		element: defaultTextElement,
	},
	timeline: {
		viewState: defaultTimelineViewState,
	},
};
