use bridge::export;
use serde::{Deserialize, Serialize};

use crate::{Params, Scalar, TransitionType};

pub const MEDIA_TREATMENT_CATALOG_SCHEMA_VERSION: &str = "opencut.media-treatment-catalog.v1";
pub const TRANSITION_CATALOG_SCHEMA_VERSION: &str = "opencut.transition-catalog.v1";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TreatmentKind {
    VisualEffect,
    MotionPreset,
    RetimeCurve,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogParameterType {
    Number,
    Integer,
    Boolean,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogParameter {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub parameter_type: CatalogParameterType,
    pub default: Scalar,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub step: Option<f64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentApplicability {
    pub element_types: Vec<String>,
    pub track_types: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TreatmentReadinessStatus {
    ReferenceMissing,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentReadiness {
    pub status: TreatmentReadinessStatus,
    pub reason: String,
    pub reference: Option<String>,
    pub tolerance: Option<f64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTreatmentDefinition {
    pub id: String,
    pub name: String,
    pub kind: TreatmentKind,
    pub parameters: Vec<CatalogParameter>,
    pub applicability: TreatmentApplicability,
    pub readiness: TreatmentReadiness,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTreatmentCatalog {
    pub schema_version: String,
    pub treatments: Vec<MediaTreatmentDefinition>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MediaTreatmentLookupResponse {
    Found { catalog: MediaTreatmentCatalog },
    Unknown { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreatmentValidationKind {
    UnknownId,
    Inapplicable,
    UnknownParameter,
    InvalidType,
    Bounds,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreatmentValidationError {
    pub kind: TreatmentValidationKind,
    pub reason: String,
    pub path: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveMediaTreatmentOptions {
    pub treatment_id: String,
    pub element_type: String,
    pub existing_params: Option<Params>,
    pub requested_params: Option<Params>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ResolveMediaTreatmentResponse {
    Resolved { params: Params },
    NotTreatment { reserved_namespace: bool },
    Rejected { reason: String, path: String },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TransitionBoundaryPolicy {
    Supported,
    Unsupported,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDurationRule {
    pub unit: String,
    pub default: i64,
    pub minimum: i64,
    pub maximum: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDefinition {
    pub id: String,
    pub name: String,
    pub track_types: Vec<String>,
    pub requires_adjacent_elements: bool,
    pub maximum_incoming_per_element: u32,
    pub duration: TransitionDurationRule,
    pub compound_boundary_policy: TransitionBoundaryPolicy,
    pub masked_incoming_policy: TransitionBoundaryPolicy,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionCatalog {
    pub schema_version: String,
    pub transitions: Vec<TransitionDefinition>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TransitionLookupResponse {
    Found { catalog: TransitionCatalog },
    Unknown { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionValidationKind {
    Invalid,
    Incompatible,
    Bounds,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransitionValidationError {
    pub kind: TransitionValidationKind,
    pub reason: String,
    pub path: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionBoundaryElement {
    pub id: String,
    #[serde(rename = "type")]
    pub element_type: String,
    pub start_time: i64,
    pub duration: i64,
    pub has_masks: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateTransitionOptions {
    pub transition_id: String,
    pub transition_type: String,
    pub track_type: String,
    pub from_element: TransitionBoundaryElement,
    pub to_element: TransitionBoundaryElement,
    pub duration: i64,
    pub existing_incoming_transition_id: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum EvaluateTransitionResponse {
    Validated,
    Rejected { reason: String, path: String },
}

fn number_parameter(
    id: &str,
    label: &str,
    default: f64,
    minimum: f64,
    maximum: f64,
) -> CatalogParameter {
    CatalogParameter {
        id: id.to_owned(),
        label: label.to_owned(),
        parameter_type: CatalogParameterType::Number,
        default: Scalar::Number(default),
        minimum: Some(minimum),
        maximum: Some(maximum),
        step: Some(0.01),
    }
}

fn duration_parameter() -> CatalogParameter {
    CatalogParameter {
        id: "durationTicks".to_owned(),
        label: "Duration".to_owned(),
        parameter_type: CatalogParameterType::Integer,
        default: Scalar::Number(60_000.0),
        minimum: Some(1.0),
        maximum: Some(1_200_000.0),
        step: Some(1.0),
    }
}

fn treatment(
    id: &str,
    name: &str,
    kind: TreatmentKind,
    element_types: &[&str],
    parameters: Vec<CatalogParameter>,
) -> MediaTreatmentDefinition {
    let track_types = element_types
        .iter()
        .map(|element_type| match *element_type {
            "text" => "text",
            "graphic" | "sticker" => "graphic",
            _ => "video",
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(str::to_owned)
        .collect();
    MediaTreatmentDefinition {
        id: id.to_owned(),
        name: name.to_owned(),
        kind,
        parameters,
        applicability: TreatmentApplicability {
            element_types: element_types.iter().map(|value| (*value).to_owned()).collect(),
            track_types,
        },
        readiness: TreatmentReadiness {
            status: TreatmentReadinessStatus::ReferenceMissing,
            reason: "Owner reference clip or frame and numeric tolerance are not recorded in audit row E. Rendering remains unavailable.".to_owned(),
            reference: None,
            tolerance: None,
        },
    }
}

fn mix_parameter() -> CatalogParameter {
    number_parameter("mix", "Mix", 1.0, 0.0, 1.0)
}

pub fn media_treatment_definitions() -> Vec<MediaTreatmentDefinition> {
    const VISUAL: &[&str] = &["video", "image", "text", "sticker", "graphic"];
    const VIDEO_IMAGE: &[&str] = &["video", "image"];
    let visual = |id: &str, name: &str| {
        treatment(
            id,
            name,
            TreatmentKind::VisualEffect,
            VISUAL,
            vec![mix_parameter()],
        )
    };
    let timed = |id: &str, name: &str| {
        treatment(
            id,
            name,
            TreatmentKind::MotionPreset,
            VISUAL,
            vec![mix_parameter(), duration_parameter()],
        )
    };
    vec![
        treatment(
            "simple-media.film-frame",
            "Film Frame",
            TreatmentKind::VisualEffect,
            VIDEO_IMAGE,
            vec![mix_parameter()],
        ),
        timed("simple-media.play-pendulum", "Play Pendulum"),
        visual("simple-media.technicolor-flash", "Technicolor Flash"),
        visual("simple-media.scanner-bar", "Scanner Bar"),
        visual("simple-media.glitch", "Glitch"),
        visual("simple-media.chromatic", "Chromatic"),
        visual("simple-media.dark-night", "Dark Night"),
        visual("simple-media.mirror", "Mirror"),
        visual("simple-media.body-treatment", "Body Treatment"),
        visual("simple-media.meme-treatment", "Meme Treatment"),
        timed("simple-media.pull-in", "Pull In"),
        timed("simple-media.pull-out", "Pull Out"),
        timed("simple-media.swipe-left", "Swipe Left"),
        treatment(
            "simple-media.montage-curve",
            "Montage Curve",
            TreatmentKind::RetimeCurve,
            &["video"],
            vec![mix_parameter(), duration_parameter()],
        ),
    ]
}

pub fn media_treatment_definition(id: &str) -> Option<MediaTreatmentDefinition> {
    media_treatment_definitions()
        .into_iter()
        .find(|definition| definition.id == id)
}

pub fn resolve_treatment_parameters(
    treatment_id: &str,
    element_type: &str,
    existing: Option<&Params>,
    requested: Option<&Params>,
) -> Result<Params, TreatmentValidationError> {
    let definition =
        media_treatment_definition(treatment_id).ok_or_else(|| TreatmentValidationError {
            kind: TreatmentValidationKind::UnknownId,
            reason: format!("unknown treatment ID: {treatment_id}"),
            path: "effectType".to_owned(),
        })?;
    if !definition
        .applicability
        .element_types
        .iter()
        .any(|candidate| candidate == element_type)
    {
        return Err(TreatmentValidationError {
            kind: TreatmentValidationKind::Inapplicable,
            reason: format!(
                "treatment {treatment_id} is not applicable to {element_type} elements"
            ),
            path: "elementId".to_owned(),
        });
    }
    let mut params = definition
        .parameters
        .iter()
        .map(|parameter| (parameter.id.clone(), parameter.default.clone()))
        .collect::<Params>();
    for source in [existing, requested].into_iter().flatten() {
        for (key, value) in source {
            let parameter = definition
                .parameters
                .iter()
                .find(|parameter| parameter.id == *key)
                .ok_or_else(|| TreatmentValidationError {
                    kind: TreatmentValidationKind::UnknownParameter,
                    reason: format!("treatment {treatment_id} has no parameter {key}"),
                    path: key.clone(),
                })?;
            let Scalar::Number(number) = value else {
                return Err(TreatmentValidationError {
                    kind: TreatmentValidationKind::InvalidType,
                    reason: format!("invalid value for treatment parameter {key}"),
                    path: key.clone(),
                });
            };
            if !number.is_finite()
                || parameter.minimum.is_some_and(|minimum| *number < minimum)
                || parameter.maximum.is_some_and(|maximum| *number > maximum)
                || (parameter.parameter_type == CatalogParameterType::Integer
                    && number.fract() != 0.0)
            {
                return Err(TreatmentValidationError {
                    kind: TreatmentValidationKind::Bounds,
                    reason: format!("treatment parameter {key} is outside supported bounds"),
                    path: key.clone(),
                });
            }
            params.insert(key.clone(), value.clone());
        }
    }
    Ok(params)
}

#[export]
pub fn resolve_media_treatment(
    options: ResolveMediaTreatmentOptions,
) -> ResolveMediaTreatmentResponse {
    match resolve_treatment_parameters(
        &options.treatment_id,
        &options.element_type,
        options.existing_params.as_ref(),
        options.requested_params.as_ref(),
    ) {
        Ok(params) => ResolveMediaTreatmentResponse::Resolved { params },
        Err(error) if error.kind == TreatmentValidationKind::UnknownId => {
            ResolveMediaTreatmentResponse::NotTreatment {
                reserved_namespace: options.treatment_id.starts_with("simple-media."),
            }
        }
        Err(error) => ResolveMediaTreatmentResponse::Rejected {
            reason: error.reason,
            path: error.path,
        },
    }
}

#[export]
pub fn media_treatment_catalog() -> MediaTreatmentCatalog {
    MediaTreatmentCatalog {
        schema_version: MEDIA_TREATMENT_CATALOG_SCHEMA_VERSION.to_owned(),
        treatments: media_treatment_definitions(),
    }
}

#[export]
pub fn find_media_treatment(treatment_id: String) -> MediaTreatmentLookupResponse {
    let Some(treatment) = media_treatment_definition(&treatment_id) else {
        return MediaTreatmentLookupResponse::Unknown {
            reason: format!("unknown treatment ID: {treatment_id}"),
        };
    };
    MediaTreatmentLookupResponse::Found {
        catalog: MediaTreatmentCatalog {
            schema_version: MEDIA_TREATMENT_CATALOG_SCHEMA_VERSION.to_owned(),
            treatments: vec![treatment],
        },
    }
}

fn transition(
    transition_type: TransitionType,
    compound_boundary_policy: TransitionBoundaryPolicy,
    masked_incoming_policy: TransitionBoundaryPolicy,
) -> TransitionDefinition {
    let name = match transition_type {
        TransitionType::Crossfade => "Crossfade",
        TransitionType::FadeThroughBlack => "Fade Through Black",
        TransitionType::Slide => "Slide",
        TransitionType::Wipe => "Wipe",
        TransitionType::Zoom => "Zoom",
    };
    TransitionDefinition {
        id: transition_type.as_str().to_owned(),
        name: name.to_owned(),
        track_types: vec!["video".to_owned()],
        requires_adjacent_elements: true,
        maximum_incoming_per_element: 1,
        duration: TransitionDurationRule {
            unit: "media-ticks".to_owned(),
            default: 30_000,
            minimum: 1,
            maximum: "shorter-element".to_owned(),
        },
        compound_boundary_policy,
        masked_incoming_policy,
    }
}

pub fn transition_definitions() -> Vec<TransitionDefinition> {
    use TransitionBoundaryPolicy::{Supported, Unsupported};
    TransitionType::ALL
        .into_iter()
        .map(|transition_type| {
            let compound = match transition_type {
                TransitionType::Crossfade | TransitionType::FadeThroughBlack => Supported,
                TransitionType::Slide | TransitionType::Wipe | TransitionType::Zoom => Unsupported,
            };
            let masked = match transition_type {
                TransitionType::Wipe => Unsupported,
                _ => Supported,
            };
            transition(transition_type, compound, masked)
        })
        .collect()
}

pub fn transition_definition(id: &str) -> Option<TransitionDefinition> {
    transition_definitions()
        .into_iter()
        .find(|definition| definition.id == id)
}

pub fn validate_transition_request(
    options: &EvaluateTransitionOptions,
) -> Result<(), TransitionValidationError> {
    validate_transition(options, true)
}

pub fn validate_stored_transition(
    options: &EvaluateTransitionOptions,
) -> Result<(), TransitionValidationError> {
    validate_transition(options, true)
}

fn validate_transition(
    options: &EvaluateTransitionOptions,
    require_adjacency: bool,
) -> Result<(), TransitionValidationError> {
    let definition = transition_definition(&options.transition_type).ok_or_else(|| {
        TransitionValidationError {
            kind: TransitionValidationKind::Invalid,
            reason: format!("unknown transition ID: {}", options.transition_type),
            path: "transitionType".to_owned(),
        }
    })?;
    if !definition
        .track_types
        .iter()
        .any(|track_type| track_type == &options.track_type)
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Incompatible,
            reason: "transitions require a video track".to_owned(),
            path: "trackId".to_owned(),
        });
    }
    if options.from_element.id == options.to_element.id {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Invalid,
            reason: "transition endpoints must differ".to_owned(),
            path: "toElementId".to_owned(),
        });
    }
    if options.duration < definition.duration.minimum
        || options.duration > options.from_element.duration
        || options.duration > options.to_element.duration
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Bounds,
            reason: "transition duration must be positive and no longer than either element"
                .to_owned(),
            path: "duration".to_owned(),
        });
    }
    if require_adjacency
        && options
            .from_element
            .start_time
            .checked_add(options.from_element.duration)
            != Some(options.to_element.start_time)
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Invalid,
            reason: "transition elements must be consecutive and edge-adjacent".to_owned(),
            path: "fromElementId".to_owned(),
        });
    }
    if options
        .existing_incoming_transition_id
        .as_ref()
        .is_some_and(|existing| existing != &options.transition_id)
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Invalid,
            reason: "incoming element already has another transition".to_owned(),
            path: "transitionId".to_owned(),
        });
    }
    if (options.from_element.element_type == "compound"
        || options.to_element.element_type == "compound")
        && definition.compound_boundary_policy == TransitionBoundaryPolicy::Unsupported
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Incompatible,
            reason: format!(
                "transition {} does not support compound boundaries",
                options.transition_type
            ),
            path: "transitionType".to_owned(),
        });
    }
    if options.to_element.has_masks
        && definition.masked_incoming_policy == TransitionBoundaryPolicy::Unsupported
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Incompatible,
            reason: format!(
                "transition {} does not support masked incoming clips",
                options.transition_type
            ),
            path: "transitionType".to_owned(),
        });
    }
    Ok(())
}

#[export]
pub fn evaluate_transition(options: EvaluateTransitionOptions) -> EvaluateTransitionResponse {
    match validate_transition_request(&options) {
        Ok(()) => EvaluateTransitionResponse::Validated,
        Err(error) => EvaluateTransitionResponse::Rejected {
            reason: error.reason,
            path: error.path,
        },
    }
}

#[export]
pub fn evaluate_stored_transition(
    options: EvaluateTransitionOptions,
) -> EvaluateTransitionResponse {
    match validate_stored_transition(&options) {
        Ok(()) => EvaluateTransitionResponse::Validated,
        Err(error) => EvaluateTransitionResponse::Rejected {
            reason: error.reason,
            path: error.path,
        },
    }
}

#[export]
pub fn transition_catalog() -> TransitionCatalog {
    TransitionCatalog {
        schema_version: TRANSITION_CATALOG_SCHEMA_VERSION.to_owned(),
        transitions: transition_definitions(),
    }
}

#[export]
pub fn find_transition(transition_id: String) -> TransitionLookupResponse {
    let Some(transition) = transition_definition(&transition_id) else {
        return TransitionLookupResponse::Unknown {
            reason: format!("unknown transition ID: {transition_id}"),
        };
    };
    TransitionLookupResponse::Found {
        catalog: TransitionCatalog {
            schema_version: TRANSITION_CATALOG_SCHEMA_VERSION.to_owned(),
            transitions: vec![transition],
        },
    }
}
