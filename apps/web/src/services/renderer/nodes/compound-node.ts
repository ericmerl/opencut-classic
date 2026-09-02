import { BaseNode } from "./base-node";

export interface CompoundNodeParams {
	timeOffset: number;
	duration: number;
	trimStart: number;
}

export interface ResolvedCompoundNodeState {
	active: boolean;
}

export class CompoundNode extends BaseNode<
	CompoundNodeParams,
	ResolvedCompoundNodeState
> {}
