import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSupervisorKind } from "./provider-supervisor-store";

const [provider, counterPath, startedPath, donePath, delayValue] =
	process.argv.slice(2);
if (!isProvider(provider) || !counterPath || !startedPath || !donePath) {
	throw new Error("fixture provider arguments are required");
}
const delayMs = Number(delayValue ?? 0);
const request = JSON.parse(await Bun.stdin.text()) as Record<
	string,
	unknown
>;
await appendFile(counterPath, `${process.pid}\n`);
await writeFile(startedPath, String(process.pid));
if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));

const response = await fixtureResponse(provider, request);
await writeFile(donePath, String(process.pid));
process.stdout.write(JSON.stringify(response));

async function fixtureResponse(
	provider: ProviderSupervisorKind,
	request: Record<string, unknown>,
) {
	if (provider === "subject-tracker-command") {
		return {
			protocolVersion: 1,
			status: "completed",
			coordinateSpace: "normalized-source",
			samples: [
				{
					sourceTime: 0,
					box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
					confidence: 0.95,
				},
				{
					sourceTime: 12_000,
					box: { x: 0.2, y: 0.25, width: 0.3, height: 0.4 },
					confidence: 0.9,
				},
				{
					sourceTime: 24_000,
					box: { x: 0.3, y: 0.3, width: 0.3, height: 0.4 },
					confidence: 0.85,
				},
			],
			model: { id: "fixture-tracker", version: "3" },
			warnings: ["full tracker fixture"],
		};
	}
	const outputDirectory = String(request.outputDirectory);
	await mkdir(outputDirectory, { recursive: true });
	const fileName =
		provider === "audio-cleaner-command" ? "clean.wav" : "matte.webm";
	const artifactPath = join(outputDirectory, fileName);
	await writeFile(
		artifactPath,
		provider === "audio-cleaner-command"
			? Buffer.from("fixture-clean-audio")
			: Buffer.from("fixture-video-matte"),
	);
	return {
		protocolVersion: 1,
		status: "completed",
		artifact: {
			path: fileName,
			...(provider === "matte-producer-command" ? { channel: "red" } : {}),
		},
		model: {
			id:
				provider === "audio-cleaner-command"
					? "fixture-cleaner"
					: "fixture-matte",
			version: provider === "audio-cleaner-command" ? "1" : "2",
		},
		warnings: [`${provider} fixture`],
	};
}

function isProvider(value: string | undefined): value is ProviderSupervisorKind {
	return new Set([
		"audio-cleaner-command",
		"matte-producer-command",
		"subject-tracker-command",
	]).has(String(value));
}
