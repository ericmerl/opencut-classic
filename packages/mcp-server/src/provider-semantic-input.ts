/** Removes only known transport locations from the provider job envelope. */
export function semanticProviderInput(value: unknown): unknown {
	if (!isRecord(value)) return cloneJson(value);
	const root = cloneRecord(value);
	delete root.outputDirectory;
	if (isRecord(root.source)) {
		const source = cloneRecord(root.source);
		delete source.path;
		root.source = source;
	}
	return root;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => [key, cloneJson(child)]),
	);
}

function cloneJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneJson);
	return isRecord(value) ? cloneRecord(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
