//! Project-state policy shared by native and WASM callers.

use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const PROJECT_SNAPSHOT_RETENTION_DAYS: u64 = 90;
pub const PROJECT_SNAPSHOT_RETENTION_MS: u64 =
    PROJECT_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRelinkDescriptor {
    #[serde(rename = "type")]
    pub media_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub fps: Option<f64>,
    pub has_audio: Option<bool>,
    pub size: u64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum MediaRelinkValue {
    String(String),
    Number(f64),
    Boolean(bool),
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRelinkDifference {
    pub field: String,
    pub before: Option<MediaRelinkValue>,
    pub after: Option<MediaRelinkValue>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateMediaRelinkOptions {
    pub current: MediaRelinkDescriptor,
    pub replacement: MediaRelinkDescriptor,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRelinkEvaluation {
    pub compatible: bool,
    pub differences: Vec<MediaRelinkDifference>,
}

#[export]
pub fn evaluate_media_relink_compatibility(
    options: EvaluateMediaRelinkOptions,
) -> MediaRelinkEvaluation {
    let mut differences = Vec::new();
    push_media_difference(
        &mut differences,
        "type",
        Some(MediaRelinkValue::String(options.current.media_type.clone())),
        Some(MediaRelinkValue::String(
            options.replacement.media_type.clone(),
        )),
    );
    push_media_difference(
        &mut differences,
        "width",
        options
            .current
            .width
            .map(|value| MediaRelinkValue::Number(value.into())),
        options
            .replacement
            .width
            .map(|value| MediaRelinkValue::Number(value.into())),
    );
    push_media_difference(
        &mut differences,
        "height",
        options
            .current
            .height
            .map(|value| MediaRelinkValue::Number(value.into())),
        options
            .replacement
            .height
            .map(|value| MediaRelinkValue::Number(value.into())),
    );
    push_media_difference(
        &mut differences,
        "duration",
        options.current.duration.map(MediaRelinkValue::Number),
        options.replacement.duration.map(MediaRelinkValue::Number),
    );
    push_media_difference(
        &mut differences,
        "fps",
        options.current.fps.map(MediaRelinkValue::Number),
        options.replacement.fps.map(MediaRelinkValue::Number),
    );
    push_media_difference(
        &mut differences,
        "hasAudio",
        options.current.has_audio.map(MediaRelinkValue::Boolean),
        options.replacement.has_audio.map(MediaRelinkValue::Boolean),
    );
    push_media_difference(
        &mut differences,
        "size",
        Some(MediaRelinkValue::Number(options.current.size as f64)),
        Some(MediaRelinkValue::Number(options.replacement.size as f64)),
    );
    MediaRelinkEvaluation {
        compatible: options.current.media_type == options.replacement.media_type,
        differences,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at_ms: f64,
    pub content_hash: Option<String>,
    pub write_version: Option<u64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleSceneSummary {
    pub id: String,
    pub name: String,
    pub is_main: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleAssetSummary {
    pub id: String,
    pub name: String,
    pub descriptor: MediaRelinkDescriptor,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleUsageSummary {
    pub asset_id: String,
    pub element_id: String,
    pub kind: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleReplacementSummary {
    pub name: String,
    pub descriptor: MediaRelinkDescriptor,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleMutationState {
    pub active_project_id: Option<String>,
    pub active_scene_id: String,
    pub active_revision: u64,
    pub active_project_content_hash: String,
    pub projects: Vec<LifecycleProjectSummary>,
    pub scenes: Vec<LifecycleSceneSummary>,
    pub assets: Vec<LifecycleAssetSummary>,
    pub usages: Vec<LifecycleUsageSummary>,
    pub replacement: Option<LifecycleReplacementSummary>,
    pub identity_sources: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleMutationRequest {
    pub project_id: String,
    pub expected_revision: Option<u64>,
    pub expected_project_content_hash: Option<String>,
    pub expected_target_content_hash: Option<String>,
    pub expected_target_write_version: Option<u64>,
    pub name: Option<String>,
    pub fallback_project_id: Option<String>,
    pub scene_id: Option<String>,
    pub new_scene_id: Option<String>,
    pub activate: Option<bool>,
    pub replacement_scene_id: Option<String>,
    pub new_main_scene_id: Option<String>,
    pub scene_ids: Option<Vec<String>>,
    pub asset_name: Option<String>,
    pub asset_id: Option<String>,
    pub source_fingerprint: Option<String>,
    pub mime_type: Option<String>,
    pub allow_incompatible: Option<bool>,
    pub policy: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateLifecycleMutationOptions {
    pub method: String,
    pub request: LifecycleMutationRequest,
    pub state: LifecycleMutationState,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleAffectedObject {
    pub object_type: String,
    pub object_id: String,
    pub action: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleBlankProject {
    pub project_id: String,
    pub scene_id: String,
    pub main_track_id: String,
}

/// Typed execution data returned by the Rust lifecycle planner. Keeping this
/// as a concrete DTO is important: `serde_json::Value` loses its object fields
/// when converted through wasm-bindgen/tsify.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleMutationConsequences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identities: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_project_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub identity_allocations: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoverability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_blank: Option<LifecycleBlankProject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_main_scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_scene_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub scene_ids: Vec<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatible: Option<bool>,
    /// Present for every relink so an identical replacement reports an
    /// explicit empty diff rather than no diff at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub differences: Option<Vec<MediaRelinkDifference>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,
    /// Present for every remove so an unused asset reports explicit empty
    /// element lists rather than no lists at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_element_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_element_ids: Option<Vec<String>>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LifecycleMutationEvaluation {
    Validated {
        preflight_fingerprint: String,
        affected_objects: Vec<LifecycleAffectedObject>,
        consequences: LifecycleMutationConsequences,
    },
    Rejected {
        reason: String,
    },
}

#[export]
pub fn evaluate_lifecycle_mutation(
    options: EvaluateLifecycleMutationOptions,
) -> LifecycleMutationEvaluation {
    match plan_lifecycle_mutation(&options) {
        Ok((affected_objects, consequences)) => {
            let fingerprint_input = json!({
                "contract": "opencut.lifecycle-preflight.v1",
                "method": options.method,
                "request": options.request,
                "planned": {
                    "affectedObjects": affected_objects,
                    "consequences": consequences,
                },
            });
            match canonical_json::canonical_sha256(&fingerprint_input) {
                Ok(preflight_fingerprint) => LifecycleMutationEvaluation::Validated {
                    preflight_fingerprint,
                    affected_objects,
                    consequences,
                },
                Err(error) => LifecycleMutationEvaluation::Rejected {
                    reason: format!("lifecycle fingerprint failed: {error}"),
                },
            }
        }
        Err(reason) => LifecycleMutationEvaluation::Rejected { reason },
    }
}

fn affected(object_type: &str, object_id: &str, action: &str) -> LifecycleAffectedObject {
    LifecycleAffectedObject {
        object_type: object_type.into(),
        object_id: object_id.into(),
        action: action.into(),
    }
}

fn lifecycle_allocations(
    options: &EvaluateLifecycleMutationOptions,
) -> Result<Vec<String>, String> {
    options
        .state
        .identity_sources
        .iter()
        .enumerate()
        .map(|(ordinal, source)| {
            let digest = canonical_json::canonical_sha256(&json!({
                "contract": "opencut.lifecycle-identity.v1",
                "method": options.method,
                "request": options.request,
                "ordinal": ordinal,
                "source": source,
            }))
            .map_err(|error| format!("lifecycle identity allocation failed: {error}"))?;
            Ok(format!(
                "{}-{}-4{}-a{}-{}",
                &digest[0..8],
                &digest[8..12],
                &digest[13..16],
                &digest[17..20],
                &digest[20..32]
            ))
        })
        .collect()
}

fn required<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str, String> {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

fn trimmed(value: &Option<String>, field: &str) -> Result<Option<String>, String> {
    match value {
        Some(value) if value.trim().is_empty() => Err(format!("{field} is required")),
        Some(value) => Ok(Some(value.trim().into())),
        None => Ok(None),
    }
}

fn duplicate_name_parts(name: &str) -> (&str, Option<u32>) {
    let Some(rest) = name.strip_prefix('(') else {
        return (name, None);
    };
    let Some((number, base)) = rest.split_once(") ") else {
        return (name, None);
    };
    match number.parse::<u32>() {
        Ok(number) if !base.is_empty() => (base, Some(number)),
        _ => (name, None),
    }
}

fn next_duplicate_name(source_name: &str, projects: &[LifecycleProjectSummary]) -> String {
    let (base, _) = duplicate_name_parts(source_name);
    let next = projects
        .iter()
        .filter_map(|project| {
            let (candidate_base, number) = duplicate_name_parts(&project.name);
            (candidate_base == base).then_some(number).flatten()
        })
        .max()
        .unwrap_or(0)
        + 1;
    format!("({next}) {base}")
}

fn plan_lifecycle_mutation(
    options: &EvaluateLifecycleMutationOptions,
) -> Result<(Vec<LifecycleAffectedObject>, LifecycleMutationConsequences), String> {
    let request = &options.request;
    let state = &options.state;
    let project_id = request.project_id.as_str();
    let allocations = lifecycle_allocations(options)?;
    let scene = |id: &str| state.scenes.iter().find(|scene| scene.id == id);
    let asset = |id: &str| state.assets.iter().find(|asset| asset.id == id);
    let project_mutation = matches!(
        options.method.as_str(),
        "rename_project" | "duplicate_project" | "delete_project"
    );
    if project_mutation {
        let target = state
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        if request.expected_target_content_hash.as_ref() != target.content_hash.as_ref()
            || request.expected_target_write_version != target.write_version
        {
            return Err("target project changed before lifecycle preflight".into());
        }
    } else {
        if state.active_project_id.as_deref() != Some(project_id) {
            return Err(format!(
                "active project is {}",
                state.active_project_id.as_deref().unwrap_or("unavailable")
            ));
        }
        if request.expected_revision != Some(state.active_revision) {
            return Err("project revision changed before lifecycle preflight".into());
        }
        if request.expected_project_content_hash.as_deref()
            != Some(state.active_project_content_hash.as_str())
        {
            return Err("project content hash changed before lifecycle preflight".into());
        }
    }

    match options.method.as_str() {
        "rename_project" => {
            let name = trimmed(&request.name, "project name")?.ok_or("project name is required")?;
            Ok((
                vec![affected("project", project_id, "updated")],
                LifecycleMutationConsequences {
                    name: Some(name),
                    ..Default::default()
                },
            ))
        }
        "duplicate_project" => {
            let duplicate_project_id = allocations
                .first()
                .ok_or("duplicate project identity allocation is missing")?;
            let source = state
                .projects
                .iter()
                .find(|project| project.id == project_id)
                .ok_or_else(|| format!("project not found: {project_id}"))?;
            let name = trimmed(&request.name, "project name")?
                .unwrap_or_else(|| next_duplicate_name(&source.name, &state.projects));
            Ok((
                vec![affected("project", duplicate_project_id, "created")],
                LifecycleMutationConsequences {
                    name: Some(name),
                    identities: Some("independent".into()),
                    media_identity: Some("shared".into()),
                    media_bytes: Some("copied".into()),
                    duplicate_project_id: Some(duplicate_project_id.clone()),
                    identity_allocations: allocations[1..].to_vec(),
                    ..Default::default()
                },
            ))
        }
        "delete_project" => {
            if request.fallback_project_id.as_deref() == Some(project_id) {
                return Err("fallbackProjectId cannot be the deleted project".into());
            }
            if let Some(fallback) = request.fallback_project_id.as_deref()
                && !state.projects.iter().any(|project| project.id == fallback)
            {
                return Err(format!("fallback project not found: {fallback}"));
            }
            let automatic = state
                .projects
                .iter()
                .filter(|project| project.id != project_id)
                .max_by(|left, right| {
                    left.updated_at_ms
                        .total_cmp(&right.updated_at_ms)
                        .then_with(|| right.id.cmp(&left.id))
                })
                .map(|project| project.id.clone());
            let fallback_id = request.fallback_project_id.clone().or(automatic);
            let fallback = if state.active_project_id.as_deref() != Some(project_id) {
                "unchanged"
            } else if fallback_id.is_some() {
                "opened-existing"
            } else {
                "created-blank"
            };
            let created_blank = if fallback == "created-blank" {
                if allocations.len() != 3 {
                    return Err("blank fallback identity allocations are incomplete".into());
                }
                Some(LifecycleBlankProject {
                    project_id: allocations[0].clone(),
                    scene_id: allocations[1].clone(),
                    main_track_id: allocations[2].clone(),
                })
            } else {
                None
            };
            let mut affected_objects = vec![affected("project", project_id, "deleted")];
            if fallback == "opened-existing" {
                affected_objects.push(affected(
                    "project",
                    fallback_id.as_deref().expect("resolved fallback"),
                    "opened",
                ));
            } else if let Some(created) = created_blank.as_ref() {
                affected_objects.push(affected("project", &created.project_id, "created"));
            }
            Ok((
                affected_objects,
                LifecycleMutationConsequences {
                    recoverability: Some("irreversible".into()),
                    fallback_project_id: fallback_id,
                    fallback: Some(fallback.into()),
                    created_blank,
                    ..Default::default()
                },
            ))
        }
        "create_scene" => {
            let name = trimmed(&request.name, "scene name")?.ok_or("scene name is required")?;
            if allocations.len() != 2 {
                return Err("create scene identity allocations are incomplete".into());
            }
            Ok((
                vec![affected("scene", &allocations[0], "created")],
                LifecycleMutationConsequences {
                    name: Some(name),
                    activate: Some(request.activate.unwrap_or(false)),
                    scene_id: Some(allocations[0].clone()),
                    main_track_id: Some(allocations[1].clone()),
                    ..Default::default()
                },
            ))
        }
        "clone_scene" => {
            let scene_id = required(&request.scene_id, "sceneId")?;
            let source = scene(scene_id).ok_or_else(|| format!("scene not found: {scene_id}"))?;
            if let Some(new_id) = request.new_scene_id.as_deref()
                && scene(new_id).is_some()
            {
                return Err(format!("scene id already exists: {new_id}"));
            }
            let name = trimmed(&request.name, "scene name")?
                .unwrap_or_else(|| format!("{} Copy", source.name));
            let generated_scene_id = allocations
                .first()
                .ok_or("clone scene identity allocation is missing")?;
            let new_scene_id = request.new_scene_id.as_ref().unwrap_or(generated_scene_id);
            Ok((
                vec![affected("scene", new_scene_id, "created")],
                LifecycleMutationConsequences {
                    source_scene_id: Some(source.id.clone()),
                    new_scene_id: Some(new_scene_id.clone()),
                    name: Some(name),
                    activate: Some(request.activate.unwrap_or(false)),
                    identity_allocations: allocations[1..].to_vec(),
                    ..Default::default()
                },
            ))
        }
        "switch_scene" => {
            let scene_id = required(&request.scene_id, "sceneId")?;
            if scene(scene_id).is_none() {
                return Err(format!("scene not found: {scene_id}"));
            }
            if state.active_scene_id == scene_id {
                return Err(format!("scene {scene_id} is already active"));
            }
            Ok((
                vec![affected("scene", scene_id, "opened")],
                LifecycleMutationConsequences {
                    active_scene_id: Some(scene_id.into()),
                    ..Default::default()
                },
            ))
        }
        "rename_scene" => {
            let scene_id = required(&request.scene_id, "sceneId")?;
            let target = scene(scene_id).ok_or_else(|| format!("scene not found: {scene_id}"))?;
            let name = trimmed(&request.name, "scene name")?.ok_or("scene name is required")?;
            if target.name == name {
                return Err("scene name already matches the requested value".into());
            }
            Ok((
                vec![affected("scene", scene_id, "updated")],
                LifecycleMutationConsequences {
                    name: Some(name),
                    ..Default::default()
                },
            ))
        }
        "delete_scene" => {
            let scene_id = required(&request.scene_id, "sceneId")?;
            let target = scene(scene_id).ok_or_else(|| format!("scene not found: {scene_id}"))?;
            if state.scenes.len() < 2 {
                return Err("a project must keep at least one scene".into());
            }
            if target.is_main && request.new_main_scene_id.is_none() {
                return Err("the main scene requires newMainSceneId before deletion".into());
            }
            if request.new_main_scene_id.as_deref() == Some(scene_id) {
                return Err("newMainSceneId cannot be the deleted scene".into());
            }
            if let Some(id) = request.new_main_scene_id.as_deref()
                && scene(id).is_none()
            {
                return Err(format!("scene not found: {id}"));
            }
            if let Some(id) = request.replacement_scene_id.as_deref()
                && scene(id).is_none()
            {
                return Err(format!("scene not found: {id}"));
            }
            let replacement = if state.active_scene_id == scene_id {
                request
                    .replacement_scene_id
                    .clone()
                    .or_else(|| request.new_main_scene_id.clone())
                    .or_else(|| {
                        state
                            .scenes
                            .iter()
                            .find(|scene| scene.is_main)
                            .map(|scene| scene.id.clone())
                    })
                    .or_else(|| {
                        state
                            .scenes
                            .iter()
                            .find(|scene| scene.id != scene_id)
                            .map(|scene| scene.id.clone())
                    })
            } else {
                None
            };
            if replacement.as_deref() == Some(scene_id) {
                return Err("replacement scene cannot be deleted".into());
            }
            let mut affected_objects = vec![];
            if let Some(id) = request.new_main_scene_id.as_deref() {
                affected_objects.push(affected("scene", id, "updated"));
            }
            if let Some(id) = replacement.as_deref() {
                affected_objects.push(affected("scene", id, "opened"));
            }
            affected_objects.push(affected("scene", scene_id, "deleted"));
            Ok((
                affected_objects,
                LifecycleMutationConsequences {
                    new_main_scene_id: request.new_main_scene_id.clone(),
                    replacement_scene_id: replacement,
                    ..Default::default()
                },
            ))
        }
        "set_main_scene" => {
            let scene_id = required(&request.scene_id, "sceneId")?;
            let target = scene(scene_id).ok_or_else(|| format!("scene not found: {scene_id}"))?;
            if target.is_main {
                return Err(format!("scene {scene_id} is already the main scene"));
            }
            Ok((
                vec![affected("scene", scene_id, "updated")],
                LifecycleMutationConsequences {
                    main_scene_id: Some(scene_id.into()),
                    ..Default::default()
                },
            ))
        }
        "reorder_scenes" => {
            let ids = request
                .scene_ids
                .as_ref()
                .filter(|ids| !ids.is_empty())
                .ok_or("sceneIds must be a non-empty string array")?;
            let mut current = state
                .scenes
                .iter()
                .map(|scene| scene.id.clone())
                .collect::<Vec<_>>();
            let mut requested = ids.clone();
            current.sort();
            requested.sort();
            if current != requested || requested.windows(2).any(|pair| pair[0] == pair[1]) {
                return Err("sceneIds must contain every scene exactly once".into());
            }
            if state.scenes.iter().map(|scene| &scene.id).eq(ids.iter()) {
                return Err("scene order already matches the requested order".into());
            }
            Ok((
                ids.iter()
                    .map(|id| affected("scene", id, "updated"))
                    .collect(),
                LifecycleMutationConsequences {
                    scene_ids: ids.clone(),
                    ..Default::default()
                },
            ))
        }
        "import_media_asset" => {
            let replacement = state
                .replacement
                .as_ref()
                .ok_or("replacement media descriptor is required")?;
            let name = trimmed(&request.asset_name, "asset name")?
                .unwrap_or_else(|| replacement.name.clone());
            let asset_id = allocations
                .first()
                .ok_or("media identity allocation is missing")?;
            Ok((
                vec![affected("media", asset_id, "imported")],
                LifecycleMutationConsequences {
                    name: Some(name),
                    media_type: Some(replacement.descriptor.media_type.clone()),
                    size: Some(replacement.descriptor.size),
                    asset_id: Some(asset_id.clone()),
                    ..Default::default()
                },
            ))
        }
        "rename_media_asset" => {
            let asset_id = required(&request.asset_id, "assetId")?;
            let current =
                asset(asset_id).ok_or_else(|| format!("media asset not found: {asset_id}"))?;
            let name = trimmed(&request.name, "asset name")?.ok_or("asset name is required")?;
            if current.name == name {
                return Err("asset name already matches the requested value".into());
            }
            Ok((
                vec![affected("media", asset_id, "updated")],
                LifecycleMutationConsequences {
                    name: Some(name),
                    ..Default::default()
                },
            ))
        }
        "relink_media_asset" => {
            let asset_id = required(&request.asset_id, "assetId")?;
            let current =
                asset(asset_id).ok_or_else(|| format!("media asset not found: {asset_id}"))?;
            let replacement = state
                .replacement
                .as_ref()
                .ok_or("replacement media descriptor is required")?;
            let comparison = evaluate_media_relink_compatibility(EvaluateMediaRelinkOptions {
                current: current.descriptor.clone(),
                replacement: replacement.descriptor.clone(),
            });
            if !comparison.compatible && !request.allow_incompatible.unwrap_or(false) {
                return Err("replacement media type is incompatible".into());
            }
            let usage_count = state
                .usages
                .iter()
                .filter(|usage| usage.asset_id == asset_id)
                .count();
            Ok((
                vec![affected("media", asset_id, "updated")],
                LifecycleMutationConsequences {
                    compatible: Some(comparison.compatible),
                    differences: Some(comparison.differences),
                    usage_count: Some(usage_count),
                    ..Default::default()
                },
            ))
        }
        "remove_media_asset" => {
            let asset_id = required(&request.asset_id, "assetId")?;
            if asset(asset_id).is_none() {
                return Err(format!("media asset not found: {asset_id}"));
            }
            let usages = state
                .usages
                .iter()
                .filter(|usage| usage.asset_id == asset_id)
                .collect::<Vec<_>>();
            if request.policy.as_deref() != Some("cascade") && !usages.is_empty() {
                return Err(format!(
                    "asset {asset_id} is still used {} time(s)",
                    usages.len()
                ));
            }
            let mut removed_ids = usages
                .iter()
                .filter(|usage| usage.kind == "source")
                .map(|usage| usage.element_id.clone())
                .collect::<Vec<_>>();
            removed_ids.sort();
            removed_ids.dedup();
            let mut updated_ids = usages
                .iter()
                .filter(|usage| usage.kind != "source" && !removed_ids.contains(&usage.element_id))
                .map(|usage| usage.element_id.clone())
                .collect::<Vec<_>>();
            updated_ids.sort();
            updated_ids.dedup();
            let mut affected_objects = vec![affected("media", asset_id, "deleted")];
            affected_objects.extend(
                removed_ids
                    .iter()
                    .map(|id| affected("element", id, "deleted")),
            );
            affected_objects.extend(
                updated_ids
                    .iter()
                    .map(|id| affected("element", id, "updated")),
            );
            Ok((
                affected_objects,
                LifecycleMutationConsequences {
                    policy: request.policy.clone(),
                    removed_element_ids: Some(removed_ids),
                    updated_element_ids: Some(updated_ids),
                    ..Default::default()
                },
            ))
        }
        _ => Err(format!(
            "unsupported lifecycle mutation: {}",
            options.method
        )),
    }
}

fn push_media_difference(
    differences: &mut Vec<MediaRelinkDifference>,
    field: &str,
    before: Option<MediaRelinkValue>,
    after: Option<MediaRelinkValue>,
) {
    if before != after {
        differences.push(MediaRelinkDifference {
            field: field.to_owned(),
            before,
            after,
        });
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotVerification {
    pub write_version: u64,
    pub receipt_id: String,
    pub operation_id: String,
    pub verified_at_ms: u64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRetentionState {
    pub first_verified_at_ms: u64,
    pub last_verified_at_ms: u64,
    pub expires_at_ms: u64,
    pub latest_verification: SnapshotVerification,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateSnapshotRetentionOptions {
    pub prior: Option<SnapshotRetentionState>,
    pub verification: SnapshotVerification,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SnapshotRetentionEvaluation {
    Retained { state: SnapshotRetentionState },
    Rejected { reason: String },
}

#[export]
pub fn evaluate_project_snapshot_retention(
    options: EvaluateSnapshotRetentionOptions,
) -> SnapshotRetentionEvaluation {
    match evaluate_retention(options) {
        Ok(state) => SnapshotRetentionEvaluation::Retained { state },
        Err(reason) => SnapshotRetentionEvaluation::Rejected { reason },
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateAutomationOperationPolicyOptions {
    pub method: String,
    pub status: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationOperationPolicy {
    pub durable_success: bool,
    pub retain_snapshot: bool,
}

#[export]
pub fn evaluate_automation_operation_policy(
    options: EvaluateAutomationOperationPolicyOptions,
) -> AutomationOperationPolicy {
    let durable_success = match options.method.as_str() {
        "create_project" => matches!(options.status.as_str(), "created" | "replayed"),
        "open_project" => matches!(options.status.as_str(), "opened" | "replayed"),
        "save_project" => matches!(options.status.as_str(), "saved" | "replayed"),
        "rename_project" => matches!(options.status.as_str(), "renamed" | "replayed"),
        "duplicate_project" => matches!(options.status.as_str(), "duplicated" | "replayed"),
        "delete_project" => matches!(options.status.as_str(), "deleted" | "replayed"),
        "sync_audio"
        | "attach_clean_audio"
        | "apply_edit_plan"
        | "import_media"
        | "import_subtitles"
        | "transcribe_timeline"
        | "attach_matte"
        | "create_scene"
        | "clone_scene"
        | "switch_scene"
        | "rename_scene"
        | "delete_scene"
        | "set_main_scene"
        | "reorder_scenes"
        | "import_media_asset"
        | "rename_media_asset"
        | "relink_media_asset"
        | "remove_media_asset" => matches!(options.status.as_str(), "applied" | "replayed"),
        "undo" => options.status == "undone",
        "redo" => options.status == "redone",
        "restore_history_state" => options.status == "restored",
        "render_preview_frame" => matches!(options.status.as_str(), "rendered" | "replayed"),
        "render_preview_range" => {
            matches!(
                options.status.as_str(),
                "rendered" | "replayed" | "cancelled"
            )
        }
        "compare_project_states" => {
            matches!(
                options.status.as_str(),
                "rendered" | "replayed" | "cancelled"
            )
        }
        _ => false,
    };
    let retain_snapshot = durable_success
        && !matches!(
            options.method.as_str(),
            "open_project"
                | "render_preview_frame"
                | "render_preview_range"
                | "compare_project_states"
        );

    AutomationOperationPolicy {
        durable_success,
        retain_snapshot,
    }
}

fn evaluate_retention(
    options: EvaluateSnapshotRetentionOptions,
) -> Result<SnapshotRetentionState, String> {
    validate_verification(&options.verification)?;
    if let Some(prior) = options.prior.as_ref() {
        validate_state(prior)?;
    }

    let latest_verification = match options.prior.as_ref() {
        Some(prior)
            if prior.latest_verification.verified_at_ms > options.verification.verified_at_ms
                || (prior.latest_verification.verified_at_ms
                    == options.verification.verified_at_ms
                    && prior.latest_verification.write_version
                        >= options.verification.write_version) =>
        {
            prior.latest_verification.clone()
        }
        _ => options.verification,
    };
    let expires_at_ms = latest_verification
        .verified_at_ms
        .checked_add(PROJECT_SNAPSHOT_RETENTION_MS)
        .ok_or_else(|| "snapshot retention expiry overflowed".to_owned())?;

    Ok(SnapshotRetentionState {
        first_verified_at_ms: options
            .prior
            .map(|prior| prior.first_verified_at_ms)
            .unwrap_or(latest_verification.verified_at_ms),
        last_verified_at_ms: latest_verification.verified_at_ms,
        expires_at_ms,
        latest_verification,
    })
}

fn validate_verification(verification: &SnapshotVerification) -> Result<(), String> {
    if verification.write_version == 0
        || verification.receipt_id.is_empty()
        || verification.operation_id.is_empty()
    {
        return Err("snapshot verification identity is invalid".to_owned());
    }
    Ok(())
}

fn validate_state(state: &SnapshotRetentionState) -> Result<(), String> {
    validate_verification(&state.latest_verification)?;
    if state.first_verified_at_ms > state.last_verified_at_ms
        || state.latest_verification.verified_at_ms != state.last_verified_at_ms
        || state.expires_at_ms
            != state
                .last_verified_at_ms
                .checked_add(PROJECT_SNAPSHOT_RETENTION_MS)
                .ok_or_else(|| "snapshot retention expiry overflowed".to_owned())?
    {
        return Err("prior snapshot retention state is invalid".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verification(write_version: u64, verified_at_ms: u64) -> SnapshotVerification {
        SnapshotVerification {
            write_version,
            receipt_id: format!("receipt-{write_version}"),
            operation_id: format!("operation-{write_version}"),
            verified_at_ms,
        }
    }

    fn lifecycle_request(project_id: &str) -> LifecycleMutationRequest {
        LifecycleMutationRequest {
            project_id: project_id.into(),
            expected_revision: Some(7),
            expected_project_content_hash: Some("a".repeat(64)),
            expected_target_content_hash: None,
            expected_target_write_version: None,
            name: None,
            fallback_project_id: None,
            scene_id: None,
            new_scene_id: None,
            activate: None,
            replacement_scene_id: None,
            new_main_scene_id: None,
            scene_ids: None,
            asset_name: None,
            asset_id: None,
            source_fingerprint: None,
            mime_type: None,
            allow_incompatible: None,
            policy: None,
        }
    }

    fn lifecycle_state() -> LifecycleMutationState {
        LifecycleMutationState {
            active_project_id: Some("project-a".into()),
            active_scene_id: "scene-main".into(),
            active_revision: 7,
            active_project_content_hash: "a".repeat(64),
            projects: vec![
                LifecycleProjectSummary {
                    id: "project-a".into(),
                    name: "Example".into(),
                    updated_at_ms: 1.0,
                    content_hash: None,
                    write_version: None,
                },
                LifecycleProjectSummary {
                    id: "project-b".into(),
                    name: "(1) Example".into(),
                    updated_at_ms: 2.0,
                    content_hash: None,
                    write_version: None,
                },
            ],
            scenes: vec![
                LifecycleSceneSummary {
                    id: "scene-main".into(),
                    name: "Main".into(),
                    is_main: true,
                },
                LifecycleSceneSummary {
                    id: "scene-alt".into(),
                    name: "Alt".into(),
                    is_main: false,
                },
            ],
            assets: vec![LifecycleAssetSummary {
                id: "asset-a".into(),
                name: "Video".into(),
                descriptor: MediaRelinkDescriptor {
                    media_type: "video".into(),
                    width: Some(1920),
                    height: Some(1080),
                    duration: Some(10.0),
                    fps: Some(30.0),
                    has_audio: Some(true),
                    size: 100,
                },
            }],
            usages: vec![],
            replacement: None,
            identity_sources: vec![],
        }
    }

    #[test]
    fn lifecycle_delete_resolves_the_exact_fallback_in_rust() {
        let mut state = lifecycle_state();
        state.projects[0].content_hash = Some("target".into());
        state.projects[0].write_version = Some(4);
        let mut request = lifecycle_request("project-a");
        request.expected_target_content_hash = Some("target".into());
        request.expected_target_write_version = Some(4);
        let evaluation = evaluate_lifecycle_mutation(EvaluateLifecycleMutationOptions {
            method: "delete_project".into(),
            request,
            state,
        });
        let LifecycleMutationEvaluation::Validated {
            preflight_fingerprint,
            consequences,
            ..
        } = evaluation
        else {
            panic!("expected a validated deletion")
        };

        assert_eq!(
            consequences.fallback_project_id.as_deref(),
            Some("project-b")
        );
        assert_eq!(consequences.fallback.as_deref(), Some("opened-existing"));
        assert_eq!(consequences.recoverability.as_deref(), Some("irreversible"));
        assert_eq!(preflight_fingerprint.len(), 64);
    }

    #[test]
    fn lifecycle_media_cascade_distinguishes_deleted_and_detached_elements() {
        let mut state = lifecycle_state();
        state.usages = vec![
            LifecycleUsageSummary {
                asset_id: "asset-a".into(),
                element_id: "source".into(),
                kind: "source".into(),
            },
            LifecycleUsageSummary {
                asset_id: "asset-a".into(),
                element_id: "matte-owner".into(),
                kind: "matte".into(),
            },
            LifecycleUsageSummary {
                asset_id: "asset-a".into(),
                element_id: "audio-owner".into(),
                kind: "audio-replacement".into(),
            },
        ];
        let mut request = lifecycle_request("project-a");
        request.asset_id = Some("asset-a".into());
        request.policy = Some("cascade".into());
        let evaluation = evaluate_lifecycle_mutation(EvaluateLifecycleMutationOptions {
            method: "remove_media_asset".into(),
            request,
            state,
        });
        let LifecycleMutationEvaluation::Validated {
            affected_objects,
            consequences,
            ..
        } = evaluation
        else {
            panic!("expected a validated cascade")
        };

        assert_eq!(
            consequences.removed_element_ids.as_deref(),
            Some(&["source".to_string()][..])
        );
        assert_eq!(
            consequences.updated_element_ids.as_deref(),
            Some(&["audio-owner".to_string(), "matte-owner".to_string()][..])
        );
        assert!(affected_objects.contains(&affected("element", "source", "deleted")));
        assert!(affected_objects.contains(&affected("element", "matte-owner", "updated")));
    }

    #[test]
    fn removing_an_unused_asset_reports_explicit_empty_element_lists() {
        let mut request = lifecycle_request("project-a");
        request.asset_id = Some("asset-a".into());
        request.policy = Some("unused-only".into());
        let evaluation = evaluate_lifecycle_mutation(EvaluateLifecycleMutationOptions {
            method: "remove_media_asset".into(),
            request,
            state: lifecycle_state(),
        });
        let LifecycleMutationEvaluation::Validated { consequences, .. } = evaluation else {
            panic!("expected a validated remove")
        };

        assert_eq!(consequences.removed_element_ids, Some(vec![]));
        assert_eq!(consequences.updated_element_ids, Some(vec![]));
        let serialized = serde_json::to_value(&consequences).unwrap();
        assert_eq!(serialized["removedElementIds"], serde_json::json!([]));
        assert_eq!(serialized["updatedElementIds"], serde_json::json!([]));
    }

    #[test]
    fn identical_relink_reports_an_explicit_empty_diff() {
        let mut state = lifecycle_state();
        state.replacement = Some(LifecycleReplacementSummary {
            name: "Video".into(),
            descriptor: state.assets[0].descriptor.clone(),
        });
        let mut request = lifecycle_request("project-a");
        request.asset_id = Some("asset-a".into());
        let evaluation = evaluate_lifecycle_mutation(EvaluateLifecycleMutationOptions {
            method: "relink_media_asset".into(),
            request,
            state,
        });
        let LifecycleMutationEvaluation::Validated { consequences, .. } = evaluation else {
            panic!("expected a validated relink")
        };

        assert_eq!(consequences.compatible, Some(true));
        assert_eq!(consequences.differences, Some(vec![]));
        let serialized = serde_json::to_value(&consequences).unwrap();
        assert_eq!(serialized["differences"], serde_json::json!([]));
    }

    #[test]
    fn lifecycle_preconditions_and_generated_ids_are_rust_authoritative() {
        let mut state = lifecycle_state();
        state.identity_sources = vec!["scene".into(), "main-track".into()];
        let mut request = lifecycle_request("project-a");
        request.name = Some(" Variant ".into());
        request.activate = Some(true);
        let options = EvaluateLifecycleMutationOptions {
            method: "create_scene".into(),
            request: request.clone(),
            state: state.clone(),
        };
        let first = evaluate_lifecycle_mutation(options.clone());
        let second = evaluate_lifecycle_mutation(options);
        assert_eq!(first, second);
        let LifecycleMutationEvaluation::Validated {
            affected_objects,
            consequences,
            ..
        } = first
        else {
            panic!("expected a validated create")
        };
        assert_eq!(consequences.name.as_deref(), Some("Variant"));
        assert_eq!(consequences.activate, Some(true));
        assert_eq!(
            Some(affected_objects[0].object_id.as_str()),
            consequences.scene_id.as_deref()
        );
        assert_ne!(consequences.scene_id, consequences.main_track_id);

        request.expected_revision = Some(8);
        assert!(matches!(
            evaluate_lifecycle_mutation(EvaluateLifecycleMutationOptions {
                method: "create_scene".into(),
                request,
                state,
            }),
            LifecycleMutationEvaluation::Rejected { reason }
                if reason == "project revision changed before lifecycle preflight"
        ));
    }

    #[test]
    fn media_relink_policy_reports_every_consequence_and_type_compatibility() {
        let evaluation = evaluate_media_relink_compatibility(EvaluateMediaRelinkOptions {
            current: MediaRelinkDescriptor {
                media_type: "video".into(),
                width: Some(1920),
                height: Some(1080),
                duration: Some(10.0),
                fps: Some(30.0),
                has_audio: Some(true),
                size: 100,
            },
            replacement: MediaRelinkDescriptor {
                media_type: "image".into(),
                width: Some(1080),
                height: Some(1080),
                duration: None,
                fps: None,
                has_audio: None,
                size: 50,
            },
        });

        assert!(!evaluation.compatible);
        assert_eq!(
            evaluation
                .differences
                .iter()
                .map(|difference| difference.field.as_str())
                .collect::<Vec<_>>(),
            vec!["type", "width", "duration", "fps", "hasAudio", "size"]
        );
    }

    #[test]
    fn starts_a_ninety_day_retention_window() {
        let result = evaluate_retention(EvaluateSnapshotRetentionOptions {
            prior: None,
            verification: verification(7, 1_000),
        })
        .unwrap();

        assert_eq!(result.first_verified_at_ms, 1_000);
        assert_eq!(result.last_verified_at_ms, 1_000);
        assert_eq!(result.expires_at_ms, 1_000 + PROJECT_SNAPSHOT_RETENTION_MS);
    }

    #[test]
    fn a_stale_verifier_cannot_shorten_a_newer_window() {
        let prior = evaluate_retention(EvaluateSnapshotRetentionOptions {
            prior: None,
            verification: verification(8, 2_000),
        })
        .unwrap();
        let result = evaluate_retention(EvaluateSnapshotRetentionOptions {
            prior: Some(prior.clone()),
            verification: verification(7, 1_000),
        })
        .unwrap();

        assert_eq!(result, prior);
    }

    #[test]
    fn a_fresh_verification_extends_the_window() {
        let prior = evaluate_retention(EvaluateSnapshotRetentionOptions {
            prior: None,
            verification: verification(7, 1_000),
        })
        .unwrap();
        let result = evaluate_retention(EvaluateSnapshotRetentionOptions {
            prior: Some(prior),
            verification: verification(7, 2_000),
        })
        .unwrap();

        assert_eq!(result.first_verified_at_ms, 1_000);
        assert_eq!(result.last_verified_at_ms, 2_000);
        assert_eq!(result.latest_verification.operation_id, "operation-7");
    }

    #[test]
    fn mutating_successes_retain_snapshots() {
        for (method, status) in [
            ("create_project", "created"),
            ("save_project", "saved"),
            ("sync_audio", "applied"),
            ("attach_clean_audio", "applied"),
            ("apply_edit_plan", "applied"),
            ("undo", "undone"),
            ("import_media", "applied"),
            ("import_subtitles", "applied"),
            ("transcribe_timeline", "applied"),
            ("attach_matte", "applied"),
            ("rename_project", "renamed"),
            ("duplicate_project", "duplicated"),
            ("delete_project", "deleted"),
            ("create_scene", "applied"),
            ("clone_scene", "applied"),
            ("switch_scene", "applied"),
            ("rename_scene", "applied"),
            ("delete_scene", "applied"),
            ("set_main_scene", "applied"),
            ("reorder_scenes", "applied"),
            ("import_media_asset", "applied"),
            ("rename_media_asset", "applied"),
            ("relink_media_asset", "applied"),
            ("remove_media_asset", "applied"),
            ("redo", "redone"),
            ("restore_history_state", "restored"),
        ] {
            assert_eq!(
                evaluate_automation_operation_policy(EvaluateAutomationOperationPolicyOptions {
                    method: method.to_owned(),
                    status: status.to_owned(),
                }),
                AutomationOperationPolicy {
                    durable_success: true,
                    retain_snapshot: true,
                },
                "{method}/{status}",
            );
        }
    }

    #[test]
    fn read_only_successes_are_durable_without_extending_retention() {
        for (method, status) in [
            ("open_project", "opened"),
            ("render_preview_frame", "rendered"),
            ("render_preview_range", "rendered"),
            ("render_preview_range", "cancelled"),
            ("compare_project_states", "rendered"),
            ("compare_project_states", "cancelled"),
        ] {
            assert_eq!(
                evaluate_automation_operation_policy(EvaluateAutomationOperationPolicyOptions {
                    method: method.to_owned(),
                    status: status.to_owned(),
                }),
                AutomationOperationPolicy {
                    durable_success: true,
                    retain_snapshot: false,
                },
                "{method}/{status}",
            );
        }
    }

    #[test]
    fn failures_and_unknown_operations_are_not_durable() {
        for (method, status) in [("save_project", "rejected"), ("unknown", "applied")] {
            assert_eq!(
                evaluate_automation_operation_policy(EvaluateAutomationOperationPolicyOptions {
                    method: method.to_owned(),
                    status: status.to_owned(),
                }),
                AutomationOperationPolicy {
                    durable_success: false,
                    retain_snapshot: false,
                },
                "{method}/{status}",
            );
        }
    }
}
