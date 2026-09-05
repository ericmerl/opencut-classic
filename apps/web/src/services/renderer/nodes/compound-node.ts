import type { ClipTransition } from "@/timeline";
import { BaseNode } from "./base-node";

export interface CompoundNodeParams {
	timeOffset: number;
	duration: number;
	trimStart: number;
	transitionIn?: ClipTransition;
	transitionOut?: ClipTransition;
}

export interface ResolvedCompoundNodeState {
	active: boolean;
	opacity: number;
}

export class CompoundNode extends BaseNode<
	CompoundNodeParams,
	ResolvedCompoundNodeState
> {}
