use bridge::export;
use canonical_json::canonical_sha256;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const MEDIA_CAPABILITY_CATALOG_SCHEMA: &str = "opencut.media-capability-catalog.v1";
const MODEL_SELECTION_REQUIRED_REASON: &str = "Owner approval of an exact model ID, immutable version, canonical source, license, and SHA-256 is required before provider execution.";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaCapabilityCatalogInput {
    #[serde(default)]
    pub task_ids: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilityCatalog {
    pub schema_version: &'static str,
    pub catalog_version: u32,
    pub provider_execution: &'static str,
    pub cost: CatalogCost,
    pub tasks: Vec<MediaCapabilityTask>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCost {
    pub status: &'static str,
    pub amount: u32,
    pub currency: serde_json::Value,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilityTask {
    pub task_id: &'static str,
    pub input_media: &'static [&'static str],
    pub outputs: &'static [&'static str],
    pub requirements: ProviderTaskRequirements,
    pub readiness: CatalogReadiness,
    pub model_requirement: ModelRequirement,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTaskRequirements {
    pub contract_version: &'static str,
    pub request_kind: ProviderTaskKind,
    pub durable_job_type: &'static str,
    pub source_identity: &'static [&'static str],
    pub output_contract: &'static str,
    pub semantic_input_contract: &'static str,
    pub option_requirements: ProviderOptionRequirements,
    pub provenance_identity: &'static [&'static str],
    pub deterministic_cache_required: bool,
    pub cpu_fallback_required: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ProviderOptionRequirements {
    SubjectTracking {
        sample_interval_ticks: IntegerBounds,
        max_samples: IntegerBounds,
        max_subjects: IntegerBounds,
        prompt_max_chars: u32,
        normalized_initial_box: bool,
    },
    AudioCleanup {
        noise_reduction: NumberBounds,
        de_reverb: NumberBounds,
        de_ess: NumberBounds,
        high_pass_hz: NumberBounds,
    },
    StemSeparation {
        allowed_stem_sets: &'static [&'static str],
        sample_aligned_outputs_required: bool,
    },
    VoiceActivityDetection {
        threshold: NumberBounds,
        minimum_duration_ticks: IntegerBounds,
        padding_ticks: IntegerBounds,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntegerBounds {
    pub minimum: i64,
    pub maximum: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NumberBounds {
    pub minimum: f64,
    pub maximum: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTaskKind {
    SubjectTracking,
    AudioCleanup,
    StemSeparation,
    VoiceActivityDetection,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogReadiness {
    pub status: &'static str,
    pub can_execute: bool,
    pub reason: &'static str,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequirement {
    pub owner_approval_required: bool,
    pub required_identity: &'static [&'static str],
    pub selected_model: serde_json::Value,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MediaCapabilityCatalogResponse {
    Catalog(MediaCapabilityCatalog),
    Rejected { code: String, reason: String },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaExecutionBlockerInput {
    pub task_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaExecutionBlocker {
    pub status: &'static str,
    pub code: &'static str,
    pub reason: &'static str,
    pub task_id: String,
    pub provider_execution: &'static str,
}

#[export]
pub fn media_capability_catalog(
    input: MediaCapabilityCatalogInput,
) -> MediaCapabilityCatalogResponse {
    let all = tasks();
    let selected = if input.task_ids.is_empty() {
        all
    } else {
        let mut selected = Vec::with_capacity(input.task_ids.len());
        for requested in input.task_ids {
            let Some(task) = all.iter().find(|task| task.task_id == requested) else {
                return MediaCapabilityCatalogResponse::Rejected {
                    code: "UNKNOWN_MEDIA_TASK_ID".into(),
                    reason: format!("unknown media task ID: {requested}"),
                };
            };
            if !selected
                .iter()
                .any(|existing: &MediaCapabilityTask| existing.task_id == task.task_id)
            {
                selected.push(task.clone());
            }
        }
        selected
    };
    MediaCapabilityCatalogResponse::Catalog(MediaCapabilityCatalog {
        schema_version: MEDIA_CAPABILITY_CATALOG_SCHEMA,
        catalog_version: 1,
        provider_execution: "forbidden",
        cost: CatalogCost {
            status: "not-incurred",
            amount: 0,
            currency: serde_json::Value::Null,
        },
        tasks: selected,
    })
}

#[export]
pub fn media_execution_blocker(input: MediaExecutionBlockerInput) -> MediaExecutionBlocker {
    let known = tasks()
        .into_iter()
        .any(|task| task.task_id == input.task_id);
    if !known {
        return MediaExecutionBlocker {
            status: "rejected",
            code: "UNKNOWN_MEDIA_TASK_ID",
            reason: "unknown media task ID",
            task_id: input.task_id,
            provider_execution: "forbidden",
        };
    }
    MediaExecutionBlocker {
        status: "rejected",
        code: "MODEL_SELECTION_REQUIRED",
        reason: MODEL_SELECTION_REQUIRED_REASON,
        task_id: input.task_id,
        provider_execution: "forbidden",
    }
}

fn tasks() -> Vec<MediaCapabilityTask> {
    [
        (
            "opencut.task.subject-tracking.v1",
            &["video"][..],
            &["tracking-object"][..],
            ProviderTaskKind::SubjectTracking,
            "opencut.media-analysis.v1#subject-tracking",
        ),
        (
            "opencut.task.audio-cleanup.v1",
            &["audio", "video"][..],
            &["clean-audio-attachment"][..],
            ProviderTaskKind::AudioCleanup,
            "opencut.clean-audio-result.v1",
        ),
        (
            "opencut.task.stem-separation.v1",
            &["audio", "video"][..],
            &["aligned-stem-attachments"][..],
            ProviderTaskKind::StemSeparation,
            "opencut.stem-separation-result.v1",
        ),
        (
            "opencut.task.voice-activity-detection.v1",
            &["audio", "video"][..],
            &["activity-analysis-object"][..],
            ProviderTaskKind::VoiceActivityDetection,
            "opencut.media-analysis.v1#voice-activity",
        ),
    ]
    .into_iter()
    .map(
        |(task_id, input_media, outputs, request_kind, output_contract)| MediaCapabilityTask {
            task_id,
            input_media,
            outputs,
            requirements: ProviderTaskRequirements {
                contract_version: "opencut.provider-task-requirements.v1",
                request_kind,
                durable_job_type: "provider",
                source_identity: &["assetId", "contentSha256", "bytes", "durationTicks"],
                output_contract,
                semantic_input_contract: match request_kind {
                    ProviderTaskKind::SubjectTracking => "opencut.subject-tracking-request.v1",
                    ProviderTaskKind::AudioCleanup => "opencut.audio-cleanup-request.v1",
                    ProviderTaskKind::StemSeparation => "opencut.stem-separation-request.v1",
                    ProviderTaskKind::VoiceActivityDetection => {
                        "opencut.voice-activity-detection-request.v1"
                    }
                },
                option_requirements: provider_option_requirements(request_kind),
                provenance_identity: &[
                    "providerId",
                    "adapterId",
                    "adapterVersion",
                    "modelId",
                    "modelVersion",
                    "modelSha256",
                    "runtime",
                    "device",
                    "semanticInputHash",
                ],
                deterministic_cache_required: true,
                cpu_fallback_required: true,
            },
            readiness: CatalogReadiness {
                status: "model-selection-required",
                can_execute: false,
                reason: MODEL_SELECTION_REQUIRED_REASON,
            },
            model_requirement: ModelRequirement {
                owner_approval_required: true,
                required_identity: &["modelId", "version", "sha256", "source", "license"],
                selected_model: serde_json::Value::Null,
            },
        },
    )
    .collect()
}

fn provider_option_requirements(kind: ProviderTaskKind) -> ProviderOptionRequirements {
    match kind {
        ProviderTaskKind::SubjectTracking => ProviderOptionRequirements::SubjectTracking {
            sample_interval_ticks: IntegerBounds {
                minimum: 1,
                maximum: MAX_SAFE_INTEGER,
            },
            max_samples: IntegerBounds {
                minimum: 2,
                maximum: 1_000_000,
            },
            max_subjects: IntegerBounds {
                minimum: 1,
                maximum: 1_024,
            },
            prompt_max_chars: 4_096,
            normalized_initial_box: true,
        },
        ProviderTaskKind::AudioCleanup => ProviderOptionRequirements::AudioCleanup {
            noise_reduction: NumberBounds {
                minimum: 0.0,
                maximum: 1.0,
            },
            de_reverb: NumberBounds {
                minimum: 0.0,
                maximum: 1.0,
            },
            de_ess: NumberBounds {
                minimum: 0.0,
                maximum: 1.0,
            },
            high_pass_hz: NumberBounds {
                minimum: 0.0,
                maximum: 300.0,
            },
        },
        ProviderTaskKind::StemSeparation => ProviderOptionRequirements::StemSeparation {
            allowed_stem_sets: &["vocals-accompaniment", "vocals-drums-bass-other"],
            sample_aligned_outputs_required: true,
        },
        ProviderTaskKind::VoiceActivityDetection => {
            ProviderOptionRequirements::VoiceActivityDetection {
                threshold: NumberBounds {
                    minimum: 0.0,
                    maximum: 1.0,
                },
                minimum_duration_ticks: IntegerBounds {
                    minimum: 1,
                    maximum: MAX_SAFE_INTEGER,
                },
                padding_ticks: IntegerBounds {
                    minimum: 0,
                    maximum: MAX_SAFE_INTEGER,
                },
            }
        }
    }
}

const MEDIA_ANALYSIS_SCHEMA: &str = "opencut.media-analysis.v1";
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidateMediaAnalysisInput {
    pub operation_id: String,
    pub created_at: String,
    pub analysis: MediaAnalysisDraft,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAnalysisDraft {
    pub schema_version: String,
    pub analysis_id: String,
    pub project_id: String,
    pub scene_id: String,
    pub task_id: String,
    pub source: AnalysisSource,
    pub semantic_inputs: MediaAnalysisSemanticInputs,
    pub provenance: AnalysisProvenance,
    pub payload: AnalysisPayload,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MediaAnalysisSemanticInputs {
    SubjectTracking {
        sampling: TrackingSamplingOptions,
        prompt: Option<String>,
        initial_box: Option<NormalizedBox>,
        max_subjects: u16,
    },
    VoiceActivityDetection {
        channel: String,
        threshold: f64,
        minimum_duration_ticks: i64,
        padding_ticks: i64,
        range: SourceRange,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackingSamplingOptions {
    pub interval_ticks: i64,
    pub max_samples: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisSource {
    pub asset_id: String,
    pub media_kind: MediaKind,
    pub duration_ticks: i64,
    pub content_sha256: String,
    pub bytes: u64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MediaKind {
    Audio,
    Video,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisProvenance {
    pub origin: AnalysisOrigin,
    pub approval_status: ApprovalStatus,
    pub provider_id: String,
    pub adapter_id: String,
    pub adapter_version: String,
    pub model: ModelIdentity,
    pub runtime: String,
    pub device: ExecutionDevice,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub fallback_reason: Option<String>,
    pub lifecycle_events: Vec<ProviderLifecycleEvent>,
    pub cost: AnalysisCost,
    pub output_artifacts: Vec<ProviderOutputArtifact>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLifecycleEvent {
    pub sequence: u32,
    pub attempt: u32,
    pub kind: ProviderLifecycleEventKind,
    pub occurred_at: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderLifecycleEventKind {
    Submitted,
    Started,
    Progress,
    Retried,
    Completed,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisCost {
    pub status: AnalysisCostStatus,
    pub amount: f64,
    pub currency: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisCostStatus {
    NotIncurred,
    ExternalUnverified,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOutputArtifact {
    pub artifact_id: String,
    pub kind: String,
    pub content_sha256: String,
    pub bytes: u64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisOrigin {
    ExternalResult,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalStatus {
    Unverified,
    Approved,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelIdentity {
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub source: String,
    pub license: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionDevice {
    Cpu,
    Cuda,
    Webgpu,
    Other,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AnalysisPayload {
    SubjectTracking {
        coverage: SourceRange,
        subjects: Vec<TrackedSubject>,
        #[serde(default)]
        attachments: Vec<TrackingAttachment>,
    },
    VoiceActivity {
        channel: String,
        ranges: Vec<ActivityRange>,
        #[serde(default)]
        corrections: Vec<ActivityCorrection>,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRange {
    pub start_ticks: i64,
    pub end_ticks: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackedSubject {
    pub subject_id: String,
    pub label: Option<String>,
    pub samples: Vec<TrackingSample>,
    #[serde(default)]
    pub corrections: Vec<TrackingCorrection>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackingSample {
    pub sample_id: String,
    pub source_time_ticks: i64,
    #[serde(rename = "box")]
    pub box_: NormalizedBox,
    pub confidence: f64,
    pub occlusion: OcclusionState,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackingCorrection {
    pub correction_id: String,
    pub source_time_ticks: i64,
    #[serde(rename = "box")]
    pub box_: NormalizedBox,
    pub note: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OcclusionState {
    Visible,
    Partial,
    Occluded,
    Unknown,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackingAttachment {
    pub attachment_id: String,
    pub kind: TrackingAttachmentKind,
    pub target_id: String,
    pub subject_id: String,
    pub source_content_sha256: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrackingAttachmentKind {
    Reframe,
    Mask,
    Effect,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityRange {
    pub range_id: String,
    pub start_ticks: i64,
    pub end_ticks: i64,
    pub confidence: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityCorrection {
    pub correction_id: String,
    pub action: ActivityCorrectionAction,
    pub range_id: String,
    pub range: Option<ActivityRange>,
    pub note: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityCorrectionAction {
    Upsert,
    Remove,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyMediaAnalysisInput {
    pub analysis: MediaAnalysisRecord,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAnalysisRecord {
    pub schema_version: String,
    pub analysis_id: String,
    pub operation_id: String,
    pub version: u32,
    pub created_at: String,
    pub project_id: String,
    pub scene_id: String,
    pub task_id: String,
    pub source: AnalysisSource,
    pub semantic_inputs: MediaAnalysisSemanticInputs,
    pub semantic_input_hash: String,
    pub cache_identity: String,
    pub provenance: AnalysisProvenance,
    pub payload: AnalysisPayload,
    pub content_hash: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MediaAnalysisValidation {
    Validated { analysis: MediaAnalysisRecord },
    Rejected { code: String, reason: String },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveMediaAnalysisCreateInput {
    pub operation_id: String,
    pub created_at: String,
    pub analysis: MediaAnalysisDraft,
    pub existing_analysis: Option<MediaAnalysisRecord>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MediaAnalysisCreateResolution {
    Created { analysis: MediaAnalysisRecord },
    Replayed { analysis: MediaAnalysisRecord },
    Rejected { code: String, reason: String },
}

#[export]
pub fn validate_media_analysis(input: ValidateMediaAnalysisInput) -> MediaAnalysisValidation {
    match build_media_analysis(input) {
        Ok(analysis) => MediaAnalysisValidation::Validated { analysis },
        Err((code, reason)) => MediaAnalysisValidation::Rejected { code, reason },
    }
}

#[export]
pub fn resolve_media_analysis_create(
    input: ResolveMediaAnalysisCreateInput,
) -> MediaAnalysisCreateResolution {
    let created_at = input
        .existing_analysis
        .as_ref()
        .map(|analysis| analysis.created_at.clone())
        .unwrap_or(input.created_at);
    let proposed = match build_media_analysis(ValidateMediaAnalysisInput {
        operation_id: input.operation_id.clone(),
        created_at,
        analysis: input.analysis,
    }) {
        Ok(analysis) => analysis,
        Err((code, reason)) => {
            return MediaAnalysisCreateResolution::Rejected { code, reason };
        }
    };
    let Some(existing) = input.existing_analysis else {
        return MediaAnalysisCreateResolution::Created { analysis: proposed };
    };
    let verified = match verify_media_analysis(VerifyMediaAnalysisInput { analysis: existing }) {
        MediaAnalysisValidation::Validated { analysis } => analysis,
        MediaAnalysisValidation::Rejected { code, reason } => {
            return MediaAnalysisCreateResolution::Rejected { code, reason };
        }
    };
    if verified.operation_id != input.operation_id || verified.content_hash != proposed.content_hash
    {
        return MediaAnalysisCreateResolution::Rejected {
            code: "MEDIA_ANALYSIS_ID_REUSED".into(),
            reason: "analysisId was already used for a different operation or semantic input"
                .into(),
        };
    }
    MediaAnalysisCreateResolution::Replayed { analysis: verified }
}

#[export]
pub fn verify_media_analysis(input: VerifyMediaAnalysisInput) -> MediaAnalysisValidation {
    let record = input.analysis;
    let draft = MediaAnalysisDraft {
        schema_version: record.schema_version.clone(),
        analysis_id: record.analysis_id.clone(),
        project_id: record.project_id.clone(),
        scene_id: record.scene_id.clone(),
        task_id: record.task_id.clone(),
        source: record.source.clone(),
        semantic_inputs: record.semantic_inputs.clone(),
        provenance: record.provenance.clone(),
        payload: record.payload.clone(),
    };
    let rebuilt = build_media_analysis(ValidateMediaAnalysisInput {
        operation_id: record.operation_id.clone(),
        created_at: record.created_at.clone(),
        analysis: draft,
    });
    match rebuilt {
        Ok(rebuilt)
            if record.version == rebuilt.version
                && record.semantic_input_hash == rebuilt.semantic_input_hash
                && record.cache_identity == rebuilt.cache_identity
                && record.content_hash == rebuilt.content_hash =>
        {
            MediaAnalysisValidation::Validated { analysis: rebuilt }
        }
        Ok(_) => rejected_analysis(
            "MEDIA_ANALYSIS_INTEGRITY_FAILED",
            "stored analysis hashes or version do not match the Rust-owned contract",
        ),
        Err((code, reason)) => MediaAnalysisValidation::Rejected { code, reason },
    }
}

fn build_media_analysis(
    input: ValidateMediaAnalysisInput,
) -> Result<MediaAnalysisRecord, (String, String)> {
    let mut draft = input.analysis;
    for (name, value) in [
        ("operationId", input.operation_id.as_str()),
        ("createdAt", input.created_at.as_str()),
        ("analysisId", draft.analysis_id.as_str()),
        ("projectId", draft.project_id.as_str()),
        ("sceneId", draft.scene_id.as_str()),
        ("providerId", draft.provenance.provider_id.as_str()),
        ("adapterId", draft.provenance.adapter_id.as_str()),
        ("adapterVersion", draft.provenance.adapter_version.as_str()),
        ("modelId", draft.provenance.model.id.as_str()),
        ("modelVersion", draft.provenance.model.version.as_str()),
        ("modelSource", draft.provenance.model.source.as_str()),
        ("modelLicense", draft.provenance.model.license.as_str()),
        ("runtime", draft.provenance.runtime.as_str()),
    ] {
        require_text(name, value)?;
    }
    if draft.schema_version != MEDIA_ANALYSIS_SCHEMA {
        return reject(
            "UNSUPPORTED_MEDIA_ANALYSIS_VERSION",
            "unsupported media analysis schema",
        );
    }
    require_sha256("source.contentSha256", &draft.source.content_sha256)?;
    require_sha256("provenance.model.sha256", &draft.provenance.model.sha256)?;
    require_text("source.assetId", &draft.source.asset_id)?;
    require_ticks("source.durationTicks", draft.source.duration_ticks, false)?;
    if draft.source.bytes == 0 || draft.source.bytes > MAX_SAFE_INTEGER as u64 {
        return reject(
            "INVALID_SOURCE_IDENTITY",
            "source bytes must be a positive safe integer",
        );
    }
    if draft.provenance.approval_status != ApprovalStatus::Unverified {
        return reject(
            "MODEL_APPROVAL_REQUIRED",
            "no local media model has owner approval",
        );
    }
    validate_provenance(&mut draft.provenance)?;
    validate_semantic_inputs(&draft.task_id, &draft.source, &mut draft.semantic_inputs)?;
    validate_payload(&draft.task_id, &draft.source, &mut draft.payload)?;
    validate_semantic_result_binding(&draft.task_id, &draft.semantic_inputs, &draft.payload)?;
    let semantic_input_hash = hash(&json!({
        "taskId": draft.task_id,
        "source": {
            "assetId": draft.source.asset_id,
            "mediaKind": draft.source.media_kind,
            "durationTicks": draft.source.duration_ticks,
            "contentSha256": draft.source.content_sha256,
            "bytes": draft.source.bytes,
        },
        "semanticInputs": draft.semantic_inputs,
    }))?;
    let cache_identity = hash(&json!({
        "contractVersion": MEDIA_ANALYSIS_SCHEMA,
        "taskId": draft.task_id,
        "semanticInputHash": semantic_input_hash,
        "providerId": draft.provenance.provider_id,
        "adapterId": draft.provenance.adapter_id,
        "adapterVersion": draft.provenance.adapter_version,
        "modelSha256": draft.provenance.model.sha256,
        "runtime": draft.provenance.runtime,
        "device": draft.provenance.device,
    }))?;
    let mut record = MediaAnalysisRecord {
        schema_version: draft.schema_version,
        analysis_id: draft.analysis_id,
        operation_id: input.operation_id,
        version: 1,
        created_at: input.created_at,
        project_id: draft.project_id,
        scene_id: draft.scene_id,
        task_id: draft.task_id,
        source: draft.source,
        semantic_inputs: draft.semantic_inputs,
        semantic_input_hash,
        cache_identity,
        provenance: draft.provenance,
        payload: draft.payload,
        content_hash: String::new(),
    };
    let mut projection = serde_json::to_value(&record)
        .map_err(|error| ("INVALID_MEDIA_ANALYSIS".into(), error.to_string()))?;
    projection
        .as_object_mut()
        .expect("record serializes as object")
        .remove("contentHash");
    record.content_hash = hash(&projection)?;
    Ok(record)
}

fn validate_provenance(provenance: &mut AnalysisProvenance) -> Result<(), (String, String)> {
    for warning in &provenance.warnings {
        require_text("provenance warning", warning)?;
    }
    if provenance.warnings.len() > 1_000 {
        return reject(
            "INVALID_MEDIA_ANALYSIS",
            "provenance warnings exceed the supported bound",
        );
    }
    if let Some(reason) = &provenance.fallback_reason {
        require_text("fallback reason", reason)?;
    }
    if provenance.lifecycle_events.is_empty() || provenance.lifecycle_events.len() > 10_000 {
        return reject(
            "INVALID_PROVIDER_LIFECYCLE",
            "provider lifecycle must contain a bounded event history",
        );
    }
    provenance
        .lifecycle_events
        .sort_by_key(|event| event.sequence);
    for (index, event) in provenance.lifecycle_events.iter().enumerate() {
        if event.sequence as usize != index + 1 || event.attempt == 0 {
            return reject(
                "INVALID_PROVIDER_LIFECYCLE",
                "provider lifecycle sequences must be contiguous and attempts must be positive",
            );
        }
        require_text("provider lifecycle timestamp", &event.occurred_at)?;
    }
    let first = &provenance.lifecycle_events[0];
    if first.kind != ProviderLifecycleEventKind::Submitted || first.attempt != 1 {
        return reject(
            "INVALID_PROVIDER_LIFECYCLE",
            "provider lifecycle must begin with submitted attempt 1",
        );
    }
    for pair in provenance.lifecycle_events.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        let valid = match (previous.kind, current.kind) {
            (ProviderLifecycleEventKind::Submitted, ProviderLifecycleEventKind::Started) => {
                current.attempt == previous.attempt
            }
            (ProviderLifecycleEventKind::Started, ProviderLifecycleEventKind::Progress)
            | (ProviderLifecycleEventKind::Progress, ProviderLifecycleEventKind::Progress)
            | (ProviderLifecycleEventKind::Progress, ProviderLifecycleEventKind::Completed) => {
                current.attempt == previous.attempt
            }
            (ProviderLifecycleEventKind::Progress, ProviderLifecycleEventKind::Retried) => {
                previous.attempt.checked_add(1) == Some(current.attempt)
            }
            (ProviderLifecycleEventKind::Retried, ProviderLifecycleEventKind::Started) => {
                current.attempt == previous.attempt
            }
            _ => false,
        };
        if !valid {
            return reject(
                "INVALID_PROVIDER_LIFECYCLE",
                "provider lifecycle events or attempt transitions are invalid",
            );
        }
    }
    if provenance.lifecycle_events.last().map(|event| event.kind)
        != Some(ProviderLifecycleEventKind::Completed)
    {
        return reject(
            "INVALID_PROVIDER_LIFECYCLE",
            "the final provider lifecycle event must be completed",
        );
    }
    if !provenance.cost.amount.is_finite() || provenance.cost.amount < 0.0 {
        return reject(
            "INVALID_PROVIDER_COST",
            "provider cost amount must be finite and nonnegative",
        );
    }
    match provenance.cost.status {
        AnalysisCostStatus::NotIncurred
            if provenance.cost.amount == 0.0 && provenance.cost.currency.is_none() => {}
        AnalysisCostStatus::ExternalUnverified => {
            if let Some(currency) = &provenance.cost.currency {
                require_text("provider cost currency", currency)?;
            }
        }
        _ => {
            return reject(
                "INVALID_PROVIDER_COST",
                "not-incurred provider cost requires zero amount and no currency",
            );
        }
    }
    if provenance.output_artifacts.len() > 100_000 {
        return reject(
            "INVALID_PROVIDER_OUTPUT",
            "provider output artifact inventory exceeds the supported bound",
        );
    }
    provenance
        .output_artifacts
        .sort_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
    let mut artifact_ids = BTreeSet::new();
    for artifact in &provenance.output_artifacts {
        require_text("provider output artifact ID", &artifact.artifact_id)?;
        require_text("provider output artifact kind", &artifact.kind)?;
        require_sha256(
            "provider output artifact contentSha256",
            &artifact.content_sha256,
        )?;
        if artifact.bytes == 0
            || artifact.bytes > MAX_SAFE_INTEGER as u64
            || !artifact_ids.insert(artifact.artifact_id.as_str())
        {
            return reject(
                "INVALID_PROVIDER_OUTPUT",
                "provider output artifacts require unique IDs and positive safe byte counts",
            );
        }
    }
    Ok(())
}

fn validate_semantic_result_binding(
    task_id: &str,
    inputs: &MediaAnalysisSemanticInputs,
    payload: &AnalysisPayload,
) -> Result<(), (String, String)> {
    match (task_id, inputs, payload) {
        (
            "opencut.task.subject-tracking.v1",
            MediaAnalysisSemanticInputs::SubjectTracking {
                sampling,
                max_subjects,
                ..
            },
            AnalysisPayload::SubjectTracking { subjects, .. },
        ) => {
            if subjects.len() > usize::from(*max_subjects)
                || subjects
                    .iter()
                    .any(|subject| subject.samples.len() > sampling.max_samples as usize)
            {
                return reject(
                    "INCOMPATIBLE_SEMANTIC_INPUTS",
                    "tracking results exceed the requested subject or sample limits",
                );
            }
        }
        (
            "opencut.task.voice-activity-detection.v1",
            MediaAnalysisSemanticInputs::VoiceActivityDetection {
                channel,
                minimum_duration_ticks,
                range: requested_range,
                ..
            },
            AnalysisPayload::VoiceActivity {
                channel: result_channel,
                ranges,
                corrections,
            },
        ) => {
            if result_channel != channel {
                return reject(
                    "INCOMPATIBLE_SEMANTIC_INPUTS",
                    "voice activity result channel does not match the requested channel",
                );
            }
            let range_matches_request = |range: &ActivityRange| {
                range.start_ticks >= requested_range.start_ticks
                    && range.end_ticks <= requested_range.end_ticks
                    && range.end_ticks - range.start_ticks >= *minimum_duration_ticks
            };
            if ranges.iter().any(|range| !range_matches_request(range))
                || corrections.iter().any(|correction| {
                    correction
                        .range
                        .as_ref()
                        .is_some_and(|range| !range_matches_request(range))
                })
            {
                return reject(
                    "INCOMPATIBLE_SEMANTIC_INPUTS",
                    "voice activity ranges must satisfy the requested range and minimum duration",
                );
            }
        }
        _ => {
            return reject(
                "INCOMPATIBLE_SEMANTIC_INPUTS",
                "task, semantic inputs, and analysis payload are incompatible",
            );
        }
    }
    Ok(())
}

fn validate_semantic_inputs(
    task_id: &str,
    source: &AnalysisSource,
    inputs: &mut MediaAnalysisSemanticInputs,
) -> Result<(), (String, String)> {
    match (task_id, inputs) {
        (
            "opencut.task.subject-tracking.v1",
            MediaAnalysisSemanticInputs::SubjectTracking {
                sampling,
                prompt,
                initial_box,
                max_subjects,
            },
        ) => {
            require_ticks("tracking sample interval", sampling.interval_ticks, false)?;
            if sampling.interval_ticks > source.duration_ticks
                || !(2..=1_000_000).contains(&sampling.max_samples)
                || !(1..=1_024).contains(max_subjects)
            {
                return reject(
                    "INVALID_SEMANTIC_INPUTS",
                    "tracking sampling and subject limits are outside their supported bounds",
                );
            }
            if let Some(prompt) = prompt {
                require_text("tracking prompt", prompt)?;
            }
            if let Some(box_) = initial_box {
                validate_box(box_)?;
            }
        }
        (
            "opencut.task.voice-activity-detection.v1",
            MediaAnalysisSemanticInputs::VoiceActivityDetection {
                channel,
                threshold,
                minimum_duration_ticks,
                padding_ticks,
                range,
            },
        ) => {
            require_text("voice activity input channel", channel)?;
            if !threshold.is_finite() || !(0.0..=1.0).contains(threshold) {
                return reject(
                    "INVALID_SEMANTIC_INPUTS",
                    "voice activity threshold must be between zero and one",
                );
            }
            require_ticks(
                "voice activity minimum duration",
                *minimum_duration_ticks,
                false,
            )?;
            require_ticks("voice activity padding", *padding_ticks, true)?;
            if *minimum_duration_ticks > source.duration_ticks
                || *padding_ticks > source.duration_ticks
            {
                return reject(
                    "INVALID_SEMANTIC_INPUTS",
                    "voice activity duration options exceed the source duration",
                );
            }
            validate_range("voice activity input range", range, source.duration_ticks)?;
        }
        (known, _) if tasks().iter().any(|task| task.task_id == known) => {
            return reject(
                "INCOMPATIBLE_SEMANTIC_INPUTS",
                "task ID and semantic input kind are incompatible",
            );
        }
        _ => return reject("UNKNOWN_MEDIA_TASK_ID", "unknown media task ID"),
    }
    Ok(())
}

fn validate_payload(
    task_id: &str,
    source: &AnalysisSource,
    payload: &mut AnalysisPayload,
) -> Result<(), (String, String)> {
    match (task_id, payload) {
        (
            "opencut.task.subject-tracking.v1",
            AnalysisPayload::SubjectTracking {
                coverage,
                subjects,
                attachments,
            },
        ) => {
            if source.media_kind != MediaKind::Video {
                return reject("INCOMPATIBLE_MEDIA_KIND", "subject tracking requires video");
            }
            validate_range("tracking coverage", coverage, source.duration_ticks)?;
            if subjects.is_empty() {
                return reject(
                    "MALFORMED_TRACKING_SAMPLES",
                    "tracking requires at least one subject",
                );
            }
            subjects.sort_by(|left, right| left.subject_id.cmp(&right.subject_id));
            if subjects
                .windows(2)
                .any(|pair| pair[0].subject_id == pair[1].subject_id)
            {
                return reject(
                    "MALFORMED_TRACKING_SAMPLES",
                    "tracked subject IDs must be unique",
                );
            }
            for subject in subjects.iter_mut() {
                require_text("subjectId", &subject.subject_id)?;
                if subject.samples.len() < 2 {
                    return reject(
                        "MALFORMED_TRACKING_SAMPLES",
                        "tracking requires first and last samples",
                    );
                }
                subject.samples.sort_by(|left, right| {
                    left.source_time_ticks
                        .cmp(&right.source_time_ticks)
                        .then_with(|| left.sample_id.cmp(&right.sample_id))
                });
                if subject
                    .samples
                    .first()
                    .map(|sample| sample.source_time_ticks)
                    != Some(coverage.start_ticks)
                    || subject
                        .samples
                        .last()
                        .map(|sample| sample.source_time_ticks)
                        != Some(coverage.end_ticks)
                {
                    return reject(
                        "TRACKING_COVERAGE_INCOMPLETE",
                        "each subject requires samples at the first and last coverage ticks",
                    );
                }
                let mut previous = None;
                let mut sample_ids = BTreeSet::new();
                for sample in &subject.samples {
                    require_text("sampleId", &sample.sample_id)?;
                    if !sample_ids.insert(sample.sample_id.as_str()) {
                        return reject(
                            "MALFORMED_TRACKING_SAMPLES",
                            "tracking sample IDs must be unique within a subject",
                        );
                    }
                    if previous == Some(sample.source_time_ticks) {
                        return reject("MALFORMED_TRACKING_SAMPLES", "sample times must be unique");
                    }
                    previous = Some(sample.source_time_ticks);
                    validate_sample(
                        sample.source_time_ticks,
                        sample.confidence,
                        &sample.box_,
                        coverage,
                    )?;
                }
                subject.corrections.sort_by(|left, right| {
                    left.source_time_ticks
                        .cmp(&right.source_time_ticks)
                        .then_with(|| left.correction_id.cmp(&right.correction_id))
                });
                let mut correction_ids = BTreeSet::new();
                for correction in &subject.corrections {
                    require_text("correctionId", &correction.correction_id)?;
                    if !correction_ids.insert(correction.correction_id.as_str()) {
                        return reject(
                            "MALFORMED_TRACKING_CORRECTION",
                            "tracking correction IDs must be unique within a subject",
                        );
                    }
                    require_text("correction.note", &correction.note)?;
                    validate_box(&correction.box_)?;
                    if correction.source_time_ticks < coverage.start_ticks
                        || correction.source_time_ticks > coverage.end_ticks
                    {
                        return reject(
                            "MALFORMED_TRACKING_CORRECTION",
                            "correction is outside tracking coverage",
                        );
                    }
                }
            }
            attachments.sort_by(|left, right| left.attachment_id.cmp(&right.attachment_id));
            let mut attachment_ids = BTreeSet::new();
            for attachment in attachments {
                require_text("attachmentId", &attachment.attachment_id)?;
                if !attachment_ids.insert(attachment.attachment_id.as_str()) {
                    return reject(
                        "INCOMPATIBLE_ATTACHMENT",
                        "tracking attachment IDs must be unique",
                    );
                }
                require_text("attachment.targetId", &attachment.target_id)?;
                if attachment.source_content_sha256 != source.content_sha256 {
                    return reject(
                        "STALE_SOURCE_IDENTITY",
                        "attachment source identity does not match analysis source",
                    );
                }
                if !subjects
                    .iter()
                    .any(|subject| subject.subject_id == attachment.subject_id)
                {
                    return reject(
                        "INCOMPATIBLE_ATTACHMENT",
                        "attachment references an unknown tracked subject",
                    );
                }
            }
        }
        (
            "opencut.task.voice-activity-detection.v1",
            AnalysisPayload::VoiceActivity {
                channel,
                ranges,
                corrections,
            },
        ) => {
            require_text("voice activity channel", channel)?;
            ranges.sort_by(|left, right| {
                left.start_ticks
                    .cmp(&right.start_ticks)
                    .then_with(|| left.range_id.cmp(&right.range_id))
            });
            let mut previous_end = 0;
            let mut range_ids = BTreeSet::new();
            for range in ranges {
                validate_activity_range(range, source.duration_ticks)?;
                if !range_ids.insert(range.range_id.as_str()) {
                    return reject(
                        "MALFORMED_ACTIVITY_RANGES",
                        "voice activity range IDs must be unique",
                    );
                }
                if range.start_ticks < previous_end {
                    return reject(
                        "MALFORMED_ACTIVITY_RANGES",
                        "voice activity ranges must not overlap",
                    );
                }
                previous_end = range.end_ticks;
            }
            corrections.sort_by(|left, right| left.correction_id.cmp(&right.correction_id));
            let mut correction_ids = BTreeSet::new();
            let mut correction_targets = BTreeSet::new();
            for correction in corrections {
                require_text("activity correction ID", &correction.correction_id)?;
                if !correction_ids.insert(correction.correction_id.as_str()) {
                    return reject(
                        "MALFORMED_ACTIVITY_CORRECTION",
                        "voice activity correction IDs must be unique",
                    );
                }
                require_text("activity correction range ID", &correction.range_id)?;
                if !correction_targets.insert(correction.range_id.as_str()) {
                    return reject(
                        "MALFORMED_ACTIVITY_CORRECTION",
                        "voice activity corrections must target distinct range IDs",
                    );
                }
                require_text("activity correction note", &correction.note)?;
                match (correction.action, &correction.range) {
                    (ActivityCorrectionAction::Upsert, Some(range)) => {
                        validate_activity_range(range, source.duration_ticks)?;
                        if range.range_id != correction.range_id {
                            return reject(
                                "MALFORMED_ACTIVITY_CORRECTION",
                                "upsert correction range identity must match rangeId",
                            );
                        }
                    }
                    (ActivityCorrectionAction::Remove, None) => {}
                    _ => {
                        return reject(
                            "MALFORMED_ACTIVITY_CORRECTION",
                            "upsert requires a range and remove forbids one",
                        );
                    }
                }
            }
        }
        (known, _) if tasks().iter().any(|task| task.task_id == known) => {
            return reject(
                "INCOMPATIBLE_ANALYSIS_PAYLOAD",
                "task ID and analysis payload kind are incompatible",
            );
        }
        _ => return reject("UNKNOWN_MEDIA_TASK_ID", "unknown media task ID"),
    }
    Ok(())
}

fn validate_sample(
    ticks: i64,
    confidence: f64,
    box_: &NormalizedBox,
    coverage: &SourceRange,
) -> Result<(), (String, String)> {
    require_ticks("sample source time", ticks, true)?;
    if ticks < coverage.start_ticks || ticks > coverage.end_ticks {
        return reject(
            "MALFORMED_TRACKING_SAMPLES",
            "sample lies outside tracking coverage",
        );
    }
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return reject(
            "MALFORMED_TRACKING_SAMPLES",
            "sample confidence must be between zero and one",
        );
    }
    validate_box(box_)
}

fn validate_box(box_: &NormalizedBox) -> Result<(), (String, String)> {
    if ![box_.x, box_.y, box_.width, box_.height]
        .iter()
        .all(|value| value.is_finite())
        || box_.x < 0.0
        || box_.y < 0.0
        || box_.width <= 0.0
        || box_.height <= 0.0
        || box_.x + box_.width > 1.0
        || box_.y + box_.height > 1.0
    {
        return reject(
            "MALFORMED_TRACKING_BOX",
            "normalized tracking box must fit inside the source frame",
        );
    }
    Ok(())
}

fn validate_activity_range(
    range: &ActivityRange,
    duration_ticks: i64,
) -> Result<(), (String, String)> {
    require_text("activity range ID", &range.range_id)?;
    validate_range(
        "voice activity range",
        &SourceRange {
            start_ticks: range.start_ticks,
            end_ticks: range.end_ticks,
        },
        duration_ticks,
    )?;
    if !range.confidence.is_finite() || !(0.0..=1.0).contains(&range.confidence) {
        return reject(
            "MALFORMED_ACTIVITY_RANGES",
            "activity confidence must be between zero and one",
        );
    }
    Ok(())
}

fn validate_range(
    name: &str,
    range: &SourceRange,
    duration_ticks: i64,
) -> Result<(), (String, String)> {
    require_ticks(name, range.start_ticks, true)?;
    require_ticks(name, range.end_ticks, false)?;
    if range.end_ticks <= range.start_ticks || range.end_ticks > duration_ticks {
        return reject(
            "MALFORMED_SOURCE_RANGE",
            format!("{name} must be positive and fit inside the source"),
        );
    }
    Ok(())
}

fn require_text(name: &str, value: &str) -> Result<(), (String, String)> {
    if value.trim().is_empty() || value.len() > 4_096 {
        return reject(
            "INVALID_MEDIA_ANALYSIS",
            format!("{name} must be nonempty and bounded"),
        );
    }
    Ok(())
}

fn require_sha256(name: &str, value: &str) -> Result<(), (String, String)> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return reject(
            "INVALID_CONTENT_IDENTITY",
            format!("{name} must be a lowercase SHA-256 digest"),
        );
    }
    Ok(())
}

fn require_ticks(name: &str, value: i64, zero_allowed: bool) -> Result<(), (String, String)> {
    if value > MAX_SAFE_INTEGER || value < 0 || (!zero_allowed && value == 0) {
        return reject(
            "INVALID_SOURCE_TIME",
            format!("{name} must be a nonnegative safe integer"),
        );
    }
    Ok(())
}

fn hash(value: &Value) -> Result<String, (String, String)> {
    canonical_sha256(value)
        .map_err(|error| ("NON_CANONICAL_MEDIA_ANALYSIS".into(), error.to_string()))
}

fn reject<T>(code: &str, reason: impl Into<String>) -> Result<T, (String, String)> {
    Err((code.into(), reason.into()))
}

fn rejected_analysis(code: &str, reason: &str) -> MediaAnalysisValidation {
    MediaAnalysisValidation::Rejected {
        code: code.into(),
        reason: reason.into(),
    }
}

const AUDIO_GRAPH_SCHEMA: &str = "opencut.audio-processing-graph.v1";
const AUDIO_POST_PLAN_SCHEMA: &str = "opencut.audio-post-plan.v1";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioPostPlanningInput {
    pub expected_analysis_content_hash: String,
    pub current_source: CurrentSourceIdentity,
    pub analysis: MediaAnalysisRecord,
    pub graph: AudioProcessingGraph,
    pub ducking: DuckingConfiguration,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentSourceIdentity {
    pub asset_id: String,
    pub content_sha256: String,
    pub duration_ticks: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioProcessingGraph {
    pub schema_version: String,
    pub stages: Vec<AudioProcessingStage>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioProcessingStage {
    pub scope: AudioStageScope,
    pub processors: Vec<AudioProcessorNode>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AudioStageScope {
    Clip { clip_id: String },
    Track { track_id: String },
    Master,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioProcessorNode {
    pub node_id: String,
    pub order: u32,
    pub enabled: bool,
    pub processor: AudioProcessor,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AudioProcessor {
    Equalizer {
        bands: Vec<EqualizerBand>,
    },
    Compressor {
        threshold_db: f64,
        ratio: f64,
        attack_ms: f64,
        release_ms: f64,
        makeup_gain_db: f64,
    },
    Limiter {
        ceiling_db: f64,
        release_ms: f64,
    },
    Gate {
        threshold_db: f64,
        attack_ms: f64,
        hold_ms: f64,
        release_ms: f64,
    },
    DeEsser {
        frequency_hz: f64,
        threshold_db: f64,
        ratio: f64,
    },
    Pan {
        pan: f64,
    },
    ChannelMap {
        input_channels: u16,
        output_channels: u16,
        mapping: Vec<ChannelMapping>,
    },
    Gain {
        gain_db: f64,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EqualizerBand {
    pub band_id: String,
    pub kind: EqualizerBandKind,
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EqualizerBandKind {
    HighPass,
    LowPass,
    LowShelf,
    HighShelf,
    Bell,
    Notch,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelMapping {
    pub input: u16,
    pub output: u16,
    pub gain_db: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuckingConfiguration {
    pub target_track_id: String,
    pub reduction_db: f64,
    pub attack_ticks: i64,
    pub release_ticks: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPostPlan {
    pub schema_version: &'static str,
    pub analysis_id: String,
    pub analysis_content_hash: String,
    pub source: CurrentSourceIdentity,
    pub graph: AudioProcessingGraph,
    pub ducking: DuckingPlan,
    pub plan_hash: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingPlan {
    pub source_analysis_id: String,
    pub target_track_id: String,
    pub reduction_db: f64,
    pub attack_ticks: i64,
    pub release_ticks: i64,
    pub overlap_policy: &'static str,
    pub envelopes: Vec<DuckingEnvelope>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckingEnvelope {
    pub source_range_ids: Vec<String>,
    pub start_ticks: i64,
    pub speech_start_ticks: i64,
    pub speech_end_ticks: i64,
    pub end_ticks: i64,
    pub gain_db: f64,
    pub confidence: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AudioPostPlanningResponse {
    Planned {
        provider_execution: &'static str,
        plan: AudioPostPlan,
    },
    Rejected {
        code: String,
        reason: String,
    },
}

#[export]
pub fn plan_audio_post(mut input: AudioPostPlanningInput) -> AudioPostPlanningResponse {
    let verified = match verify_media_analysis(VerifyMediaAnalysisInput {
        analysis: input.analysis.clone(),
    }) {
        MediaAnalysisValidation::Validated { analysis } => analysis,
        MediaAnalysisValidation::Rejected { code, reason } => {
            return AudioPostPlanningResponse::Rejected { code, reason };
        }
    };
    if input.expected_analysis_content_hash != verified.content_hash {
        return rejected_plan(
            "STALE_ANALYSIS_IDENTITY",
            "expected analysis content hash does not match the durable object",
        );
    }
    if input.current_source.asset_id != verified.source.asset_id
        || input.current_source.content_sha256 != verified.source.content_sha256
        || input.current_source.duration_ticks != verified.source.duration_ticks
    {
        return rejected_plan(
            "STALE_SOURCE_IDENTITY",
            "current source identity does not match the analysis source",
        );
    }
    if verified.task_id != "opencut.task.voice-activity-detection.v1" {
        return rejected_plan(
            "INCOMPATIBLE_ANALYSIS_PAYLOAD",
            "audio ducking requires a voice-activity analysis",
        );
    }
    if let Err((code, reason)) = canonicalize_audio_graph(&mut input.graph) {
        return AudioPostPlanningResponse::Rejected { code, reason };
    }
    if let Err((code, reason)) = validate_ducking(&input.ducking) {
        return AudioPostPlanningResponse::Rejected { code, reason };
    }
    let AnalysisPayload::VoiceActivity {
        ranges,
        corrections,
        ..
    } = &verified.payload
    else {
        return rejected_plan(
            "INCOMPATIBLE_ANALYSIS_PAYLOAD",
            "audio ducking requires voice-activity ranges",
        );
    };
    let mut effective: BTreeMap<String, ActivityRange> = ranges
        .iter()
        .cloned()
        .map(|range| (range.range_id.clone(), range))
        .collect();
    for correction in corrections {
        match correction.action {
            ActivityCorrectionAction::Remove => {
                if effective.remove(&correction.range_id).is_none() {
                    return rejected_plan(
                        "MALFORMED_ACTIVITY_CORRECTION",
                        "remove correction references an unknown activity range",
                    );
                }
            }
            ActivityCorrectionAction::Upsert => {
                if let Some(range) = &correction.range {
                    effective.insert(correction.range_id.clone(), range.clone());
                }
            }
        }
    }
    let mut ranges: Vec<_> = effective.into_values().collect();
    ranges.sort_by(|left, right| {
        left.start_ticks
            .cmp(&right.start_ticks)
            .then_with(|| left.range_id.cmp(&right.range_id))
    });
    if ranges
        .windows(2)
        .any(|pair| pair[1].start_ticks < pair[0].end_ticks)
    {
        return rejected_plan(
            "MALFORMED_ACTIVITY_RANGES",
            "corrected voice activity ranges must not overlap",
        );
    }
    let expanded = ranges
        .into_iter()
        .map(|range| DuckingEnvelope {
            source_range_ids: vec![range.range_id],
            start_ticks: range
                .start_ticks
                .saturating_sub(input.ducking.attack_ticks)
                .max(0),
            speech_start_ticks: range.start_ticks,
            speech_end_ticks: range.end_ticks,
            end_ticks: range
                .end_ticks
                .saturating_add(input.ducking.release_ticks)
                .min(verified.source.duration_ticks),
            gain_db: input.ducking.reduction_db,
            confidence: range.confidence,
        })
        .collect::<Vec<_>>();
    let mut envelopes: Vec<DuckingEnvelope> = Vec::with_capacity(expanded.len());
    for envelope in expanded {
        if let Some(previous) = envelopes.last_mut()
            && envelope.start_ticks <= previous.end_ticks
        {
            previous
                .source_range_ids
                .extend(envelope.source_range_ids.into_iter());
            previous.speech_start_ticks =
                previous.speech_start_ticks.min(envelope.speech_start_ticks);
            previous.speech_end_ticks = previous.speech_end_ticks.max(envelope.speech_end_ticks);
            previous.end_ticks = previous.end_ticks.max(envelope.end_ticks);
            previous.confidence = previous.confidence.min(envelope.confidence);
            continue;
        }
        envelopes.push(envelope);
    }
    let ducking = DuckingPlan {
        source_analysis_id: verified.analysis_id.clone(),
        target_track_id: input.ducking.target_track_id,
        reduction_db: input.ducking.reduction_db,
        attack_ticks: input.ducking.attack_ticks,
        release_ticks: input.ducking.release_ticks,
        overlap_policy: "merge",
        envelopes,
    };
    let mut plan = AudioPostPlan {
        schema_version: AUDIO_POST_PLAN_SCHEMA,
        analysis_id: verified.analysis_id,
        analysis_content_hash: verified.content_hash,
        source: input.current_source,
        graph: input.graph,
        ducking,
        plan_hash: String::new(),
    };
    let mut projection = serde_json::to_value(&plan).expect("plan serializes");
    projection
        .as_object_mut()
        .expect("plan serializes as object")
        .remove("planHash");
    plan.plan_hash = match hash(&projection) {
        Ok(hash) => hash,
        Err((code, reason)) => return AudioPostPlanningResponse::Rejected { code, reason },
    };
    AudioPostPlanningResponse::Planned {
        provider_execution: "forbidden",
        plan,
    }
}

fn canonicalize_audio_graph(graph: &mut AudioProcessingGraph) -> Result<(), (String, String)> {
    if graph.schema_version != AUDIO_GRAPH_SCHEMA {
        return reject(
            "UNSUPPORTED_AUDIO_GRAPH_VERSION",
            "unsupported audio processing graph schema",
        );
    }
    let mut scopes = BTreeSet::new();
    let mut nodes = BTreeSet::new();
    for stage in &mut graph.stages {
        let key = scope_key(&stage.scope)?;
        if !scopes.insert(key) {
            return reject(
                "DUPLICATE_AUDIO_STAGE",
                "audio graph contains a duplicate scope",
            );
        }
        stage.processors.sort_by(|left, right| {
            left.order
                .cmp(&right.order)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
        for node in &mut stage.processors {
            require_text("audio processor nodeId", &node.node_id)?;
            if !nodes.insert(node.node_id.clone()) {
                return reject(
                    "DUPLICATE_AUDIO_PROCESSOR",
                    "audio processor node IDs must be unique",
                );
            }
            validate_processor(&mut node.processor)?;
        }
    }
    graph.stages.sort_by(|left, right| {
        scope_key(&left.scope)
            .expect("validated scope")
            .cmp(&scope_key(&right.scope).expect("validated scope"))
    });
    Ok(())
}

fn scope_key(scope: &AudioStageScope) -> Result<String, (String, String)> {
    match scope {
        AudioStageScope::Clip { clip_id } => {
            require_text("clip audio stage ID", clip_id)?;
            Ok(format!("0:{clip_id}"))
        }
        AudioStageScope::Track { track_id } => {
            require_text("track audio stage ID", track_id)?;
            Ok(format!("1:{track_id}"))
        }
        AudioStageScope::Master => Ok("2:".into()),
    }
}

fn validate_processor(processor: &mut AudioProcessor) -> Result<(), (String, String)> {
    match processor {
        AudioProcessor::Equalizer { bands } => {
            bands.sort_by(|left, right| left.band_id.cmp(&right.band_id));
            for band in bands {
                require_text("equalizer band ID", &band.band_id)?;
                finite_between("equalizer frequency", band.frequency_hz, 10.0, 96_000.0)?;
                finite_between("equalizer gain", band.gain_db, -96.0, 48.0)?;
                finite_between("equalizer Q", band.q, 0.01, 100.0)?;
            }
        }
        AudioProcessor::Compressor {
            threshold_db,
            ratio,
            attack_ms,
            release_ms,
            makeup_gain_db,
        } => {
            finite_between("compressor threshold", *threshold_db, -120.0, 24.0)?;
            finite_between("compressor ratio", *ratio, 1.0, 100.0)?;
            finite_between("compressor attack", *attack_ms, 0.0, 10_000.0)?;
            finite_between("compressor release", *release_ms, 0.0, 60_000.0)?;
            finite_between("compressor makeup gain", *makeup_gain_db, -96.0, 48.0)?;
        }
        AudioProcessor::Limiter {
            ceiling_db,
            release_ms,
        } => {
            finite_between("limiter ceiling", *ceiling_db, -96.0, 0.0)?;
            finite_between("limiter release", *release_ms, 0.0, 60_000.0)?;
        }
        AudioProcessor::Gate {
            threshold_db,
            attack_ms,
            hold_ms,
            release_ms,
        } => {
            finite_between("gate threshold", *threshold_db, -120.0, 0.0)?;
            finite_between("gate attack", *attack_ms, 0.0, 10_000.0)?;
            finite_between("gate hold", *hold_ms, 0.0, 60_000.0)?;
            finite_between("gate release", *release_ms, 0.0, 60_000.0)?;
        }
        AudioProcessor::DeEsser {
            frequency_hz,
            threshold_db,
            ratio,
        } => {
            finite_between("de-esser frequency", *frequency_hz, 10.0, 96_000.0)?;
            finite_between("de-esser threshold", *threshold_db, -120.0, 0.0)?;
            finite_between("de-esser ratio", *ratio, 1.0, 100.0)?;
        }
        AudioProcessor::Pan { pan } => finite_between("pan", *pan, -1.0, 1.0)?,
        AudioProcessor::ChannelMap {
            input_channels,
            output_channels,
            mapping,
        } => {
            if *input_channels == 0 || *output_channels == 0 {
                return reject("INVALID_AUDIO_PROCESSOR", "channel counts must be positive");
            }
            mapping.sort_by_key(|entry| (entry.output, entry.input));
            for entry in mapping {
                if entry.input >= *input_channels || entry.output >= *output_channels {
                    return reject(
                        "INVALID_AUDIO_PROCESSOR",
                        "channel mapping index is out of range",
                    );
                }
                finite_between("channel mapping gain", entry.gain_db, -96.0, 24.0)?;
            }
        }
        AudioProcessor::Gain { gain_db } => {
            finite_between("gain", *gain_db, -96.0, 48.0)?;
        }
    }
    Ok(())
}

fn validate_ducking(config: &DuckingConfiguration) -> Result<(), (String, String)> {
    require_text("ducking target track", &config.target_track_id)?;
    finite_between("ducking reduction", config.reduction_db, -96.0, 0.0)?;
    require_ticks("ducking attack", config.attack_ticks, true)?;
    require_ticks("ducking release", config.release_ticks, true)?;
    Ok(())
}

fn finite_between(
    name: &str,
    value: f64,
    minimum: f64,
    maximum: f64,
) -> Result<(), (String, String)> {
    if !value.is_finite() || value < minimum || value > maximum {
        return reject(
            "INVALID_AUDIO_PROCESSOR",
            format!("{name} is outside its supported range"),
        );
    }
    Ok(())
}

fn rejected_plan(code: &str, reason: &str) -> AudioPostPlanningResponse {
    AudioPostPlanningResponse::Rejected {
        code: code.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MediaCapabilityCatalogInput, MediaCapabilityCatalogResponse, media_capability_catalog,
    };

    #[test]
    fn catalog_never_claims_unapproved_models_are_ready() {
        let MediaCapabilityCatalogResponse::Catalog(catalog) =
            media_capability_catalog(MediaCapabilityCatalogInput::default())
        else {
            panic!("catalog should be available");
        };
        assert_eq!(catalog.tasks.len(), 4);
        assert!(catalog.tasks.iter().all(|task| {
            task.readiness.status == "model-selection-required"
                && !task.readiness.can_execute
                && task.model_requirement.selected_model.is_null()
        }));
    }
}
