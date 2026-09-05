import { resolve } from "node:path";
import { ApprovedModelCache } from "../src/approved-model-cache";

const arguments_ = process.argv.slice(2);
const cacheArgument = valueAfter(arguments_, "--cache-dir");
const taskArgument = valueAfter(arguments_, "--task");
const cacheDirectory = resolve(
	cacheArgument ?? process.env.OPENCUT_MODEL_CACHE_DIRECTORY ?? "",
);
if (!cacheArgument && !process.env.OPENCUT_MODEL_CACHE_DIRECTORY) {
	throw new Error(
		"Set OPENCUT_MODEL_CACHE_DIRECTORY or pass --cache-dir; acquisition never guesses a cache location.",
	);
}

const cache = new ApprovedModelCache(cacheDirectory);
const results = taskArgument
	? [await cache.acquire(taskArgument)]
	: await cache.acquireAll();
const readiness = await Promise.all(
	results.map(({ model }) => cache.readiness(model.taskId)),
);
console.log(
	JSON.stringify(
		{
			schemaVersion: "opencut.approved-model-acquisition-result.v1",
			cacheDirectory,
			results,
			readiness,
		},
		null,
		2,
	),
);

function valueAfter(values: string[], name: string): string | undefined {
	const index = values.indexOf(name);
	if (index < 0) return undefined;
	const value = values[index + 1]?.trim();
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}
