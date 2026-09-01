import type { EditorCore } from "@/core";
import { createTimelineAudioBuffer } from "@/media/audio";
import { measureLoudness } from "@/media/loudness";
import { getUniformAudioGainRange } from "./audio-mix-gain";
import type {
	AutomationAudioAnalysisRequest,
	AutomationAudioAnalysisResult,
} from "./types";

export async function analyzeAutomationAudio({
	editor,
	request,
	revision,
}: {
	editor: EditorCore;
	request: AutomationAudioAnalysisRequest;
	revision: number;
}): Promise<AutomationAudioAnalysisResult> {
	const activeProject = editor.project.getActive();
	if (!activeProject)
		return { status: "rejected", reason: "No active project" };
	if (request.projectId !== activeProject.metadata.id) {
		return {
			status: "rejected",
			reason: `active project is ${activeProject.metadata.id}`,
		};
	}
	if (request.expectedRevision !== revision) {
		return {
			status: "conflict",
			expectedRevision: request.expectedRevision,
			actualRevision: revision,
		};
	}
	const tracks = editor.scenes.getActiveScene().tracks;
	const mediaAssets = editor.media.getAssets();
	const duration = editor.timeline.getTotalDuration();
	if (duration <= 0) {
		return { status: "rejected", reason: "Project is empty" };
	}
	const audioBuffer = await createTimelineAudioBuffer({
		tracks,
		mediaAssets,
		duration,
		applyMastering: false,
	});
	if (!audioBuffer) {
		return {
			status: "rejected",
			reason: "project has no decodable audible timeline audio",
		};
	}
	const gainRange = getUniformAudioGainRange({ tracks, mediaAssets });
	return {
		status: "analyzed",
		projectId: activeProject.metadata.id,
		revision,
		analysis: {
			...measureLoudness({ buffer: audioBuffer }),
			...gainRange,
		},
	};
}
