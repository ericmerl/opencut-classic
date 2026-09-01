import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";
import type { ClipMatteChannel } from "@/timeline";

export interface VideoMatteNodeParams {
	mediaId: string;
	url: string;
	file: File;
	type: "image" | "video";
	channel: ClipMatteChannel;
}

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	matte?: VideoMatteNodeParams;
}

export interface ResolvedVideoNodeState extends ResolvedVisualSourceNodeState {
	matteSource?: CanvasImageSource;
	matteSourceWidth?: number;
	matteSourceHeight?: number;
	matteChannel?: ClipMatteChannel;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVideoNodeState
> {}
