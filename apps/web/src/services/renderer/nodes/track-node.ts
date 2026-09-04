import type { TrackMatteRouting } from "@/timeline";
import { BaseNode } from "./base-node";

export interface TrackNodeParams {
	trackId: string;
	trackMatte?: TrackMatteRouting;
}

/** A stable render group used for track-matte routing. */
export class TrackNode extends BaseNode<TrackNodeParams, undefined> {}
