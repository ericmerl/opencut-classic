export type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| CanonicalJsonValue[]
	| { [key: string]: CanonicalJsonValue };

export type CanonicalJsonDomainBlocker =
	| { code: "unsafe-integer"; path: string; value: string }
	| { code: "invalid-unicode"; path: string };

export class CanonicalJsonDomainError extends Error {
	constructor(readonly blocker: CanonicalJsonDomainBlocker) {
		super(
			blocker.code === "unsafe-integer"
				? `Canonical JSON contains an unsafe integer at ${blocker.path}`
				: `Canonical JSON contains invalid Unicode at ${blocker.path}`,
		);
		this.name = "CanonicalJsonDomainError";
	}
}

export function canonicalSerialize(value: unknown): string {
	const blocker = findCanonicalJsonDomainBlockers(value)[0];
	if (blocker) throw new CanonicalJsonDomainError(blocker);
	return serializeValue(value, new Set<object>());
}

export function findCanonicalJsonDomainBlockers(
	value: unknown,
	path = "$",
	ancestors = new Set<object>(),
): CanonicalJsonDomainBlocker[] {
	if (typeof value === "string") {
		return hasUnpairedSurrogate(value)
			? [{ code: "invalid-unicode", path }]
			: [];
	}
	if (typeof value === "number") {
		return Number.isInteger(value) && !Number.isSafeInteger(value)
			? [{ code: "unsafe-integer", path, value: String(value) }]
			: [];
	}
	if (!value || typeof value !== "object" || ancestors.has(value)) return [];

	ancestors.add(value);
	const blockers: CanonicalJsonDomainBlocker[] = [];
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			blockers.push(
				...findCanonicalJsonDomainBlockers(
					value[index],
					`${path}[${index}]`,
					ancestors,
				),
			);
		}
	} else {
		for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
			compareOrdinal(left, right),
		)) {
			const childPath = propertyPath(path, key);
			if (hasUnpairedSurrogate(key)) {
				blockers.push({ code: "invalid-unicode", path: childPath });
			}
			blockers.push(
				...findCanonicalJsonDomainBlockers(child, childPath, ancestors),
			);
		}
	}
	ancestors.delete(value);
	return blockers;
}

export function omitCanonicalJsonKeys(
	value: unknown,
	omittedKeys: ReadonlySet<string>,
): CanonicalJsonValue {
	return transformCanonicalJson(value, omittedKeys, "$", new Set<object>());
}

function transformCanonicalJson(
	value: unknown,
	omittedKeys: ReadonlySet<string>,
	path: string,
	ancestors: Set<object>,
): CanonicalJsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		assertValidString(value, path);
		return value;
	}
	if (typeof value === "number") {
		assertValidNumber(value, path);
		return value;
	}
	if (Array.isArray(value)) {
		assertDenseDefinedArray(value);
		assertNotCircular(value, ancestors);
		const result = value.map((child, index) =>
			transformCanonicalJson(
				child,
				omittedKeys,
				`${path}[${index}]`,
				ancestors,
			),
		);
		ancestors.delete(value);
		return result;
	}
	if (!isPlainObject(value)) {
		throw new Error("Canonical JSON contains a non-serializable value");
	}
	assertNotCircular(value, ancestors);
	const result: Record<string, CanonicalJsonValue> = {};
	for (const [key, child] of Object.entries(value)) {
		if (omittedKeys.has(key)) continue;
		const childPath = propertyPath(path, key);
		assertValidString(key, childPath);
		if (child === undefined) {
			throw new Error(`Canonical JSON contains undefined at object key ${key}`);
		}
		result[key] = transformCanonicalJson(
			child,
			omittedKeys,
			childPath,
			ancestors,
		);
	}
	ancestors.delete(value);
	return result;
}

function serializeValue(value: unknown, ancestors: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Canonical JSON contains a non-finite number");
		}
		return Object.is(value, -0) ? "0" : JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		assertDenseDefinedArray(value);
		assertNotCircular(value, ancestors);
		const result = `[${value
			.map((entry) => serializeValue(entry, ancestors))
			.join(",")}]`;
		ancestors.delete(value);
		return result;
	}
	if (!isPlainObject(value)) {
		throw new Error("Canonical JSON contains a non-serializable value");
	}
	assertNotCircular(value, ancestors);
	const keys = Object.keys(value).sort(compareOrdinal);
	for (const key of keys) {
		if (value[key] === undefined) {
			throw new Error(`Canonical JSON contains undefined at object key ${key}`);
		}
	}
	const result = `{${keys
		.map(
			(key) =>
				`${JSON.stringify(key)}:${serializeValue(value[key], ancestors)}`,
		)
		.join(",")}}`;
	ancestors.delete(value);
	return result;
}

function assertValidString(value: string, path: string): void {
	if (hasUnpairedSurrogate(value)) {
		throw new CanonicalJsonDomainError({ code: "invalid-unicode", path });
	}
}

function assertValidNumber(value: number, path: string): void {
	if (!Number.isFinite(value)) {
		throw new Error("Canonical JSON contains a non-finite number");
	}
	if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
		throw new CanonicalJsonDomainError({
			code: "unsafe-integer",
			path,
			value: String(value),
		});
	}
}

function assertDenseDefinedArray(value: unknown[]): void {
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) {
			throw new Error(
				`Canonical JSON contains a sparse array slot at ${index}`,
			);
		}
		if (value[index] === undefined) {
			throw new Error(
				`Canonical JSON contains undefined at array index ${index}`,
			);
		}
	}
}

function assertNotCircular(value: object, ancestors: Set<object>): void {
	if (ancestors.has(value)) {
		throw new Error("Canonical JSON contains a circular reference");
	}
	ancestors.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function propertyPath(parent: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
		? `${parent}.${key}`
		: `${parent}[${JSON.stringify(key)}]`;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
				return true;
			}
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function compareOrdinal(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
