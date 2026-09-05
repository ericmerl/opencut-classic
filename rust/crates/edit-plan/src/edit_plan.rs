//! Typed, deterministic edit-plan simulation shared by native and WASM callers.

mod canonical;
mod catalog;
mod model;
pub use catalog::*;
pub use model::*;

use bridge::export;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use time::{MediaTime, TICKS_PER_SECOND};

const SNAPSHOT_VERSION: &str = "opencut.edit-plan-snapshot.v2";
const MAX_OPERATIONS: usize = 1_000;
const MAX_ID_BYTES: usize = 256;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateEditPlanOptions {
    pub contract_version: String,
    pub source: SourceBinding,
    pub capability_snapshot: CapabilitySnapshot,
    pub policy: Policy,
    pub description: String,
    pub operations: Vec<EditOperation>,
    pub before: ProjectSnapshot,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBinding {
    pub connection_identity: ConnectionIdentity,
    pub project_id: String,
    pub scene_id: String,
    pub session_revision: u64,
    pub canonical_project_hash: String,
    pub durable_write_version: u64,
    pub save_receipt_id: String,
    pub save_operation_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionIdentity {
    pub server_instance_id: String,
    pub editor_instance_id: String,
    pub editor_session_id: String,
    pub connection_generation: u64,
    pub bridge_protocol_version: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitySnapshot {
    pub hash: String,
    pub edit_plan_ready: bool,
    pub provider_execution: ProviderExecution,
    pub cost: Cost,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub warning_policy: WarningPolicy,
    pub provider_execution: ProviderExecution,
    pub cost_policy: CostPolicy,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WarningPolicy {
    Allow,
    RejectAny,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderExecution {
    Forbidden,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CostPolicy {
    RequireExact,
    AllowBounded,
    AllowUnavailable,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Cost {
    NotApplicable,
    Exact {
        currency: String,
        minor_units: u64,
    },
    Bounded {
        currency: String,
        maximum_minor_units: u64,
    },
    Unavailable {
        reason: String,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object, missing_as_null)
)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum EditPlanEvaluationResponse {
    Validated { result: Box<EditPlanEvaluation> },
    Rejected { error: EditPlanError },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditPlanEvaluation {
    pub schema_version: String,
    pub source: SourceBinding,
    pub plan_fingerprint: String,
    pub preflight_fingerprint: String,
    pub plan_diff_hash: String,
    pub predicted_project_hash: String,
    pub before_summary: Summary,
    pub predicted_after_summary: Summary,
    pub before: ProjectSnapshot,
    pub predicted_after: ProjectSnapshot,
    #[cfg_attr(feature = "wasm", tsify(type = "ResolvedEditOperation[]"))]
    pub resolved_operations: Vec<EditOperation>,
    pub resolved_ids: Vec<ResolvedIdAllocation>,
    pub changed_objects: Vec<ChangedObject>,
    pub timing_consequences: Vec<TimingConsequence>,
    pub ripple_expansion: Vec<Expansion>,
    pub relationship_expansion: Vec<Expansion>,
    pub warnings: Vec<Warning>,
    pub requirements: CapabilitySnapshot,
    pub cost: Cost,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub canonical_hash: String,
    pub track_count: usize,
    pub element_count: usize,
    pub transition_count: usize,
    pub duration_ticks: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangedObject {
    pub object_type: String,
    pub object_id: String,
    pub field_path: String,
    pub before: CanonicalValue,
    pub after: CanonicalValue,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingConsequence {
    pub operation_index: usize,
    pub element_id: String,
    pub before_start_ticks: Option<i64>,
    pub after_start_ticks: Option<i64>,
    pub before_duration_ticks: Option<i64>,
    pub after_duration_ticks: Option<i64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedIdAllocation {
    pub operation_index: usize,
    pub role: AllocationRole,
    pub source_id: Option<String>,
    pub resolved_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expansion {
    pub operation_index: usize,
    pub cause_id: String,
    pub affected_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Warning {
    pub code: WarningCode,
    pub operation_index: usize,
    pub object_id: Option<String>,
    pub message: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WarningCode {
    TimelineGapPossible,
    TransitionRemoved,
    RelationshipPruned,
    CaptionOverlap,
    CaptionReadingSpeed,
}

/// Captions faster than this are hard to read at full speed; the evaluator
/// warns rather than rejects so a reviewer decides.
pub const CAPTION_MAX_CHARS_PER_SECOND: f64 = 20.0;
/// Default character budget for one rechunked caption: two short lines of
/// a large social caption.
pub const CAPTION_DEFAULT_MAX_CHARS: u32 = 32;
/// Default pause (half a second) that a rechunked caption will not bridge.
pub const CAPTION_DEFAULT_MAX_GAP_TICKS: i64 = TICKS_PER_SECOND / 2;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditPlanError {
    pub code: ErrorCode,
    pub message: String,
    pub operation_index: Option<usize>,
    pub path: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ContractVersion,
    SnapshotVersion,
    SourceMismatch,
    CapabilityNotReady,
    CostUnavailable,
    EmptyPlan,
    TooManyOperations,
    InvalidValue,
    DuplicateId,
    UnknownReference,
    IncompatibleTrack,
    UnsupportedFrameRate,
    Bounds,
    SilentNoOp,
    ArithmeticOverflow,
}

/// The reusable caption style presets, exported so every shell resolves the
/// same style for a preset id.
#[export]
pub fn caption_style_presets() -> CaptionStylePresetList {
    model::caption_style_presets()
}

/// Expands a caption style's preset the way the evaluator does.
#[export]
pub fn resolve_caption_style(options: ResolveCaptionStyleOptions) -> ResolveCaptionStyleResponse {
    match model::resolve_caption_style(&options.style) {
        Ok(style) => ResolveCaptionStyleResponse::Resolved { style },
        Err(reason) => ResolveCaptionStyleResponse::Rejected { reason },
    }
}

#[export]
pub fn evaluate_edit_plan(options: EvaluateEditPlanOptions) -> EditPlanEvaluationResponse {
    match evaluate(options) {
        Ok(result) => EditPlanEvaluationResponse::Validated {
            result: Box::new(result),
        },
        Err(error) => EditPlanEvaluationResponse::Rejected { error },
    }
}

pub fn evaluate(options: EvaluateEditPlanOptions) -> Result<EditPlanEvaluation, EditPlanError> {
    validate_options(&options)?;
    let mut fingerprint_operations = options.operations.clone();
    clear_internal_resolved_fields(&mut fingerprint_operations);
    let plan_fingerprint = hash_serialized(&PlanFingerprintDomain {
        contract_version: &options.contract_version,
        description: &options.description,
        operations: &fingerprint_operations,
    })?;
    let preflight_fingerprint = hash_serialized(&PreflightFingerprintDomain {
        plan_fingerprint: &plan_fingerprint,
        source: &options.source,
        capability_snapshot: &options.capability_snapshot,
        policy: &options.policy,
    })?;
    let before = options.before.clone();
    let before_active = canonical::extract_active(
        &before,
        &options.source.project_id,
        &options.source.scene_id,
    )?;
    let before_summary = summarize(&before)?;
    let mut state = State::new(before_active.clone(), &before)?;
    let mut resolved_operations = Vec::with_capacity(options.operations.len());
    let mut ripple = BTreeSet::new();
    let mut relationships = BTreeSet::new();
    let mut warnings = BTreeSet::new();
    let mut timing_consequences = Vec::new();
    for (index, operation) in options.operations.iter().enumerate() {
        let resolved = state.resolve(operation.clone(), index, &plan_fingerprint)?;
        let prior = state.snapshot.clone();
        state.apply(
            &resolved,
            index,
            &mut ripple,
            &mut relationships,
            &mut warnings,
        )?;
        if operation_uses_ripple(&resolved) {
            apply_ripple_adjustments(
                &prior,
                &mut state.snapshot,
                operation_primary_element_id(&resolved),
                index,
                &mut ripple,
            )?;
        }
        if prior == state.snapshot {
            return Err(error(
                ErrorCode::SilentNoOp,
                "operation did not change state",
                Some(index),
                None,
            ));
        }
        timing_consequences.extend(timing_diff_step(&prior, &state.snapshot, index));
        resolved_operations.push(resolved);
    }
    state.validate_integrity(None)?;
    let resolved_ids = state.resolved_ids.clone();
    let retained_media_ids = state.media_assets.keys().cloned().collect::<BTreeSet<_>>();
    let predicted_after_active = state.snapshot;
    let mut predicted_after = canonical::merge_active(&before, &predicted_after_active)?;
    predicted_after
        .media_assets
        .retain(|asset| retained_media_ids.contains(&asset.id));
    let predicted_after_summary = summarize(&predicted_after)?;
    let changed_objects = diff_snapshots(&options.source.project_id, &before, &predicted_after)?;
    let plan_diff_hash = hash_serialized(&DiffFingerprintDomain {
        predicted_project_hash: &predicted_after_summary.canonical_hash,
        changed_objects: &changed_objects,
        timing_consequences: &timing_consequences,
        ripple_expansion: &ripple,
        relationship_expansion: &relationships,
    })?;
    if options.policy.warning_policy == WarningPolicy::RejectAny && !warnings.is_empty() {
        return Err(error(
            ErrorCode::InvalidValue,
            "warning policy rejected the plan",
            None,
            Some("policy.warningPolicy"),
        ));
    }
    Ok(EditPlanEvaluation {
        schema_version: CONTRACT_VERSION.into(),
        source: options.source,
        plan_fingerprint,
        preflight_fingerprint,
        plan_diff_hash,
        predicted_project_hash: predicted_after_summary.canonical_hash.clone(),
        before_summary,
        predicted_after_summary,
        before,
        predicted_after,
        resolved_operations,
        resolved_ids,
        changed_objects,
        timing_consequences,
        ripple_expansion: ripple.into_iter().collect(),
        relationship_expansion: relationships.into_iter().collect(),
        warnings: warnings.into_iter().collect(),
        requirements: options.capability_snapshot.clone(),
        cost: options.capability_snapshot.cost,
    })
}

fn clear_internal_resolved_fields(operations: &mut [EditOperation]) {
    for operation in operations {
        match operation {
            EditOperation::InsertCaptions { captions, .. } => {
                for caption in captions {
                    caption.resolved_name = None;
                    caption.resolved_content = None;
                    caption.resolved_params = None;
                    caption.resolved_layout_version = None;
                    caption.resolved_layout_engine = None;
                }
            }
            EditOperation::UpdateCaption {
                resolved_allocations,
                ..
            }
            | EditOperation::SplitCaption {
                resolved_allocations,
                ..
            }
            | EditOperation::SetRetime {
                resolved_allocations,
                ..
            }
            | EditOperation::Trim {
                resolved_allocations,
                ..
            } => *resolved_allocations = None,
            EditOperation::RestyleCaptions {
                resolved_params, ..
            } => *resolved_params = None,
            EditOperation::RemoveTrack {
                resolved_cascade_element_ids,
                ..
            } => *resolved_cascade_element_ids = None,
            EditOperation::RechunkCaptions {
                resolved_chunks,
                resolved_allocations,
                ..
            } => {
                *resolved_chunks = None;
                *resolved_allocations = None;
            }
            _ => {}
        }
    }
}

fn operation_uses_ripple(operation: &EditOperation) -> bool {
    match operation {
        EditOperation::Delete { ripple, .. }
        | EditOperation::Trim { ripple, .. }
        | EditOperation::Split { ripple, .. } => *ripple,
        _ => false,
    }
}

fn operation_primary_element_id(operation: &EditOperation) -> &str {
    match operation {
        EditOperation::Delete { element_id, .. }
        | EditOperation::Trim { element_id, .. }
        | EditOperation::Split { element_id, .. } => element_id,
        _ => "",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanFingerprintDomain<'a> {
    contract_version: &'a str,
    description: &'a str,
    operations: &'a [EditOperation],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightFingerprintDomain<'a> {
    plan_fingerprint: &'a str,
    source: &'a SourceBinding,
    capability_snapshot: &'a CapabilitySnapshot,
    policy: &'a Policy,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffFingerprintDomain<'a> {
    predicted_project_hash: &'a str,
    changed_objects: &'a [ChangedObject],
    timing_consequences: &'a [TimingConsequence],
    ripple_expansion: &'a BTreeSet<Expansion>,
    relationship_expansion: &'a BTreeSet<Expansion>,
}

fn validate_options(options: &EvaluateEditPlanOptions) -> Result<(), EditPlanError> {
    if options.contract_version != CONTRACT_VERSION {
        return Err(error(
            ErrorCode::ContractVersion,
            "unsupported contract version",
            None,
            Some("contractVersion"),
        ));
    }
    canonical::validate_projection(&options.before, &options.source.scene_id)?;
    for (path, id) in [
        ("projectId", &options.source.project_id),
        ("sceneId", &options.source.scene_id),
        ("saveReceiptId", &options.source.save_receipt_id),
        ("saveOperationId", &options.source.save_operation_id),
    ] {
        validate_id(id, None, path)?;
    }
    for (path, id) in [
        (
            "serverInstanceId",
            &options.source.connection_identity.server_instance_id,
        ),
        (
            "editorInstanceId",
            &options.source.connection_identity.editor_instance_id,
        ),
        (
            "editorSessionId",
            &options.source.connection_identity.editor_session_id,
        ),
    ] {
        validate_id(id, None, path)?;
    }
    if options.source.connection_identity.connection_generation == 0
        || options.source.connection_identity.bridge_protocol_version != 2
    {
        return Err(error(
            ErrorCode::SourceMismatch,
            "invalid v2 connection affinity",
            None,
            Some("source.connectionIdentity"),
        ));
    }
    validate_digest(
        &options.source.canonical_project_hash,
        "source.canonicalProjectHash",
    )?;
    let actual_hash = hash_serialized(&options.before)?;
    if actual_hash != options.source.canonical_project_hash {
        return Err(error(
            ErrorCode::SourceMismatch,
            format!(
                "source canonical project hash does not match before (expected {}, actual {})",
                options.source.canonical_project_hash, actual_hash
            ),
            None,
            Some("source.canonicalProjectHash"),
        ));
    }
    validate_digest(&options.capability_snapshot.hash, "capabilitySnapshot.hash")?;
    if !options.capability_snapshot.edit_plan_ready {
        return Err(error(
            ErrorCode::CapabilityNotReady,
            "edit-plan evaluator is not ready",
            None,
            None,
        ));
    }
    if options.capability_snapshot.provider_execution != ProviderExecution::Forbidden
        || options.policy.provider_execution != ProviderExecution::Forbidden
    {
        return Err(error(
            ErrorCode::InvalidValue,
            "provider execution must be forbidden",
            None,
            Some("policy.providerExecution"),
        ));
    }
    validate_cost(
        &options.capability_snapshot.cost,
        options.policy.cost_policy,
    )?;
    if options.operations.is_empty() {
        return Err(error(
            ErrorCode::EmptyPlan,
            "operations cannot be empty",
            None,
            Some("operations"),
        ));
    }
    if options.operations.len() > MAX_OPERATIONS {
        return Err(error(
            ErrorCode::TooManyOperations,
            "operations exceed the 1000 item limit",
            None,
            Some("operations"),
        ));
    }
    if options.description.trim().is_empty() {
        return Err(error(
            ErrorCode::InvalidValue,
            "description cannot be empty",
            None,
            Some("description"),
        ));
    }
    Ok(())
}

fn validate_cost(cost: &Cost, policy: CostPolicy) -> Result<(), EditPlanError> {
    let accepted = matches!(cost, Cost::NotApplicable | Cost::Exact { .. })
        || matches!(
            (cost, policy),
            (
                Cost::Bounded { .. },
                CostPolicy::AllowBounded | CostPolicy::AllowUnavailable
            ) | (Cost::Unavailable { .. }, CostPolicy::AllowUnavailable)
        );
    if accepted {
        Ok(())
    } else {
        Err(error(
            ErrorCode::CostUnavailable,
            "cost evidence does not satisfy policy",
            None,
            Some("capabilitySnapshot.cost"),
        ))
    }
}

struct State {
    snapshot: ActiveSceneSnapshot,
    media_assets: BTreeMap<String, CanonicalMediaAsset>,
    media_reference_counts: BTreeMap<String, usize>,
    ids: BTreeSet<String>,
    resolved_ids: Vec<ResolvedIdAllocation>,
}

struct InsertTrackResolution<'a> {
    element_type: &'a str,
    explicit_track_id: Option<&'a str>,
    element_id: &'a str,
    start_time: MediaTime,
    duration: MediaTime,
    auto_track_id: &'a mut Option<String>,
    resolved_allocations: &'a mut Option<Vec<ObjectIdAllocation>>,
}

impl State {
    fn new(
        snapshot: ActiveSceneSnapshot,
        project: &ProjectSnapshot,
    ) -> Result<Self, EditPlanError> {
        let media_reference_counts = media_reference_counts(project);
        let reserved_ids = project_object_ids(project);
        let mut state = Self {
            snapshot,
            media_assets: project
                .media_assets
                .iter()
                .cloned()
                .map(|asset| (asset.id.clone(), asset))
                .collect(),
            media_reference_counts,
            ids: reserved_ids,
            resolved_ids: Vec::new(),
        };
        state.validate_integrity(None)?;
        Ok(state)
    }

    fn validate_integrity(&mut self, operation_index: Option<usize>) -> Result<(), EditPlanError> {
        let mut ids = BTreeSet::new();
        for track in &self.snapshot.tracks {
            validate_id(&track.track_id, operation_index, "trackId")?;
            unique(&mut ids, &track.track_id, operation_index)?;
            if let Some(routing) = &track.track_matte {
                let source = self
                    .snapshot
                    .tracks
                    .iter()
                    .find(|candidate| candidate.track_id == routing.source_track_id)
                    .ok_or_else(|| {
                        error(
                            ErrorCode::UnknownReference,
                            "track matte source is missing",
                            operation_index,
                            Some("track.trackMatte.sourceTrackId"),
                        )
                    })?;
                if source.track_id == track.track_id {
                    return Err(error(
                        ErrorCode::InvalidValue,
                        "track matte source cannot be its destination",
                        operation_index,
                        Some("track.trackMatte.sourceTrackId"),
                    ));
                }
                if matches!(source.track_type.as_str(), "audio" | "effect")
                    || source.role == "audio"
                    || matches!(track.track_type.as_str(), "audio" | "effect")
                    || track.role == "audio"
                {
                    return Err(error(
                        ErrorCode::IncompatibleTrack,
                        "track matte routing requires visual tracks",
                        operation_index,
                        Some("track.trackMatte"),
                    ));
                }
                if routing.enabled && source.hidden == Some(true) {
                    return Err(error(
                        ErrorCode::InvalidValue,
                        "track matte source is hidden",
                        operation_index,
                        Some("track.trackMatte.sourceTrackId"),
                    ));
                }
                if routing.enabled {
                    let mut next_id = Some(routing.source_track_id.as_str());
                    let mut visited = BTreeSet::new();
                    while let Some(candidate_id) = next_id {
                        if candidate_id == track.track_id || !visited.insert(candidate_id) {
                            return Err(error(
                                ErrorCode::InvalidValue,
                                "track matte dependency cycle",
                                operation_index,
                                Some("track.trackMatte.sourceTrackId"),
                            ));
                        }
                        next_id = self
                            .snapshot
                            .tracks
                            .iter()
                            .find(|candidate| candidate.track_id == candidate_id)
                            .and_then(|candidate| candidate.track_matte.as_ref())
                            .filter(|candidate| candidate.enabled)
                            .map(|candidate| candidate.source_track_id.as_str());
                    }
                }
            }
        }
        for element in &self.snapshot.elements {
            validate_id(&element.element_id, operation_index, "elementId")?;
            unique(&mut ids, &element.element_id, operation_index)?;
            if !self
                .snapshot
                .tracks
                .iter()
                .any(|track| track.track_id == element.track_id)
            {
                return Err(error(
                    ErrorCode::UnknownReference,
                    "element references an unknown track",
                    operation_index,
                    Some("element.trackId"),
                ));
            }
            validate_interval(element.start_time, element.duration, operation_index)?;
            validate_finite_element(element, operation_index)?;
            if let Some(key) = &element.key {
                if let Err(mut key_error) = validate_compositing_key(key, 0) {
                    key_error.operation_index = operation_index;
                    return Err(key_error);
                }
            }
        }
        for transition in &self.snapshot.transitions {
            unique(&mut ids, &transition.transition_id, operation_index)?;
        }
        validate_catalog_state(
            &self.snapshot.tracks,
            &self.snapshot.elements,
            &self.snapshot.transitions,
            operation_index,
        )?;
        for bookmark in &self.snapshot.bookmarks {
            if let Some(bookmark_id) = &bookmark.bookmark_id {
                validate_id(bookmark_id, operation_index, "bookmarkId")?;
                unique(&mut ids, bookmark_id, operation_index)?;
            }
            if bookmark.time < MediaTime::ZERO {
                return Err(error(
                    ErrorCode::InvalidValue,
                    "bookmark time must be non-negative",
                    operation_index,
                    Some("bookmark.time"),
                ));
            }
        }
        self.snapshot
            .settings
            .fps
            .ticks_per_frame()
            .ok_or_else(|| {
                error(
                    ErrorCode::UnsupportedFrameRate,
                    "fps does not map to integral 120000-timebase ticks",
                    operation_index,
                    Some("settings.fps"),
                )
            })?;
        self.ids.extend(ids);
        Ok(())
    }

    fn resolve(
        &mut self,
        mut operation: EditOperation,
        index: usize,
        fingerprint: &str,
    ) -> Result<EditOperation, EditPlanError> {
        match &mut operation {
            EditOperation::RemoveTrack {
                track_id,
                occupied,
                resolved_cascade_element_ids,
                ..
            } => {
                if *occupied == RemoveTrackOccupiedPolicy::Cascade {
                    let track = self.track_mut(track_id, index)?.clone();
                    let seeds: Vec<String> = self
                        .snapshot
                        .elements
                        .iter()
                        .filter(|element| element.track_id == track.track_id)
                        .map(|element| element.element_id.clone())
                        .collect();
                    let mut expanded = BTreeSet::new();
                    for seed in seeds {
                        expanded.extend(self.related_ids(&seed, RelationshipScope::All));
                    }
                    *resolved_cascade_element_ids = Some(expanded.into_iter().collect());
                } else {
                    *resolved_cascade_element_ids = Some(Vec::new());
                }
            }
            EditOperation::InsertText {
                element_id,
                start_time,
                duration,
                auto_track_id,
                resolved_allocations,
                ..
            } => {
                self.resolve_created_id(element_id, "element", None, index, fingerprint, 0)?;
                self.resolve_insert_track(
                    InsertTrackResolution {
                        element_type: "text",
                        explicit_track_id: None,
                        element_id: required(element_id),
                        start_time: *start_time,
                        duration: *duration,
                        auto_track_id,
                        resolved_allocations,
                    },
                    index,
                    fingerprint,
                )?;
            }
            EditOperation::InsertGraphic {
                element_id,
                start_time,
                duration,
                track_id,
                auto_track_id,
                resolved_allocations,
                ..
            }
            | EditOperation::InsertSticker {
                element_id,
                start_time,
                duration,
                track_id,
                auto_track_id,
                resolved_allocations,
                ..
            } => {
                self.resolve_created_id(element_id, "element", None, index, fingerprint, 0)?;
                self.resolve_insert_track(
                    InsertTrackResolution {
                        element_type: "graphic",
                        explicit_track_id: track_id.as_deref(),
                        element_id: required(element_id),
                        start_time: *start_time,
                        duration: *duration,
                        auto_track_id,
                        resolved_allocations,
                    },
                    index,
                    fingerprint,
                )?;
            }
            EditOperation::InsertAdjustmentLayer {
                element_id,
                start_time,
                duration,
                track_id,
                auto_track_id,
                resolved_allocations,
                ..
            } => {
                self.resolve_created_id(element_id, "element", None, index, fingerprint, 0)?;
                self.resolve_insert_track(
                    InsertTrackResolution {
                        element_type: "effect",
                        explicit_track_id: track_id.as_deref(),
                        element_id: required(element_id),
                        start_time: *start_time,
                        duration: *duration,
                        auto_track_id,
                        resolved_allocations,
                    },
                    index,
                    fingerprint,
                )?;
            }
            EditOperation::InsertCaptions {
                track_id, captions, ..
            } => {
                self.resolve_created_id(track_id, "caption-track", None, index, fingerprint, 0)?;
                for (ordinal, caption) in captions.iter_mut().enumerate() {
                    self.resolve_created_id(
                        &mut caption.element_id,
                        "caption-element",
                        None,
                        index,
                        fingerprint,
                        ordinal,
                    )?;
                }
            }
            EditOperation::DuplicateElements {
                elements,
                duplicate_ids,
                resolved_allocations,
                relationship_scope,
            } => {
                let mut expanded = Vec::new();
                for reference in elements.iter() {
                    self.require_element(&reference.track_id, &reference.element_id, Some(index))?;
                    for id in self.related_ids(&reference.element_id, *relationship_scope) {
                        if !expanded.contains(&id) {
                            expanded.push(id);
                        }
                    }
                }
                let mut ids = duplicate_ids.take().unwrap_or_default();
                if !ids.is_empty() && ids.len() != expanded.len() {
                    invalid(index, "duplicate IDs must cover relationship expansion")?;
                }
                while ids.len() < expanded.len() {
                    ids.push(String::new());
                }
                for (ordinal, (source, id)) in expanded.iter().zip(ids.iter_mut()).enumerate() {
                    let mut slot = (!id.is_empty()).then(|| id.clone());
                    self.resolve_created_id(
                        &mut slot,
                        "duplicate-element",
                        Some(source),
                        index,
                        fingerprint,
                        ordinal,
                    )?;
                    *id = required(&slot).into();
                }
                *duplicate_ids = Some(ids);
                let mut identity_sources = Vec::<(String, String)>::new();
                let mut source_tracks = BTreeSet::new();
                for source in &expanded {
                    if let Some(element) = self
                        .snapshot
                        .elements
                        .iter()
                        .find(|element| element.element_id == *source)
                    {
                        source_tracks.insert(element.track_id.clone());
                        collect_owned_identity_sources(element, "duplicate", &mut identity_sources);
                    }
                }
                for transition in &self.snapshot.transitions {
                    if expanded.contains(&transition.from_element_id)
                        && expanded.contains(&transition.to_element_id)
                    {
                        identity_sources.push((
                            "duplicate-transition".into(),
                            transition.transition_id.clone(),
                        ));
                    }
                }
                for track_id in source_tracks {
                    identity_sources.push(("duplicate-track".into(), track_id));
                }
                identity_sources.sort();
                identity_sources.dedup();
                let mut allocations = Vec::with_capacity(identity_sources.len());
                for (ordinal, (role, source)) in identity_sources.iter().enumerate() {
                    allocations.push(self.allocate_mapping(
                        role,
                        source,
                        index,
                        fingerprint,
                        ordinal,
                    )?);
                }
                *resolved_allocations = Some(allocations);
            }
            EditOperation::AddTrack { track_id, .. } => {
                self.record_created_id(track_id, "track", None, index)?
            }
            EditOperation::DuplicateTrack {
                track_id,
                new_track_id,
                resolved_allocations,
                ..
            } => {
                if !self
                    .snapshot
                    .tracks
                    .iter()
                    .any(|track| track.track_id == *track_id)
                {
                    return Err(error(
                        ErrorCode::UnknownReference,
                        "unknown track",
                        Some(index),
                        Some("trackId"),
                    ));
                }
                self.resolve_created_id(
                    new_track_id,
                    "duplicate-track",
                    Some(track_id),
                    index,
                    fingerprint,
                    0,
                )?;
                let mut allocations = vec![ObjectIdAllocation {
                    role: AllocationRole::DuplicateTrack,
                    source_id: track_id.clone(),
                    resolved_id: required(new_track_id).into(),
                }];
                let mut identity_sources = Vec::<(String, String)>::new();
                for element in self
                    .snapshot
                    .elements
                    .iter()
                    .filter(|element| element.track_id == *track_id)
                {
                    identity_sources.push(("duplicate-element".into(), element.element_id.clone()));
                    collect_owned_identity_sources(element, "duplicate", &mut identity_sources);
                }
                for transition in self
                    .snapshot
                    .transitions
                    .iter()
                    .filter(|transition| transition.track_id == *track_id)
                {
                    identity_sources.push((
                        "duplicate-transition".into(),
                        transition.transition_id.clone(),
                    ));
                }
                identity_sources.sort();
                identity_sources.dedup();
                for (ordinal, (role, source)) in identity_sources.iter().enumerate() {
                    allocations.push(self.allocate_mapping(
                        role,
                        source,
                        index,
                        fingerprint,
                        ordinal + 1,
                    )?);
                }
                *resolved_allocations = Some(allocations);
            }
            EditOperation::AddBookmark { bookmark_id, .. } => {
                self.resolve_created_id(bookmark_id, "bookmark", None, index, fingerprint, 0)?;
            }
            EditOperation::InstantiateAsset {
                asset_id,
                element_id,
                start_time,
                duration,
                track_id,
                auto_track_id,
                resolved_allocations,
                ..
            } => {
                let asset = self.require_timeline_asset(asset_id, index)?;
                let element_type = media_element_type(&asset, index)?;
                let resolved_duration = resolve_asset_duration(&asset, *duration, index)?;
                *duration = Some(resolved_duration);
                self.resolve_created_id(element_id, "element", None, index, fingerprint, 0)?;
                self.resolve_insert_track(
                    InsertTrackResolution {
                        element_type,
                        explicit_track_id: track_id.as_deref(),
                        element_id: required(element_id),
                        start_time: *start_time,
                        duration: resolved_duration,
                        auto_track_id,
                        resolved_allocations,
                    },
                    index,
                    fingerprint,
                )?;
            }
            EditOperation::CreateCompound {
                compound_id,
                elements,
                target_track_id,
                auto_track_id,
                empty_main_track_id,
                resolved_allocations,
                ..
            } => {
                self.record_created_id(compound_id, "compound-element", None, index)?;
                let mut allocations = Vec::new();
                if target_track_id.is_none() {
                    self.resolve_created_id(
                        auto_track_id,
                        "compound-auto-track",
                        None,
                        index,
                        fingerprint,
                        0,
                    )?;
                    allocations.push(ObjectIdAllocation {
                        role: AllocationRole::CompoundAutoTrack,
                        source_id: String::new(),
                        resolved_id: required(auto_track_id).into(),
                    });
                }
                let selects_main = elements.iter().any(|reference| {
                    self.snapshot
                        .tracks
                        .iter()
                        .any(|track| track.track_id == reference.track_id && track.role == "main")
                });
                if !selects_main {
                    self.resolve_created_id(
                        empty_main_track_id,
                        "compound-empty-main-track",
                        None,
                        index,
                        fingerprint,
                        0,
                    )?;
                    allocations.push(ObjectIdAllocation {
                        role: AllocationRole::CompoundEmptyMainTrack,
                        source_id: String::new(),
                        resolved_id: required(empty_main_track_id).into(),
                    });
                }
                *resolved_allocations = Some(allocations);
            }
            EditOperation::BreakApartCompound {
                track_id,
                element_id,
                restored_element_ids,
                resolved_allocations,
            } => {
                let compound = self
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| {
                        element.track_id == *track_id && element.element_id == *element_id
                    })
                    .ok_or_else(|| {
                        error(
                            ErrorCode::UnknownReference,
                            "unknown compound",
                            Some(index),
                            Some("elementId"),
                        )
                    })?;
                if compound.element_type != "compound" || compound.compound_members.is_empty() {
                    incompatible(index, "element is not a compound")?;
                }
                let source_ids: Vec<_> = compound
                    .compound_members
                    .iter()
                    .map(|member| member.element_id.clone())
                    .collect();
                let mut ids = restored_element_ids.take().unwrap_or_default();
                if !ids.is_empty() && ids.len() != source_ids.len() {
                    invalid(index, "restored element IDs must cover compound members")?;
                }
                while ids.len() < source_ids.len() {
                    ids.push(String::new());
                }
                let mut allocations = Vec::with_capacity(source_ids.len());
                for (ordinal, (source_id, id)) in source_ids.iter().zip(ids.iter_mut()).enumerate()
                {
                    let mut slot = (!id.is_empty()).then(|| id.clone());
                    self.resolve_created_id(
                        &mut slot,
                        "break-apart-element",
                        Some(source_id),
                        index,
                        fingerprint,
                        ordinal,
                    )?;
                    *id = required(&slot).into();
                    allocations.push(ObjectIdAllocation {
                        role: AllocationRole::BreakApartElement,
                        source_id: source_id.clone(),
                        resolved_id: id.clone(),
                    });
                }
                *restored_element_ids = Some(ids);
                *resolved_allocations = Some(allocations);
            }
            EditOperation::UpdateCaption {
                track_id,
                element_id,
                duration,
                resolved_allocations,
                ..
            } => {
                *resolved_allocations = if duration.is_some() {
                    Some(self.allocate_duration_clamp(track_id, element_id, index, fingerprint)?)
                } else {
                    Some(vec![])
                };
            }
            EditOperation::SplitCaption {
                element_id,
                right_element_id,
                resolved_allocations,
                ..
            } => {
                self.resolve_created_id(
                    right_element_id,
                    "caption-element",
                    Some(element_id),
                    index,
                    fingerprint,
                    0,
                )?;
                *resolved_allocations = Some(vec![ObjectIdAllocation {
                    role: AllocationRole::CaptionElement,
                    source_id: element_id.clone(),
                    resolved_id: required(right_element_id).to_owned(),
                }]);
            }
            EditOperation::RestyleCaptions {
                style,
                resolved_params,
                ..
            } => {
                *resolved_params = Some(caption_style_params(style).map_err(|message| {
                    error(ErrorCode::InvalidValue, message, Some(index), Some("style"))
                })?);
            }
            EditOperation::RechunkCaptions {
                track_id,
                element_ids,
                speaker,
                max_chars,
                max_chars_per_second,
                max_duration,
                max_gap,
                resolved_chunks,
                resolved_allocations,
            } => {
                let (chunks, allocations) = self.resolve_caption_chunks(
                    track_id,
                    element_ids.as_deref(),
                    speaker.as_deref(),
                    *max_chars,
                    *max_chars_per_second,
                    *max_duration,
                    *max_gap,
                    index,
                    fingerprint,
                )?;
                *resolved_chunks = Some(chunks);
                *resolved_allocations = Some(allocations);
            }
            EditOperation::SetRetime {
                track_id,
                element_id,
                resolved_allocations,
                ..
            }
            | EditOperation::Trim {
                track_id,
                element_id,
                resolved_allocations,
                ..
            } => {
                *resolved_allocations =
                    Some(self.allocate_duration_clamp(track_id, element_id, index, fingerprint)?);
            }
            EditOperation::SetAudio {
                track_id,
                element_id,
                volume_db,
                fade,
                resolved_allocations,
                ..
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                require_audio(element, index)?;
                let target_volume = volume_db.unwrap_or(element.volume_db.unwrap_or(0.0));
                let points = fade
                    .as_ref()
                    .map(|fade| fade_keyframe_points(element.duration, target_volume, fade))
                    .unwrap_or_default();
                *resolved_allocations =
                    Some(self.allocate_keyframe_points("volume", &points, index, fingerprint)?);
            }
            EditOperation::DuckAudio {
                track_id,
                element_id,
                regions,
                reduction_db,
                attack_duration,
                release_duration,
                resolved_allocations,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                require_audio(element, index)?;
                let points = ducking_keyframe_points(
                    element,
                    regions,
                    *reduction_db,
                    *attack_duration,
                    *release_duration,
                    index,
                )?;
                *resolved_allocations =
                    Some(self.allocate_keyframe_points("ducking", &points, index, fingerprint)?);
            }
            EditOperation::SeparateSourceAudio {
                track_id,
                element_id,
                audio_track_id,
                audio_element_id,
                link_id,
                resolved_allocations,
            } => {
                let source = self
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| {
                        element.track_id == *track_id && element.element_id == *element_id
                    })
                    .ok_or_else(|| {
                        error(
                            ErrorCode::UnknownReference,
                            "unknown source",
                            Some(index),
                            Some("elementId"),
                        )
                    })?
                    .clone();
                if let Some(requested_track_id) = audio_track_id.as_deref() {
                    if let Some(existing) = self
                        .snapshot
                        .tracks
                        .iter()
                        .find(|track| track.track_id == requested_track_id)
                    {
                        if existing.track_type != "audio" {
                            incompatible(index, "source audio track must be audio")?;
                        }
                    } else {
                        self.resolve_created_id(
                            audio_track_id,
                            "source-audio-track",
                            None,
                            index,
                            fingerprint,
                            0,
                        )?;
                    }
                } else {
                    self.resolve_created_id(
                        audio_track_id,
                        "source-audio-track",
                        None,
                        index,
                        fingerprint,
                        0,
                    )?;
                }
                self.resolve_created_id(
                    audio_element_id,
                    "source-audio-element",
                    None,
                    index,
                    fingerprint,
                    0,
                )?;
                if link_id.is_none() {
                    *link_id = source.link_id.clone();
                }
                let link_exists = link_id.as_ref().is_some_and(|requested_link_id| {
                    self.snapshot.elements.iter().any(|element| {
                        element.link_id.as_deref() == Some(requested_link_id.as_str())
                    })
                });
                if !link_exists {
                    self.resolve_created_id(
                        link_id,
                        "source-audio-link",
                        None,
                        index,
                        fingerprint,
                        0,
                    )?;
                }
                let source_keyframes: Vec<_> = source
                    .keyframes
                    .iter()
                    .filter(|keyframe| {
                        matches!(keyframe.property_path.as_str(), "volume" | "ducking")
                    })
                    .map(|keyframe| keyframe.keyframe_id.clone())
                    .collect();
                let mut allocations = Vec::with_capacity(source_keyframes.len());
                for (ordinal, source_id) in source_keyframes.iter().enumerate() {
                    allocations.push(self.allocate_mapping(
                        "keyframe",
                        source_id,
                        index,
                        fingerprint,
                        ordinal,
                    )?);
                }
                *resolved_allocations = Some(allocations);
            }
            EditOperation::UpsertKeyframe {
                track_id,
                element_id,
                property_path,
                keyframe_id,
                ..
            } => {
                let is_existing = keyframe_id.as_ref().is_some_and(|id| {
                    self.snapshot.elements.iter().any(|element| {
                        element.track_id == *track_id
                            && element.element_id == *element_id
                            && element.keyframes.iter().any(|key| {
                                key.keyframe_id == *id && key.property_path == *property_path
                            })
                    })
                });
                if !is_existing {
                    self.resolve_created_id(keyframe_id, "keyframe", None, index, fingerprint, 0)?;
                }
            }
            EditOperation::Split {
                track_id,
                element_id,
                split_time,
                right_element_id,
                retain_side,
                resolved_allocations,
                ..
            } => {
                let source = self
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| {
                        element.track_id == *track_id && element.element_id == *element_id
                    })
                    .cloned()
                    .ok_or_else(|| {
                        error(
                            ErrorCode::UnknownReference,
                            "unknown split element",
                            Some(index),
                            Some("elementId"),
                        )
                    })?;
                let source_end = add(source.start_time, source.duration, index)?;
                if *split_time <= source.start_time || *split_time >= source_end {
                    bounds(index, "splitTime")?;
                }
                let local_split = sub(*split_time, source.start_time, index)?;
                let animation_keys = animation_storage_keys(&source);
                let mut allocations = Vec::new();
                for (ordinal, property_path) in animation_keys.iter().enumerate() {
                    allocations.push(self.allocate_mapping(
                        "split-left-boundary-keyframe",
                        property_path,
                        index,
                        fingerprint,
                        ordinal,
                    )?);
                    allocations.push(self.allocate_mapping(
                        "split-right-boundary-keyframe",
                        property_path,
                        index,
                        fingerprint,
                        ordinal,
                    )?);
                }
                if *retain_side != Some(RetainSide::Left) {
                    self.resolve_created_id(
                        right_element_id,
                        "split-right",
                        None,
                        index,
                        fingerprint,
                        0,
                    )?;
                    let mut identity_sources = Vec::new();
                    collect_owned_identity_sources(&source, "split", &mut identity_sources);
                    identity_sources.retain(|(role, _)| role != "split-keyframe");
                    identity_sources.sort();
                    identity_sources.dedup();
                    for (ordinal, (role, source_id)) in identity_sources.iter().enumerate() {
                        allocations.push(self.allocate_mapping(
                            role,
                            source_id,
                            index,
                            fingerprint,
                            ordinal,
                        )?);
                    }
                } else if right_element_id.is_some() {
                    invalid(index, "rightElementId is unused when retainSide is left")?;
                }
                validate_split_boundary_allocations(
                    &allocations,
                    &animation_keys,
                    local_split,
                    index,
                )?;
                *resolved_allocations = Some(allocations);
            }
            EditOperation::UpsertEffect {
                track_id,
                element_id,
                effect_id,
                ..
            } => {
                let exists = self
                    .element_mut(track_id, element_id, index)?
                    .effects
                    .iter()
                    .any(|effect| effect.effect_id == *effect_id);
                if !exists {
                    self.record_created_id(effect_id, "effect", None, index)?;
                }
            }
            EditOperation::UpsertTransition { transition_id, .. } => {
                if !self
                    .snapshot
                    .transitions
                    .iter()
                    .any(|transition| transition.transition_id == *transition_id)
                {
                    self.record_created_id(transition_id, "transition", None, index)?;
                }
            }
            EditOperation::SetMask {
                track_id,
                element_id,
                mask_id,
                ..
            } => {
                let exists = self
                    .element_mut(track_id, element_id, index)?
                    .masks
                    .iter()
                    .any(|mask| mask.mask_id == *mask_id);
                if !exists {
                    self.record_created_id(mask_id, "mask", None, index)?;
                }
            }
            EditOperation::SetGroup { group_id, .. }
                if !self
                    .snapshot
                    .elements
                    .iter()
                    .any(|element| element.group_id.as_deref() == Some(group_id)) =>
            {
                self.record_created_id(group_id, "group", None, index)?;
            }
            EditOperation::SetLink { link_id, .. }
                if !self
                    .snapshot
                    .elements
                    .iter()
                    .any(|element| element.link_id.as_deref() == Some(link_id)) =>
            {
                self.record_created_id(link_id, "link", None, index)?;
            }
            _ => {}
        }
        Ok(operation)
    }

    fn allocate_keyframe_points(
        &mut self,
        property_path: &str,
        points: &[(MediaTime, f64)],
        index: usize,
        fingerprint: &str,
    ) -> Result<Vec<ObjectIdAllocation>, EditPlanError> {
        points
            .iter()
            .enumerate()
            .map(|(ordinal, (time, _))| {
                self.allocate_mapping(
                    "keyframe",
                    &format!("{property_path}:{}", time.as_ticks()),
                    index,
                    fingerprint,
                    ordinal,
                )
            })
            .collect()
    }

    fn allocate_duration_clamp(
        &mut self,
        track_id: &str,
        element_id: &str,
        index: usize,
        fingerprint: &str,
    ) -> Result<Vec<ObjectIdAllocation>, EditPlanError> {
        let element = self
            .snapshot
            .elements
            .iter()
            .find(|element| element.track_id == track_id && element.element_id == element_id)
            .cloned()
            .ok_or_else(|| unknown_error(index, "element"))?;
        let mut allocations = Vec::new();
        for (ordinal, property_path) in animation_storage_keys(&element).iter().enumerate() {
            allocations.push(self.allocate_mapping(
                "duration-clamp-left-boundary-keyframe",
                property_path,
                index,
                fingerprint,
                ordinal,
            )?);
            allocations.push(self.allocate_mapping(
                "duration-clamp-right-boundary-keyframe",
                property_path,
                index,
                fingerprint,
                ordinal,
            )?);
        }
        Ok(allocations)
    }

    fn resolve_insert_track(
        &mut self,
        request: InsertTrackResolution<'_>,
        index: usize,
        fingerprint: &str,
    ) -> Result<(), EditPlanError> {
        validate_interval(request.start_time, request.duration, Some(index))?;
        let required_track_type = track_type_for_element(request.element_type);
        if let Some(track_id) = request.explicit_track_id {
            let track = self
                .snapshot
                .tracks
                .iter()
                .find(|track| track.track_id == track_id)
                .ok_or_else(|| {
                    error(
                        ErrorCode::UnknownReference,
                        "unknown explicit insertion track",
                        Some(index),
                        Some("trackId"),
                    )
                })?;
            if track.track_type != required_track_type {
                return incompatible(index, "element and track types are incompatible");
            }
            if request.auto_track_id.is_some() {
                return invalid(index, "autoTrackId is unused with an explicit trackId");
            }
            *request.resolved_allocations = Some(vec![]);
            return Ok(());
        }
        let end_time = add(request.start_time, request.duration, index)?;
        let has_available_track = self.snapshot.tracks.iter().any(|track| {
            track.track_type == required_track_type
                && self
                    .snapshot
                    .elements
                    .iter()
                    .filter(|element| element.track_id == track.track_id)
                    .all(|element| {
                        let element_end = element
                            .start_time
                            .as_ticks()
                            .saturating_add(element.duration.as_ticks());
                        end_time.as_ticks() <= element.start_time.as_ticks()
                            || request.start_time.as_ticks() >= element_end
                    })
        });
        if has_available_track {
            if request.auto_track_id.is_some() {
                return invalid(
                    index,
                    "autoTrackId is unused when an existing track is available",
                );
            }
            *request.resolved_allocations = Some(vec![]);
            return Ok(());
        }
        self.resolve_created_id(
            request.auto_track_id,
            "element-auto-track",
            Some(request.element_id),
            index,
            fingerprint,
            0,
        )?;
        *request.resolved_allocations = Some(vec![ObjectIdAllocation {
            role: AllocationRole::ElementAutoTrack,
            source_id: request.element_id.into(),
            resolved_id: required(request.auto_track_id).into(),
        }]);
        Ok(())
    }

    fn resolve_created_id(
        &mut self,
        slot: &mut Option<String>,
        role: &str,
        source_id: Option<&str>,
        index: usize,
        fingerprint: &str,
        ordinal: usize,
    ) -> Result<(), EditPlanError> {
        let caller_id = slot.clone();
        let id = caller_id.clone().unwrap_or_else(|| {
            let seed = format!("{fingerprint}:{index}:{role}:{ordinal}");
            format!("plan-{}", &sha256(seed.as_bytes())[..24])
        });
        validate_id(&id, Some(index), role)?;
        if self.ids.contains(&id) {
            return duplicate(index, &id);
        }
        self.ids.insert(id.clone());
        self.resolved_ids.push(ResolvedIdAllocation {
            operation_index: index,
            role: AllocationRole::from_name(role).expect("internal allocation role is closed"),
            source_id: source_id.map(str::to_owned).or(caller_id),
            resolved_id: id.clone(),
        });
        *slot = Some(id);
        Ok(())
    }

    fn record_created_id(
        &mut self,
        id: &str,
        role: &str,
        source_id: Option<&str>,
        index: usize,
    ) -> Result<(), EditPlanError> {
        validate_id(id, Some(index), role)?;
        if self.ids.contains(id) {
            return duplicate(index, id);
        }
        self.ids.insert(id.into());
        self.resolved_ids.push(ResolvedIdAllocation {
            operation_index: index,
            role: AllocationRole::from_name(role).expect("internal allocation role is closed"),
            source_id: source_id.map(str::to_owned).or_else(|| Some(id.into())),
            resolved_id: id.into(),
        });
        Ok(())
    }

    fn allocate_mapping(
        &mut self,
        role: &str,
        source_id: &str,
        index: usize,
        fingerprint: &str,
        ordinal: usize,
    ) -> Result<ObjectIdAllocation, EditPlanError> {
        let mut slot = None;
        self.resolve_created_id(
            &mut slot,
            role,
            Some(source_id),
            index,
            fingerprint,
            ordinal,
        )?;
        Ok(ObjectIdAllocation {
            role: AllocationRole::from_name(role).expect("internal allocation role is closed"),
            source_id: source_id.into(),
            resolved_id: required(&slot).into(),
        })
    }

    fn apply(
        &mut self,
        operation: &EditOperation,
        index: usize,
        ripple: &mut BTreeSet<Expansion>,
        relationships: &mut BTreeSet<Expansion>,
        warnings: &mut BTreeSet<Warning>,
    ) -> Result<(), EditPlanError> {
        match operation {
            EditOperation::InsertText {
                element_id,
                content,
                start_time,
                duration,
                auto_track_id,
                resolved_allocations,
            } => {
                let mut element =
                    new_element(required(element_id), "text", "Text", *start_time, *duration);
                element.text = Some(content.clone());
                element.params = default_text_params(content);
                self.insert_with_placement(
                    element,
                    None,
                    auto_track_id.as_deref(),
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )
            }
            EditOperation::InsertGraphic {
                element_id,
                definition_id,
                name,
                start_time,
                duration,
                track_id,
                params,
                auto_track_id,
                resolved_allocations,
            } => {
                let resolved_params =
                    visual_params("graphic", Some(definition_id), params.as_ref(), index)?;
                let resolved_name = name
                    .clone()
                    .unwrap_or_else(|| capitalize_first(definition_id));
                let mut element = new_element(
                    required(element_id),
                    "graphic",
                    &resolved_name,
                    *start_time,
                    *duration,
                );
                element.definition_id = Some(definition_id.clone());
                element.params = resolved_params;
                self.insert_with_placement(
                    element,
                    track_id.as_deref(),
                    auto_track_id.as_deref(),
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )
            }
            EditOperation::InsertSticker {
                element_id,
                sticker_id,
                name,
                start_time,
                duration,
                track_id,
                params,
                auto_track_id,
                resolved_allocations,
            } => {
                let shape = shape_sticker(sticker_id);
                let element_type = if shape.is_some() {
                    "graphic"
                } else {
                    "sticker"
                };
                let (resolved_name, definition_id) =
                    if let Some((definition, shape_name, _)) = shape {
                        (
                            name.clone().unwrap_or_else(|| shape_name.into()),
                            Some(definition),
                        )
                    } else {
                        validate_sticker_id(sticker_id, index)?;
                        (
                            name.clone()
                                .unwrap_or_else(|| sticker_default_name(sticker_id)),
                            None,
                        )
                    };
                let mut element = new_element(
                    required(element_id),
                    element_type,
                    &resolved_name,
                    *start_time,
                    *duration,
                );
                if let Some(definition_id) = definition_id {
                    element.definition_id = Some(definition_id.into());
                    element.params = shape_graphic_params(sticker_id, params.as_ref(), index)?;
                } else {
                    element.sticker_id = Some(sticker_id.clone());
                    element.params = visual_params("sticker", None, params.as_ref(), index)?;
                }
                self.insert_with_placement(
                    element,
                    track_id.as_deref(),
                    auto_track_id.as_deref(),
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )
            }
            EditOperation::InsertAdjustmentLayer {
                element_id,
                effect_type,
                name,
                start_time,
                duration,
                track_id,
                params,
                auto_track_id,
                resolved_allocations,
            } => {
                let resolved_params =
                    effect_params(effect_type, "effect", None, params.as_ref(), index)?;
                let resolved_name = name
                    .clone()
                    .unwrap_or_else(|| capitalize_first(effect_type));
                let mut element = new_element(
                    required(element_id),
                    "effect",
                    &resolved_name,
                    *start_time,
                    *duration,
                );
                element.effect_type = Some(effect_type.clone());
                element.params = resolved_params;
                self.insert_with_placement(
                    element,
                    track_id.as_deref(),
                    auto_track_id.as_deref(),
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )
            }
            EditOperation::RenameTrack { track_id, name } => {
                let name = name.trim();
                if name.is_empty() {
                    return invalid(index, "track name is required");
                }
                let track = self.track_mut(track_id, index)?;
                if track.name == name {
                    return Err(error(
                        ErrorCode::SilentNoOp,
                        "track name already matches the requested value",
                        Some(index),
                        None,
                    ));
                }
                track.name = name.to_owned();
                Ok(())
            }
            EditOperation::ReorderTracks {
                overlay_track_ids,
                audio_track_ids,
            } => self.reorder_tracks(
                overlay_track_ids.as_deref(),
                audio_track_ids.as_deref(),
                index,
            ),
            EditOperation::RemoveTrack {
                track_id,
                occupied,
                target_track_id,
                resolved_cascade_element_ids,
            } => self.remove_track(
                track_id,
                *occupied,
                target_track_id.as_deref(),
                resolved_cascade_element_ids.as_deref().unwrap_or_default(),
                index,
                relationships,
                warnings,
            ),
            EditOperation::DuplicateTrack {
                track_id,
                new_track_id,
                name,
                resolved_allocations,
            } => self.duplicate_track(
                track_id,
                required(new_track_id),
                name.as_deref(),
                resolved_allocations.as_deref().unwrap_or_default(),
                index,
                relationships,
            ),
            EditOperation::SetMainTrack { track_id } => self.set_main_track(track_id, index),
            EditOperation::SetTrackMatte { track_id, routing } => {
                let destination = self
                    .snapshot
                    .tracks
                    .iter()
                    .find(|track| track.track_id == *track_id)
                    .ok_or_else(|| unknown_error(index, "track matte destination"))?;
                let source = self
                    .snapshot
                    .tracks
                    .iter()
                    .find(|track| track.track_id == routing.source_track_id)
                    .ok_or_else(|| unknown_error(index, "track matte source"))?;
                if source.track_id == *track_id {
                    return invalid(index, "track matte source cannot be its destination");
                }
                if matches!(source.track_type.as_str(), "audio" | "effect")
                    || source.role == "audio"
                {
                    return incompatible(index, "track matte source must be visual");
                }
                if matches!(destination.track_type.as_str(), "audio" | "effect")
                    || destination.role == "audio"
                {
                    return incompatible(index, "track matte destination must be visual");
                }
                if routing.enabled && source.hidden == Some(true) {
                    return invalid(index, "track matte source is hidden");
                }
                if routing.enabled {
                    let mut next_id = Some(routing.source_track_id.as_str());
                    let mut visited = BTreeSet::new();
                    while let Some(candidate_id) = next_id {
                        if candidate_id == track_id {
                            return invalid(index, "track matte dependency cycle");
                        }
                        if !visited.insert(candidate_id) {
                            return invalid(index, "track matte dependency cycle");
                        }
                        next_id = self
                            .snapshot
                            .tracks
                            .iter()
                            .find(|candidate| candidate.track_id == candidate_id)
                            .and_then(|candidate| candidate.track_matte.as_ref())
                            .filter(|candidate| candidate.enabled)
                            .map(|candidate| candidate.source_track_id.as_str());
                    }
                }
                self.track_mut(track_id, index)?.track_matte = Some(routing.clone());
                Ok(())
            }
            EditOperation::RemoveTrackMatte { track_id } => {
                if self
                    .track_mut(track_id, index)?
                    .track_matte
                    .take()
                    .is_none()
                {
                    return unknown(index, "track matte routing");
                }
                Ok(())
            }
            EditOperation::AddBookmark {
                bookmark_id,
                time,
                duration,
                note,
                color,
            } => self.add_bookmark(
                required(bookmark_id),
                *time,
                *duration,
                note.clone(),
                color.clone(),
                index,
            ),
            EditOperation::UpdateBookmark {
                bookmark_id,
                note,
                color,
                duration,
                clear,
            } => self.update_bookmark(
                bookmark_id,
                note.clone(),
                color.clone(),
                *duration,
                clear,
                index,
            ),
            EditOperation::MoveBookmark { bookmark_id, time } => {
                self.move_bookmark(bookmark_id, *time, index)
            }
            EditOperation::RemoveBookmark { bookmark_id } => {
                self.remove_bookmark(bookmark_id, index)
            }
            EditOperation::InstantiateAsset {
                asset_id,
                element_id,
                name,
                start_time,
                duration,
                track_id,
                auto_track_id,
                resolved_allocations,
            } => {
                let asset = self.require_timeline_asset(asset_id, index)?;
                let element_type = media_element_type(&asset, index)?;
                let resolved_duration = resolve_asset_duration(&asset, *duration, index)?;
                let resolved_name = name.clone().unwrap_or_else(|| asset.name.clone());
                let element = media_element(
                    required(element_id),
                    element_type,
                    &resolved_name,
                    &asset,
                    *start_time,
                    resolved_duration,
                );
                self.insert_with_placement(
                    element,
                    track_id.as_deref(),
                    auto_track_id.as_deref(),
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )?;
                increment_reference(&mut self.media_reference_counts, asset_id);
                Ok(())
            }
            EditOperation::AddTrack {
                track_type,
                track_id,
            } => self.add_track(track_type.as_str(), track_id, index),
            EditOperation::SetTrackState {
                track_id,
                muted,
                hidden,
            } => {
                if hidden == &Some(true)
                    && self.snapshot.tracks.iter().any(|candidate| {
                        candidate.track_matte.as_ref().is_some_and(|routing| {
                            routing.enabled && routing.source_track_id == *track_id
                        })
                    })
                {
                    return invalid(
                        index,
                        "track is an enabled track matte source; remove its routing first",
                    );
                }
                let track = self.track_mut(track_id, index)?;
                if muted.is_none() && hidden.is_none() {
                    return invalid(index, "track state is empty");
                }
                if muted.is_some() && !matches!(track.track_type.as_str(), "video" | "audio") {
                    return incompatible(index, "track type cannot be muted");
                }
                if hidden.is_some() && track.track_type == "audio" {
                    return incompatible(index, "audio tracks cannot be hidden");
                }
                let changes_muted = muted.is_some_and(|value| track.muted != Some(value));
                let changes_hidden = hidden.is_some_and(|value| track.hidden != Some(value));
                if !changes_muted && !changes_hidden {
                    return Err(error(
                        ErrorCode::SilentNoOp,
                        "track state already matches requested values",
                        Some(index),
                        None,
                    ));
                }
                if let Some(value) = muted {
                    track.muted = Some(*value)
                }
                if let Some(value) = hidden {
                    track.hidden = Some(*value)
                }
                Ok(())
            }
            EditOperation::SetProjectSettings {
                fps,
                canvas_size,
                background,
            } => {
                if fps.is_none() && canvas_size.is_none() && background.is_none() {
                    return invalid(index, "project settings are empty");
                }
                if let Some(value) = fps {
                    value.ticks_per_frame().ok_or_else(|| {
                        error(
                            ErrorCode::UnsupportedFrameRate,
                            "unsupported fps",
                            Some(index),
                            Some("fps"),
                        )
                    })?;
                    self.snapshot.settings.fps = *value;
                }
                if let Some(value) = canvas_size {
                    if value.width == 0
                        || value.height == 0
                        || u64::from(value.width) * u64::from(value.height) > 67_108_864
                    {
                        return bounds(index, "canvasSize");
                    }
                    self.snapshot.settings.canvas_size = value.clone();
                    let is_preset = matches!(
                        (value.width, value.height),
                        (1920, 1080) | (1080, 1920) | (1080, 1080) | (1440, 1080)
                    );
                    self.snapshot.settings.canvas_size_mode =
                        Some(if is_preset { "preset" } else { "custom" }.into());
                    if !is_preset {
                        self.snapshot.settings.last_custom_canvas_size = Some(value.clone());
                    }
                }
                if let Some(value) = background {
                    if matches!(value, Background::Color { color } if color.trim().is_empty()) {
                        return invalid(index, "background color is required");
                    }
                    self.snapshot.settings.background = value.clone();
                }
                Ok(())
            }
            EditOperation::InsertCaptions {
                track_id,
                captions,
                style,
            } => {
                if let Some(preset) = style.as_ref().and_then(|value| value.preset.as_deref()) {
                    if !is_caption_style_preset(preset) {
                        return invalid(index, "unknown caption style preset");
                    }
                }
                let id = required(track_id);
                self.insert_track("text", id, true, index)?;
                if captions.is_empty() {
                    return invalid(index, "captions cannot be empty");
                }
                for (caption_index, caption) in captions.iter().enumerate() {
                    if caption.text.trim().is_empty() {
                        return invalid(index, "caption text is empty");
                    }
                    positive(caption.duration, Some(index), "caption.duration")?;
                    nonnegative(caption.start_time, Some(index), "caption.startTime")?;
                    let resolved_name = caption
                        .resolved_name
                        .as_deref()
                        .ok_or_else(|| invalid_error(index, "caption resolvedName is required"))?;
                    let resolved_content =
                        caption.resolved_content.as_deref().ok_or_else(|| {
                            invalid_error(index, "caption resolvedContent is required")
                        })?;
                    let resolved_params = caption.resolved_params.as_ref().ok_or_else(|| {
                        invalid_error(index, "caption resolvedParams are required")
                    })?;
                    if caption.resolved_layout_version.as_deref()
                        != Some("opencut.caption-layout.v1")
                        || caption.resolved_layout_engine.as_deref() != Some("browser-canvas-2d")
                    {
                        return invalid(index, "caption resolved layout provenance is invalid");
                    }
                    if resolved_name.trim().is_empty() || resolved_content.trim().is_empty() {
                        return invalid(index, "resolved caption name and content are required");
                    }
                    let CanonicalValue::Object(param_object) = resolved_params else {
                        return invalid(index, "caption resolvedParams must be an object");
                    };
                    let scalar_params = canonical::scalar_params_for_evaluation(resolved_params);
                    if scalar_params.len() != param_object.len()
                        || scalar_params.get("content")
                            != Some(&Scalar::String(resolved_content.to_owned()))
                    {
                        return invalid(
                            index,
                            "caption resolvedParams must be flat scalar params bound to resolvedContent",
                        );
                    }
                    let materialized_speaker =
                        scalar_params
                            .get("caption.speaker")
                            .and_then(|value| match value {
                                Scalar::String(value) => Some(value.as_str()),
                                _ => None,
                            });
                    if materialized_speaker != caption.speaker.as_deref() {
                        return invalid(
                            index,
                            "caption resolvedParams speaker does not match the caption",
                        );
                    }
                    let mut element = new_element(
                        required(&caption.element_id),
                        "text",
                        resolved_name,
                        caption.start_time,
                        caption.duration,
                    );
                    if resolved_name != format!("Caption {}", caption_index + 1) {
                        return invalid(index, "caption resolvedName does not match its ordinal");
                    }
                    element.text = Some(resolved_content.to_owned());
                    element.canonical_params = resolved_params.clone();
                    element.params = scalar_params;
                    self.insert_element(element, Some(id), index)?;
                }
                self.caption_track_warnings(id, index, warnings);
                Ok(())
            }
            EditOperation::UpdateCaption {
                track_id,
                element_id,
                text,
                start_time,
                duration,
                resolved_allocations,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                if element.element_type != "text" {
                    return incompatible(index, "caption must reference text");
                }
                if text.is_none() && start_time.is_none() && duration.is_none() {
                    return invalid(index, "caption update is empty");
                }
                if let Some(v) = text {
                    if v.trim().is_empty() {
                        return invalid(index, "caption text is empty");
                    }
                    element.text = Some(v.clone());
                }
                if let Some(v) = start_time {
                    element.start_time = *v;
                }
                if let Some(v) = duration {
                    positive(*v, Some(index), "duration")?;
                    element.duration = *v;
                    clamp_keyframes_to_duration(
                        element,
                        *v,
                        resolved_allocations.as_deref().unwrap_or_default(),
                        index,
                    )?;
                } else if resolved_allocations
                    .as_ref()
                    .is_some_and(|allocations| !allocations.is_empty())
                {
                    return invalid(index, "caption has unused duration-clamp allocations");
                }
                self.caption_track_warnings(track_id, index, warnings);
                Ok(())
            }
            EditOperation::ShiftCaptions {
                track_id,
                delta,
                element_ids,
            } => {
                if delta.as_ticks() == 0 {
                    return invalid(index, "delta cannot be zero");
                }
                let targets =
                    self.caption_targets(track_id, element_ids.as_deref(), None, index)?;
                for id in &targets {
                    let element = self.element_mut(track_id, id, index)?;
                    let moved = add(element.start_time, *delta, index)?;
                    if moved.as_ticks() < 0 {
                        return bounds(index, "delta");
                    }
                    element.start_time = moved;
                }
                self.caption_track_warnings(track_id, index, warnings);
                Ok(())
            }
            EditOperation::MergeCaptions {
                track_id,
                element_ids,
                separator,
            } => {
                if element_ids.len() < 2 {
                    return invalid(index, "merge needs at least two captions");
                }
                let mut ordered = self.caption_targets(track_id, Some(element_ids), None, index)?;
                if ordered.len() != element_ids.len() {
                    return invalid(index, "merge captions must be distinct");
                }
                let starts: Vec<(MediaTime, String)> = ordered
                    .iter()
                    .map(|id| {
                        let element = self
                            .snapshot
                            .elements
                            .iter()
                            .find(|e| e.track_id == *track_id && e.element_id == *id)
                            .expect("targets were validated");
                        (element.start_time, id.clone())
                    })
                    .collect();
                ordered.sort_by(|left, right| {
                    let left_start = starts.iter().find(|(_, id)| id == left).map(|(s, _)| *s);
                    let right_start = starts.iter().find(|(_, id)| id == right).map(|(s, _)| *s);
                    left_start.cmp(&right_start).then_with(|| left.cmp(right))
                });
                let mut texts = Vec::new();
                let mut start = MediaTime::from_ticks(i64::MAX);
                let mut end = MediaTime::ZERO;
                for id in &ordered {
                    let element = self.element_mut(track_id, id, index)?;
                    texts.push(caption_text(element).trim().to_owned());
                    start = start.min(element.start_time);
                    end = end.max(add(element.start_time, element.duration, index)?);
                }
                let joined = texts.join(separator.as_deref().unwrap_or(" "));
                if joined.trim().is_empty() {
                    return invalid(index, "merged caption text is empty");
                }
                let kept_id = ordered[0].clone();
                let kept = self.element_mut(track_id, &kept_id, index)?;
                kept.text = Some(joined.clone());
                kept.params
                    .0
                    .insert("content".to_owned(), Scalar::String(joined));
                kept.start_time = start;
                kept.duration = sub(end, start, index)?;
                // The kept caption spans the absorbed ones, so this is not a
                // gap-leaving delete; drop them and any transition they held.
                let absorbed: BTreeSet<&String> = ordered.iter().skip(1).collect();
                self.snapshot.elements.retain(|element| {
                    !(element.track_id == *track_id && absorbed.contains(&element.element_id))
                });
                self.snapshot.transitions.retain(|transition| {
                    !absorbed.contains(&transition.from_element_id)
                        && !absorbed.contains(&transition.to_element_id)
                });
                self.caption_track_warnings(track_id, index, warnings);
                Ok(())
            }
            EditOperation::SplitCaption {
                track_id,
                element_id,
                split_index,
                right_element_id,
                resolved_allocations,
            } => {
                let source = self
                    .snapshot
                    .elements
                    .iter()
                    .find(|e| e.track_id == *track_id && e.element_id == *element_id)
                    .cloned()
                    .ok_or_else(|| {
                        error(
                            ErrorCode::UnknownReference,
                            "unknown caption",
                            Some(index),
                            Some("elementId"),
                        )
                    })?;
                if source.element_type != "text" {
                    return incompatible(index, "caption must reference text");
                }
                if !source.keyframes.is_empty() {
                    return invalid(index, "split_caption does not support animated captions");
                }
                let chars: Vec<char> = caption_text(&source).chars().collect();
                if *split_index == 0 || *split_index >= chars.len() {
                    return bounds(index, "splitIndex");
                }
                let left: String = chars[..*split_index]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_owned();
                let right: String = chars[*split_index..]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_owned();
                if left.is_empty() || right.is_empty() {
                    return invalid(index, "split leaves an empty caption");
                }
                let left_len = left.chars().count() as i64;
                let total_len = left_len + right.chars().count() as i64;
                let left_ticks = source
                    .duration
                    .as_ticks()
                    .checked_mul(left_len)
                    .map(|value| value / total_len)
                    .ok_or_else(|| {
                        error(ErrorCode::ArithmeticOverflow, "overflow", Some(index), None)
                    })?;
                let right_ticks = source.duration.as_ticks() - left_ticks;
                if left_ticks <= 0 || right_ticks <= 0 {
                    return invalid(index, "caption is too short to split");
                }
                if resolved_allocations
                    .as_ref()
                    .is_none_or(|allocations| allocations.len() != 1)
                {
                    return invalid(index, "split caption allocations were not resolved");
                }
                let left_element = self.element_mut(track_id, element_id, index)?;
                left_element.text = Some(left.clone());
                left_element
                    .params
                    .0
                    .insert("content".to_owned(), Scalar::String(left));
                left_element.duration = MediaTime::from_ticks(left_ticks);
                let mut right_element = new_element(
                    required(right_element_id),
                    "text",
                    &source.name,
                    add(source.start_time, MediaTime::from_ticks(left_ticks), index)?,
                    MediaTime::from_ticks(right_ticks),
                );
                right_element.text = Some(right.clone());
                right_element.params = source.params.clone();
                right_element
                    .params
                    .0
                    .insert("content".to_owned(), Scalar::String(right));
                right_element.canonical_params = source.canonical_params.clone();
                self.insert_element(right_element, Some(track_id), index)?;
                self.caption_track_warnings(track_id, index, warnings);
                Ok(())
            }
            EditOperation::RestyleCaptions {
                track_id,
                element_ids,
                speaker,
                resolved_params,
                ..
            } => {
                let Some(params) = resolved_params else {
                    return invalid(index, "restyle params were not resolved");
                };
                let targets = self.caption_targets(
                    track_id,
                    element_ids.as_deref(),
                    speaker.as_deref(),
                    index,
                )?;
                for id in &targets {
                    let element = self.element_mut(track_id, id, index)?;
                    for (key, value) in &params.0 {
                        element.params.0.insert(key.clone(), value.clone());
                    }
                }
                Ok(())
            }
            EditOperation::RechunkCaptions {
                track_id,
                element_ids,
                speaker,
                max_chars_per_second,
                resolved_chunks,
                ..
            } => {
                let Some(chunks) = resolved_chunks else {
                    return invalid(index, "caption chunks were not resolved");
                };
                if chunks.is_empty() {
                    return invalid(index, "no caption chunks to apply");
                }
                let targets = self.caption_targets(
                    track_id,
                    element_ids.as_deref(),
                    speaker.as_deref(),
                    index,
                )?;
                let sources: BTreeMap<String, Element> = targets
                    .iter()
                    .map(|id| {
                        let element = self
                            .snapshot
                            .elements
                            .iter()
                            .find(|e| e.track_id == *track_id && e.element_id == *id)
                            .cloned()
                            .expect("targets were validated");
                        (id.clone(), element)
                    })
                    .collect();
                let chunk_ids: BTreeSet<&String> =
                    chunks.iter().map(|chunk| &chunk.element_id).collect();
                // Captions the chunks did not reuse vanished into the chunks
                // that replaced them, so this is not a gap-leaving delete.
                let surplus: BTreeSet<&String> = targets
                    .iter()
                    .filter(|id| !chunk_ids.contains(id))
                    .collect();
                self.snapshot.elements.retain(|element| {
                    !(element.track_id == *track_id && surplus.contains(&element.element_id))
                });
                self.snapshot.transitions.retain(|transition| {
                    !surplus.contains(&transition.from_element_id)
                        && !surplus.contains(&transition.to_element_id)
                });
                for chunk in chunks {
                    let source = sources.get(&chunk.source_element_id).ok_or_else(|| {
                        error(
                            ErrorCode::UnknownReference,
                            "unknown chunk source",
                            Some(index),
                            Some("resolvedChunks"),
                        )
                    })?;
                    let mut params = source.params.clone();
                    params
                        .0
                        .insert("content".to_owned(), Scalar::String(chunk.text.clone()));
                    if sources.contains_key(&chunk.element_id) {
                        let element = self.element_mut(track_id, &chunk.element_id, index)?;
                        element.name = source.name.clone();
                        element.text = Some(chunk.text.clone());
                        element.params = params;
                        element.canonical_params = source.canonical_params.clone();
                        element.start_time = chunk.start_time;
                        element.duration = chunk.duration;
                    } else {
                        let mut element = new_element(
                            &chunk.element_id,
                            "text",
                            &source.name,
                            chunk.start_time,
                            chunk.duration,
                        );
                        element.text = Some(chunk.text.clone());
                        element.params = params;
                        element.canonical_params = source.canonical_params.clone();
                        self.insert_element(element, Some(track_id), index)?;
                    }
                }
                self.caption_track_warnings(track_id, index, warnings);
                // The caller asked for a reading speed; say where the
                // timeline left no room to meet it.
                self.caption_reading_speed_warnings(
                    track_id,
                    max_chars_per_second.unwrap_or(CAPTION_MAX_CHARS_PER_SECOND),
                    index,
                    warnings,
                );
                Ok(())
            }
            EditOperation::RepairCaptionOverlaps {
                track_id,
                element_ids,
                min_gap,
            } => {
                let gap = min_gap.unwrap_or(MediaTime::ZERO);
                if gap.as_ticks() < 0 {
                    return bounds(index, "minGap");
                }
                let targets =
                    self.caption_targets(track_id, element_ids.as_deref(), None, index)?;
                let mut ordered: Vec<(MediaTime, String, MediaTime, bool)> = targets
                    .iter()
                    .map(|id| {
                        let element = self
                            .snapshot
                            .elements
                            .iter()
                            .find(|e| e.track_id == *track_id && e.element_id == *id)
                            .expect("targets were validated");
                        (
                            element.start_time,
                            id.clone(),
                            element.duration,
                            !element.keyframes.is_empty(),
                        )
                    })
                    .collect();
                ordered.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
                for pair in ordered.windows(2) {
                    let (start, id, duration, animated) = &pair[0];
                    let end = add(*start, *duration, index)?;
                    let limit = sub(pair[1].0, gap, index)?;
                    if end.as_ticks() <= limit.as_ticks() {
                        continue;
                    }
                    // Shortening an animated caption would re-key its
                    // animations, which the browser would do its own way.
                    if *animated {
                        return invalid(
                            index,
                            "repair_caption_overlaps does not support animated captions",
                        );
                    }
                    let trimmed = sub(limit, *start, index)?;
                    if trimmed.as_ticks() <= 0 {
                        return invalid(index, "overlap repair leaves a caption without duration");
                    }
                    self.element_mut(track_id, id, index)?.duration = trimmed;
                }
                self.caption_track_warnings(track_id, index, warnings);
                Ok(())
            }
            EditOperation::Delete {
                track_id,
                element_id,
                ripple: use_ripple,
                relationship_scope,
            } => self.delete_related(
                track_id,
                element_id,
                *use_ripple,
                *relationship_scope,
                index,
                ripple,
                relationships,
                warnings,
            ),
            EditOperation::DuplicateElements {
                elements,
                duplicate_ids,
                relationship_scope,
                resolved_allocations,
            } => self.duplicate(
                elements,
                duplicate_ids.as_deref().unwrap_or_default(),
                resolved_allocations.as_deref().unwrap_or_default(),
                *relationship_scope,
                index,
                relationships,
            ),
            EditOperation::CreateCompound {
                compound_id,
                name,
                elements,
                relationship_scope,
                target_track_id,
                auto_track_id,
                empty_main_track_id,
                ..
            } => self.create_compound(
                compound_id,
                name.as_deref(),
                elements,
                *relationship_scope,
                target_track_id.as_deref(),
                auto_track_id.as_deref(),
                empty_main_track_id.as_deref(),
                index,
                relationships,
            ),
            EditOperation::BreakApartCompound {
                track_id,
                element_id,
                restored_element_ids,
                resolved_allocations,
            } => self.break_compound(
                track_id,
                element_id,
                restored_element_ids.as_deref().unwrap_or_default(),
                resolved_allocations.as_deref().unwrap_or_default(),
                index,
            ),
            EditOperation::SetGroup { group_id, elements } => {
                self.set_relationship(group_id, elements, true, index)
            }
            EditOperation::ClearGroup { group_id } => {
                self.clear_relationship(group_id, true, index)
            }
            EditOperation::SetLink { link_id, elements } => {
                self.set_relationship(link_id, elements, false, index)
            }
            EditOperation::ClearLink { link_id } => self.clear_relationship(link_id, false, index),
            EditOperation::Move {
                track_id,
                target_track_id,
                element_id,
                start_time,
                relationship_scope,
            } => self.move_related(
                track_id,
                target_track_id.as_deref().unwrap_or(track_id),
                element_id,
                *start_time,
                *relationship_scope,
                index,
                relationships,
            ),
            EditOperation::SetParams {
                track_id,
                element_id,
                params,
            } => {
                if params.is_empty() {
                    return invalid(index, "params cannot be empty");
                }
                let element = self.element_mut(track_id, element_id, index)?;
                let definition_id = element.definition_id.as_deref();
                let effect_type = element.effect_type.as_deref();
                let coerced = if let Some(effect_type) = effect_type {
                    effect_params(
                        effect_type,
                        &element.element_type,
                        Some(&element.params),
                        Some(params),
                        index,
                    )?
                } else {
                    params
                        .iter()
                        .map(|(key, value)| {
                            Ok((
                                key.clone(),
                                coerce_element_param(
                                    &element.element_type,
                                    definition_id,
                                    key,
                                    value,
                                    index,
                                )?,
                            ))
                        })
                        .collect::<Result<Params, EditPlanError>>()?
                };
                element.params.extend(coerced);
                sync_element_control_params(element);
                Ok(())
            }
            EditOperation::SetReframe {
                track_id,
                element_id,
                mode,
                crop,
                focal_point,
                target_rect,
                layout,
            } => {
                if mode.is_none()
                    && crop.is_none()
                    && focal_point.is_none()
                    && target_rect.is_none()
                    && layout.is_none()
                {
                    return invalid(index, "reframe is empty");
                }
                validate_reframe(
                    crop.as_ref(),
                    focal_point.as_ref(),
                    target_rect.as_ref(),
                    layout.map(|value| value.as_str()),
                    index,
                )?;
                let element = self.element_mut(track_id, element_id, index)?;
                if !matches!(element.element_type.as_str(), "video" | "image") {
                    return incompatible(index, "reframing requires video or image");
                }
                let current = element.reframe.clone().unwrap_or_else(default_reframe);
                let resolved_target = target_rect
                    .clone()
                    .or_else(|| layout.map(layout_rect))
                    .or(current.target_rect);
                element.reframe = Some(Reframe {
                    mode: Some(
                        mode.map(|value| normalize_reframe_mode(value.as_str()).to_owned())
                            .or(current.mode)
                            .unwrap_or_else(|| "contain".into()),
                    ),
                    crop: crop.clone().or(current.crop),
                    focal_point: focal_point.clone().or(current.focal_point),
                    target_rect: resolved_target,
                    layout: None,
                });
                Ok(())
            }
            EditOperation::SetAudio {
                track_id,
                element_id,
                volume_db,
                muted,
                fade,
                resolved_allocations,
            } => {
                if volume_db.is_none() && muted.is_none() && fade.is_none() {
                    return invalid(index, "audio update is empty");
                }
                if let Some(v) = volume_db {
                    finite_range(*v, -60.0, 20.0, index, "volumeDb")?;
                }
                if let Some(v) = fade {
                    validate_fade(v, index)?;
                }
                let element = self.element_mut(track_id, element_id, index)?;
                require_audio(element, index)?;
                let target_volume = volume_db.unwrap_or(element.volume_db.unwrap_or(0.0));
                if let Some(fade) = fade {
                    if fade.floor_db > target_volume {
                        return invalid(index, "fade.floorDb cannot exceed volumeDb");
                    }
                    if fade.in_duration.as_ticks() + fade.out_duration.as_ticks()
                        > element.duration.as_ticks()
                    {
                        return bounds(index, "fade");
                    }
                    let points = fade_keyframe_points(element.duration, target_volume, fade);
                    replace_generated_keyframes(
                        element,
                        "volume",
                        &points,
                        resolved_allocations.as_deref().unwrap_or_default(),
                        index,
                    )?;
                }
                if let Some(v) = volume_db {
                    element.volume_db = Some(*v)
                }
                if let Some(v) = muted {
                    element.muted = Some(*v)
                }
                if let Some(v) = fade {
                    element.fade = Some(v.clone())
                }
                Ok(())
            }
            EditOperation::SeparateSourceAudio {
                track_id,
                element_id,
                audio_track_id,
                audio_element_id,
                link_id,
                resolved_allocations,
            } => self.separate_audio(
                track_id,
                element_id,
                required(audio_track_id),
                required(audio_element_id),
                required(link_id),
                resolved_allocations.as_deref().unwrap_or_default(),
                index,
            ),
            EditOperation::DuckAudio {
                track_id,
                element_id,
                regions,
                reduction_db,
                attack_duration,
                release_duration,
                resolved_allocations,
            } => {
                let list = regions
                    .iter()
                    .map(|r| {
                        validate_interval(r.start_time, r.duration, Some(index))?;
                        Ok(DuckingRegion {
                            start_time: r.start_time,
                            duration: r.duration,
                            reduction_db: *reduction_db,
                            attack_duration: *attack_duration,
                            release_duration: *release_duration,
                        })
                    })
                    .collect::<Result<Vec<_>, EditPlanError>>()?;
                let element = self.element_mut(track_id, element_id, index)?;
                require_audio(element, index)?;
                let points = ducking_keyframe_points(
                    element,
                    regions,
                    *reduction_db,
                    *attack_duration,
                    *release_duration,
                    index,
                )?;
                replace_generated_keyframes(
                    element,
                    "ducking",
                    &points,
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )?;
                element.ducking = list;
                Ok(())
            }
            EditOperation::AdjustMixGain { gain_db } => {
                finite_range(*gain_db, -60.0, 20.0, index, "gainDb")?;
                let target_ids: BTreeSet<_> = self
                    .snapshot
                    .elements
                    .iter()
                    .filter(|element| self.is_audible_timeline_element(element))
                    .map(|element| element.element_id.clone())
                    .collect();
                if target_ids.is_empty() {
                    return invalid(index, "no audible elements");
                }
                for element in self
                    .snapshot
                    .elements
                    .iter()
                    .filter(|element| target_ids.contains(&element.element_id))
                {
                    for value in mix_gain_values(element) {
                        let shifted = value + gain_db;
                        if !(-60.0..=20.0).contains(&shifted) {
                            return bounds(index, "gainDb");
                        }
                    }
                }
                for element in self
                    .snapshot
                    .elements
                    .iter_mut()
                    .filter(|element| target_ids.contains(&element.element_id))
                {
                    element.volume_db = Some(element.volume_db.unwrap_or(0.0) + gain_db);
                    if volume_animation_is_scalar(element) {
                        for keyframe in &mut element.keyframes {
                            if keyframe.property_path == "volume" {
                                let Scalar::Number(value) = &mut keyframe.value else {
                                    unreachable!("scalar volume channel was validated")
                                };
                                *value += gain_db;
                            }
                        }
                    }
                }
                Ok(())
            }
            EditOperation::UpsertEffect {
                track_id,
                element_id,
                effect_id,
                effect_type,
                params,
                enabled,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                if !matches!(
                    element.element_type.as_str(),
                    "video" | "image" | "text" | "sticker" | "graphic"
                ) {
                    return incompatible(index, "clip effects require a visual timeline element");
                }
                if let Some(effect) = element
                    .effects
                    .iter_mut()
                    .find(|e| e.effect_id == *effect_id)
                {
                    if effect.effect_type != *effect_type {
                        return invalid(index, "effect ID already has a different type");
                    }
                    effect.params = effect_params(
                        effect_type,
                        &element.element_type,
                        Some(&effect.params),
                        params.as_ref(),
                        index,
                    )?;
                    if let Some(enabled) = enabled {
                        effect.enabled = *enabled;
                    }
                } else {
                    element.effects.push(Effect {
                        effect_id: effect_id.clone(),
                        effect_type: effect_type.clone(),
                        enabled: enabled.unwrap_or(true),
                        params: effect_params(
                            effect_type,
                            &element.element_type,
                            None,
                            params.as_ref(),
                            index,
                        )?,
                    });
                }
                Ok(())
            }
            EditOperation::RemoveEffect {
                track_id,
                element_id,
                effect_id,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                if !matches!(
                    element.element_type.as_str(),
                    "video" | "image" | "text" | "sticker" | "graphic"
                ) {
                    return incompatible(index, "clip effects require a visual timeline element");
                }
                let old = element.effects.len();
                element
                    .effects
                    .retain(|effect| effect.effect_id != *effect_id);
                if old == element.effects.len() {
                    return unknown(index, "effect");
                }
                let prefix = format!("effects.{effect_id}.params.");
                element
                    .keyframes
                    .retain(|keyframe| !keyframe.property_path.starts_with(&prefix));
                Ok(())
            }
            EditOperation::ReorderEffects {
                track_id,
                element_id,
                effect_ids,
            } => self.reorder_effects(track_id, element_id, effect_ids, index),
            EditOperation::UpsertKeyframe {
                track_id,
                element_id,
                property_path,
                time,
                value,
                interpolation,
                keyframe_id,
            } => self.upsert_keyframe(
                track_id,
                element_id,
                property_path,
                *time,
                value,
                interpolation.map(|value| value.as_str()),
                required(keyframe_id),
                index,
            ),
            EditOperation::RemoveKeyframe {
                track_id,
                element_id,
                property_path,
                keyframe_id,
            } => self.remove_keyframe(track_id, element_id, property_path, keyframe_id, index),
            EditOperation::RetimeKeyframe {
                track_id,
                element_id,
                property_path,
                keyframe_id,
                time,
            } => {
                nonnegative(*time, Some(index), "time")?;
                let duration = self.element_mut(track_id, element_id, index)?.duration;
                if *time > duration {
                    return bounds(index, "time");
                }
                let key =
                    self.keyframe_mut(track_id, element_id, property_path, keyframe_id, index)?;
                key.time = *time;
                Ok(())
            }
            EditOperation::UpsertTransition {
                track_id,
                transition_id,
                from_element_id,
                to_element_id,
                transition_type,
                duration,
            } => self.upsert_transition(
                track_id,
                transition_id,
                from_element_id,
                to_element_id,
                transition_type.as_str(),
                *duration,
                index,
            ),
            EditOperation::RemoveTransition {
                track_id,
                transition_id,
            } => {
                let old = self.snapshot.transitions.len();
                self.snapshot
                    .transitions
                    .retain(|t| !(t.track_id == *track_id && t.transition_id == *transition_id));
                if old == self.snapshot.transitions.len() {
                    return unknown(index, "transition");
                }
                Ok(())
            }
            EditOperation::SetRetime {
                track_id,
                element_id,
                rate,
                maintain_pitch,
                resolved_allocations,
            } => {
                finite_range(*rate, 0.01, 5.0, index, "rate")?;
                let element = self.element_mut(track_id, element_id, index)?;
                if !matches!(element.element_type.as_str(), "video" | "audio") {
                    return incompatible(index, "only video and audio elements can be retimed");
                }
                let source_duration = element_source_duration(element, index)?;
                let visible_source_ticks = source_duration
                    .as_ticks()
                    .checked_sub(element.trim_start.as_ticks())
                    .and_then(|value| value.checked_sub(element.trim_end.as_ticks()))
                    .ok_or_else(|| {
                        error(
                            ErrorCode::ArithmeticOverflow,
                            "retimed source span overflow",
                            Some(index),
                            None,
                        )
                    })?;
                if visible_source_ticks <= 0 {
                    return invalid(index, "retime requires a visible source span");
                }
                element.retime_rate = Some(*rate);
                element.maintain_pitch = Some(maintain_pitch.unwrap_or(false));
                element.duration = timeline_duration_for_source_span(
                    MediaTime::from_ticks(visible_source_ticks),
                    element,
                    index,
                )?;
                clamp_keyframes_to_duration(
                    element,
                    element.duration,
                    resolved_allocations.as_deref().unwrap_or_default(),
                    index,
                )?;
                if element.source_duration.is_none() {
                    element.source_duration = Some(source_duration);
                }
                Ok(())
            }
            EditOperation::Trim {
                track_id,
                element_id,
                start_time,
                duration,
                trim_start,
                trim_end,
                ripple: use_ripple,
                resolved_allocations,
            } => self.trim(
                track_id,
                element_id,
                *start_time,
                *duration,
                *trim_start,
                *trim_end,
                *use_ripple,
                resolved_allocations.as_deref().unwrap_or_default(),
                index,
                ripple,
            ),
            EditOperation::Split {
                track_id,
                element_id,
                split_time,
                right_element_id,
                retain_side,
                ripple: use_ripple,
                resolved_allocations,
            } => self.split(
                track_id,
                element_id,
                *split_time,
                right_element_id.as_deref(),
                retain_side.map(|value| value.as_str()).unwrap_or("both"),
                *use_ripple,
                resolved_allocations.as_deref().unwrap_or_default(),
                index,
                ripple,
            ),
            EditOperation::SetMatteState {
                track_id,
                element_id,
                enabled,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                if element.element_type != "video" {
                    return incompatible(index, "matte requires video");
                }
                if element.matte_enabled.is_none() {
                    return unknown(index, "matte attachment");
                }
                element.matte_enabled = Some(*enabled);
                Ok(())
            }
            EditOperation::RemoveMatte {
                track_id,
                element_id,
            } => {
                let asset_id = self
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| {
                        element.track_id == *track_id && element.element_id == *element_id
                    })
                    .and_then(matte_asset_id)
                    .ok_or_else(|| unknown_error(index, "matte attachment"))?;
                let references = self
                    .media_reference_counts
                    .get(&asset_id)
                    .copied()
                    .unwrap_or_default();
                let element = self.element_mut(track_id, element_id, index)?;
                if element.matte_enabled.take().is_none() {
                    return unknown(index, "matte attachment");
                }
                if references == 1 {
                    self.media_assets.remove(&asset_id);
                }
                decrement_reference(&mut self.media_reference_counts, &asset_id);
                Ok(())
            }
            EditOperation::SetKey {
                track_id,
                element_id,
                key,
            } => {
                validate_compositing_key(key, index)?;
                match self.element_mut(track_id, element_id, index)? {
                    element if matches!(element.element_type.as_str(), "video" | "image") => {
                        element.key = Some(key.clone());
                        Ok(())
                    }
                    _ => incompatible(index, "keying requires a video or image element"),
                }
            }
            EditOperation::RemoveKey {
                track_id,
                element_id,
            } => match self.element_mut(track_id, element_id, index)? {
                element if matches!(element.element_type.as_str(), "video" | "image") => {
                    if element.key.take().is_none() {
                        return unknown(index, "compositing key");
                    }
                    Ok(())
                }
                _ => incompatible(index, "keying requires a video or image element"),
            },
            EditOperation::SetMask {
                track_id,
                element_id,
                mask_id,
                mask_type,
                params,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                if !matches!(element.element_type.as_str(), "video" | "image" | "graphic") {
                    return incompatible(
                        index,
                        "authored masks require a video, image, or graphic element",
                    );
                }
                element.masks = vec![Mask {
                    mask_id: mask_id.clone(),
                    mask_type: mask_type.as_str().into(),
                    params: resolved_mask_params(*mask_type, params.as_ref(), index)?,
                }];
                Ok(())
            }
            EditOperation::RemoveMask {
                track_id,
                element_id,
                mask_id,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                if !matches!(element.element_type.as_str(), "video" | "image" | "graphic") {
                    return incompatible(
                        index,
                        "authored masks require a video, image, or graphic element",
                    );
                }
                if !element.masks.iter().any(|mask| mask.mask_id == *mask_id) {
                    return unknown(index, "mask");
                }
                element.masks.clear();
                Ok(())
            }
            EditOperation::SetAudioReplacementState {
                track_id,
                element_id,
                enabled,
            } => {
                let element = self.element_mut(track_id, element_id, index)?;
                require_audio(element, index)?;
                if element.audio_replacement_enabled.is_none() {
                    return unknown(index, "audio replacement");
                }
                element.audio_replacement_enabled = Some(*enabled);
                Ok(())
            }
            EditOperation::RemoveAudioReplacement {
                track_id,
                element_id,
            } => {
                let asset_id = self
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| {
                        element.track_id == *track_id && element.element_id == *element_id
                    })
                    .and_then(audio_replacement_asset_id)
                    .ok_or_else(|| unknown_error(index, "audio replacement"))?;
                let references = self
                    .media_reference_counts
                    .get(&asset_id)
                    .copied()
                    .unwrap_or_default();
                let element = self.element_mut(track_id, element_id, index)?;
                require_audio(element, index)?;
                if element.audio_replacement_enabled.take().is_none() {
                    return unknown(index, "audio replacement");
                }
                if references == 1 {
                    self.media_assets.remove(&asset_id);
                }
                decrement_reference(&mut self.media_reference_counts, &asset_id);
                Ok(())
            }
        }
    }

    fn track_mut(&mut self, id: &str, index: usize) -> Result<&mut Track, EditPlanError> {
        self.snapshot
            .tracks
            .iter_mut()
            .find(|t| t.track_id == id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown track",
                    Some(index),
                    Some("trackId"),
                )
            })
    }
    /// The text elements a caption operation addresses on `track`: the listed
    /// ids, each of which must be a caption on that track, or every caption
    /// on the track in timeline order.
    fn caption_targets(
        &self,
        track: &str,
        element_ids: Option<&[String]>,
        speaker: Option<&str>,
        index: usize,
    ) -> Result<Vec<String>, EditPlanError> {
        if !self.snapshot.tracks.iter().any(|t| t.track_id == track) {
            return Err(error(
                ErrorCode::UnknownReference,
                "unknown track",
                Some(index),
                Some("trackId"),
            ));
        }
        let mut targets: Vec<String> = match element_ids {
            Some(ids) => {
                let mut seen = BTreeSet::new();
                for id in ids {
                    let element = self
                        .snapshot
                        .elements
                        .iter()
                        .find(|e| e.track_id == track && e.element_id == *id)
                        .ok_or_else(|| {
                            error(
                                ErrorCode::UnknownReference,
                                "unknown caption",
                                Some(index),
                                Some("elementIds"),
                            )
                        })?;
                    if element.element_type != "text" {
                        return Err(error(
                            ErrorCode::IncompatibleTrack,
                            "caption must reference text",
                            Some(index),
                            Some("elementIds"),
                        ));
                    }
                    seen.insert(id.clone());
                }
                seen.into_iter().collect()
            }
            None => {
                let mut captions: Vec<&Element> = self
                    .snapshot
                    .elements
                    .iter()
                    .filter(|e| e.track_id == track && e.element_type == "text")
                    .collect();
                captions.sort_by(|a, b| {
                    a.start_time
                        .cmp(&b.start_time)
                        .then_with(|| a.element_id.cmp(&b.element_id))
                });
                captions.iter().map(|e| e.element_id.clone()).collect()
            }
        };
        if let Some(speaker) = speaker {
            if speaker.trim().is_empty() {
                return Err(error(
                    ErrorCode::InvalidValue,
                    "speaker cannot be empty",
                    Some(index),
                    Some("speaker"),
                ));
            }
            targets.retain(|id| {
                self.snapshot
                    .elements
                    .iter()
                    .find(|e| e.track_id == track && e.element_id == *id)
                    .is_some_and(|element| caption_speaker(element) == speaker)
            });
        }
        if targets.is_empty() {
            return Err(error(
                ErrorCode::InvalidValue,
                "no captions to operate on",
                Some(index),
                Some(if speaker.is_some() {
                    "speaker"
                } else {
                    "trackId"
                }),
            ));
        }
        targets.dedup();
        Ok(targets)
    }

    /// Re-segments the targeted captions into chunks of at most `max_chars`
    /// characters that read no faster than `max_chars_per_second`. Word
    /// timings are interpolated by character share inside each source
    /// caption; a chunk closes when the next word would exceed the character
    /// budget, `max_duration`, or a pause longer than `max_gap`. Each chunk's
    /// end then grows, up to the next chunk (or the next caption this
    /// operation leaves alone), until it meets the reading speed. Chunks reuse
    /// the targeted ids in timeline order and allocate ids for the rest; a
    /// chunk inherits the style of the caption its first word came from.
    #[allow(clippy::too_many_arguments)]
    fn resolve_caption_chunks(
        &mut self,
        track: &str,
        element_ids: Option<&[String]>,
        speaker: Option<&str>,
        max_chars: Option<u32>,
        max_chars_per_second: Option<f64>,
        max_duration: Option<MediaTime>,
        max_gap: Option<MediaTime>,
        index: usize,
        fingerprint: &str,
    ) -> Result<(Vec<ResolvedCaptionChunk>, Vec<ObjectIdAllocation>), EditPlanError> {
        let max_chars = max_chars.unwrap_or(CAPTION_DEFAULT_MAX_CHARS) as usize;
        if max_chars == 0 {
            bounds(index, "maxChars")?;
        }
        let max_cps = max_chars_per_second.unwrap_or(CAPTION_MAX_CHARS_PER_SECOND);
        if !max_cps.is_finite() || max_cps <= 0.0 {
            bounds(index, "maxCharsPerSecond")?;
        }
        if max_duration.is_some_and(|limit| limit.as_ticks() <= 0) {
            bounds(index, "maxDuration")?;
        }
        let max_gap = max_gap.unwrap_or(MediaTime::from_ticks(CAPTION_DEFAULT_MAX_GAP_TICKS));
        if max_gap.as_ticks() < 0 {
            bounds(index, "maxGap")?;
        }
        let targets = self.caption_targets(track, element_ids, speaker, index)?;
        let mut sources: Vec<Element> = targets
            .iter()
            .map(|id| {
                self.snapshot
                    .elements
                    .iter()
                    .find(|e| e.track_id == track && e.element_id == *id)
                    .cloned()
                    .expect("targets were validated")
            })
            .collect();
        sources.sort_by(|a, b| {
            a.start_time
                .cmp(&b.start_time)
                .then_with(|| a.element_id.cmp(&b.element_id))
        });
        struct Word {
            text: String,
            start: i64,
            end: i64,
            source: usize,
        }
        let mut words: Vec<Word> = Vec::new();
        for (source_index, source) in sources.iter().enumerate() {
            if !source.keyframes.is_empty() {
                invalid(index, "rechunk_captions does not support animated captions")?;
            }
            let text = caption_text(source);
            let tokens: Vec<&str> = text.split_whitespace().collect();
            let total: i128 = tokens
                .iter()
                .map(|token| token.chars().count() as i128)
                .sum();
            if total == 0 {
                continue;
            }
            let start = i128::from(source.start_time.as_ticks());
            let span = i128::from(source.duration.as_ticks());
            let mut before: i128 = 0;
            for token in tokens {
                let length = token.chars().count() as i128;
                words.push(Word {
                    text: token.to_owned(),
                    start: (start + span * before / total) as i64,
                    end: (start + span * (before + length) / total) as i64,
                    source: source_index,
                });
                before += length;
            }
        }
        if words.is_empty() {
            invalid(index, "captions have no words to rechunk")?;
        }
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut current: Vec<usize> = Vec::new();
        let mut current_chars = 0usize;
        for (position, word) in words.iter().enumerate() {
            let word_chars = word.text.chars().count();
            if let (Some(&first), Some(&last)) = (current.first(), current.last()) {
                let exceeds_chars = current_chars + 1 + word_chars > max_chars;
                let exceeds_duration = max_duration
                    .is_some_and(|limit| word.end - words[first].start > limit.as_ticks());
                let exceeds_gap = word.start - words[last].end > max_gap.as_ticks();
                let changes_speaker = caption_speaker(&sources[words[first].source])
                    != caption_speaker(&sources[word.source]);
                if exceeds_chars || exceeds_duration || exceeds_gap || changes_speaker {
                    groups.push(std::mem::take(&mut current));
                }
            }
            current_chars = if current.is_empty() {
                word_chars
            } else {
                current_chars + 1 + word_chars
            };
            current.push(position);
        }
        groups.push(current);
        let starts: Vec<i64> = groups.iter().map(|group| words[group[0]].start).collect();
        let last_start = *starts.last().expect("at least one chunk");
        let track_limit = self
            .snapshot
            .elements
            .iter()
            .filter(|e| {
                e.track_id == track
                    && e.element_type == "text"
                    && !targets.contains(&e.element_id)
                    && e.start_time.as_ticks() >= last_start
            })
            .map(|e| e.start_time.as_ticks())
            .min();
        let mut chunks = Vec::with_capacity(groups.len());
        let mut allocations = Vec::new();
        for (ordinal, group) in groups.iter().enumerate() {
            let text = group
                .iter()
                .map(|&position| words[position].text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let characters = text.chars().filter(|ch| !ch.is_whitespace()).count() as f64;
            let start = starts[ordinal];
            let natural_end = words[*group.last().expect("group is non-empty")].end;
            let needed = (characters / max_cps * TICKS_PER_SECOND as f64).ceil() as i64;
            let limit = if ordinal + 1 < groups.len() {
                Some(starts[ordinal + 1])
            } else {
                track_limit
            };
            let mut end = natural_end.max(start.saturating_add(needed));
            if let Some(limit) = limit {
                end = end.min(limit);
            }
            if let Some(max) = max_duration {
                end = end.min(start.saturating_add(max.as_ticks()));
            }
            end = end.max(natural_end);
            let duration = end - start;
            if duration <= 0 {
                invalid(index, "caption is too short to rechunk")?;
            }
            let source = &sources[words[group[0]].source];
            let element_id = match sources.get(ordinal) {
                Some(reused) => reused.element_id.clone(),
                None => {
                    let allocation = self.allocate_mapping(
                        "caption-element",
                        &source.element_id,
                        index,
                        fingerprint,
                        ordinal - sources.len(),
                    )?;
                    let id = allocation.resolved_id.clone();
                    allocations.push(allocation);
                    id
                }
            };
            chunks.push(ResolvedCaptionChunk {
                element_id,
                source_element_id: source.element_id.clone(),
                text,
                start_time: MediaTime::from_ticks(start),
                duration: MediaTime::from_ticks(duration),
            });
        }
        Ok((chunks, allocations))
    }

    /// Warns about captions that overlap or read faster than
    /// `CAPTION_MAX_CHARS_PER_SECOND` on `track` after an operation.
    fn caption_track_warnings(&self, track: &str, index: usize, warnings: &mut BTreeSet<Warning>) {
        let mut captions: Vec<&Element> = self
            .snapshot
            .elements
            .iter()
            .filter(|e| e.track_id == track && e.element_type == "text")
            .collect();
        captions.sort_by(|a, b| {
            a.start_time
                .cmp(&b.start_time)
                .then_with(|| a.element_id.cmp(&b.element_id))
        });
        for pair in captions.windows(2) {
            let (earlier, later) = (pair[0], pair[1]);
            let earlier_end = earlier
                .start_time
                .as_ticks()
                .saturating_add(earlier.duration.as_ticks());
            if later.start_time.as_ticks() < earlier_end {
                warnings.insert(Warning {
                    code: WarningCode::CaptionOverlap,
                    message: format!(
                        "caption {} overlaps caption {}",
                        later.element_id, earlier.element_id
                    ),
                    operation_index: index,
                    object_id: Some(later.element_id.clone()),
                });
            }
        }
        self.caption_reading_speed_warnings(track, CAPTION_MAX_CHARS_PER_SECOND, index, warnings);
    }

    /// Warns about captions on `track` that read faster than `max_cps`.
    fn caption_reading_speed_warnings(
        &self,
        track: &str,
        max_cps: f64,
        index: usize,
        warnings: &mut BTreeSet<Warning>,
    ) {
        for caption in self
            .snapshot
            .elements
            .iter()
            .filter(|e| e.track_id == track && e.element_type == "text")
        {
            let characters = caption_text(caption)
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .count() as f64;
            let seconds = caption.duration.to_seconds_f64();
            if seconds > 0.0 && characters / seconds > max_cps {
                warnings.insert(Warning {
                    code: WarningCode::CaptionReadingSpeed,
                    message: format!(
                        "caption {} reads at {:.1} characters per second",
                        caption.element_id,
                        characters / seconds
                    ),
                    operation_index: index,
                    object_id: Some(caption.element_id.clone()),
                });
            }
        }
    }

    fn element_mut(
        &mut self,
        track: &str,
        id: &str,
        index: usize,
    ) -> Result<&mut Element, EditPlanError> {
        self.snapshot
            .elements
            .iter_mut()
            .find(|e| e.track_id == track && e.element_id == id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown element",
                    Some(index),
                    Some("elementId"),
                )
            })
    }
    fn require_element(
        &self,
        track: &str,
        id: &str,
        index: Option<usize>,
    ) -> Result<(), EditPlanError> {
        if self
            .snapshot
            .elements
            .iter()
            .any(|e| e.track_id == track && e.element_id == id)
        {
            Ok(())
        } else {
            Err(error(
                ErrorCode::UnknownReference,
                "unknown element",
                index,
                Some("elementId"),
            ))
        }
    }
    fn reorder_tracks(
        &mut self,
        overlay: Option<&[String]>,
        audio: Option<&[String]>,
        index: usize,
    ) -> Result<(), EditPlanError> {
        if overlay.is_none() && audio.is_none() {
            return invalid(index, "a track order is required");
        }
        let reorder = |role: &str, requested: &[String]| -> Result<Vec<Track>, EditPlanError> {
            let current: Vec<&Track> = self
                .snapshot
                .tracks
                .iter()
                .filter(|track| track.role == role)
                .collect();
            let mut seen = BTreeSet::new();
            let complete = requested.len() == current.len()
                && requested.iter().all(|id| seen.insert(id.as_str()))
                && current
                    .iter()
                    .all(|track| requested.iter().any(|id| *id == track.track_id));
            if !complete {
                return Err(invalid_error(
                    index,
                    &format!("{role} track order must list every {role} track exactly once"),
                ));
            }
            Ok(requested
                .iter()
                .map(|id| {
                    (*current
                        .iter()
                        .find(|track| track.track_id == *id)
                        .expect("validated track order"))
                    .clone()
                })
                .collect())
        };
        let overlay_tracks = match overlay {
            Some(ids) => reorder("overlay", ids)?,
            None => self
                .snapshot
                .tracks
                .iter()
                .filter(|track| track.role == "overlay")
                .cloned()
                .collect(),
        };
        let audio_tracks = match audio {
            Some(ids) => reorder("audio", ids)?,
            None => self
                .snapshot
                .tracks
                .iter()
                .filter(|track| track.role == "audio")
                .cloned()
                .collect(),
        };
        let main_tracks: Vec<Track> = self
            .snapshot
            .tracks
            .iter()
            .filter(|track| track.role == "main")
            .cloned()
            .collect();
        let next: Vec<Track> = overlay_tracks
            .into_iter()
            .chain(main_tracks)
            .chain(audio_tracks)
            .collect();
        if next.iter().map(|track| &track.track_id).eq(self
            .snapshot
            .tracks
            .iter()
            .map(|track| &track.track_id))
        {
            return Err(error(
                ErrorCode::SilentNoOp,
                "track order already matches the requested order",
                Some(index),
                None,
            ));
        }
        self.snapshot.tracks = next;
        Ok(())
    }

    fn remove_track(
        &mut self,
        track_id: &str,
        occupied: RemoveTrackOccupiedPolicy,
        target_track_id: Option<&str>,
        resolved_cascade_element_ids: &[String],
        index: usize,
        relationships: &mut BTreeSet<Expansion>,
        warnings: &mut BTreeSet<Warning>,
    ) -> Result<(), EditPlanError> {
        let track = self.track_mut(track_id, index)?.clone();
        if self.snapshot.tracks.iter().any(|candidate| {
            candidate
                .track_matte
                .as_ref()
                .is_some_and(|routing| routing.enabled && routing.source_track_id == track_id)
        }) {
            return invalid(
                index,
                "track is an enabled track matte source; remove its routing first",
            );
        }
        if track.role == "main" {
            return incompatible(
                index,
                "the main track cannot be removed; promote another video track first",
            );
        }
        if target_track_id.is_some() && occupied != RemoveTrackOccupiedPolicy::Move {
            return invalid(index, "targetTrackId is only used with the move policy");
        }
        let element_ids: BTreeSet<String> = self
            .snapshot
            .elements
            .iter()
            .filter(|element| element.track_id == track_id)
            .map(|element| element.element_id.clone())
            .collect();
        if !element_ids.is_empty() {
            match occupied {
                RemoveTrackOccupiedPolicy::Reject => {
                    return incompatible(
                        index,
                        "track still holds elements; pass an occupied policy of delete or move",
                    );
                }
                RemoveTrackOccupiedPolicy::Delete | RemoveTrackOccupiedPolicy::Cascade => {
                    let removed_ids = if occupied == RemoveTrackOccupiedPolicy::Cascade {
                        let expected: BTreeSet<String> = element_ids
                            .iter()
                            .flat_map(|seed| self.related_ids(seed, RelationshipScope::All))
                            .collect();
                        let resolved: BTreeSet<String> =
                            resolved_cascade_element_ids.iter().cloned().collect();
                        if resolved != expected {
                            return invalid(
                                index,
                                "resolved cascade elements do not match relationship expansion",
                            );
                        }
                        for affected in expected.difference(&element_ids) {
                            relationships.insert(Expansion {
                                operation_index: index,
                                cause_id: track_id.to_owned(),
                                affected_id: affected.clone(),
                            });
                        }
                        expected
                    } else {
                        element_ids.clone()
                    };
                    self.snapshot
                        .elements
                        .retain(|element| !removed_ids.contains(&element.element_id));
                    let before = self.snapshot.transitions.len();
                    self.snapshot.transitions.retain(|transition| {
                        !removed_ids.contains(&transition.from_element_id)
                            && !removed_ids.contains(&transition.to_element_id)
                    });
                    if before != self.snapshot.transitions.len() {
                        warnings.insert(Warning {
                            code: WarningCode::TransitionRemoved,
                            message: "dependent transition removed".into(),
                            operation_index: index,
                            object_id: Some(track_id.to_owned()),
                        });
                    }
                }
                RemoveTrackOccupiedPolicy::Move => {
                    let target_id = target_track_id.ok_or_else(|| {
                        invalid_error(index, "the move policy requires targetTrackId")
                    })?;
                    if target_id == track_id {
                        return invalid(index, "a track cannot receive its own elements");
                    }
                    let target = self.track_mut(target_id, index)?.clone();
                    if target.track_type != track.track_type {
                        return incompatible(
                            index,
                            "elements cannot move onto a track of another type",
                        );
                    }
                    let moving: Vec<(MediaTime, MediaTime)> = self
                        .snapshot
                        .elements
                        .iter()
                        .filter(|element| element_ids.contains(&element.element_id))
                        .map(|element| (element.start_time, element.duration))
                        .collect();
                    for (start, duration) in &moving {
                        let end = add(*start, *duration, index)?;
                        for candidate in self
                            .snapshot
                            .elements
                            .iter()
                            .filter(|element| element.track_id == target_id)
                        {
                            let candidate_end =
                                add(candidate.start_time, candidate.duration, index)?;
                            if !(end <= candidate.start_time || *start >= candidate_end) {
                                return incompatible(
                                    index,
                                    "target track does not have room for every element",
                                );
                            }
                        }
                    }
                    for element in &mut self.snapshot.elements {
                        if element_ids.contains(&element.element_id) {
                            element.track_id = target_id.to_owned();
                        }
                    }
                    for transition in &mut self.snapshot.transitions {
                        if transition.track_id == track_id {
                            transition.track_id = target_id.to_owned();
                        }
                    }
                    // The native command appends the moved elements and sorts
                    // the target by start time, so mirror that order here.
                    let mut target_elements: Vec<Element> = Vec::new();
                    let mut others: Vec<Element> = Vec::new();
                    for element in self.snapshot.elements.drain(..) {
                        if element.track_id == target_id {
                            target_elements.push(element);
                        } else {
                            others.push(element);
                        }
                    }
                    target_elements.sort_by_key(|element| element.start_time);
                    others.extend(target_elements);
                    self.snapshot.elements = others;
                }
            }
        }
        self.snapshot
            .tracks
            .retain(|candidate| candidate.track_id != track_id);
        Ok(())
    }

    fn duplicate_track(
        &mut self,
        track_id: &str,
        new_track_id: &str,
        name: Option<&str>,
        allocations: &[ObjectIdAllocation],
        index: usize,
        relationships: &mut BTreeSet<Expansion>,
    ) -> Result<(), EditPlanError> {
        let position = self
            .snapshot
            .tracks
            .iter()
            .position(|track| track.track_id == track_id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown track",
                    Some(index),
                    Some("trackId"),
                )
            })?;
        validate_id(new_track_id, Some(index), "newTrackId")?;
        if self
            .snapshot
            .tracks
            .iter()
            .any(|track| track.track_id == new_track_id)
        {
            return duplicate(index, new_track_id);
        }
        let mapping: BTreeMap<_, _> = allocations
            .iter()
            .map(|allocation| {
                (
                    (allocation.role.as_str(), allocation.source_id.as_str()),
                    allocation.resolved_id.as_str(),
                )
            })
            .collect();
        if mapping.get(&("duplicate-track", track_id)) != Some(&new_track_id) {
            return invalid(index, "duplicate track allocation is inconsistent");
        }
        let source = self.snapshot.tracks[position].clone();
        let copy = Track {
            track_id: new_track_id.to_owned(),
            name: name
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{} copy", source.name)),
            track_type: source.track_type.clone(),
            role: if source.role == "main" {
                "overlay".into()
            } else {
                source.role.clone()
            },
            muted: source.muted,
            hidden: source.hidden,
            track_matte: None,
        };
        // The copy sits directly after its source; the main track duplicates
        // onto the top of the overlay stack.
        let insert_at = if source.role == "main" {
            0
        } else {
            position + 1
        };
        self.snapshot.tracks.insert(insert_at, copy);
        let mut copies = Vec::new();
        let mut element_ids = BTreeMap::new();
        for element in self
            .snapshot
            .elements
            .iter()
            .filter(|element| element.track_id == track_id)
        {
            let resolved = mapping
                .get(&("duplicate-element", element.element_id.as_str()))
                .ok_or_else(|| {
                    error(
                        ErrorCode::InvalidValue,
                        "missing resolved duplicate element ID",
                        Some(index),
                        Some("resolvedAllocations"),
                    )
                })?;
            element_ids.insert(element.element_id.clone(), (*resolved).to_owned());
            let mut copy = element.clone();
            copy.element_id = (*resolved).to_owned();
            copy.name = format!("{} (copy)", copy.name);
            copy.track_id = new_track_id.to_owned();
            if let Some(group_id) = copy.group_id.as_mut()
                && let Some(resolved) = mapping.get(&("duplicate-group", group_id.as_str()))
            {
                *group_id = (*resolved).into();
            }
            if let Some(link_id) = copy.link_id.as_mut()
                && let Some(resolved) = mapping.get(&("duplicate-link", link_id.as_str()))
            {
                *link_id = (*resolved).into();
            }
            remap_owned_identities(&mut copy, allocations, "duplicate");
            copies.push(copy);
        }
        for (source_id, copy_id) in &element_ids {
            if self
                .snapshot
                .elements
                .iter()
                .any(|e| e.element_id == *copy_id)
            {
                return duplicate(index, copy_id);
            }
            relationships.insert(Expansion {
                operation_index: index,
                cause_id: source_id.clone(),
                affected_id: copy_id.clone(),
            });
        }
        let transition_copies: Vec<Transition> = self
            .snapshot
            .transitions
            .iter()
            .filter(|transition| transition.track_id == track_id)
            .map(|transition| {
                let transition_id = mapping
                    .get(&("duplicate-transition", transition.transition_id.as_str()))
                    .ok_or_else(|| {
                        error(
                            ErrorCode::InvalidValue,
                            "missing resolved duplicate transition ID",
                            Some(index),
                            Some("resolvedAllocations"),
                        )
                    })?;
                Ok(Transition {
                    transition_id: (*transition_id).to_owned(),
                    track_id: new_track_id.to_owned(),
                    from_element_id: element_ids[&transition.from_element_id].clone(),
                    to_element_id: element_ids[&transition.to_element_id].clone(),
                    transition_type: transition.transition_type.clone(),
                    duration: transition.duration,
                })
            })
            .collect::<Result<_, EditPlanError>>()?;
        self.snapshot.elements.extend(copies);
        self.snapshot.transitions.extend(transition_copies);
        Ok(())
    }

    fn set_main_track(&mut self, track_id: &str, index: usize) -> Result<(), EditPlanError> {
        let position = self
            .snapshot
            .tracks
            .iter()
            .position(|track| track.track_id == track_id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown track",
                    Some(index),
                    Some("trackId"),
                )
            })?;
        let candidate = &self.snapshot.tracks[position];
        if candidate.role == "main" {
            return Err(error(
                ErrorCode::SilentNoOp,
                "track is already the main track",
                Some(index),
                None,
            ));
        }
        if candidate.role != "overlay" {
            return incompatible(index, "only overlay tracks can become the main track");
        }
        if candidate.track_type != "video" {
            return incompatible(index, "only video tracks can become the main track");
        }
        self.validate_main_track_consequences(track_id, index)?;
        let mut promoted = self.snapshot.tracks.remove(position);
        promoted.role = "main".into();
        promoted.name = MAIN_TRACK_NAME.into();
        let main_position = self
            .snapshot
            .tracks
            .iter()
            .position(|track| track.role == "main")
            .ok_or_else(|| invalid_error(index, "scene has no main track"))?;
        let mut demoted = self.snapshot.tracks.remove(main_position);
        demoted.role = "overlay".into();
        if demoted.name == MAIN_TRACK_NAME {
            demoted.name = "Video Track".into();
        }
        self.snapshot.tracks.insert(0, demoted);
        let main_slot = self
            .snapshot
            .tracks
            .iter()
            .position(|track| track.role == "audio")
            .unwrap_or(self.snapshot.tracks.len());
        self.snapshot.tracks.insert(main_slot, promoted);
        Ok(())
    }

    fn validate_main_track_consequences(
        &self,
        candidate_track_id: &str,
        index: usize,
    ) -> Result<(), EditPlanError> {
        let current_main_track_id = self
            .snapshot
            .tracks
            .iter()
            .find(|track| track.role == "main")
            .map(|track| track.track_id.as_str())
            .ok_or_else(|| invalid_error(index, "scene has no main track"))?;
        let current_duration = self.track_end_time(current_main_track_id, index)?;
        let candidate_duration = self.track_end_time(candidate_track_id, index)?;
        if candidate_duration == MediaTime::ZERO {
            return incompatible(index, "the promoted main track cannot be empty");
        }
        if candidate_duration != current_duration {
            return incompatible(
                index,
                "the promoted main track must preserve the current main-track duration",
            );
        }

        let canvas = &self.snapshot.settings.canvas_size;
        if canvas.width == 0 || canvas.height == 0 {
            return Err(invalid_error(
                index,
                "project canvas dimensions must be positive",
            ));
        }
        for element in self
            .snapshot
            .elements
            .iter()
            .filter(|element| element.track_id == candidate_track_id)
        {
            let media_id = match element.canonical_source.as_ref() {
                Some(CanonicalElement::Video { media_id, .. })
                | Some(CanonicalElement::Image { media_id, .. }) => Some(media_id),
                _ => None,
            };
            if let Some(media_id) = media_id {
                let asset = self.media_assets.get(media_id).ok_or_else(|| {
                    error(
                        ErrorCode::UnknownReference,
                        "promoted main-track media asset is missing",
                        Some(index),
                        Some("trackId"),
                    )
                })?;
                if asset.width.unwrap_or(0) == 0 || asset.height.unwrap_or(0) == 0 {
                    return incompatible(
                        index,
                        "promoted main-track media must have valid dimensions for the project canvas",
                    );
                }
            }
        }

        let mut group_counts = BTreeMap::<&str, usize>::new();
        let mut link_counts = BTreeMap::<&str, usize>::new();
        for element in &self.snapshot.elements {
            if let Some(group_id) = element.group_id.as_deref() {
                *group_counts.entry(group_id).or_default() += 1;
            }
            if let Some(link_id) = element.link_id.as_deref() {
                *link_counts.entry(link_id).or_default() += 1;
            }
        }
        for element in self.snapshot.elements.iter().filter(|element| {
            element.track_id == candidate_track_id || element.track_id == current_main_track_id
        }) {
            if element
                .group_id
                .as_deref()
                .is_some_and(|id| group_counts.get(id).copied().unwrap_or_default() < 2)
                || element
                    .link_id
                    .as_deref()
                    .is_some_and(|id| link_counts.get(id).copied().unwrap_or_default() < 2)
            {
                return Err(invalid_error(
                    index,
                    "main-track promotion would retain an invalid downstream relationship",
                ));
            }
        }
        Ok(())
    }

    fn track_end_time(&self, track_id: &str, index: usize) -> Result<MediaTime, EditPlanError> {
        self.snapshot
            .elements
            .iter()
            .filter(|element| element.track_id == track_id)
            .try_fold(MediaTime::ZERO, |latest, element| {
                add(element.start_time, element.duration, index)
                    .map(|end| std::cmp::max(latest, end))
            })
    }

    fn require_bookmark_identity(&self, index: usize) -> Result<(), EditPlanError> {
        if self
            .snapshot
            .bookmarks
            .iter()
            .any(|bookmark| bookmark.bookmark_id.is_none())
        {
            return invalid(
                index,
                "bookmark operations require projection version 3 bookmark identities",
            );
        }
        Ok(())
    }

    fn bookmark_position(&self, bookmark_id: &str, index: usize) -> Result<usize, EditPlanError> {
        self.require_bookmark_identity(index)?;
        self.snapshot
            .bookmarks
            .iter()
            .position(|bookmark| bookmark.bookmark_id.as_deref() == Some(bookmark_id))
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown bookmark",
                    Some(index),
                    Some("bookmarkId"),
                )
            })
    }

    fn bookmark_frame_time(
        &self,
        time: MediaTime,
        index: usize,
    ) -> Result<MediaTime, EditPlanError> {
        if time < MediaTime::ZERO {
            return Err(error(
                ErrorCode::InvalidValue,
                "bookmark time must be non-negative",
                Some(index),
                Some("time"),
            ));
        }
        time.round_to_frame(self.snapshot.settings.fps)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnsupportedFrameRate,
                    "fps does not map to integral 120000-timebase ticks",
                    Some(index),
                    Some("settings.fps"),
                )
            })
    }

    fn sort_bookmarks(&mut self) {
        self.snapshot.bookmarks.sort_by(|left, right| {
            left.time
                .cmp(&right.time)
                .then_with(|| left.bookmark_id.cmp(&right.bookmark_id))
        });
    }

    fn add_bookmark(
        &mut self,
        bookmark_id: &str,
        time: MediaTime,
        duration: Option<MediaTime>,
        note: Option<String>,
        color: Option<String>,
        index: usize,
    ) -> Result<(), EditPlanError> {
        self.require_bookmark_identity(index)?;
        validate_id(bookmark_id, Some(index), "bookmarkId")?;
        if self
            .snapshot
            .bookmarks
            .iter()
            .any(|bookmark| bookmark.bookmark_id.as_deref() == Some(bookmark_id))
        {
            return duplicate(index, bookmark_id);
        }
        let time = self.bookmark_frame_time(time, index)?;
        if let Some(duration) = duration {
            positive(duration, Some(index), "duration")?;
        }
        self.snapshot.bookmarks.push(Bookmark {
            bookmark_id: Some(bookmark_id.to_owned()),
            time,
            duration,
            note,
            color,
        });
        self.sort_bookmarks();
        Ok(())
    }

    fn update_bookmark(
        &mut self,
        bookmark_id: &str,
        note: Option<String>,
        color: Option<String>,
        duration: Option<MediaTime>,
        clear: &[BookmarkField],
        index: usize,
    ) -> Result<(), EditPlanError> {
        let position = self.bookmark_position(bookmark_id, index)?;
        if note.is_none() && color.is_none() && duration.is_none() && clear.is_empty() {
            return invalid(index, "bookmark update is empty");
        }
        let conflicting = (note.is_some() && clear.contains(&BookmarkField::Note))
            || (color.is_some() && clear.contains(&BookmarkField::Color))
            || (duration.is_some() && clear.contains(&BookmarkField::Duration));
        if conflicting {
            return invalid(index, "a bookmark field cannot be both set and cleared");
        }
        if let Some(duration) = duration {
            positive(duration, Some(index), "duration")?;
        }
        let bookmark = &mut self.snapshot.bookmarks[position];
        if let Some(note) = note {
            bookmark.note = Some(note);
        }
        if let Some(color) = color {
            bookmark.color = Some(color);
        }
        if let Some(duration) = duration {
            bookmark.duration = Some(duration);
        }
        for field in clear {
            match field {
                BookmarkField::Note => bookmark.note = None,
                BookmarkField::Color => bookmark.color = None,
                BookmarkField::Duration => bookmark.duration = None,
            }
        }
        Ok(())
    }

    fn move_bookmark(
        &mut self,
        bookmark_id: &str,
        time: MediaTime,
        index: usize,
    ) -> Result<(), EditPlanError> {
        let position = self.bookmark_position(bookmark_id, index)?;
        let time = self.bookmark_frame_time(time, index)?;
        if self.snapshot.bookmarks[position].time == time {
            return Err(error(
                ErrorCode::SilentNoOp,
                "bookmark already sits at the requested frame",
                Some(index),
                None,
            ));
        }
        self.snapshot.bookmarks[position].time = time;
        self.sort_bookmarks();
        Ok(())
    }

    fn remove_bookmark(&mut self, bookmark_id: &str, index: usize) -> Result<(), EditPlanError> {
        let position = self.bookmark_position(bookmark_id, index)?;
        self.snapshot.bookmarks.remove(position);
        Ok(())
    }

    fn require_timeline_asset(
        &self,
        asset_id: &str,
        index: usize,
    ) -> Result<CanonicalMediaAsset, EditPlanError> {
        let asset = self.media_assets.get(asset_id).cloned().ok_or_else(|| {
            error(
                ErrorCode::UnknownReference,
                "unknown media asset",
                Some(index),
                Some("assetId"),
            )
        })?;
        if asset.role.as_deref().is_some_and(|role| role != "timeline") {
            return Err(error(
                ErrorCode::IncompatibleTrack,
                "only timeline media assets can be instantiated",
                Some(index),
                Some("assetId"),
            ));
        }
        Ok(asset)
    }
    fn add_track(&mut self, kind: &str, id: &str, index: usize) -> Result<(), EditPlanError> {
        self.insert_track(kind, id, false, index)
    }

    fn insert_track(
        &mut self,
        kind: &str,
        id: &str,
        highest: bool,
        index: usize,
    ) -> Result<(), EditPlanError> {
        validate_id(id, Some(index), "trackId")?;
        if self.snapshot.tracks.iter().any(|t| t.track_id == id) {
            return duplicate(index, id);
        }
        if !["video", "text", "audio", "graphic", "effect"].contains(&kind) {
            return invalid(index, "unknown track type");
        }
        let track = Track {
            track_id: id.into(),
            name: format!("{} track", capitalize_first(kind)),
            track_type: kind.into(),
            role: if kind == "audio" {
                "audio".into()
            } else {
                "overlay".into()
            },
            muted: matches!(kind, "video" | "audio").then_some(false),
            hidden: (kind != "audio").then_some(false),
            track_matte: None,
        };
        let insert_index = if kind == "audio" {
            if highest {
                self.snapshot
                    .tracks
                    .iter()
                    .position(|track| track.role == "audio")
                    .unwrap_or(self.snapshot.tracks.len())
            } else {
                self.snapshot.tracks.len()
            }
        } else if highest || kind == "effect" {
            0
        } else {
            self.snapshot
                .tracks
                .iter()
                .position(|track| matches!(track.role.as_str(), "main" | "audio"))
                .unwrap_or(self.snapshot.tracks.len())
        };
        self.snapshot.tracks.insert(insert_index, track);
        Ok(())
    }

    fn insert_with_placement(
        &mut self,
        element: Element,
        explicit_track_id: Option<&str>,
        auto_track_id: Option<&str>,
        allocations: &[ObjectIdAllocation],
        index: usize,
    ) -> Result<(), EditPlanError> {
        let track_id = if let Some(track_id) = explicit_track_id {
            if auto_track_id.is_some() || !allocations.is_empty() {
                return invalid(index, "explicit placement contains unused auto-track IDs");
            }
            track_id.to_owned()
        } else if let Some(track_id) = available_track_id(&self.snapshot, &element, index)? {
            if auto_track_id.is_some() || !allocations.is_empty() {
                return invalid(index, "existing placement contains unused auto-track IDs");
            }
            track_id
        } else {
            let auto_track_id = auto_track_id
                .ok_or_else(|| invalid_error(index, "missing resolved element auto-track ID"))?;
            if allocations.len() != 1
                || allocations[0].role != AllocationRole::ElementAutoTrack
                || allocations[0].source_id != element.element_id
                || allocations[0].resolved_id != auto_track_id
            {
                return invalid(index, "element auto-track allocation is inconsistent");
            }
            self.insert_track(
                track_type_for_element(&element.element_type),
                auto_track_id,
                true,
                index,
            )?;
            auto_track_id.to_owned()
        };
        self.insert_element(element, Some(&track_id), index)
    }
    fn insert_element(
        &mut self,
        mut element: Element,
        track: Option<&str>,
        index: usize,
    ) -> Result<(), EditPlanError> {
        let track_id = track
            .map(str::to_owned)
            .or_else(|| {
                self.snapshot
                    .tracks
                    .iter()
                    .find(|t| compatible(&t.track_type, &element.element_type))
                    .map(|t| t.track_id.clone())
            })
            .ok_or_else(|| {
                error(
                    ErrorCode::IncompatibleTrack,
                    "no compatible track",
                    Some(index),
                    Some("trackId"),
                )
            })?;
        let t = self
            .snapshot
            .tracks
            .iter()
            .find(|t| t.track_id == track_id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown track",
                    Some(index),
                    Some("trackId"),
                )
            })?;
        if !compatible(&t.track_type, &element.element_type) {
            return incompatible(index, "element and track types are incompatible");
        }
        if self
            .snapshot
            .elements
            .iter()
            .any(|e| e.element_id == element.element_id)
        {
            return duplicate(index, &element.element_id);
        }
        validate_interval(element.start_time, element.duration, Some(index))?;
        element.track_id = track_id;
        self.snapshot.elements.push(element);
        Ok(())
    }
    fn related_ids(&self, seed: &str, scope: RelationshipScope) -> BTreeSet<String> {
        let mut found = BTreeSet::from([seed.to_owned()]);
        let mut queue = VecDeque::from([seed.to_owned()]);
        while let Some(id) = queue.pop_front() {
            let Some(element) = self.snapshot.elements.iter().find(|e| e.element_id == id) else {
                continue;
            };
            for candidate in &self.snapshot.elements {
                let matches = match scope {
                    RelationshipScope::Element => false,
                    RelationshipScope::Group => {
                        element.group_id.is_some() && element.group_id == candidate.group_id
                    }
                    RelationshipScope::Link => {
                        element.link_id.is_some() && element.link_id == candidate.link_id
                    }
                    RelationshipScope::All => {
                        (element.group_id.is_some() && element.group_id == candidate.group_id)
                            || (element.link_id.is_some() && element.link_id == candidate.link_id)
                    }
                };
                if matches && found.insert(candidate.element_id.clone()) {
                    queue.push_back(candidate.element_id.clone());
                }
            }
        }
        found
    }
    fn delete_related(
        &mut self,
        track: &str,
        id: &str,
        use_ripple: bool,
        scope: RelationshipScope,
        index: usize,
        _ripple: &mut BTreeSet<Expansion>,
        relationships: &mut BTreeSet<Expansion>,
        warnings: &mut BTreeSet<Warning>,
    ) -> Result<(), EditPlanError> {
        self.require_element(track, id, Some(index))?;
        let ids = self.related_ids(id, scope);
        for affected in &ids {
            if affected != id {
                relationships.insert(Expansion {
                    operation_index: index,
                    cause_id: id.into(),
                    affected_id: affected.clone(),
                });
            }
        }
        let removed: Vec<_> = self
            .snapshot
            .elements
            .iter()
            .filter(|e| ids.contains(&e.element_id))
            .map(|e| e.element_id.clone())
            .collect();
        self.snapshot
            .elements
            .retain(|e| !ids.contains(&e.element_id));
        let before = self.snapshot.transitions.len();
        self.snapshot
            .transitions
            .retain(|t| !ids.contains(&t.from_element_id) && !ids.contains(&t.to_element_id));
        if before != self.snapshot.transitions.len() {
            warnings.insert(Warning {
                code: WarningCode::TransitionRemoved,
                operation_index: index,
                object_id: Some(id.into()),
                message: "dependent transition removed".into(),
            });
        }
        for removed_id in removed {
            if !use_ripple {
                warnings.insert(Warning {
                    code: WarningCode::TimelineGapPossible,
                    operation_index: index,
                    object_id: Some(removed_id),
                    message: "non-ripple delete may leave a gap".into(),
                });
            }
        }
        Ok(())
    }
    fn duplicate(
        &mut self,
        refs: &[ElementRef],
        ids: &[String],
        allocations: &[ObjectIdAllocation],
        scope: RelationshipScope,
        index: usize,
        relationships: &mut BTreeSet<Expansion>,
    ) -> Result<(), EditPlanError> {
        if refs.is_empty() || refs.len() != ids.len() {
            return invalid(index, "duplicate IDs must match elements");
        }
        let mut expanded = Vec::new();
        for reference in refs {
            self.require_element(&reference.track_id, &reference.element_id, Some(index))?;
            for id in self.related_ids(&reference.element_id, scope) {
                if !expanded.contains(&id) {
                    expanded.push(id);
                }
            }
        }
        if expanded.len() != ids.len() {
            return invalid(index, "duplicate IDs must cover relationship expansion");
        }
        let mapping: BTreeMap<_, _> = allocations
            .iter()
            .map(|allocation| {
                (
                    (allocation.role.as_str(), allocation.source_id.as_str()),
                    allocation.resolved_id.as_str(),
                )
            })
            .collect();
        let duplicate_element_ids: BTreeMap<_, _> =
            expanded.iter().cloned().zip(ids.iter().cloned()).collect();
        let source_tracks = self
            .snapshot
            .tracks
            .iter()
            .filter(|track| {
                expanded.iter().any(|id| {
                    self.snapshot.elements.iter().any(|element| {
                        element.element_id == *id && element.track_id == track.track_id
                    })
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        for source_track in source_tracks {
            let source_track_id = source_track.track_id.clone();
            let resolved_track_id = mapping
                .get(&("duplicate-track", source_track_id.as_str()))
                .ok_or_else(|| {
                    error(
                        ErrorCode::InvalidValue,
                        "missing resolved duplicate track ID",
                        Some(index),
                        Some("resolvedAllocations"),
                    )
                })?;
            self.insert_track(&source_track.track_type, resolved_track_id, true, index)?;
        }
        let mut copies = Vec::new();
        for (source, id) in expanded.iter().zip(ids) {
            validate_id(id, Some(index), "duplicateIds")?;
            if self.snapshot.elements.iter().any(|e| e.element_id == *id) {
                return duplicate(index, id);
            }
            let mut copy = self
                .snapshot
                .elements
                .iter()
                .find(|e| e.element_id == *source)
                .unwrap()
                .clone();
            copy.element_id = id.clone();
            copy.name = format!("{} (copy)", copy.name);
            copy.track_id = mapping
                .get(&("duplicate-track", copy.track_id.as_str()))
                .ok_or_else(|| {
                    error(
                        ErrorCode::InvalidValue,
                        "missing resolved duplicate track ID",
                        Some(index),
                        Some("resolvedAllocations"),
                    )
                })?
                .to_string();
            if let Some(group_id) = copy.group_id.as_mut()
                && let Some(resolved) = mapping.get(&("duplicate-group", group_id.as_str()))
            {
                *group_id = (*resolved).into();
            }
            if let Some(link_id) = copy.link_id.as_mut()
                && let Some(resolved) = mapping.get(&("duplicate-link", link_id.as_str()))
            {
                *link_id = (*resolved).into();
            }
            remap_owned_identities(&mut copy, allocations, "duplicate");
            copies.push(copy);
            relationships.insert(Expansion {
                operation_index: index,
                cause_id: source.clone(),
                affected_id: id.clone(),
            });
        }
        let transition_copies: Vec<_> = self
            .snapshot
            .transitions
            .iter()
            .filter(|transition| {
                duplicate_element_ids.contains_key(&transition.from_element_id)
                    && duplicate_element_ids.contains_key(&transition.to_element_id)
            })
            .map(|transition| {
                let transition_id = mapping
                    .get(&("duplicate-transition", transition.transition_id.as_str()))
                    .expect("duplicate transition allocation was resolved")
                    .to_string();
                Transition {
                    transition_id,
                    track_id: mapping
                        .get(&("duplicate-track", transition.track_id.as_str()))
                        .expect("duplicate track allocation was resolved")
                        .to_string(),
                    from_element_id: duplicate_element_ids[&transition.from_element_id].clone(),
                    to_element_id: duplicate_element_ids[&transition.to_element_id].clone(),
                    transition_type: transition.transition_type.clone(),
                    duration: transition.duration,
                }
            })
            .collect();
        self.snapshot.elements.extend(copies);
        self.snapshot.transitions.extend(transition_copies);
        Ok(())
    }
    fn set_relationship(
        &mut self,
        id: &str,
        refs: &[ElementRef],
        group: bool,
        index: usize,
    ) -> Result<(), EditPlanError> {
        validate_id(id, Some(index), if group { "groupId" } else { "linkId" })?;
        if refs.len() < 2 {
            return invalid(index, "relationship requires at least two elements");
        }
        for r in refs {
            let e = self.element_mut(&r.track_id, &r.element_id, index)?;
            if group {
                e.group_id = Some(id.into())
            } else {
                e.link_id = Some(id.into())
            }
        }
        Ok(())
    }
    fn clear_relationship(
        &mut self,
        id: &str,
        group: bool,
        index: usize,
    ) -> Result<(), EditPlanError> {
        let mut count = 0;
        for e in &mut self.snapshot.elements {
            let slot = if group {
                &mut e.group_id
            } else {
                &mut e.link_id
            };
            if slot.as_deref() == Some(id) {
                *slot = None;
                count += 1;
            }
        }
        if count == 0 {
            return unknown(index, "relationship");
        }
        Ok(())
    }
    fn move_related(
        &mut self,
        track: &str,
        target: &str,
        id: &str,
        start: MediaTime,
        scope: RelationshipScope,
        index: usize,
        exp: &mut BTreeSet<Expansion>,
    ) -> Result<(), EditPlanError> {
        nonnegative(start, Some(index), "startTime")?;
        self.require_element(track, id, Some(index))?;
        let target_type = self
            .snapshot
            .tracks
            .iter()
            .find(|t| t.track_id == target)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown target track",
                    Some(index),
                    Some("targetTrackId"),
                )
            })?
            .track_type
            .clone();
        let ids = self.related_ids(id, scope);
        let base = self
            .snapshot
            .elements
            .iter()
            .find(|e| e.element_id == id)
            .unwrap()
            .start_time;
        let delta = start
            .as_ticks()
            .checked_sub(base.as_ticks())
            .ok_or_else(|| {
                error(
                    ErrorCode::ArithmeticOverflow,
                    "move delta overflow",
                    Some(index),
                    None,
                )
            })?;
        for e in self
            .snapshot
            .elements
            .iter_mut()
            .filter(|e| ids.contains(&e.element_id))
        {
            let old_start = e.start_time;
            if e.element_id == id {
                if !compatible(&target_type, &e.element_type) {
                    return incompatible(index, "target track is incompatible");
                }
                e.track_id = target.into();
            }
            e.start_time = MediaTime::from_ticks(
                e.start_time.as_ticks().checked_add(delta).ok_or_else(|| {
                    error(
                        ErrorCode::ArithmeticOverflow,
                        "move overflow",
                        Some(index),
                        None,
                    )
                })?,
            );
            let element_delta = e.start_time.as_ticks() - old_start.as_ticks();
            shift_compound_members(e, element_delta, index)?;
            if e.element_id != id {
                exp.insert(Expansion {
                    operation_index: index,
                    cause_id: id.into(),
                    affected_id: e.element_id.clone(),
                });
            }
        }
        Ok(())
    }
    fn create_compound(
        &mut self,
        id: &str,
        name: Option<&str>,
        refs: &[ElementRef],
        scope: RelationshipScope,
        target: Option<&str>,
        auto_track_id: Option<&str>,
        empty_main_track_id: Option<&str>,
        index: usize,
        exp: &mut BTreeSet<Expansion>,
    ) -> Result<(), EditPlanError> {
        if refs.len() < 2 {
            return invalid(index, "compound requires two elements");
        }
        let mut ids = BTreeSet::new();
        for r in refs {
            self.require_element(&r.track_id, &r.element_id, Some(index))?;
            ids.extend(self.related_ids(&r.element_id, scope));
        }
        let members: Vec<_> = self
            .snapshot
            .elements
            .iter()
            .filter(|e| ids.contains(&e.element_id))
            .cloned()
            .collect();
        let member_track_ids: BTreeSet<_> = members
            .iter()
            .map(|element| element.track_id.clone())
            .collect();
        let member_tracks: Vec<_> = self
            .snapshot
            .tracks
            .iter()
            .filter(|track| member_track_ids.contains(&track.track_id))
            .cloned()
            .collect();
        let member_transitions: Vec<_> = self
            .snapshot
            .transitions
            .iter()
            .filter(|transition| {
                ids.contains(&transition.from_element_id) && ids.contains(&transition.to_element_id)
            })
            .cloned()
            .collect();
        let start = members.iter().map(|e| e.start_time).min().unwrap();
        let end = members
            .iter()
            .map(|e| add(e.start_time, e.duration, index))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap();
        let track = if let Some(target) = target {
            target.to_owned()
        } else {
            let id = auto_track_id.ok_or_else(|| {
                error(
                    ErrorCode::InvalidValue,
                    "missing resolved compound auto-track ID",
                    Some(index),
                    Some("autoTrackId"),
                )
            })?;
            self.add_track("video", id, index)?;
            id.to_owned()
        };
        self.snapshot
            .elements
            .retain(|e| !ids.contains(&e.element_id));
        self.snapshot
            .transitions
            .retain(|t| !ids.contains(&t.from_element_id) && !ids.contains(&t.to_element_id));
        let mut compound = new_element(
            id,
            "compound",
            name.map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("Compound clip"),
            start,
            sub(end, start, index)?,
        );
        compound.source_duration = Some(compound.duration);
        compound.compound_members = members;
        compound.compound_tracks = member_tracks;
        compound.compound_transitions = member_transitions;
        compound.compound_empty_main_track_id = empty_main_track_id.map(str::to_owned);
        for member in &ids {
            exp.insert(Expansion {
                operation_index: index,
                cause_id: id.into(),
                affected_id: member.clone(),
            });
        }
        self.insert_element(compound, Some(&track), index)
    }
    fn break_compound(
        &mut self,
        track: &str,
        id: &str,
        restored_ids: &[String],
        allocations: &[ObjectIdAllocation],
        index: usize,
    ) -> Result<(), EditPlanError> {
        let position = self
            .snapshot
            .elements
            .iter()
            .position(|e| e.track_id == track && e.element_id == id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown compound",
                    Some(index),
                    None,
                )
            })?;
        let compound = self.snapshot.elements.remove(position);
        if compound.element_type != "compound" || compound.compound_members.is_empty() {
            return incompatible(index, "element is not a compound");
        }
        if restored_ids.len() != compound.compound_members.len()
            || allocations.len() != restored_ids.len()
        {
            return invalid(index, "restored element ID allocation is incomplete");
        }
        let mut id_mapping = BTreeMap::new();
        for ((member, restored_id), allocation) in compound
            .compound_members
            .iter()
            .zip(restored_ids)
            .zip(allocations)
        {
            if allocation.role != AllocationRole::BreakApartElement
                || allocation.source_id != member.element_id
                || allocation.resolved_id != *restored_id
            {
                return invalid(index, "restored element ID allocation is inconsistent");
            }
            id_mapping.insert(member.element_id.clone(), restored_id.clone());
        }
        for source_track in &compound.compound_tracks {
            if let Some(existing) = self
                .snapshot
                .tracks
                .iter()
                .find(|candidate| candidate.track_id == source_track.track_id)
            {
                if existing.track_type != source_track.track_type {
                    return incompatible(index, "compound track type changed while nested");
                }
            } else {
                let mut restored_track = source_track.clone();
                restored_track.role = if restored_track.track_type == "audio" {
                    "audio".into()
                } else {
                    "overlay".into()
                };
                self.snapshot.tracks.push(restored_track);
            }
        }
        let mut restored_members = compound.compound_members;
        for member in &mut restored_members {
            member.element_id = id_mapping[&member.element_id].clone();
        }
        let mut restored_transitions = compound.compound_transitions;
        for transition in &mut restored_transitions {
            if let Some(resolved) = id_mapping.get(&transition.from_element_id) {
                transition.from_element_id = resolved.clone();
            }
            if let Some(resolved) = id_mapping.get(&transition.to_element_id) {
                transition.to_element_id = resolved.clone();
            }
        }
        self.snapshot.transitions.retain(|transition| {
            transition.from_element_id != id && transition.to_element_id != id
        });
        self.snapshot.elements.extend(restored_members);
        self.snapshot.transitions.extend(restored_transitions);
        Ok(())
    }
    fn separate_audio(
        &mut self,
        track: &str,
        id: &str,
        audio_track: &str,
        audio_id: &str,
        link: &str,
        allocations: &[ObjectIdAllocation],
        index: usize,
    ) -> Result<(), EditPlanError> {
        let source = self
            .snapshot
            .elements
            .iter()
            .find(|e| e.track_id == track && e.element_id == id)
            .cloned()
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown source",
                    Some(index),
                    None,
                )
            })?;
        if source.element_type != "video" {
            return incompatible(index, "source audio separation requires video");
        }
        if !self
            .snapshot
            .tracks
            .iter()
            .any(|t| t.track_id == audio_track)
        {
            self.insert_track("audio", audio_track, true, index)?;
        }
        let original = self.element_mut(track, id, index)?;
        original.source_audio_separated = Some(true);
        original.link_id = Some(link.into());
        let mut audio = source;
        audio.element_id = audio_id.into();
        audio.element_type = "audio".into();
        audio.group_id = None;
        audio.link_id = Some(link.into());
        audio.source_audio_separated = None;
        audio.reframe = None;
        audio.effects.clear();
        audio.masks.clear();
        audio.matte_enabled = None;
        audio
            .params
            .retain(|key, _| matches!(key.as_str(), "volume" | "muted"));
        audio
            .params
            .entry("volume".into())
            .or_insert(Scalar::Number(0.0));
        audio
            .params
            .entry("muted".into())
            .or_insert(Scalar::Boolean(false));
        audio.canonical_params = canonical::source_audio_params(&audio.canonical_params);
        audio
            .keyframes
            .retain(|keyframe| matches!(keyframe.property_path.as_str(), "volume" | "ducking"));
        if allocations.len() != audio.keyframes.len() {
            return invalid(index, "source audio keyframe allocation is incomplete");
        }
        for (keyframe, allocation) in audio.keyframes.iter_mut().zip(allocations) {
            if allocation.role != AllocationRole::Keyframe
                || allocation.source_id != keyframe.keyframe_id
            {
                return invalid(index, "source audio keyframe allocation is inconsistent");
            }
            keyframe.keyframe_id = allocation.resolved_id.clone();
        }
        audio.canonical_source = canonical::separated_audio_source(&audio);
        self.insert_element(audio, Some(audio_track), index)
    }
    fn reorder_effects(
        &mut self,
        track: &str,
        id: &str,
        ids: &[String],
        index: usize,
    ) -> Result<(), EditPlanError> {
        let element = self.element_mut(track, id, index)?;
        if !matches!(
            element.element_type.as_str(),
            "video" | "image" | "text" | "sticker" | "graphic"
        ) {
            return incompatible(index, "clip effects require a visual timeline element");
        }
        let existing: BTreeSet<_> = element
            .effects
            .iter()
            .map(|e| e.effect_id.clone())
            .collect();
        let requested: BTreeSet<_> = ids.iter().cloned().collect();
        if existing != requested || requested.len() != ids.len() {
            return invalid(index, "effectIds must contain every effect exactly once");
        }
        let mut map: BTreeMap<_, _> = element
            .effects
            .drain(..)
            .map(|e| (e.effect_id.clone(), e))
            .collect();
        element.effects = ids.iter().map(|id| map.remove(id).unwrap()).collect();
        Ok(())
    }
    fn upsert_keyframe(
        &mut self,
        track: &str,
        id: &str,
        path: &str,
        time: MediaTime,
        value: &Scalar,
        interpolation: Option<&str>,
        key_id: &str,
        index: usize,
    ) -> Result<(), EditPlanError> {
        nonnegative(time, Some(index), "time")?;
        if path.trim().is_empty() {
            return invalid(index, "propertyPath is empty");
        }
        let element = self.element_mut(track, id, index)?;
        let value = coerce_animation_value(element, path, value, index)?;
        if time > element.duration {
            return bounds(index, "time");
        }
        if !matches!(value, Scalar::Number(_)) && interpolation.is_some_and(|value| value != "hold")
        {
            return invalid(index, "discrete keyframes only support hold interpolation");
        }
        let interpolation = interpolation.unwrap_or(if matches!(value, Scalar::Number(_)) {
            "linear"
        } else {
            "hold"
        });
        if let Some(key) = element
            .keyframes
            .iter_mut()
            .find(|k| k.keyframe_id == key_id)
        {
            key.property_path = path.into();
            key.time = time;
            key.value = value.clone();
            key.interpolation = interpolation.into();
        } else {
            element.keyframes.push(Keyframe {
                keyframe_id: key_id.into(),
                property_path: path.into(),
                time,
                value: value.clone(),
                interpolation: interpolation.into(),
                left_handle: None,
                right_handle: None,
                tangent_mode: matches!(value, Scalar::Number(_)).then(|| "flat".into()),
            });
        }
        Ok(())
    }
    fn keyframe_mut(
        &mut self,
        track: &str,
        id: &str,
        path: &str,
        key: &str,
        index: usize,
    ) -> Result<&mut Keyframe, EditPlanError> {
        self.element_mut(track, id, index)?
            .keyframes
            .iter_mut()
            .find(|k| k.keyframe_id == key && k.property_path == path)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown keyframe",
                    Some(index),
                    Some("keyframeId"),
                )
            })
    }
    fn remove_keyframe(
        &mut self,
        track: &str,
        id: &str,
        path: &str,
        key: &str,
        index: usize,
    ) -> Result<(), EditPlanError> {
        let e = self.element_mut(track, id, index)?;
        let old = e.keyframes.len();
        e.keyframes
            .retain(|k| !(k.keyframe_id == key && k.property_path == path));
        if old == e.keyframes.len() {
            return unknown(index, "keyframe");
        }
        Ok(())
    }
    fn upsert_transition(
        &mut self,
        track: &str,
        id: &str,
        from: &str,
        to: &str,
        kind: &str,
        duration: MediaTime,
        index: usize,
    ) -> Result<(), EditPlanError> {
        self.require_element(track, from, Some(index))?;
        self.require_element(track, to, Some(index))?;
        let track_state = self
            .snapshot
            .tracks
            .iter()
            .find(|candidate| candidate.track_id == track)
            .ok_or_else(|| unknown_error(index, "track"))?;
        let from_element = self
            .snapshot
            .elements
            .iter()
            .find(|element| element.track_id == track && element.element_id == from)
            .expect("validated transition source");
        let to_element = self
            .snapshot
            .elements
            .iter()
            .find(|element| element.track_id == track && element.element_id == to)
            .expect("validated transition destination");
        let existing_incoming = self
            .snapshot
            .transitions
            .iter()
            .find(|transition| transition.track_id == track && transition.to_element_id == to)
            .map(|transition| transition.transition_id.as_str());
        validate_transition_request(&transition_evaluation_options(
            id,
            kind,
            &track_state.track_type,
            from_element,
            to_element,
            duration,
            existing_incoming,
        ))
        .map_err(|failure| map_transition_error(failure, index))?;
        if let Some(t) = self
            .snapshot
            .transitions
            .iter_mut()
            .find(|t| t.transition_id == id)
        {
            t.track_id = track.into();
            t.from_element_id = from.into();
            t.to_element_id = to.into();
            t.transition_type = kind.into();
            t.duration = duration;
        } else {
            self.snapshot.transitions.push(Transition {
                transition_id: id.into(),
                track_id: track.into(),
                from_element_id: from.into(),
                to_element_id: to.into(),
                transition_type: kind.into(),
                duration,
            });
        }
        Ok(())
    }
    fn trim(
        &mut self,
        track: &str,
        id: &str,
        start: Option<MediaTime>,
        duration: Option<MediaTime>,
        trim_start: MediaTime,
        trim_end: MediaTime,
        _use_ripple: bool,
        resolved_allocations: &[ObjectIdAllocation],
        index: usize,
        _ripple: &mut BTreeSet<Expansion>,
    ) -> Result<(), EditPlanError> {
        if let Some(start) = start {
            nonnegative(start, Some(index), "startTime")?;
        }
        if let Some(duration) = duration {
            positive(duration, Some(index), "duration")?;
        }
        nonnegative(trim_start, Some(index), "trimStart")?;
        nonnegative(trim_end, Some(index), "trimEnd")?;
        let effective_start = start.map(|requested| {
            let is_main = self
                .snapshot
                .tracks
                .iter()
                .any(|candidate| candidate.track_id == track && candidate.role == "main");
            if !is_main {
                return requested;
            }
            let earliest_other = self
                .snapshot
                .elements
                .iter()
                .filter(|candidate| candidate.track_id == track && candidate.element_id != id)
                .map(|candidate| candidate.start_time)
                .min();
            if earliest_other.is_none_or(|earliest| requested <= earliest) {
                MediaTime::ZERO
            } else {
                requested
            }
        });
        {
            let e = self.element_mut(track, id, index)?;
            let source_duration = element_source_duration(e, index)?;
            let remaining_source_ticks = source_duration
                .as_ticks()
                .checked_sub(trim_start.as_ticks())
                .and_then(|value| value.checked_sub(trim_end.as_ticks()))
                .ok_or_else(|| {
                    error(
                        ErrorCode::ArithmeticOverflow,
                        "trim source span overflow",
                        Some(index),
                        None,
                    )
                })?;
            if remaining_source_ticks <= 0 {
                return invalid(
                    index,
                    "trimStart and trimEnd must leave a visible source span",
                );
            }
            let derived_duration = timeline_duration_for_source_span(
                MediaTime::from_ticks(remaining_source_ticks),
                e,
                index,
            )?;
            if duration.is_some_and(|duration| duration != derived_duration) {
                return invalid(
                    index,
                    &format!(
                        "duration must be {} ticks for the requested source trims",
                        derived_duration.as_ticks()
                    ),
                );
            }
            let old_origin = e
                .start_time
                .as_ticks()
                .checked_sub(e.trim_start.as_ticks())
                .ok_or_else(|| {
                    error(
                        ErrorCode::ArithmeticOverflow,
                        "compound time origin overflow",
                        Some(index),
                        None,
                    )
                })?;
            if let Some(v) = effective_start {
                e.start_time = v;
            }
            e.duration = derived_duration;
            clamp_keyframes_to_duration(e, derived_duration, resolved_allocations, index)?;
            if matches!(e.element_type.as_str(), "video" | "audio") && e.source_duration.is_none() {
                e.source_duration = Some(source_duration);
            }
            e.trim_start = trim_start;
            e.trim_end = trim_end;
            let new_origin = e
                .start_time
                .as_ticks()
                .checked_sub(e.trim_start.as_ticks())
                .ok_or_else(|| {
                    error(
                        ErrorCode::ArithmeticOverflow,
                        "compound time origin overflow",
                        Some(index),
                        None,
                    )
                })?;
            shift_compound_members(e, new_origin - old_origin, index)?;
        }
        Ok(())
    }
    fn split(
        &mut self,
        track: &str,
        id: &str,
        at: MediaTime,
        right_id: Option<&str>,
        retain: &str,
        _ripple: bool,
        allocations: &[ObjectIdAllocation],
        index: usize,
        _exp: &mut BTreeSet<Expansion>,
    ) -> Result<(), EditPlanError> {
        let source = self
            .snapshot
            .elements
            .iter()
            .find(|e| e.track_id == track && e.element_id == id)
            .cloned()
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "unknown split element",
                    Some(index),
                    None,
                )
            })?;
        let end = add(source.start_time, source.duration, index)?;
        if at <= source.start_time || at >= end {
            return bounds(index, "splitTime");
        }
        if !["both", "left", "right"].contains(&retain) {
            return invalid(index, "invalid retainSide");
        }
        let left_duration = sub(at, source.start_time, index)?;
        let right_duration = sub(end, at, index)?;
        let left_source_span = source_span_at_clip_time(left_duration, &source, index)?;
        let total_source_span = source_span_at_clip_time(source.duration, &source, index)?;
        let right_source_span = sub(total_source_span, left_source_span, index)?;
        let (left_keyframes, right_keyframes) =
            split_keyframes(&source, left_duration, allocations, index)?;
        let pos = self
            .snapshot
            .elements
            .iter()
            .position(|e| e.element_id == id)
            .unwrap();
        self.snapshot.elements.remove(pos);
        let mut split_elements = Vec::with_capacity(2);
        if retain != "right" {
            let mut left = source.clone();
            left.name = format!("{} (left)", left.name);
            left.duration = left_duration;
            left.trim_end = add(left.trim_end, right_source_span, index)?;
            left.keyframes = left_keyframes;
            split_elements.push(left);
        }
        if retain != "left" {
            let mut right = source;
            right.name = format!("{} (right)", right.name);
            right.element_id = right_id
                .ok_or_else(|| {
                    error(
                        ErrorCode::InvalidValue,
                        "missing resolved right-side element ID",
                        Some(index),
                        Some("rightElementId"),
                    )
                })?
                .into();
            remap_owned_identities(&mut right, allocations, "split");
            right.start_time = at;
            right.duration = right_duration;
            right.trim_start = add(right.trim_start, left_source_span, index)?;
            right.keyframes = right_keyframes;
            split_elements.push(right);
        }
        self.snapshot.elements.splice(pos..pos, split_elements);

        if retain == "left" {
            self.snapshot
                .transitions
                .retain(|transition| transition.from_element_id != id);
        } else {
            let right_id = right_id.expect("right-side ID was validated before insertion");
            if retain == "right" {
                self.snapshot
                    .transitions
                    .retain(|transition| transition.to_element_id != id);
            }
            for transition in &mut self.snapshot.transitions {
                if transition.from_element_id == id {
                    transition.from_element_id = right_id.into();
                }
            }
        }
        Ok(())
    }
}

fn transition_evaluation_options(
    transition_id: &str,
    transition_type: &str,
    track_type: &str,
    from_element: &Element,
    to_element: &Element,
    duration: MediaTime,
    existing_incoming_transition_id: Option<&str>,
) -> EvaluateTransitionOptions {
    EvaluateTransitionOptions {
        transition_id: transition_id.to_owned(),
        transition_type: transition_type.to_owned(),
        track_type: track_type.to_owned(),
        from_element: transition_boundary(from_element),
        to_element: transition_boundary(to_element),
        duration: duration.as_ticks(),
        existing_incoming_transition_id: existing_incoming_transition_id.map(str::to_owned),
    }
}

fn transition_boundary(element: &Element) -> TransitionBoundaryElement {
    TransitionBoundaryElement {
        id: element.element_id.clone(),
        element_type: element.element_type.clone(),
        start_time: element.start_time.as_ticks(),
        duration: element.duration.as_ticks(),
        has_masks: !element.masks.is_empty(),
    }
}

fn map_transition_error(failure: TransitionValidationError, index: usize) -> EditPlanError {
    let code = match failure.kind {
        TransitionValidationKind::Invalid => ErrorCode::InvalidValue,
        TransitionValidationKind::Incompatible => ErrorCode::IncompatibleTrack,
        TransitionValidationKind::Bounds => ErrorCode::Bounds,
    };
    error(code, failure.reason, Some(index), Some(&failure.path))
}

fn validate_catalog_state(
    tracks: &[Track],
    elements: &[Element],
    transitions: &[Transition],
    operation_index: Option<usize>,
) -> Result<(), EditPlanError> {
    for element in elements {
        for effect in &element.effects {
            if let Err(mut effect_error) = validate_effect_attachment(
                &element.element_type,
                &effect.effect_type,
                &effect.params,
                operation_index.unwrap_or(0),
            ) {
                effect_error.operation_index = operation_index;
                return Err(effect_error);
            }
        }
        validate_catalog_state(
            &element.compound_tracks,
            &element.compound_members,
            &element.compound_transitions,
            operation_index,
        )?;
    }
    for transition in transitions {
        let track = tracks
            .iter()
            .find(|track| track.track_id == transition.track_id)
            .ok_or_else(|| {
                error(
                    ErrorCode::UnknownReference,
                    "transition references an unknown track",
                    operation_index,
                    Some("transition.trackId"),
                )
            })?;
        let endpoint = |element_id: &str| {
            elements
                .iter()
                .find(|element| {
                    element.track_id == transition.track_id && element.element_id == element_id
                })
                .ok_or_else(|| {
                    error(
                        ErrorCode::UnknownReference,
                        "transition references an unknown element",
                        operation_index,
                        Some("transition.elementId"),
                    )
                })
        };
        let from_element = endpoint(&transition.from_element_id)?;
        let to_element = endpoint(&transition.to_element_id)?;
        if transitions
            .iter()
            .filter(|candidate| {
                candidate.track_id == transition.track_id
                    && candidate.to_element_id == transition.to_element_id
            })
            .count()
            > 1
        {
            return Err(error(
                ErrorCode::InvalidValue,
                "incoming element has more than one transition",
                operation_index,
                Some("transition.toElementId"),
            ));
        }
        if let Err(transition_error) = validate_stored_transition(&transition_evaluation_options(
            &transition.transition_id,
            &transition.transition_type,
            &track.track_type,
            from_element,
            to_element,
            transition.duration,
            Some(&transition.transition_id),
        )) {
            let mut mapped = map_transition_error(transition_error, 0);
            mapped.operation_index = operation_index;
            if mapped.path.as_deref() == Some("transitionType") {
                mapped.path = Some("transition.type".to_owned());
            }
            return Err(mapped);
        }
    }
    Ok(())
}

fn animation_storage_keys(element: &Element) -> Vec<String> {
    let mut keys = match element
        .canonical_source
        .as_ref()
        .map(|source| &source.common().animations)
    {
        Some(CanonicalValue::Object(animations)) => animations
            .keys()
            .filter(|key| !matches!(key.as_str(), "bindings" | "channels"))
            .cloned()
            .collect::<Vec<_>>(),
        _ => element
            .keyframes
            .iter()
            .map(|keyframe| keyframe.property_path.clone())
            .collect(),
    };
    keys.sort();
    keys.dedup();
    keys
}

fn validate_split_boundary_allocations(
    allocations: &[ObjectIdAllocation],
    property_paths: &[String],
    split_time: MediaTime,
    index: usize,
) -> Result<(), EditPlanError> {
    if split_time <= MediaTime::ZERO {
        return bounds(index, "splitTime");
    }
    for property_path in property_paths {
        for role in [
            AllocationRole::SplitLeftBoundaryKeyframe,
            AllocationRole::SplitRightBoundaryKeyframe,
        ] {
            let count = allocations
                .iter()
                .filter(|allocation| {
                    allocation.role == role && allocation.source_id == *property_path
                })
                .count();
            if count != 1 {
                return invalid(index, "split boundary keyframe allocation is incomplete");
            }
        }
    }
    Ok(())
}

fn clamp_keyframes_to_duration(
    element: &mut Element,
    duration: MediaTime,
    allocations: &[ObjectIdAllocation],
    index: usize,
) -> Result<(), EditPlanError> {
    let property_paths = animation_storage_keys(element);
    if allocations.len() != property_paths.len() * 2 {
        return invalid(index, "duration-clamp allocation set is incomplete");
    }
    let mut split_allocations = Vec::with_capacity(allocations.len());
    for property_path in &property_paths {
        for (source_role, split_role) in [
            (
                AllocationRole::DurationClampLeftBoundaryKeyframe,
                AllocationRole::SplitLeftBoundaryKeyframe,
            ),
            (
                AllocationRole::DurationClampRightBoundaryKeyframe,
                AllocationRole::SplitRightBoundaryKeyframe,
            ),
        ] {
            let matches: Vec<_> = allocations
                .iter()
                .filter(|allocation| {
                    allocation.role == source_role && allocation.source_id == *property_path
                })
                .collect();
            if matches.len() != 1 {
                return invalid(index, "duration-clamp allocation set is inconsistent");
            }
            split_allocations.push(ObjectIdAllocation {
                role: split_role,
                source_id: property_path.clone(),
                resolved_id: matches[0].resolved_id.clone(),
            });
        }
    }
    let (left, _) = split_keyframes(element, duration, &split_allocations, index)?;
    element.keyframes = left;
    Ok(())
}

fn split_keyframes(
    source: &Element,
    split_time: MediaTime,
    allocations: &[ObjectIdAllocation],
    index: usize,
) -> Result<(Vec<Keyframe>, Vec<Keyframe>), EditPlanError> {
    let property_paths = animation_storage_keys(source);
    validate_split_boundary_allocations(allocations, &property_paths, split_time, index)?;
    let boundaries = property_paths
        .iter()
        .map(|property_path| {
            let left = allocations
                .iter()
                .find(|allocation| {
                    allocation.role == AllocationRole::SplitLeftBoundaryKeyframe
                        && allocation.source_id == *property_path
                })
                .expect("validated left split boundary allocation")
                .resolved_id
                .clone();
            let right = allocations
                .iter()
                .find(|allocation| {
                    allocation.role == AllocationRole::SplitRightBoundaryKeyframe
                        && allocation.source_id == *property_path
                })
                .expect("validated right split boundary allocation")
                .resolved_id
                .clone();
            (property_path.clone(), (left, right))
        })
        .collect::<BTreeMap<_, _>>();
    let mut grouped = BTreeMap::<String, Vec<Keyframe>>::new();
    for keyframe in &source.keyframes {
        grouped
            .entry(keyframe.property_path.clone())
            .or_default()
            .push(keyframe.clone());
    }
    let mut left_output = Vec::new();
    let mut right_output = Vec::new();
    for (leaf_path, mut keys) in grouped {
        keys.sort_by_key(|keyframe| (keyframe.time, keyframe.keyframe_id.clone()));
        let storage_path = property_paths
            .iter()
            .filter(|candidate| {
                leaf_path.as_str() == candidate.as_str()
                    || leaf_path.starts_with(&format!("{candidate}."))
            })
            .max_by_key(|candidate| candidate.len())
            .cloned()
            .unwrap_or_else(|| leaf_path.clone());
        let (left_boundary_id, right_boundary_id) = boundaries
            .get(&storage_path)
            .ok_or_else(|| invalid_error(index, "split animation storage key is inconsistent"))?;
        let mut left_keys: Vec<_> = keys
            .iter()
            .filter(|keyframe| keyframe.time <= split_time)
            .cloned()
            .collect();
        let mut right_keys: Vec<_> = keys
            .iter()
            .filter(|keyframe| keyframe.time >= split_time)
            .cloned()
            .map(|mut keyframe| {
                keyframe.time =
                    MediaTime::from_ticks(keyframe.time.as_ticks() - split_time.as_ticks());
                keyframe
            })
            .collect();
        let has_boundary = keys.iter().any(|keyframe| keyframe.time == split_time);
        if !has_boundary && !keys.is_empty() {
            if keys
                .iter()
                .all(|keyframe| matches!(keyframe.value, Scalar::Number(_)))
            {
                if let Some((left_key, right_key)) = keys
                    .windows(2)
                    .find(|pair| pair[0].time < split_time && split_time < pair[1].time)
                    .map(|pair| (&pair[0], &pair[1]))
                {
                    let value = scalar_value_at_split(left_key, right_key, split_time, index)?;
                    let bezier = bezier_split_at_time(left_key, right_key, split_time, index)?;
                    if let Some(bezier) = &bezier {
                        let retained_left = left_keys
                            .iter_mut()
                            .find(|keyframe| keyframe.keyframe_id == left_key.keyframe_id)
                            .expect("left scalar key was retained");
                        retained_left.right_handle = Some(bezier.left_right_handle);
                        let retained_right = right_keys
                            .iter_mut()
                            .find(|keyframe| keyframe.keyframe_id == right_key.keyframe_id)
                            .expect("right scalar key was retained");
                        retained_right.left_handle = Some(bezier.right_left_handle);
                    }
                    left_keys.push(Keyframe {
                        keyframe_id: left_boundary_id.clone(),
                        property_path: leaf_path.clone(),
                        time: split_time,
                        value: Scalar::Number(value),
                        interpolation: if bezier.is_some() {
                            left_key.interpolation.clone()
                        } else {
                            "linear".into()
                        },
                        left_handle: bezier.as_ref().map(|split| split.boundary_left_handle),
                        right_handle: None,
                        tangent_mode: Some(
                            bezier
                                .as_ref()
                                .and_then(|_| left_key.tangent_mode.clone())
                                .unwrap_or_else(|| "flat".into()),
                        ),
                    });
                    right_keys.insert(
                        0,
                        Keyframe {
                            keyframe_id: right_boundary_id.clone(),
                            property_path: leaf_path.clone(),
                            time: MediaTime::ZERO,
                            value: Scalar::Number(value),
                            interpolation: left_key.interpolation.clone(),
                            left_handle: None,
                            right_handle: bezier.as_ref().map(|split| split.boundary_right_handle),
                            tangent_mode: Some(
                                bezier
                                    .as_ref()
                                    .and_then(|_| left_key.tangent_mode.clone())
                                    .unwrap_or_else(|| "flat".into()),
                            ),
                        },
                    );
                }
            } else if keys
                .iter()
                .all(|keyframe| !matches!(keyframe.value, Scalar::Number(_)))
            {
                let boundary_value = discrete_value_at_split(&keys, split_time).clone();
                left_keys.push(Keyframe {
                    keyframe_id: left_boundary_id.clone(),
                    property_path: leaf_path.clone(),
                    time: split_time,
                    value: boundary_value.clone(),
                    interpolation: "hold".into(),
                    left_handle: None,
                    right_handle: None,
                    tangent_mode: None,
                });
                right_keys.insert(
                    0,
                    Keyframe {
                        keyframe_id: right_boundary_id.clone(),
                        property_path: leaf_path.clone(),
                        time: MediaTime::ZERO,
                        value: boundary_value,
                        interpolation: "hold".into(),
                        left_handle: None,
                        right_handle: None,
                        tangent_mode: None,
                    },
                );
            } else {
                return Err(invalid_error(
                    index,
                    "animation channel mixes scalar and discrete values",
                ));
            }
        }
        left_output.extend(left_keys);
        right_output.extend(right_keys);
    }
    Ok((left_output, right_output))
}

fn scalar_value_at_split(
    left: &Keyframe,
    right: &Keyframe,
    split_time: MediaTime,
    index: usize,
) -> Result<f64, EditPlanError> {
    let Scalar::Number(left_value) = &left.value else {
        return Err(invalid_error(
            index,
            "scalar animation has a non-numeric keyframe",
        ));
    };
    let Scalar::Number(right_value) = &right.value else {
        return Err(invalid_error(
            index,
            "scalar animation has a non-numeric keyframe",
        ));
    };
    if left.interpolation == "hold" {
        return Ok(*left_value);
    }
    let span = right.time.as_ticks() - left.time.as_ticks();
    if span <= 0 {
        return Err(invalid_error(
            index,
            "animation keyframes must have distinct ordered times",
        ));
    }
    if let Some(bezier) = bezier_split_at_time(left, right, split_time, index)? {
        return Ok(bezier.value);
    }
    let progress = (split_time.as_ticks() - left.time.as_ticks()) as f64 / span as f64;
    Ok(left_value + (right_value - left_value) * progress)
}

#[derive(Clone, Copy)]
struct BezierSplit {
    value: f64,
    left_right_handle: KeyframeHandle,
    boundary_left_handle: KeyframeHandle,
    boundary_right_handle: KeyframeHandle,
    right_left_handle: KeyframeHandle,
}

fn bezier_split_at_time(
    left: &Keyframe,
    right: &Keyframe,
    split_time: MediaTime,
    index: usize,
) -> Result<Option<BezierSplit>, EditPlanError> {
    if left.interpolation != "bezier" {
        return Ok(None);
    }
    let Scalar::Number(left_value) = &left.value else {
        return Err(invalid_error(
            index,
            "bezier animation requires numeric values",
        ));
    };
    let Scalar::Number(right_value) = &right.value else {
        return Err(invalid_error(
            index,
            "bezier animation requires numeric values",
        ));
    };
    let span = right.time.as_ticks() - left.time.as_ticks();
    if span <= 0 {
        return Err(invalid_error(
            index,
            "bezier keyframes must have distinct ordered times",
        ));
    }
    let value_delta = right_value - left_value;
    let (right_dt, right_dv) = left
        .right_handle
        .map(|handle| (handle.dt.as_ticks() as f64, handle.dv))
        .unwrap_or((span as f64 / 3.0, value_delta / 3.0));
    let (left_dt, left_dv) = right
        .left_handle
        .map(|handle| (handle.dt.as_ticks() as f64, handle.dv))
        .unwrap_or((-(span as f64) / 3.0, -value_delta / 3.0));
    let p0 = (left.time.as_ticks() as f64, *left_value);
    let p1 = (p0.0 + right_dt, p0.1 + right_dv);
    let p3 = (right.time.as_ticks() as f64, *right_value);
    let p2 = (p3.0 + left_dt, p3.1 + left_dv);
    let mut lower = 0.0;
    let mut upper = 1.0;
    for _ in 0..20 {
        let mid = (lower + upper) / 2.0;
        if cubic_point(mid, p0.0, p1.0, p2.0, p3.0) < split_time.as_ticks() as f64 {
            lower = mid;
        } else {
            upper = mid;
        }
    }
    let progress = (lower + upper) / 2.0;
    let q0 = lerp_pair(p0, p1, progress);
    let q1 = lerp_pair(p1, p2, progress);
    let q2 = lerp_pair(p2, p3, progress);
    let r0 = lerp_pair(q0, q1, progress);
    let r1 = lerp_pair(q1, q2, progress);
    let point = lerp_pair(r0, r1, progress);
    Ok(Some(BezierSplit {
        value: point.1,
        left_right_handle: KeyframeHandle {
            dt: MediaTime::from_ticks(js_round(q0.0 - p0.0)),
            dv: q0.1 - p0.1,
        },
        boundary_left_handle: KeyframeHandle {
            dt: MediaTime::from_ticks(js_round(r0.0 - point.0)),
            dv: r0.1 - point.1,
        },
        boundary_right_handle: KeyframeHandle {
            dt: MediaTime::from_ticks(js_round(r1.0 - point.0)),
            dv: r1.1 - point.1,
        },
        right_left_handle: KeyframeHandle {
            dt: MediaTime::from_ticks(js_round(q2.0 - p3.0)),
            dv: q2.1 - p3.1,
        },
    }))
}

fn cubic_point(progress: f64, p0: f64, p1: f64, p2: f64, p3: f64) -> f64 {
    let inverse = 1.0 - progress;
    inverse.powi(3) * p0
        + 3.0 * inverse.powi(2) * progress * p1
        + 3.0 * inverse * progress.powi(2) * p2
        + progress.powi(3) * p3
}

fn lerp_pair(left: (f64, f64), right: (f64, f64), progress: f64) -> (f64, f64) {
    (
        left.0 + (right.0 - left.0) * progress,
        left.1 + (right.1 - left.1) * progress,
    )
}

fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn discrete_value_at_split(keys: &[Keyframe], split_time: MediaTime) -> &Scalar {
    keys.iter()
        .rev()
        .find(|keyframe| keyframe.time <= split_time)
        .or_else(|| keys.first())
        .map(|keyframe| &keyframe.value)
        .expect("non-empty discrete channel")
}

fn invalid_error(index: usize, message: &str) -> EditPlanError {
    error(ErrorCode::InvalidValue, message, Some(index), None)
}

fn collect_owned_identity_sources(
    element: &Element,
    prefix: &str,
    identities: &mut Vec<(String, String)>,
) {
    collect_owned_identity_sources_inner(element, prefix, identities, false);
}

fn collect_owned_identity_sources_inner(
    element: &Element,
    prefix: &str,
    identities: &mut Vec<(String, String)>,
    nested: bool,
) {
    if let Some(group_id) = &element.group_id {
        identities.push((format!("{prefix}-group"), group_id.clone()));
    }
    if let Some(link_id) = &element.link_id {
        identities.push((format!("{prefix}-link"), link_id.clone()));
    }
    for effect in &element.effects {
        identities.push((format!("{prefix}-effect"), effect.effect_id.clone()));
    }
    for mask in &element.masks {
        identities.push((format!("{prefix}-mask"), mask.mask_id.clone()));
    }
    for keyframe in &element.keyframes {
        identities.push((
            if nested {
                format!("{prefix}-nested-keyframe")
            } else {
                format!("{prefix}-keyframe")
            },
            keyframe.keyframe_id.clone(),
        ));
    }
    for track in &element.compound_tracks {
        identities.push((format!("{prefix}-nested-track"), track.track_id.clone()));
    }
    for transition in &element.compound_transitions {
        identities.push((
            format!("{prefix}-nested-transition"),
            transition.transition_id.clone(),
        ));
    }
    for child in &element.compound_members {
        identities.push((format!("{prefix}-nested-element"), child.element_id.clone()));
        collect_owned_identity_sources_inner(child, prefix, identities, true);
    }
}

fn remap_owned_identities(element: &mut Element, allocations: &[ObjectIdAllocation], prefix: &str) {
    let mapping: BTreeMap<(String, String), String> = allocations
        .iter()
        .map(|allocation| {
            (
                (
                    allocation.role.as_str().to_owned(),
                    allocation.source_id.clone(),
                ),
                allocation.resolved_id.clone(),
            )
        })
        .collect();
    remap_owned_identities_with(element, &mapping, prefix, false);
}

fn remap_owned_identities_with(
    element: &mut Element,
    mapping: &BTreeMap<(String, String), String>,
    prefix: &str,
    nested: bool,
) {
    remap_optional_identity(&mut element.group_id, mapping, &format!("{prefix}-group"));
    remap_optional_identity(&mut element.link_id, mapping, &format!("{prefix}-link"));
    for effect in &mut element.effects {
        remap_identity(&mut effect.effect_id, mapping, &format!("{prefix}-effect"));
    }
    for mask in &mut element.masks {
        remap_identity(&mut mask.mask_id, mapping, &format!("{prefix}-mask"));
    }
    for keyframe in &mut element.keyframes {
        let role = if nested {
            format!("{prefix}-nested-keyframe")
        } else {
            format!("{prefix}-keyframe")
        };
        remap_identity(&mut keyframe.keyframe_id, mapping, &role);
    }
    for track in &mut element.compound_tracks {
        remap_identity(
            &mut track.track_id,
            mapping,
            &format!("{prefix}-nested-track"),
        );
    }
    for transition in &mut element.compound_transitions {
        remap_identity(
            &mut transition.transition_id,
            mapping,
            &format!("{prefix}-nested-transition"),
        );
        remap_identity(
            &mut transition.track_id,
            mapping,
            &format!("{prefix}-nested-track"),
        );
        remap_identity(
            &mut transition.from_element_id,
            mapping,
            &format!("{prefix}-nested-element"),
        );
        remap_identity(
            &mut transition.to_element_id,
            mapping,
            &format!("{prefix}-nested-element"),
        );
    }
    for child in &mut element.compound_members {
        remap_identity(
            &mut child.element_id,
            mapping,
            &format!("{prefix}-nested-element"),
        );
        remap_identity(
            &mut child.track_id,
            mapping,
            &format!("{prefix}-nested-track"),
        );
        remap_owned_identities_with(child, mapping, prefix, true);
    }
}

fn remap_identity(value: &mut String, mapping: &BTreeMap<(String, String), String>, role: &str) {
    if let Some(resolved) = mapping.get(&(role.to_owned(), value.clone())) {
        *value = resolved.clone();
    }
}

fn remap_optional_identity(
    value: &mut Option<String>,
    mapping: &BTreeMap<(String, String), String>,
    role: &str,
) {
    if let Some(value) = value {
        remap_identity(value, mapping, role);
    }
}

fn shift_compound_members(
    element: &mut Element,
    delta: i64,
    index: usize,
) -> Result<(), EditPlanError> {
    if delta == 0 || element.element_type != "compound" {
        return Ok(());
    }
    for member in &mut element.compound_members {
        member.start_time =
            MediaTime::from_ticks(member.start_time.as_ticks().checked_add(delta).ok_or_else(
                || {
                    error(
                        ErrorCode::ArithmeticOverflow,
                        "compound member move overflow",
                        Some(index),
                        None,
                    )
                },
            )?);
        if member.start_time < MediaTime::ZERO {
            return bounds(index, "compound member startTime");
        }
        shift_compound_members(member, delta, index)?;
    }
    Ok(())
}

fn fade_keyframe_points(duration: MediaTime, target: f64, fade: &Fade) -> Vec<(MediaTime, f64)> {
    let mut points = BTreeMap::new();
    if fade.in_duration > MediaTime::ZERO {
        points.insert(MediaTime::ZERO, fade.floor_db);
        points.insert(fade.in_duration, target);
    }
    if fade.out_duration > MediaTime::ZERO {
        points.insert(
            MediaTime::from_ticks(duration.as_ticks() - fade.out_duration.as_ticks()),
            target,
        );
        points.insert(duration, fade.floor_db);
    }
    points.into_iter().collect()
}

fn ducking_keyframe_points(
    element: &Element,
    regions: &[Region],
    reduction_db: f64,
    attack: MediaTime,
    release: MediaTime,
    index: usize,
) -> Result<Vec<(MediaTime, f64)>, EditPlanError> {
    if !reduction_db.is_finite() || reduction_db <= 0.0 || reduction_db > 60.0 {
        invalid(
            index,
            "reductionDb must be greater than zero and at most 60",
        )?;
    }
    nonnegative(attack, Some(index), "attackDuration")?;
    nonnegative(release, Some(index), "releaseDuration")?;
    let element_end = add(element.start_time, element.duration, index)?;
    let mut local_regions = Vec::<(i64, i64)>::new();
    for region in regions {
        validate_interval(region.start_time, region.duration, Some(index))?;
        let region_end = add(region.start_time, region.duration, index)?;
        let start = region.start_time.max(element.start_time);
        let end = region_end.min(element_end);
        if end > start {
            local_regions.push((
                start.as_ticks() - element.start_time.as_ticks(),
                end.as_ticks() - element.start_time.as_ticks(),
            ));
        }
    }
    if regions.is_empty() {
        return Ok(vec![]);
    }
    if local_regions.is_empty() {
        invalid(
            index,
            "audio ducking regions do not overlap the target element",
        )?;
    }
    local_regions.sort_unstable();
    let join_distance = attack
        .as_ticks()
        .checked_add(release.as_ticks())
        .ok_or_else(|| {
            error(
                ErrorCode::ArithmeticOverflow,
                "ducking join distance overflow",
                Some(index),
                None,
            )
        })?;
    let mut merged = Vec::<(i64, i64)>::new();
    for (start, end) in local_regions {
        if let Some(last) = merged.last_mut()
            && start <= last.1.saturating_add(join_distance)
        {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    let mut points = BTreeMap::from([(0, 0.0), (element.duration.as_ticks(), 0.0)]);
    for (start, end) in merged {
        let effective_attack = attack.as_ticks().max(1);
        let effective_release = release.as_ticks().max(1);
        let attack_start = 0.max(start - effective_attack);
        let release_end = element.duration.as_ticks().min(end + effective_release);
        set_lowest(
            &mut points,
            attack_start,
            if attack_start == start {
                -reduction_db
            } else {
                0.0
            },
        );
        set_lowest(&mut points, start, -reduction_db);
        set_lowest(&mut points, end, -reduction_db);
        set_lowest(
            &mut points,
            release_end,
            if release_end == end {
                -reduction_db
            } else {
                0.0
            },
        );
    }
    Ok(points
        .into_iter()
        .map(|(time, value)| (MediaTime::from_ticks(time), value))
        .collect())
}

fn set_lowest(points: &mut BTreeMap<i64, f64>, time: i64, value: f64) {
    points
        .entry(time)
        .and_modify(|current| *current = current.min(value))
        .or_insert(value);
}

fn replace_generated_keyframes(
    element: &mut Element,
    property_path: &str,
    points: &[(MediaTime, f64)],
    allocations: &[ObjectIdAllocation],
    index: usize,
) -> Result<(), EditPlanError> {
    if points.len() != allocations.len() {
        return invalid(index, "generated keyframe allocation is incomplete");
    }
    element
        .keyframes
        .retain(|keyframe| keyframe.property_path != property_path);
    for ((time, value), allocation) in points.iter().zip(allocations) {
        let source_id = format!("{property_path}:{}", time.as_ticks());
        if allocation.role != AllocationRole::Keyframe || allocation.source_id != source_id {
            return invalid(index, "generated keyframe allocation is inconsistent");
        }
        element.keyframes.push(Keyframe {
            keyframe_id: allocation.resolved_id.clone(),
            property_path: property_path.into(),
            time: *time,
            value: Scalar::Number(*value),
            interpolation: "linear".into(),
            left_handle: None,
            right_handle: None,
            tangent_mode: Some("flat".into()),
        });
    }
    Ok(())
}

/// A caption's text: the evaluator's text field, else its content param.
/// The caption's speaker label, or empty when it has none.
fn caption_speaker(element: &Element) -> &str {
    match element.params.0.get("caption.speaker") {
        Some(Scalar::String(value)) => value.as_str(),
        _ => "",
    }
}

fn caption_text(element: &Element) -> String {
    element
        .text
        .clone()
        .unwrap_or_else(|| match element.params.0.get("content") {
            Some(Scalar::String(value)) => value.clone(),
            _ => String::new(),
        })
}

fn new_element(id: &str, kind: &str, name: &str, start: MediaTime, duration: MediaTime) -> Element {
    Element {
        element_id: id.into(),
        track_id: String::new(),
        element_type: kind.into(),
        name: name.into(),
        definition_id: None,
        sticker_id: None,
        effect_type: None,
        start_time: start,
        duration,
        trim_start: MediaTime::ZERO,
        trim_end: MediaTime::ZERO,
        source_duration: None,
        text: if kind == "text" {
            Some(name.into())
        } else {
            None
        },
        params: Params::new(),
        canonical_params: CanonicalValue::Object(BTreeMap::new()),
        canonical_source: None,
        reframe: None,
        volume_db: if audio_capable_type(kind) {
            Some(0.0)
        } else {
            None
        },
        muted: None,
        fade: None,
        retime_rate: None,
        maintain_pitch: None,
        effects: vec![],
        keyframes: vec![],
        masks: vec![],
        key: None,
        matte_enabled: None,
        audio_replacement_enabled: None,
        source_audio_separated: None,
        ducking: vec![],
        group_id: None,
        link_id: None,
        compound_tracks: vec![],
        compound_transitions: vec![],
        compound_members: vec![],
        compound_empty_main_track_id: None,
    }
}

fn capitalize_first(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

fn default_text_params(content: &str) -> Params {
    [
        ("content", Scalar::String(content.into())),
        ("fontSize", Scalar::Number(15.0)),
        ("fontFamily", Scalar::String("Arial".into())),
        ("color", Scalar::String("#ffffff".into())),
        ("textAlign", Scalar::String("center".into())),
        ("fontWeight", Scalar::String("normal".into())),
        ("fontStyle", Scalar::String("normal".into())),
        ("textDecoration", Scalar::String("none".into())),
        ("letterSpacing", Scalar::Number(0.0)),
        ("lineHeight", Scalar::Number(1.2)),
        ("background.enabled", Scalar::Boolean(false)),
        ("background.color", Scalar::String("#000000".into())),
        ("background.perLine", Scalar::Boolean(false)),
        ("background.cornerRadius", Scalar::Number(0.0)),
        ("background.paddingX", Scalar::Number(30.0)),
        ("background.paddingY", Scalar::Number(42.0)),
        ("background.offsetX", Scalar::Number(0.0)),
        ("background.offsetY", Scalar::Number(0.0)),
        ("highlight.enabled", Scalar::Boolean(false)),
        ("highlight.color", Scalar::String("#ffd400".into())),
        ("outline.enabled", Scalar::Boolean(false)),
        ("outline.color", Scalar::String("#000000".into())),
        ("outline.width", Scalar::Number(0.08)),
        ("shadow.enabled", Scalar::Boolean(false)),
        ("shadow.color", Scalar::String("#000000".into())),
        ("shadow.offsetX", Scalar::Number(0.04)),
        ("shadow.offsetY", Scalar::Number(0.04)),
        ("shadow.blur", Scalar::Number(0.08)),
        ("caption.speaker", Scalar::String(String::new())),
        ("transform.positionX", Scalar::Number(0.0)),
        ("transform.positionY", Scalar::Number(0.0)),
        ("transform.scaleX", Scalar::Number(1.0)),
        ("transform.scaleY", Scalar::Number(1.0)),
        ("transform.rotate", Scalar::Number(0.0)),
        ("opacity", Scalar::Number(1.0)),
        ("blendMode", Scalar::String("normal".into())),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn default_visual_params() -> Params {
    [
        ("transform.positionX", Scalar::Number(0.0)),
        ("transform.positionY", Scalar::Number(0.0)),
        ("transform.scaleX", Scalar::Number(1.0)),
        ("transform.scaleY", Scalar::Number(1.0)),
        ("transform.rotate", Scalar::Number(0.0)),
        ("opacity", Scalar::Number(1.0)),
        ("blendMode", Scalar::String("normal".into())),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn visual_params(
    element_type: &str,
    definition_id: Option<&str>,
    requested: Option<&Params>,
    index: usize,
) -> Result<Params, EditPlanError> {
    let mut params = default_visual_params();
    if element_type == "graphic" {
        let definition_id =
            definition_id.ok_or_else(|| invalid_error(index, "graphic definition is required"))?;
        params.extend(graphic_defaults(definition_id, index)?);
    }
    for (key, value) in requested.into_iter().flatten() {
        params.insert(
            key.clone(),
            coerce_element_param(element_type, definition_id, key, value, index)?,
        );
    }
    Ok(params)
}

fn graphic_defaults(definition_id: &str, index: usize) -> Result<Params, EditPlanError> {
    let mut values = Params::from_iter([
        ("fill".into(), Scalar::String("#ffffff".into())),
        ("stroke".into(), Scalar::String("#000000".into())),
        ("strokeWidth".into(), Scalar::Number(0.0)),
        ("strokeAlign".into(), Scalar::String("center".into())),
    ]);
    match definition_id {
        "rectangle" => {
            values.insert("cornerRadius".into(), Scalar::Number(0.0));
        }
        "ellipse" => {}
        "polygon" => {
            values.insert("sides".into(), Scalar::Number(5.0));
            values.insert("cornerRadius".into(), Scalar::Number(0.0));
        }
        "star" => {
            values.insert("points".into(), Scalar::Number(5.0));
            values.insert("depth".into(), Scalar::Number(45.0));
        }
        _ => return Err(invalid_error(index, "unknown graphic definition")),
    }
    Ok(values)
}

fn shape_sticker(
    sticker_id: &str,
) -> Option<(&'static str, &'static str, Option<(&'static str, f64)>)> {
    let value = sticker_id.split_once(':')?.1;
    match value {
        "square" | "rectangle" => Some(("rectangle", "Rectangle", None)),
        "circle" | "ellipse" => Some(("ellipse", "Ellipse", None)),
        "triangle" => Some(("polygon", "Triangle", Some(("sides", 3.0)))),
        "hexagon" => Some(("polygon", "Hexagon", Some(("sides", 6.0)))),
        "diamond" => Some(("polygon", "Diamond", Some(("sides", 4.0)))),
        "polygon" => Some(("polygon", "Polygon", None)),
        "star" => Some(("star", "Star", None)),
        _ => None,
    }
}

fn shape_graphic_params(
    sticker_id: &str,
    requested: Option<&Params>,
    index: usize,
) -> Result<Params, EditPlanError> {
    let (definition_id, _, preset) =
        shape_sticker(sticker_id).ok_or_else(|| invalid_error(index, "unknown shape sticker"))?;
    let mut params = visual_params("graphic", Some(definition_id), None, index)?;
    if let Some((key, value)) = preset {
        params.insert(key.into(), Scalar::Number(value));
    }
    for (key, value) in requested.into_iter().flatten() {
        params.insert(
            key.clone(),
            coerce_element_param("graphic", Some(definition_id), key, value, index)?,
        );
    }
    Ok(params)
}

fn validate_sticker_id(sticker_id: &str, index: usize) -> Result<(), EditPlanError> {
    let Some((provider, value)) = sticker_id.trim().split_once(':') else {
        return invalid(index, "invalid sticker ID format");
    };
    if value.is_empty() || !matches!(provider, "logos" | "flags" | "shapes") {
        return invalid(index, "unknown sticker provider or empty value");
    }
    Ok(())
}

fn sticker_default_name(sticker_id: &str) -> String {
    sticker_id
        .rsplit(':')
        .next()
        .unwrap_or(sticker_id)
        .replace('-', " ")
}

fn effect_params(
    effect_type: &str,
    element_type: &str,
    existing: Option<&Params>,
    requested: Option<&Params>,
    index: usize,
) -> Result<Params, EditPlanError> {
    if media_treatment_definition(effect_type).is_some() {
        return treatment_params(effect_type, element_type, existing, requested, index);
    }
    let mut params = if let Some(existing) = existing {
        existing.clone()
    } else {
        match effect_type {
            "blur" => Params::from_iter([("intensity".into(), Scalar::Number(15.0))]),
            "color-grade" => Params::from_iter(
                [
                    "temperature",
                    "tint",
                    "saturation",
                    "exposure",
                    "contrast",
                    "highlights",
                    "shadows",
                    "fade",
                ]
                .into_iter()
                .map(|key| (key.into(), Scalar::Number(0.0))),
            ),
            _ => {
                return Err(error(
                    ErrorCode::InvalidValue,
                    "unknown effect type",
                    Some(index),
                    Some("effectType"),
                ));
            }
        }
    };
    for (key, value) in requested.into_iter().flatten() {
        let value = match effect_type {
            "blur" if key == "intensity" => {
                coerce_number(value, 0.0, Some(100.0), 1.0, index, key)?
            }
            "color-grade"
                if matches!(
                    key.as_str(),
                    "temperature"
                        | "tint"
                        | "saturation"
                        | "exposure"
                        | "contrast"
                        | "highlights"
                        | "shadows"
                        | "fade"
                ) =>
            {
                coerce_number(value, -100.0, Some(100.0), 1.0, index, key)?
            }
            _ => {
                return Err(invalid_error(
                    index,
                    &format!("effect {effect_type} has no parameter {key}"),
                ));
            }
        };
        params.insert(key.clone(), value);
    }
    Ok(params)
}

fn validate_effect_attachment(
    element_type: &str,
    effect_type: &str,
    params: &Params,
    index: usize,
) -> Result<(), EditPlanError> {
    if media_treatment_definition(effect_type).is_none() {
        if effect_type.starts_with("simple-media.") {
            return Err(error(
                ErrorCode::InvalidValue,
                format!("unknown treatment ID: {effect_type}"),
                Some(index),
                Some("effectType"),
            ));
        }
        return Ok(());
    }
    effect_params(effect_type, element_type, None, Some(params), index).map(|_| ())
}

fn treatment_params(
    treatment_id: &str,
    element_type: &str,
    existing: Option<&Params>,
    requested: Option<&Params>,
    index: usize,
) -> Result<Params, EditPlanError> {
    resolve_treatment_parameters(treatment_id, element_type, existing, requested)
        .map_err(|failure| treatment_error(failure, index))
}

fn treatment_error(failure: TreatmentValidationError, index: usize) -> EditPlanError {
    let code = match failure.kind {
        TreatmentValidationKind::Inapplicable => ErrorCode::IncompatibleTrack,
        TreatmentValidationKind::Bounds => ErrorCode::Bounds,
        TreatmentValidationKind::UnknownId
        | TreatmentValidationKind::UnknownParameter
        | TreatmentValidationKind::InvalidType => ErrorCode::InvalidValue,
    };
    error(code, failure.reason, Some(index), Some(&failure.path))
}

fn coerce_element_param(
    element_type: &str,
    definition_id: Option<&str>,
    key: &str,
    value: &Scalar,
    index: usize,
) -> Result<Scalar, EditPlanError> {
    match key {
        "transform.positionX" | "transform.positionY"
            if matches!(
                element_type,
                "video" | "image" | "text" | "sticker" | "graphic"
            ) =>
        {
            coerce_number(value, -100_000.0, None, 1.0, index, key)
        }
        "transform.scaleX" | "transform.scaleY"
            if matches!(
                element_type,
                "video" | "image" | "text" | "sticker" | "graphic"
            ) =>
        {
            coerce_number(value, 0.01, None, 0.01, index, key)
        }
        "transform.rotate"
            if matches!(
                element_type,
                "video" | "image" | "text" | "sticker" | "graphic"
            ) =>
        {
            coerce_number(value, -360.0, Some(360.0), 1.0, index, key)
        }
        "opacity"
            if matches!(
                element_type,
                "video" | "image" | "text" | "sticker" | "graphic"
            ) =>
        {
            coerce_number(value, 0.0, Some(1.0), 0.01, index, key)
        }
        "blendMode"
            if matches!(
                element_type,
                "video" | "image" | "text" | "sticker" | "graphic"
            ) =>
        {
            coerce_select(
                value,
                &[
                    "normal",
                    "darken",
                    "multiply",
                    "color-burn",
                    "lighten",
                    "screen",
                    "plus-lighter",
                    "color-dodge",
                    "overlay",
                    "soft-light",
                    "hard-light",
                    "difference",
                    "exclusion",
                    "hue",
                    "saturation",
                    "color",
                    "luminosity",
                ],
                index,
                key,
            )
        }
        "volume" if matches!(element_type, "video" | "audio") => {
            coerce_number(value, -60.0, Some(20.0), 0.01, index, key)
        }
        "muted" if matches!(element_type, "video" | "audio") => coerce_boolean(value, index, key),
        "reframe.mode" if matches!(element_type, "video" | "image") => {
            coerce_select(value, &["contain", "cover", "stretch"], index, key)
        }
        "reframe.cropX" | "reframe.cropY" | "reframe.focalX" | "reframe.focalY"
        | "reframe.targetX" | "reframe.targetY"
            if matches!(element_type, "video" | "image") =>
        {
            coerce_number(value, 0.0, Some(0.999), 0.01, index, key)
        }
        "reframe.cropWidth"
        | "reframe.cropHeight"
        | "reframe.targetWidth"
        | "reframe.targetHeight"
            if matches!(element_type, "video" | "image") =>
        {
            coerce_number(value, 0.001, Some(1.0), 0.01, index, key)
        }
        "content" | "fontFamily" | "color" | "background.color" if element_type == "text" => {
            coerce_string(value, index, key)
        }
        "fontSize" if element_type == "text" => coerce_number(value, 1.0, None, 1.0, index, key),
        "textAlign" if element_type == "text" => {
            coerce_select(value, &["left", "center", "right"], index, key)
        }
        "fontWeight" if element_type == "text" => {
            coerce_select(value, &["normal", "bold"], index, key)
        }
        "fontStyle" if element_type == "text" => {
            coerce_select(value, &["normal", "italic"], index, key)
        }
        "textDecoration" if element_type == "text" => {
            coerce_select(value, &["none", "underline", "line-through"], index, key)
        }
        "letterSpacing" if element_type == "text" => {
            coerce_number(value, -100.0, None, 0.1, index, key)
        }
        "lineHeight" if element_type == "text" => coerce_number(value, 0.1, None, 0.1, index, key),
        "background.enabled" | "background.perLine" | "highlight.enabled"
            if element_type == "text" =>
        {
            coerce_boolean(value, index, key)
        }
        "highlight.color" | "caption.speaker" | "outline.color" | "shadow.color"
            if element_type == "text" =>
        {
            coerce_string(value, index, key)
        }
        "outline.enabled" | "shadow.enabled" if element_type == "text" => {
            coerce_boolean(value, index, key)
        }
        "outline.width" if element_type == "text" => coerce_number(
            value,
            0.0,
            Some(crate::model::TEXT_OUTLINE_MAX_WIDTH),
            0.01,
            index,
            key,
        ),
        "shadow.blur" if element_type == "text" => coerce_number(
            value,
            0.0,
            Some(crate::model::TEXT_SHADOW_MAX_BLUR),
            0.01,
            index,
            key,
        ),
        "shadow.offsetX" | "shadow.offsetY" if element_type == "text" => coerce_number(
            value,
            -crate::model::TEXT_SHADOW_MAX_OFFSET,
            Some(crate::model::TEXT_SHADOW_MAX_OFFSET),
            0.01,
            index,
            key,
        ),
        "background.cornerRadius" if element_type == "text" => {
            coerce_number(value, 0.0, Some(100.0), 1.0, index, key)
        }
        "background.paddingX" | "background.paddingY" if element_type == "text" => {
            coerce_number(value, 0.0, None, 1.0, index, key)
        }
        "background.offsetX" | "background.offsetY" if element_type == "text" => {
            coerce_number(value, -100_000.0, None, 1.0, index, key)
        }
        "fill" | "stroke" if element_type == "graphic" => coerce_string(value, index, key),
        "strokeWidth" if element_type == "graphic" => {
            coerce_number(value, 0.0, Some(64.0), 1.0, index, key)
        }
        "strokeAlign" if element_type == "graphic" => {
            coerce_select(value, &["inside", "center", "outside"], index, key)
        }
        "cornerRadius"
            if element_type == "graphic"
                && matches!(definition_id, Some("rectangle" | "polygon")) =>
        {
            coerce_number(value, 0.0, Some(50.0), 1.0, index, key)
        }
        "sides" if element_type == "graphic" && definition_id == Some("polygon") => {
            coerce_number(value, 3.0, Some(12.0), 1.0, index, key)
        }
        "points" if element_type == "graphic" && definition_id == Some("star") => {
            coerce_number(value, 3.0, Some(12.0), 1.0, index, key)
        }
        "depth" if element_type == "graphic" && definition_id == Some("star") => {
            coerce_number(value, 1.0, Some(99.0), 1.0, index, key)
        }
        _ => Err(invalid_error(
            index,
            &format!("parameter {key} is not supported for {element_type} elements"),
        )),
    }
}

fn coerce_number(
    value: &Scalar,
    min: f64,
    max: Option<f64>,
    step: f64,
    index: usize,
    path: &str,
) -> Result<Scalar, EditPlanError> {
    let Scalar::Number(value) = value else {
        return Err(invalid_error(
            index,
            &format!("invalid value for parameter {path}"),
        ));
    };
    if !value.is_finite() {
        return Err(invalid_error(
            index,
            &format!("invalid value for parameter {path}"),
        ));
    }
    let snapped = (js_round(*value / step) as f64) * step;
    let snapped = if step == 0.01 {
        (snapped * 100.0).round() / 100.0
    } else if step == 0.1 {
        (snapped * 10.0).round() / 10.0
    } else {
        snapped
    };
    Ok(Scalar::Number(
        snapped.max(min).min(max.unwrap_or(f64::INFINITY)),
    ))
}

fn coerce_boolean(value: &Scalar, index: usize, path: &str) -> Result<Scalar, EditPlanError> {
    matches!(value, Scalar::Boolean(_))
        .then(|| value.clone())
        .ok_or_else(|| invalid_error(index, &format!("invalid value for parameter {path}")))
}

fn coerce_string(value: &Scalar, index: usize, path: &str) -> Result<Scalar, EditPlanError> {
    matches!(value, Scalar::String(_))
        .then(|| value.clone())
        .ok_or_else(|| invalid_error(index, &format!("invalid value for parameter {path}")))
}

fn coerce_select(
    value: &Scalar,
    options: &[&str],
    index: usize,
    path: &str,
) -> Result<Scalar, EditPlanError> {
    let Scalar::String(value) = value else {
        return Err(invalid_error(
            index,
            &format!("invalid value for parameter {path}"),
        ));
    };
    if options.contains(&value.as_str()) {
        Ok(Scalar::String(value.clone()))
    } else {
        Err(invalid_error(
            index,
            &format!("invalid value for parameter {path}"),
        ))
    }
}

fn sync_element_control_params(element: &mut Element) {
    if let Some(Scalar::String(content)) = element.params.get("content") {
        element.text = Some(content.clone());
    }
    if let Some(Scalar::Number(volume)) = element.params.get("volume") {
        element.volume_db = Some(*volume);
    }
    if let Some(Scalar::Boolean(muted)) = element.params.get("muted") {
        element.muted = Some(*muted);
    }
    if !matches!(element.element_type.as_str(), "video" | "image")
        || !element.params.keys().any(|key| key.starts_with("reframe."))
    {
        return;
    }
    let number = |key: &str, fallback: f64| match element.params.get(key) {
        Some(Scalar::Number(value)) => *value,
        _ => fallback,
    };
    let mode = match element.params.get("reframe.mode") {
        Some(Scalar::String(value)) => value.clone(),
        _ => "contain".into(),
    };
    element.reframe = Some(Reframe {
        mode: Some(mode),
        crop: Some(Rect {
            x: number("reframe.cropX", 0.0),
            y: number("reframe.cropY", 0.0),
            width: number("reframe.cropWidth", 1.0),
            height: number("reframe.cropHeight", 1.0),
        }),
        focal_point: Some(Point {
            x: number("reframe.focalX", 0.5),
            y: number("reframe.focalY", 0.5),
        }),
        target_rect: Some(Rect {
            x: number("reframe.targetX", 0.0),
            y: number("reframe.targetY", 0.0),
            width: number("reframe.targetWidth", 1.0),
            height: number("reframe.targetHeight", 1.0),
        }),
        layout: None,
    });
}

fn coerce_animation_value(
    element: &Element,
    property_path: &str,
    value: &Scalar,
    index: usize,
) -> Result<Scalar, EditPlanError> {
    if matches!(
        property_path,
        "blendMode"
            | "content"
            | "fontFamily"
            | "textAlign"
            | "fontWeight"
            | "fontStyle"
            | "textDecoration"
            | "background.enabled"
            | "outline.enabled"
            | "shadow.enabled"
            | "muted"
            | "reframe.mode"
    ) {
        return Err(invalid_error(
            index,
            &format!(
                "property {property_path} cannot be keyframed on {} elements",
                element.element_type
            ),
        ));
    }
    if let Some(param_key) = property_path.strip_prefix("params.") {
        if element.element_type != "graphic" {
            return Err(invalid_error(
                index,
                "graphic parameter path requires a graphic element",
            ));
        }
        return coerce_element_param(
            "graphic",
            element.definition_id.as_deref(),
            param_key,
            value,
            index,
        );
    }
    if let Some(rest) = property_path.strip_prefix("effects.")
        && let Some((effect_id, param_key)) = rest.split_once(".params.")
        && !effect_id.is_empty()
        && !param_key.is_empty()
    {
        let effect = element
            .effects
            .iter()
            .find(|effect| effect.effect_id == effect_id)
            .ok_or_else(|| {
                invalid_error(index, "effect parameter path references an unknown effect")
            })?;
        let requested = Params::from_iter([(param_key.into(), value.clone())]);
        return effect_params(
            &effect.effect_type,
            &element.element_type,
            Some(&effect.params),
            Some(&requested),
            index,
        )?
        .remove(param_key)
        .ok_or_else(|| invalid_error(index, "effect parameter could not be resolved"));
    }
    coerce_element_param(&element.element_type, None, property_path, value, index)
}

fn compatible(track: &str, element: &str) -> bool {
    track == track_type_for_element(element)
}

fn available_track_id(
    snapshot: &ActiveSceneSnapshot,
    element: &Element,
    index: usize,
) -> Result<Option<String>, EditPlanError> {
    let end = add(element.start_time, element.duration, index)?;
    for track in &snapshot.tracks {
        if track.track_type != track_type_for_element(&element.element_type) {
            continue;
        }
        let available = snapshot
            .elements
            .iter()
            .filter(|candidate| candidate.track_id == track.track_id)
            .try_fold(true, |available, candidate| {
                let candidate_end = add(candidate.start_time, candidate.duration, index)?;
                Ok::<_, EditPlanError>(
                    available
                        && (end <= candidate.start_time || element.start_time >= candidate_end),
                )
            })?;
        if available {
            return Ok(Some(track.track_id.clone()));
        }
    }
    Ok(None)
}

impl State {
    fn is_audible_timeline_element(&self, element: &Element) -> bool {
        if !audio_capable(element)
            || element.duration <= MediaTime::ZERO
            || element.muted == Some(true)
        {
            return false;
        }
        let Some(track) = self
            .snapshot
            .tracks
            .iter()
            .find(|track| track.track_id == element.track_id)
        else {
            return false;
        };
        if track.muted == Some(true) {
            return false;
        }
        let Some(source) = element.canonical_source.as_ref() else {
            return false;
        };
        match source {
            CanonicalElement::Audio {
                source_type,
                media_id,
                audio_replacement,
                ..
            } => {
                if replacement_asset_resolves(
                    &self.media_assets,
                    audio_replacement.as_deref(),
                    element.audio_replacement_enabled,
                ) {
                    return true;
                }
                media_id
                    .as_ref()
                    .is_some_and(|id| self.media_assets.contains_key(id))
                    || source_type == "library"
            }
            CanonicalElement::Video {
                media_id,
                audio_replacement,
                ..
            } => {
                let Some(source_asset) = self.media_assets.get(media_id) else {
                    return false;
                };
                if source_asset.has_audio == Some(false)
                    || element.source_audio_separated == Some(true)
                {
                    return false;
                }
                replacement_asset_resolves(
                    &self.media_assets,
                    audio_replacement.as_deref(),
                    element.audio_replacement_enabled,
                ) || self.media_assets.contains_key(media_id)
            }
            _ => false,
        }
    }
}

fn replacement_asset_resolves(
    media_assets: &BTreeMap<String, CanonicalMediaAsset>,
    attachment: Option<&CanonicalAttachment>,
    enabled: Option<bool>,
) -> bool {
    if enabled != Some(true) {
        return false;
    }
    attachment
        .and_then(|attachment| media_assets.get(&attachment.asset_id))
        .is_some_and(|asset| asset.asset_type == "audio")
}

fn media_reference_counts(project: &ProjectSnapshot) -> BTreeMap<String, usize> {
    let mut references = BTreeMap::new();
    for scene in &project.project.scenes {
        count_track_media_references(&scene.tracks, &mut references);
    }
    references
}

fn project_object_ids(project: &ProjectSnapshot) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    ids.extend(project.media_assets.iter().map(|asset| asset.id.clone()));
    for scene in &project.project.scenes {
        ids.insert(scene.id.clone());
        ids.extend(
            scene
                .bookmarks
                .iter()
                .filter_map(|bookmark| bookmark.id.clone()),
        );
        collect_track_object_ids(&scene.tracks, &mut ids);
    }
    ids
}

fn collect_track_object_ids(tracks: &[CanonicalTrack], ids: &mut BTreeSet<String>) {
    for track in tracks {
        ids.insert(track.id.clone());
        ids.extend(
            track
                .transitions
                .iter()
                .map(|transition| transition.id.clone()),
        );
        for element in &track.elements {
            let common = element.common();
            ids.insert(common.id.clone());
            ids.extend(common.group_id.iter().cloned());
            ids.extend(common.link_id.iter().cloned());
            collect_animation_ids(&common.animations, ids);
            match element {
                CanonicalElement::Video { effects, masks, .. }
                | CanonicalElement::Image { effects, masks, .. }
                | CanonicalElement::Graphic { effects, masks, .. } => {
                    ids.extend(effects.iter().map(|effect| effect.id.clone()));
                    ids.extend(masks.iter().map(|mask| mask.id.clone()));
                }
                CanonicalElement::Text { effects, .. }
                | CanonicalElement::Sticker { effects, .. } => {
                    ids.extend(effects.iter().map(|effect| effect.id.clone()));
                }
                CanonicalElement::Compound { tracks, .. } => {
                    collect_track_object_ids(tracks, ids);
                }
                CanonicalElement::Audio { .. } | CanonicalElement::Effect { .. } => {}
            }
        }
    }
}

fn collect_animation_ids(value: &CanonicalValue, ids: &mut BTreeSet<String>) {
    match value {
        CanonicalValue::Array(values) => {
            for value in values {
                collect_animation_ids(value, ids);
            }
        }
        CanonicalValue::Object(values) => {
            if let Some(CanonicalValue::String(id)) = values.get("id") {
                ids.insert(id.clone());
            }
            for value in values.values() {
                collect_animation_ids(value, ids);
            }
        }
        _ => {}
    }
}

fn count_track_media_references(
    tracks: &[CanonicalTrack],
    references: &mut BTreeMap<String, usize>,
) {
    for element in tracks.iter().flat_map(|track| &track.elements) {
        match element {
            CanonicalElement::Video {
                media_id,
                matte: attachment,
                audio_replacement,
                ..
            } => {
                increment_reference(references, media_id);
                if let Some(attachment) = attachment {
                    increment_reference(references, &attachment.asset_id);
                }
                if let Some(attachment) = audio_replacement {
                    increment_reference(references, &attachment.asset_id);
                }
            }
            CanonicalElement::Audio {
                media_id,
                audio_replacement,
                ..
            } => {
                if let Some(media_id) = media_id {
                    increment_reference(references, media_id);
                }
                if let Some(attachment) = audio_replacement {
                    increment_reference(references, &attachment.asset_id);
                }
            }
            CanonicalElement::Image { media_id, .. } => {
                increment_reference(references, media_id);
            }
            CanonicalElement::Compound { tracks, .. } => {
                count_track_media_references(tracks, references);
            }
            _ => {}
        }
    }
}

fn increment_reference(references: &mut BTreeMap<String, usize>, asset_id: &str) {
    *references.entry(asset_id.to_owned()).or_default() += 1;
}

fn matte_asset_id(element: &Element) -> Option<String> {
    match element.canonical_source.as_ref()? {
        CanonicalElement::Video { matte, .. } => {
            matte.as_ref().map(|attachment| attachment.asset_id.clone())
        }
        _ => None,
    }
}

fn audio_replacement_asset_id(element: &Element) -> Option<String> {
    match element.canonical_source.as_ref()? {
        CanonicalElement::Video {
            audio_replacement, ..
        }
        | CanonicalElement::Audio {
            audio_replacement, ..
        } => audio_replacement
            .as_ref()
            .map(|attachment| attachment.asset_id.clone()),
        _ => None,
    }
}

fn decrement_reference(references: &mut BTreeMap<String, usize>, asset_id: &str) {
    let Some(count) = references.get_mut(asset_id) else {
        return;
    };
    *count = count.saturating_sub(1);
    if *count == 0 {
        references.remove(asset_id);
    }
}

fn volume_animation_is_scalar(element: &Element) -> bool {
    element
        .keyframes
        .iter()
        .filter(|keyframe| keyframe.property_path == "volume")
        .all(|keyframe| matches!(keyframe.value, Scalar::Number(_)))
}

fn mix_gain_values(element: &Element) -> Vec<f64> {
    let mut values = vec![element.volume_db.unwrap_or(0.0)];
    if volume_animation_is_scalar(element) {
        values.extend(element.keyframes.iter().filter_map(|keyframe| {
            if keyframe.property_path != "volume" {
                return None;
            }
            match keyframe.value {
                Scalar::Number(value) => Some(value),
                _ => None,
            }
        }));
    }
    values
}

fn track_type_for_element(element: &str) -> &str {
    match element {
        "audio" => "audio",
        "text" => "text",
        "graphic" | "sticker" => "graphic",
        "effect" => "effect",
        _ => "video",
    }
}
fn audio_capable(e: &Element) -> bool {
    audio_capable_type(&e.element_type)
}

fn source_span_at_clip_time(
    clip_time: MediaTime,
    element: &Element,
    index: usize,
) -> Result<MediaTime, EditPlanError> {
    let rate = if matches!(element.element_type.as_str(), "video" | "audio") {
        element.retime_rate.unwrap_or(1.0)
    } else {
        1.0
    };
    let ticks = (clip_time.as_ticks() as f64) * rate;
    if !ticks.is_finite() || ticks < i64::MIN as f64 || ticks > i64::MAX as f64 {
        return Err(error(
            ErrorCode::ArithmeticOverflow,
            "retimed source span overflow",
            Some(index),
            None,
        ));
    }
    Ok(MediaTime::from_ticks(js_round(ticks)))
}

fn timeline_duration_for_source_span(
    source_span: MediaTime,
    element: &Element,
    index: usize,
) -> Result<MediaTime, EditPlanError> {
    let rate = if matches!(element.element_type.as_str(), "video" | "audio") {
        element.retime_rate.unwrap_or(1.0)
    } else {
        1.0
    };
    let ticks = (source_span.as_ticks() as f64) / rate;
    if !ticks.is_finite() || ticks <= 0.0 || ticks > i64::MAX as f64 {
        return Err(error(
            ErrorCode::ArithmeticOverflow,
            "retimed timeline span overflow",
            Some(index),
            None,
        ));
    }
    Ok(MediaTime::from_ticks(js_round(ticks)))
}

fn element_source_duration(element: &Element, index: usize) -> Result<MediaTime, EditPlanError> {
    if matches!(element.element_type.as_str(), "video" | "audio")
        && let Some(source_duration) = element.source_duration
    {
        return Ok(source_duration);
    }
    add(
        add(
            element.trim_start,
            source_span_at_clip_time(element.duration, element, index)?,
            index,
        )?,
        element.trim_end,
        index,
    )
}
fn audio_capable_type(t: &str) -> bool {
    t == "audio" || t == "video"
}
fn require_audio(e: &Element, index: usize) -> Result<(), EditPlanError> {
    if audio_capable(e) {
        Ok(())
    } else {
        incompatible(index, "element has no audio")
    }
}
fn required(value: &Option<String>) -> &str {
    value.as_deref().expect("resolve supplies created IDs")
}
fn unique(ids: &mut BTreeSet<String>, id: &str, index: Option<usize>) -> Result<(), EditPlanError> {
    if ids.insert(id.into()) {
        Ok(())
    } else {
        Err(error(
            ErrorCode::DuplicateId,
            format!("duplicate ID: {id}"),
            index,
            None,
        ))
    }
}
fn duplicate(index: usize, id: &str) -> Result<(), EditPlanError> {
    Err(error(
        ErrorCode::DuplicateId,
        format!("duplicate ID: {id}"),
        Some(index),
        None,
    ))
}
fn unknown(index: usize, kind: &str) -> Result<(), EditPlanError> {
    Err(unknown_error(index, kind))
}
fn unknown_error(index: usize, kind: &str) -> EditPlanError {
    error(
        ErrorCode::UnknownReference,
        format!("unknown {kind}"),
        Some(index),
        None,
    )
}
fn invalid(index: usize, message: &str) -> Result<(), EditPlanError> {
    Err(error(ErrorCode::InvalidValue, message, Some(index), None))
}
fn incompatible(index: usize, message: &str) -> Result<(), EditPlanError> {
    Err(error(
        ErrorCode::IncompatibleTrack,
        message,
        Some(index),
        None,
    ))
}
fn bounds(index: usize, path: &str) -> Result<(), EditPlanError> {
    Err(error(
        ErrorCode::Bounds,
        "value is outside supported bounds",
        Some(index),
        Some(path),
    ))
}
fn error(
    code: ErrorCode,
    message: impl Into<String>,
    operation_index: Option<usize>,
    path: Option<&str>,
) -> EditPlanError {
    EditPlanError {
        code,
        message: message.into(),
        operation_index,
        path: path.map(str::to_owned),
    }
}
fn validate_id(id: &str, index: Option<usize>, path: &str) -> Result<(), EditPlanError> {
    if id.is_empty()
        || id.len() > MAX_ID_BYTES
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:@/-".contains(c))
    {
        Err(error(
            ErrorCode::InvalidValue,
            "invalid identifier",
            index,
            Some(path),
        ))
    } else {
        Ok(())
    }
}
fn validate_digest(value: &str, path: &str) -> Result<(), EditPlanError> {
    if value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(error(
            ErrorCode::InvalidValue,
            "expected lowercase SHA-256",
            None,
            Some(path),
        ))
    }
}
fn nonnegative(v: MediaTime, index: Option<usize>, path: &str) -> Result<(), EditPlanError> {
    if v.as_ticks() >= 0 {
        Ok(())
    } else {
        Err(error(
            ErrorCode::Bounds,
            "time must be nonnegative",
            index,
            Some(path),
        ))
    }
}
fn positive(v: MediaTime, index: Option<usize>, path: &str) -> Result<(), EditPlanError> {
    if v.as_ticks() > 0 {
        Ok(())
    } else {
        Err(error(
            ErrorCode::Bounds,
            "time must be positive",
            index,
            Some(path),
        ))
    }
}
fn validate_interval(
    start: MediaTime,
    duration: MediaTime,
    index: Option<usize>,
) -> Result<(), EditPlanError> {
    nonnegative(start, index, "startTime")?;
    positive(duration, index, "duration")?;
    start
        .as_ticks()
        .checked_add(duration.as_ticks())
        .ok_or_else(|| {
            error(
                ErrorCode::ArithmeticOverflow,
                "timeline interval overflow",
                index,
                None,
            )
        })?;
    Ok(())
}
fn add(a: MediaTime, b: MediaTime, index: usize) -> Result<MediaTime, EditPlanError> {
    a.as_ticks()
        .checked_add(b.as_ticks())
        .map(MediaTime::from_ticks)
        .ok_or_else(|| {
            error(
                ErrorCode::ArithmeticOverflow,
                "time addition overflow",
                Some(index),
                None,
            )
        })
}
fn sub(a: MediaTime, b: MediaTime, index: usize) -> Result<MediaTime, EditPlanError> {
    a.as_ticks()
        .checked_sub(b.as_ticks())
        .map(MediaTime::from_ticks)
        .ok_or_else(|| {
            error(
                ErrorCode::ArithmeticOverflow,
                "time subtraction overflow",
                Some(index),
                None,
            )
        })
}
fn finite_range(v: f64, min: f64, max: f64, index: usize, path: &str) -> Result<(), EditPlanError> {
    if v.is_finite() && v >= min && v <= max {
        Ok(())
    } else {
        Err(error(
            ErrorCode::Bounds,
            "number is nonfinite or out of bounds",
            Some(index),
            Some(path),
        ))
    }
}

fn validate_compositing_key(key: &CompositingKey, index: usize) -> Result<(), EditPlanError> {
    match key {
        CompositingKey::Chroma {
            key_color,
            similarity,
            softness,
            spill_suppression,
            ..
        } => {
            let bytes = key_color.as_bytes();
            if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(u8::is_ascii_hexdigit)
            {
                return invalid(index, "keyColor must be a six-digit hexadecimal color");
            }
            unit_key_control(*similarity, index, "similarity")?;
            unit_key_control(*softness, index, "softness")?;
            unit_key_control(*spill_suppression, index, "spillSuppression")
        }
        CompositingKey::Luma {
            low,
            high,
            softness,
            ..
        } => {
            unit_key_control(*low, index, "low")?;
            unit_key_control(*high, index, "high")?;
            unit_key_control(*softness, index, "softness")?;
            if low > high {
                return invalid(index, "luma key low must not exceed high");
            }
            Ok(())
        }
    }
}

fn unit_key_control(value: f64, index: usize, name: &str) -> Result<(), EditPlanError> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return invalid(index, &format!("key {name} must be between zero and one"));
    }
    Ok(())
}
fn validate_mask_params(params: &MaskParams, index: usize) -> Result<(), EditPlanError> {
    for (key, value) in params {
        if key.trim().is_empty() {
            return invalid(index, "mask parameter key is empty");
        }
        match value {
            MaskParamValue::Number(number) if !number.is_finite() => {
                return invalid(index, "mask parameter number must be finite");
            }
            MaskParamValue::Path(points) => {
                let mut ids = BTreeSet::new();
                for point in points {
                    validate_id(&point.id, Some(index), "mask.path.id")?;
                    if !ids.insert(&point.id) {
                        return duplicate(index, &point.id);
                    }
                    for coordinate in [
                        point.x,
                        point.y,
                        point.in_x,
                        point.in_y,
                        point.out_x,
                        point.out_y,
                    ] {
                        if !coordinate.is_finite() {
                            return invalid(index, "mask path coordinate must be finite");
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn resolved_mask_params(
    mask_type: MaskType,
    requested: Option<&MaskParams>,
    index: usize,
) -> Result<MaskParams, EditPlanError> {
    let mut params = default_mask_params(mask_type);
    validate_mask_params(requested.unwrap_or(&MaskParams::new()), index)?;
    for (key, value) in requested.into_iter().flatten() {
        let resolved = match (key.as_str(), value) {
            ("inverted", MaskParamValue::Boolean(_)) => value.clone(),
            ("strokeAlign", MaskParamValue::String(value))
                if matches!(value.as_str(), "inside" | "center" | "outside") =>
            {
                MaskParamValue::String(value.clone())
            }
            ("path", MaskParamValue::Path(_)) if mask_type == MaskType::Freeform => value.clone(),
            ("closed", MaskParamValue::Boolean(_)) if mask_type == MaskType::Freeform => {
                value.clone()
            }
            ("strokeColor", MaskParamValue::String(_)) => value.clone(),
            ("feather", _) => coerce_mask_number(value, 0.0, Some(1000.0), 1.0, index, key)?,
            ("strokeWidth", _) => coerce_mask_number(value, 0.0, Some(100.0), 1.0, index, key)?,
            ("centerX" | "centerY", _) if mask_accepts_position(mask_type) => {
                coerce_mask_number(value, -100.0, Some(100.0), 1.0, index, key)?
            }
            ("rotation", _) if mask_accepts_position(mask_type) => {
                coerce_mask_number(value, 0.0, Some(360.0), 1.0, index, key)?
            }
            ("width" | "height", _)
                if matches!(
                    mask_type,
                    MaskType::CinematicBars
                        | MaskType::Rectangle
                        | MaskType::Ellipse
                        | MaskType::Heart
                        | MaskType::Diamond
                        | MaskType::Star
                ) =>
            {
                coerce_mask_number(value, 1.0, None, 1.0, index, key)?
            }
            ("scale", _)
                if matches!(
                    mask_type,
                    MaskType::CinematicBars
                        | MaskType::Rectangle
                        | MaskType::Ellipse
                        | MaskType::Heart
                        | MaskType::Diamond
                        | MaskType::Star
                        | MaskType::Text
                        | MaskType::Freeform
                ) =>
            {
                coerce_mask_number(value, 1.0, Some(500.0), 1.0, index, key)?
            }
            ("fontSize", _) if mask_type == MaskType::Text => {
                coerce_mask_number(value, 5.0, Some(300.0), 1.0, index, key)?
            }
            ("content" | "fontFamily", MaskParamValue::String(_))
                if mask_type == MaskType::Text =>
            {
                value.clone()
            }
            ("fontWeight", MaskParamValue::String(value))
                if mask_type == MaskType::Text && matches!(value.as_str(), "normal" | "bold") =>
            {
                MaskParamValue::String(value.clone())
            }
            ("fontStyle", MaskParamValue::String(value))
                if mask_type == MaskType::Text && matches!(value.as_str(), "normal" | "italic") =>
            {
                MaskParamValue::String(value.clone())
            }
            ("textDecoration", MaskParamValue::String(value))
                if mask_type == MaskType::Text
                    && matches!(value.as_str(), "none" | "underline" | "line-through") =>
            {
                MaskParamValue::String(value.clone())
            }
            ("letterSpacing", _) if mask_type == MaskType::Text => {
                coerce_mask_number(value, -100.0, None, 0.1, index, key)?
            }
            ("lineHeight", _) if mask_type == MaskType::Text => {
                coerce_mask_number(value, 0.1, None, 0.1, index, key)?
            }
            _ => {
                return Err(invalid_error(
                    index,
                    &format!("mask {} has no parameter {key}", mask_type.as_str()),
                ));
            }
        };
        params.insert(key.clone(), resolved);
    }
    if mask_type == MaskType::Freeform
        && params.get("closed") == Some(&MaskParamValue::Boolean(true))
        && !matches!(params.get("path"), Some(MaskParamValue::Path(points)) if points.len() >= 3)
    {
        return Err(invalid_error(
            index,
            "a closed freeform mask requires at least three points",
        ));
    }
    Ok(params)
}

fn default_mask_params(mask_type: MaskType) -> MaskParams {
    let mut params = MaskParams::from_iter([
        ("feather".into(), MaskParamValue::Number(0.0)),
        ("inverted".into(), MaskParamValue::Boolean(false)),
        (
            "strokeColor".into(),
            MaskParamValue::String("#ffffff".into()),
        ),
        ("strokeWidth".into(), MaskParamValue::Number(0.0)),
        (
            "strokeAlign".into(),
            MaskParamValue::String("center".into()),
        ),
    ]);
    match mask_type {
        MaskType::Split => {
            insert_mask_numbers(
                &mut params,
                &[("centerX", 0.0), ("centerY", 0.0), ("rotation", 0.0)],
            );
        }
        MaskType::CinematicBars => {
            insert_mask_numbers(
                &mut params,
                &[
                    ("centerX", 0.0),
                    ("centerY", 0.0),
                    ("width", std::f64::consts::SQRT_2),
                    ("height", 0.6),
                    ("rotation", 0.0),
                    ("scale", 1.0),
                ],
            );
        }
        MaskType::Rectangle
        | MaskType::Ellipse
        | MaskType::Heart
        | MaskType::Diamond
        | MaskType::Star => {
            insert_mask_numbers(
                &mut params,
                &[
                    ("centerX", 0.0),
                    ("centerY", 0.0),
                    ("width", 0.6),
                    ("height", 0.6),
                    ("rotation", 0.0),
                    ("scale", 1.0),
                ],
            );
        }
        MaskType::Text => {
            insert_mask_numbers(
                &mut params,
                &[
                    ("fontSize", 15.0),
                    ("centerX", 0.0),
                    ("centerY", 0.0),
                    ("rotation", 0.0),
                    ("scale", 1.0),
                ],
            );
            for (key, value) in [
                ("content", "Mask"),
                ("fontFamily", "Arial"),
                ("fontWeight", "normal"),
                ("fontStyle", "normal"),
                ("textDecoration", "none"),
            ] {
                params.insert(key.into(), MaskParamValue::String(value.into()));
            }
            insert_mask_numbers(&mut params, &[("letterSpacing", 0.0), ("lineHeight", 1.2)]);
        }
        MaskType::Freeform => {
            insert_mask_numbers(
                &mut params,
                &[
                    ("centerX", 0.0),
                    ("centerY", 0.0),
                    ("rotation", 0.0),
                    ("scale", 1.0),
                ],
            );
            params.insert("path".into(), MaskParamValue::Path(vec![]));
            params.insert("closed".into(), MaskParamValue::Boolean(false));
        }
    }
    params
}

fn insert_mask_numbers(params: &mut MaskParams, values: &[(&str, f64)]) {
    for (key, value) in values {
        params.insert((*key).into(), MaskParamValue::Number(*value));
    }
}

fn mask_accepts_position(mask_type: MaskType) -> bool {
    matches!(
        mask_type,
        MaskType::Split
            | MaskType::CinematicBars
            | MaskType::Rectangle
            | MaskType::Ellipse
            | MaskType::Heart
            | MaskType::Diamond
            | MaskType::Star
            | MaskType::Text
            | MaskType::Freeform
    )
}

fn coerce_mask_number(
    value: &MaskParamValue,
    min: f64,
    max: Option<f64>,
    step: f64,
    index: usize,
    path: &str,
) -> Result<MaskParamValue, EditPlanError> {
    let MaskParamValue::Number(value) = value else {
        return Err(invalid_error(
            index,
            &format!("invalid value for mask parameter {path}"),
        ));
    };
    let Scalar::Number(value) =
        coerce_number(&Scalar::Number(*value), min, max, step, index, path)?
    else {
        unreachable!()
    };
    Ok(MaskParamValue::Number(value))
}
fn validate_fade(fade: &Fade, index: usize) -> Result<(), EditPlanError> {
    nonnegative(fade.in_duration, Some(index), "fade.inDuration")?;
    nonnegative(fade.out_duration, Some(index), "fade.outDuration")?;
    finite_range(fade.floor_db, -120.0, 0.0, index, "fade.floorDb")
}
fn validate_reframe(
    crop: Option<&Rect>,
    focal: Option<&Point>,
    target: Option<&Rect>,
    layout: Option<&str>,
    index: usize,
) -> Result<(), EditPlanError> {
    if target.is_some() && layout.is_some() {
        return invalid(index, "targetRect and layout are mutually exclusive");
    }
    for r in [crop, target].into_iter().flatten() {
        for (v, path) in [
            (r.x, "x"),
            (r.y, "y"),
            (r.width, "width"),
            (r.height, "height"),
        ] {
            finite_range(v, 0.0, 1.0, index, path)?;
        }
        if r.width <= 0.0 || r.height <= 0.0 {
            return bounds(index, "rect");
        }
    }
    if let Some(p) = focal {
        finite_range(p.x, 0.0, 1.0, index, "focalPoint.x")?;
        finite_range(p.y, 0.0, 1.0, index, "focalPoint.y")?;
    }
    Ok(())
}

fn default_reframe() -> Reframe {
    Reframe {
        mode: Some("contain".into()),
        crop: Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }),
        focal_point: Some(Point { x: 0.5, y: 0.5 }),
        target_rect: Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }),
        layout: None,
    }
}

fn normalize_reframe_mode(mode: &str) -> &str {
    match mode {
        "fit" => "contain",
        "fill" => "cover",
        value => value,
    }
}

fn layout_rect(layout: ReframeLayout) -> Rect {
    match layout {
        ReframeLayout::FullFrame => rect(0.0, 0.0, 1.0, 1.0),
        ReframeLayout::SplitLeft => rect(0.0, 0.0, 0.5, 1.0),
        ReframeLayout::SplitRight => rect(0.5, 0.0, 0.5, 1.0),
        ReframeLayout::SplitTop => rect(0.0, 0.0, 1.0, 0.5),
        ReframeLayout::SplitBottom => rect(0.0, 0.5, 1.0, 0.5),
        ReframeLayout::PipTopLeft => rect(0.04, 0.04, 0.32, 0.32),
        ReframeLayout::PipTopRight => rect(0.64, 0.04, 0.32, 0.32),
        ReframeLayout::PipBottomLeft => rect(0.04, 0.64, 0.32, 0.32),
        ReframeLayout::PipBottomRight => rect(0.64, 0.64, 0.32, 0.32),
    }
}

const fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}
fn validate_finite_element(e: &Element, index: Option<usize>) -> Result<(), EditPlanError> {
    for value in e.params.values() {
        if let Scalar::Number(v) = value
            && !v.is_finite()
        {
            return Err(error(
                ErrorCode::InvalidValue,
                "snapshot contains nonfinite number",
                index,
                None,
            ));
        }
    }
    Ok(())
}

fn summarize(snapshot: &ProjectSnapshot) -> Result<Summary, EditPlanError> {
    let canonical_hash = hash_serialized(snapshot)?;
    let mut track_count = 0;
    let mut element_count = 0;
    let mut transition_count = 0;
    let mut duration_ticks = 0_i64;
    for scene in &snapshot.project.scenes {
        summarize_tracks(
            &scene.tracks,
            &mut track_count,
            &mut element_count,
            &mut transition_count,
            &mut duration_ticks,
        )?;
    }
    Ok(Summary {
        canonical_hash,
        track_count,
        element_count,
        transition_count,
        duration_ticks,
    })
}

fn summarize_tracks(
    tracks: &[CanonicalTrack],
    track_count: &mut usize,
    element_count: &mut usize,
    transition_count: &mut usize,
    duration_ticks: &mut i64,
) -> Result<(), EditPlanError> {
    *track_count += tracks.len();
    for track in tracks {
        *transition_count += track.transitions.len();
        *element_count += track.elements.len();
        for element in &track.elements {
            let common = element.common();
            let end = common
                .start_time
                .as_ticks()
                .checked_add(common.duration.as_ticks())
                .ok_or_else(|| {
                    error(
                        ErrorCode::ArithmeticOverflow,
                        "duration overflow",
                        None,
                        None,
                    )
                })?;
            *duration_ticks = (*duration_ticks).max(end);
            if let CanonicalElement::Compound { tracks, .. } = element {
                summarize_tracks(
                    tracks,
                    track_count,
                    element_count,
                    transition_count,
                    duration_ticks,
                )?;
            }
        }
    }
    Ok(())
}
fn timing_diff_step(
    before: &ActiveSceneSnapshot,
    after: &ActiveSceneSnapshot,
    operation_index: usize,
) -> Vec<TimingConsequence> {
    let ids: BTreeSet<_> = before
        .elements
        .iter()
        .chain(after.elements.iter())
        .map(|e| e.element_id.clone())
        .collect();
    ids.into_iter()
        .filter_map(|id| {
            let a = before.elements.iter().find(|e| e.element_id == id);
            let b = after.elements.iter().find(|e| e.element_id == id);
            let tuple = (
                a.map(|e| e.start_time.as_ticks()),
                b.map(|e| e.start_time.as_ticks()),
                a.map(|e| e.duration.as_ticks()),
                b.map(|e| e.duration.as_ticks()),
            );
            if tuple.0 == tuple.1 && tuple.2 == tuple.3 {
                return None;
            }
            Some(TimingConsequence {
                operation_index,
                element_id: id,
                before_start_ticks: tuple.0,
                after_start_ticks: tuple.1,
                before_duration_ticks: tuple.2,
                after_duration_ticks: tuple.3,
            })
        })
        .collect()
}

fn apply_ripple_adjustments(
    before: &ActiveSceneSnapshot,
    after: &mut ActiveSceneSnapshot,
    cause_id: &str,
    operation_index: usize,
    expansion: &mut BTreeSet<Expansion>,
) -> Result<(), EditPlanError> {
    let all_after_ids = after
        .elements
        .iter()
        .map(|element| element.element_id.clone())
        .collect::<BTreeSet<_>>();
    let track_ids = before
        .tracks
        .iter()
        .map(|track| track.track_id.clone())
        .collect::<Vec<_>>();
    for track_id in track_ids {
        let before_elements = before
            .elements
            .iter()
            .filter(|element| element.track_id == track_id)
            .collect::<Vec<_>>();
        let after_elements = after
            .elements
            .iter()
            .filter(|element| element.track_id == track_id)
            .collect::<Vec<_>>();
        let mut vacated = Vec::new();
        for element in &before_elements {
            let before_end = add(element.start_time, element.duration, operation_index)?;
            if let Some(current) = after_elements
                .iter()
                .find(|candidate| candidate.element_id == element.element_id)
            {
                let current_end = add(current.start_time, current.duration, operation_index)?;
                if before_end > current_end {
                    push_interval(&mut vacated, current_end, before_end);
                }
            } else if !all_after_ids.contains(&element.element_id) {
                push_interval(&mut vacated, element.start_time, before_end);
            }
        }
        let before_ids = before_elements
            .iter()
            .map(|element| element.element_id.as_str())
            .collect::<BTreeSet<_>>();
        let mut joined = Vec::new();
        for element in after_elements {
            if !before_ids.contains(element.element_id.as_str()) {
                push_interval(
                    &mut joined,
                    element.start_time,
                    add(element.start_time, element.duration, operation_index)?,
                );
            }
        }
        let vacated = normalize_intervals(vacated);
        let joined = normalize_intervals(joined);
        let mut freed = Vec::new();
        for interval in vacated {
            freed.extend(subtract_intervals(interval, &joined));
        }
        freed.sort_by(|left, right| right.1.cmp(&left.1));
        for (start, end) in freed {
            let shift = sub(end, start, operation_index)?;
            for element in after
                .elements
                .iter_mut()
                .filter(|element| element.track_id == track_id && element.start_time >= end)
            {
                element.start_time = sub(element.start_time, shift, operation_index)?;
                shift_compound_members(element, -shift.as_ticks(), operation_index)?;
                expansion.insert(Expansion {
                    operation_index,
                    cause_id: cause_id.to_owned(),
                    affected_id: element.element_id.clone(),
                });
            }
        }
    }
    Ok(())
}

fn push_interval(intervals: &mut Vec<(MediaTime, MediaTime)>, start: MediaTime, end: MediaTime) {
    if end > start {
        intervals.push((start, end));
    }
}

fn normalize_intervals(mut intervals: Vec<(MediaTime, MediaTime)>) -> Vec<(MediaTime, MediaTime)> {
    intervals.sort_by_key(|interval| (interval.0, interval.1));
    let mut merged: Vec<(MediaTime, MediaTime)> = Vec::new();
    for (start, end) in intervals {
        if let Some(previous) = merged.last_mut()
            && start <= previous.1
        {
            previous.1 = previous.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}

fn subtract_intervals(
    source: (MediaTime, MediaTime),
    overlapping: &[(MediaTime, MediaTime)],
) -> Vec<(MediaTime, MediaTime)> {
    let mut remaining = vec![source];
    for overlap in overlapping {
        let mut next = Vec::new();
        for interval in remaining {
            if overlap.1 <= interval.0 || overlap.0 >= interval.1 {
                next.push(interval);
                continue;
            }
            push_interval(&mut next, interval.0, overlap.0);
            push_interval(&mut next, overlap.1, interval.1);
        }
        remaining = next;
        if remaining.is_empty() {
            break;
        }
    }
    remaining
}

fn diff_snapshots(
    project_id: &str,
    before: &ProjectSnapshot,
    after: &ProjectSnapshot,
) -> Result<Vec<ChangedObject>, EditPlanError> {
    let left = flatten_project_objects(project_id, before)?;
    let right = flatten_project_objects(project_id, after)?;
    let mut out = Vec::new();
    let keys: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
    for (kind, id) in keys {
        let empty = BTreeMap::new();
        let left_instances = left.get(&(kind.clone(), id.clone())).unwrap_or(&empty);
        let right_instances = right.get(&(kind.clone(), id.clone())).unwrap_or(&empty);
        let owners: BTreeSet<_> = left_instances
            .keys()
            .chain(right_instances.keys())
            .cloned()
            .collect();
        let qualify =
            owners.len() > 1 || left_instances.keys().next() != right_instances.keys().next();
        for owner in owners {
            let path = qualify.then(|| format!("@{owner}")).unwrap_or_default();
            diff_value(
                &kind,
                &id,
                &path,
                left_instances
                    .get(&owner)
                    .unwrap_or(&serde_json::Value::Null),
                right_instances
                    .get(&owner)
                    .unwrap_or(&serde_json::Value::Null),
                &mut out,
            )?;
        }
    }
    out.sort_by(|a, b| {
        (&a.object_type, &a.object_id, &a.field_path).cmp(&(
            &b.object_type,
            &b.object_id,
            &b.field_path,
        ))
    });
    Ok(out)
}

type ProjectObjectMap = BTreeMap<(String, String), BTreeMap<String, serde_json::Value>>;

fn flatten_project_objects(
    project_id: &str,
    snapshot: &ProjectSnapshot,
) -> Result<ProjectObjectMap, EditPlanError> {
    let mut objects = ProjectObjectMap::new();
    let mut project = serde_json::to_value(&snapshot.project).map_err(serialization_error)?;
    remove_fields(&mut project, &["scenes"]);
    insert_project_object(&mut objects, "project", project_id, "project", project);
    for scene in &snapshot.project.scenes {
        let mut value = serde_json::to_value(scene).map_err(serialization_error)?;
        remove_fields(&mut value, &["id", "tracks"]);
        let scene_owner = format!("scene:{}", scene.id);
        insert_project_object(&mut objects, "scene", &scene.id, &scene_owner, value);
        flatten_tracks(&mut objects, &scene.tracks, &scene_owner)?;
    }
    for asset in &snapshot.media_assets {
        let mut value = serde_json::to_value(asset).map_err(serialization_error)?;
        remove_fields(&mut value, &["id"]);
        insert_project_object(&mut objects, "media-asset", &asset.id, "media-bin", value);
    }
    Ok(objects)
}

fn flatten_tracks(
    objects: &mut ProjectObjectMap,
    tracks: &[CanonicalTrack],
    owner: &str,
) -> Result<(), EditPlanError> {
    for track in tracks {
        let track_owner = format!("{owner}/track:{}", track.id);
        let mut value = serde_json::to_value(track).map_err(serialization_error)?;
        remove_fields(&mut value, &["id", "transitions", "elements"]);
        insert_project_object(objects, "track", &track.id, owner, value);
        for transition in &track.transitions {
            let mut value = serde_json::to_value(transition).map_err(serialization_error)?;
            remove_fields(&mut value, &["id"]);
            insert_project_object(objects, "transition", &transition.id, &track_owner, value);
        }
        for element in &track.elements {
            flatten_element(objects, element, &track_owner)?;
        }
    }
    Ok(())
}

fn flatten_element(
    objects: &mut ProjectObjectMap,
    element: &CanonicalElement,
    owner: &str,
) -> Result<(), EditPlanError> {
    let element_owner = format!("{owner}/element:{}", element.common().id);
    let mut value = serde_json::to_value(element).map_err(serialization_error)?;
    remove_fields(&mut value, &["id", "effects", "masks", "tracks"]);
    insert_project_object(objects, "element", &element.common().id, owner, value);
    match element {
        CanonicalElement::Video { effects, masks, .. }
        | CanonicalElement::Image { effects, masks, .. }
        | CanonicalElement::Graphic { effects, masks, .. } => {
            flatten_effects(objects, effects, &element_owner)?;
            flatten_masks(objects, masks, &element_owner)?;
        }
        CanonicalElement::Text { effects, .. } | CanonicalElement::Sticker { effects, .. } => {
            flatten_effects(objects, effects, &element_owner)?;
        }
        CanonicalElement::Compound { tracks, .. } => {
            flatten_tracks(objects, tracks, &element_owner)?
        }
        CanonicalElement::Audio { .. } | CanonicalElement::Effect { .. } => {}
    }
    Ok(())
}

fn flatten_effects(
    objects: &mut ProjectObjectMap,
    effects: &[CanonicalEffect],
    owner: &str,
) -> Result<(), EditPlanError> {
    for effect in effects {
        let mut value = serde_json::to_value(effect).map_err(serialization_error)?;
        remove_fields(&mut value, &["id"]);
        insert_project_object(objects, "effect", &effect.id, owner, value);
    }
    Ok(())
}

fn flatten_masks(
    objects: &mut ProjectObjectMap,
    masks: &[CanonicalMask],
    owner: &str,
) -> Result<(), EditPlanError> {
    for mask in masks {
        let mut value = serde_json::to_value(mask).map_err(serialization_error)?;
        remove_fields(&mut value, &["id"]);
        insert_project_object(objects, "mask", &mask.id, owner, value);
    }
    Ok(())
}

fn remove_fields(value: &mut serde_json::Value, fields: &[&str]) {
    let serde_json::Value::Object(object) = value else {
        return;
    };
    for field in fields {
        object.remove(*field);
    }
}

fn insert_project_object(
    objects: &mut ProjectObjectMap,
    kind: &str,
    id: &str,
    owner: &str,
    value: serde_json::Value,
) {
    objects
        .entry((kind.to_owned(), id.to_owned()))
        .or_default()
        .insert(owner.to_owned(), value);
}
fn diff_value(
    kind: &str,
    id: &str,
    path: &str,
    left: &serde_json::Value,
    right: &serde_json::Value,
    out: &mut Vec<ChangedObject>,
) -> Result<(), EditPlanError> {
    if left == right {
        return Ok(());
    }
    if let (serde_json::Value::Number(a), serde_json::Value::Number(b)) = (left, right) {
        if a.as_f64() == b.as_f64() {
            return Ok(());
        }
    }
    match (left, right) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            let keys: BTreeSet<_> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let next = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                diff_value(
                    kind,
                    id,
                    &next,
                    a.get(key).unwrap_or(&serde_json::Value::Null),
                    b.get(key).unwrap_or(&serde_json::Value::Null),
                    out,
                )?;
            }
        }
        (serde_json::Value::Array(a), serde_json::Value::Array(b)) => {
            let max = a.len().max(b.len());
            for i in 0..max {
                diff_value(
                    kind,
                    id,
                    &format!("{path}[{i}]"),
                    a.get(i).unwrap_or(&serde_json::Value::Null),
                    b.get(i).unwrap_or(&serde_json::Value::Null),
                    out,
                )?;
            }
        }
        _ => out.push(ChangedObject {
            object_type: kind.into(),
            object_id: id.into(),
            field_path: path.into(),
            before: canonical_value(left)?,
            after: canonical_value(right)?,
        }),
    }
    Ok(())
}
fn canonical_value(value: &serde_json::Value) -> Result<CanonicalValue, EditPlanError> {
    Ok(match value {
        serde_json::Value::Null => CanonicalValue::Null(()),
        serde_json::Value::Bool(v) => CanonicalValue::Boolean(*v),
        serde_json::Value::String(v) => CanonicalValue::String(v.clone()),
        serde_json::Value::Number(v) => {
            if let Some(n) = v.as_i64() {
                CanonicalValue::Integer(n)
            } else if let Some(n) = v.as_u64() {
                CanonicalValue::Unsigned(n)
            } else {
                let n = v
                    .as_f64()
                    .ok_or_else(|| error(ErrorCode::InvalidValue, "invalid number", None, None))?;
                if !n.is_finite() {
                    return Err(error(
                        ErrorCode::InvalidValue,
                        "nonfinite number",
                        None,
                        None,
                    ));
                }
                CanonicalValue::Number(n)
            }
        }
        serde_json::Value::Array(v) => {
            CanonicalValue::Array(v.iter().map(canonical_value).collect::<Result<_, _>>()?)
        }
        serde_json::Value::Object(v) => CanonicalValue::Object(
            v.iter()
                .map(|(k, v)| canonical_value(v).map(|v| (k.clone(), v)))
                .collect::<Result<_, _>>()?,
        ),
    })
}
fn hash_serialized<T: Serialize>(value: &T) -> Result<String, EditPlanError> {
    let json = serde_json::to_value(value).map_err(serialization_error)?;
    let canonical = canonical_json(&json)?;
    Ok(sha256(canonical.as_bytes()))
}
fn canonical_json(value: &serde_json::Value) -> Result<String, EditPlanError> {
    match value {
        serde_json::Value::Object(map) => {
            let mut object_entries: Vec<_> = map.iter().collect();
            object_entries
                .sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            let entries: Result<Vec<_>, _> = object_entries
                .into_iter()
                .map(|(k, v)| {
                    canonical_json(v).map(|v| format!("{}:{v}", serde_json::to_string(k).unwrap()))
                })
                .collect();
            Ok(format!("{{{}}}", entries?.join(",")))
        }
        serde_json::Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        serde_json::Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => {
            let value = n.as_f64().expect("guarded finite JSON number");
            if value == 0.0 {
                Ok("0".into())
            } else {
                Ok(ryu_js::Buffer::new().format_finite(value).into())
            }
        }
        serde_json::Value::Number(_) => Err(error(
            ErrorCode::InvalidValue,
            "nonfinite number",
            None,
            None,
        )),
        _ => serde_json::to_string(value).map_err(serialization_error),
    }
}
fn serialization_error(e: serde_json::Error) -> EditPlanError {
    error(ErrorCode::InvalidValue, e.to_string(), None, None)
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests;

/// Name the native editor gives a promoted main track.
const MAIN_TRACK_NAME: &str = "Main Track";
/// Duration the native editor assigns to elements without an intrinsic
/// duration (images): five seconds at the 120000 tick timebase.
const DEFAULT_NEW_ELEMENT_DURATION: MediaTime = MediaTime::from_ticks(5 * 120_000);

fn media_element_type(
    asset: &CanonicalMediaAsset,
    index: usize,
) -> Result<&'static str, EditPlanError> {
    match asset.asset_type.as_str() {
        "video" => Ok("video"),
        "image" => Ok("image"),
        "audio" => Ok("audio"),
        _ => Err(error(
            ErrorCode::IncompatibleTrack,
            "asset type cannot be placed on the timeline",
            Some(index),
            Some("assetId"),
        )),
    }
}

/// Mirrors the native import path: an explicit duration wins, otherwise the
/// asset's intrinsic duration rounded to ticks, and images fall back to the
/// editor's default new-element duration.
fn resolve_asset_duration(
    asset: &CanonicalMediaAsset,
    requested: Option<MediaTime>,
    index: usize,
) -> Result<MediaTime, EditPlanError> {
    if let Some(duration) = requested {
        positive(duration, Some(index), "duration")?;
        return Ok(duration);
    }
    match asset.duration {
        Some(seconds) => MediaTime::from_seconds_f64(seconds)
            .filter(|duration| *duration > MediaTime::ZERO)
            .ok_or_else(|| invalid_error(index, "asset duration is not a valid media time")),
        None if asset.asset_type == "image" => Ok(DEFAULT_NEW_ELEMENT_DURATION),
        None => Err(invalid_error(
            index,
            "asset has no duration; pass duration explicitly",
        )),
    }
}

fn default_reframe_params() -> Params {
    [
        ("reframe.mode", Scalar::String("contain".into())),
        ("reframe.cropX", Scalar::Number(0.0)),
        ("reframe.cropY", Scalar::Number(0.0)),
        ("reframe.cropWidth", Scalar::Number(1.0)),
        ("reframe.cropHeight", Scalar::Number(1.0)),
        ("reframe.focalX", Scalar::Number(0.5)),
        ("reframe.focalY", Scalar::Number(0.5)),
        ("reframe.targetX", Scalar::Number(0.0)),
        ("reframe.targetY", Scalar::Number(0.0)),
        ("reframe.targetWidth", Scalar::Number(1.0)),
        ("reframe.targetHeight", Scalar::Number(1.0)),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

fn default_audio_params() -> Params {
    [
        ("volume", Scalar::Number(0.0)),
        ("muted", Scalar::Boolean(false)),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

/// Builds the same element the native `buildElementFromMedia` helper builds,
/// including the canonical media identity the projection needs.
fn media_element(
    id: &str,
    element_type: &str,
    name: &str,
    asset: &CanonicalMediaAsset,
    start_time: MediaTime,
    duration: MediaTime,
) -> Element {
    let mut element = new_element(id, element_type, name, start_time, duration);
    let mut params = Params::new();
    if element_type != "audio" {
        params.extend(default_visual_params());
        params.extend(default_reframe_params());
    }
    if element_type != "image" {
        params.extend(default_audio_params());
        element.source_duration = Some(duration);
    }
    element.params = params;
    element.muted = Some(false);
    if element_type == "video" {
        element.source_audio_separated = Some(false);
    }
    let common = Box::new(CanonicalElementCommon {
        order: 0,
        id: id.to_owned(),
        name: name.to_owned(),
        group_id: None,
        link_id: None,
        start_time,
        duration,
        trim_start: MediaTime::ZERO,
        trim_end: MediaTime::ZERO,
        source_duration: element.source_duration,
        params: CanonicalValue::Object(BTreeMap::new()),
        animations: CanonicalValue::Object(BTreeMap::new()),
    });
    element.canonical_source = Some(match element_type {
        "audio" => CanonicalElement::Audio {
            common,
            source_type: "upload".into(),
            media_id: Some(asset.id.clone()),
            source_url: None,
            retime: CanonicalValue::Null(()),
            audio_replacement: None,
        },
        "image" => CanonicalElement::Image {
            common,
            media_id: asset.id.clone(),
            hidden: Some(false),
            effects: vec![],
            masks: vec![],
            key: None,
        },
        _ => CanonicalElement::Video {
            common,
            media_id: asset.id.clone(),
            hidden: Some(false),
            is_source_audio_enabled: Some(true),
            retime: CanonicalValue::Null(()),
            effects: vec![],
            masks: vec![],
            key: None,
            matte: None,
            audio_replacement: None,
        },
    });
    element
}
