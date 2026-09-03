import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import {
	buildCanonicalProjectState,
	canonicalSerialize,
	hashProjectContent,
	type ProjectContentHashResult,
	type ProjectContentInput,
	type ProjectContentMediaAsset,
	type ProjectContentProjectionOptions,
} from "./project-content-hash";

export function buildEditorProjectContentInput({
	project,
	mediaAssets,
}: {
	project: TProject;
	mediaAssets: readonly ProjectContentMediaInput[];
}): ProjectContentInput {
	return {
		project,
		mediaAssets: mediaAssets.map(toProjectContentMediaAsset),
	};
}

export type ProjectContentMediaInput = Pick<
	MediaAsset,
	| "id"
	| "name"
	| "type"
	| "file"
	| "width"
	| "height"
	| "duration"
	| "fps"
	| "hasAudio"
	| "sourceFingerprint"
	| "role"
	| "sourceIdentity"
>;

export function readEditorProjectContentInput(
	editor: EditorCore,
): ProjectContentInput {
	const project = editor.project.getActive();
	if (!project) throw new Error("No active project");
	return buildEditorProjectContentInput({
		project: { ...project, scenes: editor.scenes.getScenes() },
		mediaAssets: editor.media.getAssets(),
	});
}

export function serializeEditorProjectContent(editor: EditorCore): string {
	return canonicalSerialize(
		buildCanonicalProjectState(readEditorProjectContentInput(editor)),
	);
}

export function hashEditorProjectContent(
	editor: EditorCore,
	options: ProjectContentProjectionOptions = {},
): Promise<ProjectContentHashResult> {
	return hashProjectContent(readEditorProjectContentInput(editor), options);
}

function toProjectContentMediaAsset(
	asset: ProjectContentMediaInput,
): ProjectContentMediaAsset {
	return {
		id: asset.id,
		name: asset.name,
		type: asset.type,
		file: asset.file,
		width: asset.width,
		height: asset.height,
		duration: asset.duration,
		fps: asset.fps,
		hasAudio: asset.hasAudio,
		sourceFingerprint: asset.sourceFingerprint,
		role: asset.role,
		source:
			asset.sourceIdentity?.kind === "provider"
				? asset.sourceIdentity
				: {
						kind: "local",
						contentHash: asset.sourceIdentity?.contentHash,
					},
	};
}
