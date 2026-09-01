export interface TimelineElement {
	id: string;
	kind: "video" | "audio" | "text";
	label: string;
	startTick: number;
	durationTicks: number;
}

export interface ProjectSnapshot {
	projectId: string;
	revision: number;
	elements: TimelineElement[];
}

export type EditOperation =
	| { type: "insert"; element: TimelineElement }
	| { type: "move"; elementId: string; startTick: number }
	| { type: "trim"; elementId: string; durationTicks: number }
	| { type: "remove"; elementId: string };

export interface EditPlan {
	operationId: string;
	expectedRevision: number;
	description: string;
	operations: EditOperation[];
}

export interface AppliedResult {
	status: "applied";
	operationId: string;
	revision: number;
	snapshot: ProjectSnapshot;
}

export type ApplyResult =
	| AppliedResult
	| {
			status: "replayed";
			operationId: string;
			revision: number;
			snapshot: ProjectSnapshot;
	  }
	| {
			status: "conflict";
			operationId: string;
			expectedRevision: number;
			actualRevision: number;
	  }
	| {
			status: "rejected";
			operationId: string;
			reason: string;
	  };

export type UndoResult =
	| { status: "undone"; revision: number; snapshot: ProjectSnapshot }
	| { status: "nothing-to-undo"; revision: number }
	| { status: "conflict"; expectedRevision: number; actualRevision: number };

interface AppliedOperation {
	fingerprint: string;
	result: AppliedResult;
}

interface HistoryEntry {
	description: string;
	previousElements: TimelineElement[];
}

export class CommandGateway {
	private state: ProjectSnapshot;
	private appliedOperations = new Map<string, AppliedOperation>();
	private history: HistoryEntry[] = [];
	private writer: Promise<void> = Promise.resolve();

	constructor(initialState: ProjectSnapshot) {
		validateSnapshot(initialState);
		this.state = cloneSnapshot(initialState);
	}

	read(): ProjectSnapshot {
		return cloneSnapshot(this.state);
	}

	apply(plan: EditPlan): Promise<ApplyResult> {
		return this.enqueue(() => this.applyNow(plan));
	}

	undo(expectedRevision: number): Promise<UndoResult> {
		return this.enqueue(() => this.undoNow(expectedRevision));
	}

	private enqueue<T>(work: () => T): Promise<T> {
		const result = this.writer.then(work);
		this.writer = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private applyNow(plan: EditPlan): ApplyResult {
		const rejection = validatePlanShape(plan);
		if (rejection) {
			return {
				status: "rejected",
				operationId: plan.operationId,
				reason: rejection,
			};
		}

		const fingerprint = stableSerialize(plan);
		const previous = this.appliedOperations.get(plan.operationId);
		if (previous) {
			if (previous.fingerprint !== fingerprint) {
				return {
					status: "rejected",
					operationId: plan.operationId,
					reason: "operationId was already used for a different plan",
				};
			}
			return {
				...previous.result,
				status: "replayed",
				snapshot: cloneSnapshot(previous.result.snapshot),
			};
		}

		if (plan.expectedRevision !== this.state.revision) {
			return {
				status: "conflict",
				operationId: plan.operationId,
				expectedRevision: plan.expectedRevision,
				actualRevision: this.state.revision,
			};
		}

		try {
			const nextElements = applyOperations(
				this.state.elements,
				plan.operations,
			);
			const previousElements = cloneElements(this.state.elements);
			this.state = {
				...this.state,
				revision: this.state.revision + 1,
				elements: nextElements,
			};
			this.history.push({
				description: plan.description,
				previousElements,
			});
			const result: AppliedResult = {
				status: "applied",
				operationId: plan.operationId,
				revision: this.state.revision,
				snapshot: cloneSnapshot(this.state),
			};
			this.appliedOperations.set(plan.operationId, { fingerprint, result });
			return result;
		} catch (error) {
			return {
				status: "rejected",
				operationId: plan.operationId,
				reason: error instanceof Error ? error.message : "unknown plan error",
			};
		}
	}

	private undoNow(expectedRevision: number): UndoResult {
		if (expectedRevision !== this.state.revision) {
			return {
				status: "conflict",
				expectedRevision,
				actualRevision: this.state.revision,
			};
		}

		const entry = this.history.pop();
		if (!entry) {
			return { status: "nothing-to-undo", revision: this.state.revision };
		}

		this.state = {
			...this.state,
			revision: this.state.revision + 1,
			elements: cloneElements(entry.previousElements),
		};
		return {
			status: "undone",
			revision: this.state.revision,
			snapshot: cloneSnapshot(this.state),
		};
	}
}

function applyOperations(
	currentElements: TimelineElement[],
	operations: EditOperation[],
): TimelineElement[] {
	let elements = cloneElements(currentElements);
	for (const operation of operations) {
		switch (operation.type) {
			case "insert": {
				if (elements.some((element) => element.id === operation.element.id)) {
					throw new Error(`element already exists: ${operation.element.id}`);
				}
				validateElement(operation.element);
				elements.push({ ...operation.element });
				break;
			}
			case "move": {
				assertWholeNonNegative(operation.startTick, "startTick");
				elements = replaceElement(elements, operation.elementId, (element) => ({
					...element,
					startTick: operation.startTick,
				}));
				break;
			}
			case "trim": {
				assertWholePositive(operation.durationTicks, "durationTicks");
				elements = replaceElement(elements, operation.elementId, (element) => ({
					...element,
					durationTicks: operation.durationTicks,
				}));
				break;
			}
			case "remove": {
				const next = elements.filter(
					(element) => element.id !== operation.elementId,
				);
				if (next.length === elements.length) {
					throw new Error(`element not found: ${operation.elementId}`);
				}
				elements = next;
				break;
			}
		}
	}

	validateElements(elements);
	return elements.sort((left, right) => left.startTick - right.startTick);
}

function replaceElement(
	elements: TimelineElement[],
	elementId: string,
	update: (element: TimelineElement) => TimelineElement,
): TimelineElement[] {
	let found = false;
	const result = elements.map((element) => {
		if (element.id !== elementId) return element;
		found = true;
		return update(element);
	});
	if (!found) throw new Error(`element not found: ${elementId}`);
	return result;
}

function validatePlanShape(plan: EditPlan): string | null {
	if (!plan.operationId.trim()) return "operationId is required";
	if (
		!Number.isSafeInteger(plan.expectedRevision) ||
		plan.expectedRevision < 0
	) {
		return "expectedRevision must be a non-negative safe integer";
	}
	if (!plan.description.trim()) return "description is required";
	if (plan.operations.length === 0) return "at least one operation is required";
	return null;
}

function validateSnapshot(snapshot: ProjectSnapshot): void {
	if (!snapshot.projectId.trim()) throw new Error("projectId is required");
	assertWholeNonNegative(snapshot.revision, "revision");
	validateElements(snapshot.elements);
}

function validateElements(elements: TimelineElement[]): void {
	const ids = new Set<string>();
	for (const element of elements) {
		validateElement(element);
		if (ids.has(element.id))
			throw new Error(`duplicate element id: ${element.id}`);
		ids.add(element.id);
	}
}

function validateElement(element: TimelineElement): void {
	if (!element.id.trim()) throw new Error("element id is required");
	if (!element.label.trim())
		throw new Error(`label is required for ${element.id}`);
	assertWholeNonNegative(element.startTick, "startTick");
	assertWholePositive(element.durationTicks, "durationTicks");
}

function assertWholeNonNegative(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
}

function assertWholePositive(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function cloneElements(elements: TimelineElement[]): TimelineElement[] {
	return elements.map((element) => ({ ...element }));
}

function cloneSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
	return { ...snapshot, elements: cloneElements(snapshot.elements) };
}
