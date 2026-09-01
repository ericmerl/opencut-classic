import type { MediaTime } from "@/wasm";

export interface AutomationElementSnapshot {
	trackId: string;
	elementId: string;
	type: string;
	name: string;
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
}

export interface AutomationProjectSnapshot {
	projectId: string;
	sceneId: string;
	revision: number;
	elements: AutomationElementSnapshot[];
}

export type AutomationEditOperation =
	| {
			kind: "insert_text";
			content: string;
			startTime: MediaTime;
			duration: MediaTime;
	  }
	| {
			kind: "move";
			trackId: string;
			elementId: string;
			startTime: MediaTime;
	  }
	| {
			kind: "trim";
			trackId: string;
			elementId: string;
			startTime: MediaTime;
			duration: MediaTime;
			trimStart: MediaTime;
			trimEnd: MediaTime;
	  };

export interface AutomationEditPlan {
	projectId: string;
	operationId: string;
	expectedRevision: number;
	description: string;
	operations: AutomationEditOperation[];
}

export interface AutomationAppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	snapshot: AutomationProjectSnapshot;
}

export type AutomationMutationResult =
	| AutomationAppliedResult
	| {
			status: "replayed";
			operationId: string;
			revision: number;
			snapshot: AutomationProjectSnapshot;
	  }
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "rejected"; operationId: string; reason: string };

export type AutomationUndoResult =
	| {
			status: "undone";
			revision: number;
			snapshot: AutomationProjectSnapshot;
	  }
	| {
			status: "conflict";
			expectedRevision: number;
			actualRevision: number;
	  }
	| { status: "nothing-to-undo"; revision: number };
