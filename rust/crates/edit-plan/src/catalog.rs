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
    Ready,
    ReferenceMissing,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TreatmentImplementation {
    #[serde(rename = "opencut-defined-v1")]
    OpenCutDefinedV1,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalEquivalence {
    NotClaimed,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentReadiness {
    pub status: TreatmentReadinessStatus,
    pub reason: String,
    pub implementation: TreatmentImplementation,
    pub external_equivalence: ExternalEquivalence,
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
    pub behavior: String,
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
    pub track_type: String,
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
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveMediaTreatmentRenderOptions {
    pub treatment_id: String,
    pub params: Params,
    pub local_time: i64,
    pub duration: i64,
    pub canvas_width: f64,
    pub canvas_height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentRenderPass {
    pub shader: String,
    pub uniforms: std::collections::BTreeMap<String, f64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreatmentMotion {
    pub scale_x: f64,
    pub scale_y: f64,
    pub position_x: f64,
    pub position_y: f64,
    pub rotation_degrees: f64,
    pub opacity_multiplier: f64,
}

impl Default for TreatmentMotion {
    fn default() -> Self {
        Self {
            scale_x: 1.0,
            scale_y: 1.0,
            position_x: 0.0,
            position_y: 0.0,
            rotation_degrees: 0.0,
            opacity_multiplier: 1.0,
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ResolveMediaTreatmentRenderResponse {
    Resolved {
        passes: Vec<TreatmentRenderPass>,
        motion: TreatmentMotion,
        source_progress: Option<f64>,
    },
    NotTreatment,
    Rejected {
        reason: String,
    },
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
    pub from_element_id: String,
    pub to_element_id: String,
    pub track_elements: Vec<TransitionBoundaryElement>,
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

#[derive(Clone, Copy)]
enum TreatmentParameterProfile {
    Mix,
    Timed,
}

#[derive(Clone, Copy)]
enum TreatmentRenderKind {
    Shader(f64),
    Pendulum,
    PullIn,
    PullOut,
    SwipeLeft,
    MontageCurve,
}

#[derive(Clone, Copy)]
struct MediaTreatmentDescriptor {
    id: &'static str,
    name: &'static str,
    kind: TreatmentKind,
    behavior: &'static str,
    element_types: &'static [&'static str],
    parameters: TreatmentParameterProfile,
    render: TreatmentRenderKind,
}

impl MediaTreatmentDescriptor {
    fn definition(self) -> MediaTreatmentDefinition {
        let track_types = self
            .element_types
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
        let mut parameters = vec![mix_parameter()];
        if matches!(self.parameters, TreatmentParameterProfile::Timed) {
            parameters.push(duration_parameter());
        }
        MediaTreatmentDefinition {
            id: self.id.to_owned(),
            name: self.name.to_owned(),
            kind: self.kind,
            behavior: self.behavior.to_owned(),
            parameters,
            applicability: TreatmentApplicability {
                element_types: self
                    .element_types
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                track_types,
            },
            readiness: TreatmentReadiness {
                status: TreatmentReadinessStatus::Ready,
                reason: "Deterministic OpenCut-defined renderer behavior is available; external Simple Media pixel equivalence is not claimed.".to_owned(),
                implementation: TreatmentImplementation::OpenCutDefinedV1,
                external_equivalence: ExternalEquivalence::NotClaimed,
                reference: None,
                tolerance: None,
            },
        }
    }
}

const VISUAL_ELEMENT_TYPES: &[&str] = &["video", "image", "text", "sticker", "graphic"];
const VIDEO_IMAGE_ELEMENT_TYPES: &[&str] = &["video", "image"];
const VIDEO_ELEMENT_TYPES: &[&str] = &["video"];

const MEDIA_TREATMENTS: &[MediaTreatmentDescriptor] = &[
    MediaTreatmentDescriptor {
        id: "simple-media.film-frame",
        name: "Film Frame",
        kind: TreatmentKind::VisualEffect,
        behavior: "Adds a dark film gate, vignette, deterministic grain, and a time-varying vertical scratch.",
        element_types: VIDEO_IMAGE_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(0.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.play-pendulum",
        name: "Play Pendulum",
        kind: TreatmentKind::MotionPreset,
        behavior: "Rotates around center through one damp-free 12-degree sinusoidal pendulum cycle over durationTicks, then rests.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Timed,
        render: TreatmentRenderKind::Pendulum,
    },
    MediaTreatmentDescriptor {
        id: "simple-media.technicolor-flash",
        name: "Technicolor Flash",
        kind: TreatmentKind::VisualEffect,
        behavior: "Adds a time-varying three-channel exposure flash with alternating red, green, and blue emphasis.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(1.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.scanner-bar",
        name: "Scanner Bar",
        kind: TreatmentKind::VisualEffect,
        behavior: "Moves a narrow cyan-white luminance bar from top to bottom while slightly cooling the underlying image.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(2.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.glitch",
        name: "Glitch",
        kind: TreatmentKind::VisualEffect,
        behavior: "Applies deterministic horizontal scan-band displacement, RGB separation, and intermittent luminance blocks.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(3.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.chromatic",
        name: "Chromatic",
        kind: TreatmentKind::VisualEffect,
        behavior: "Separates red and blue channels horizontally while preserving the green channel.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(4.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.dark-night",
        name: "Dark Night",
        kind: TreatmentKind::VisualEffect,
        behavior: "Applies a low-exposure blue night grade with center-weighted illumination.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(5.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.mirror",
        name: "Mirror",
        kind: TreatmentKind::VisualEffect,
        behavior: "Reflects the left half of the frame across the vertical center line.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(6.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.body-treatment",
        name: "Body Treatment",
        kind: TreatmentKind::VisualEffect,
        behavior: "Applies a warm center spotlight, increased contrast, and edge falloff intended for a centered subject.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(7.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.meme-treatment",
        name: "Meme Treatment",
        kind: TreatmentKind::VisualEffect,
        behavior: "Applies high contrast, boosted saturation, a bright center, and a dark caption-safe frame.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::Shader(8.0),
    },
    MediaTreatmentDescriptor {
        id: "simple-media.pull-in",
        name: "Pull In",
        kind: TreatmentKind::MotionPreset,
        behavior: "Animates scale from 1.18 to 1.0 with smoothstep easing over durationTicks, then rests.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Timed,
        render: TreatmentRenderKind::PullIn,
    },
    MediaTreatmentDescriptor {
        id: "simple-media.pull-out",
        name: "Pull Out",
        kind: TreatmentKind::MotionPreset,
        behavior: "Animates scale from 0.82 to 1.0 with smoothstep easing over durationTicks, then rests.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Timed,
        render: TreatmentRenderKind::PullOut,
    },
    MediaTreatmentDescriptor {
        id: "simple-media.swipe-left",
        name: "Swipe Left",
        kind: TreatmentKind::MotionPreset,
        behavior: "Animates from one canvas width right to the resting position with smoothstep easing and a matching fade-in over durationTicks.",
        element_types: VISUAL_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Timed,
        render: TreatmentRenderKind::SwipeLeft,
    },
    MediaTreatmentDescriptor {
        id: "simple-media.montage-curve",
        name: "Montage Curve",
        kind: TreatmentKind::RetimeCurve,
        behavior: "Maps normalized source time through smoothstep; mix interpolates from linear time to the monotonic endpoint-preserving curve.",
        element_types: VIDEO_ELEMENT_TYPES,
        parameters: TreatmentParameterProfile::Mix,
        render: TreatmentRenderKind::MontageCurve,
    },
];

fn mix_parameter() -> CatalogParameter {
    number_parameter("mix", "Mix", 1.0, 0.0, 1.0)
}

pub fn media_treatment_definitions() -> Vec<MediaTreatmentDefinition> {
    MEDIA_TREATMENTS
        .iter()
        .copied()
        .map(MediaTreatmentDescriptor::definition)
        .collect()
}

pub fn media_treatment_definition(id: &str) -> Option<MediaTreatmentDefinition> {
    media_treatment_descriptor(id).map(|descriptor| descriptor.definition())
}

fn media_treatment_descriptor(id: &str) -> Option<&'static MediaTreatmentDescriptor> {
    MEDIA_TREATMENTS
        .iter()
        .find(|descriptor| descriptor.id == id)
}

pub fn resolve_treatment_parameters(
    treatment_id: &str,
    element_type: &str,
    track_type: &str,
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
    if !definition
        .applicability
        .track_types
        .iter()
        .any(|candidate| candidate == track_type)
    {
        return Err(TreatmentValidationError {
            kind: TreatmentValidationKind::Inapplicable,
            reason: format!("treatment {treatment_id} is not applicable to {track_type} tracks"),
            path: "trackId".to_owned(),
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
        &options.track_type,
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
pub fn resolve_media_treatment_render(
    options: ResolveMediaTreatmentRenderOptions,
) -> ResolveMediaTreatmentRenderResponse {
    let Some(descriptor) = media_treatment_descriptor(&options.treatment_id) else {
        return if options.treatment_id.starts_with("simple-media.") {
            ResolveMediaTreatmentRenderResponse::Rejected {
                reason: format!("unknown treatment ID: {}", options.treatment_id),
            }
        } else {
            ResolveMediaTreatmentRenderResponse::NotTreatment
        };
    };
    let definition = descriptor.definition();
    if options.local_time < 0
        || options.duration <= 0
        || !options.canvas_width.is_finite()
        || !options.canvas_height.is_finite()
        || options.canvas_width <= 0.0
        || options.canvas_height <= 0.0
    {
        return ResolveMediaTreatmentRenderResponse::Rejected {
            reason: "treatment render time and canvas dimensions must be positive".to_owned(),
        };
    }
    let params = match resolve_treatment_parameters(
        &options.treatment_id,
        &definition.applicability.element_types[0],
        &definition.applicability.track_types[0],
        None,
        Some(&options.params),
    ) {
        Ok(params) => params,
        Err(error) => {
            return ResolveMediaTreatmentRenderResponse::Rejected {
                reason: error.reason,
            };
        }
    };
    let mix = match params.get("mix") {
        Some(Scalar::Number(value)) => *value,
        _ => 1.0,
    };
    let progress = (options.local_time as f64 / options.duration as f64).clamp(0.0, 1.0);
    let timed_progress = match params.get("durationTicks") {
        Some(Scalar::Number(value)) => (options.local_time as f64 / *value).clamp(0.0, 1.0),
        _ => progress,
    };
    let eased = timed_progress * timed_progress * (3.0 - 2.0 * timed_progress);
    let mut motion = TreatmentMotion::default();
    let mut source_progress = None;
    let visual_mode = match descriptor.render {
        TreatmentRenderKind::Shader(mode) => Some(mode),
        TreatmentRenderKind::Pendulum => {
            motion.rotation_degrees = (timed_progress * std::f64::consts::TAU).sin() * 12.0 * mix;
            None
        }
        TreatmentRenderKind::PullIn => {
            let scale = 1.0 + (1.0 - eased) * 0.18 * mix;
            motion.scale_x = scale;
            motion.scale_y = scale;
            None
        }
        TreatmentRenderKind::PullOut => {
            let scale = 1.0 - (1.0 - eased) * 0.18 * mix;
            motion.scale_x = scale;
            motion.scale_y = scale;
            None
        }
        TreatmentRenderKind::SwipeLeft => {
            motion.position_x = options.canvas_width * (1.0 - eased) * mix;
            motion.opacity_multiplier = 1.0 - (1.0 - timed_progress) * mix;
            None
        }
        TreatmentRenderKind::MontageCurve => {
            let curved = progress * progress * (3.0 - 2.0 * progress);
            source_progress = Some(progress + (curved - progress) * mix);
            None
        }
    };
    let passes = visual_mode
        .map(|mode| TreatmentRenderPass {
            shader: "named-treatment".to_owned(),
            uniforms: std::collections::BTreeMap::from([
                ("u_mode".to_owned(), mode),
                ("u_mix".to_owned(), mix),
                ("u_progress".to_owned(), progress),
            ]),
        })
        .into_iter()
        .collect();
    ResolveMediaTreatmentRenderResponse::Resolved {
        passes,
        motion,
        source_progress,
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
    if options.from_element_id == options.to_element_id {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Invalid,
            reason: "transition endpoints must differ".to_owned(),
            path: "toElementId".to_owned(),
        });
    }

    let endpoint = |id: &str, path: &str| {
        let mut matches = options
            .track_elements
            .iter()
            .filter(|element| element.id == id);
        let element = matches.next().ok_or_else(|| TransitionValidationError {
            kind: TransitionValidationKind::Invalid,
            reason: "transition endpoint is missing from its track".to_owned(),
            path: path.to_owned(),
        })?;
        if matches.next().is_some() {
            return Err(TransitionValidationError {
                kind: TransitionValidationKind::Invalid,
                reason: "transition track contains duplicate element IDs".to_owned(),
                path: path.to_owned(),
            });
        }
        Ok(element)
    };
    let from_element = endpoint(&options.from_element_id, "fromElementId")?;
    let to_element = endpoint(&options.to_element_id, "toElementId")?;
    if options.duration < definition.duration.minimum
        || options.duration > from_element.duration
        || options.duration > to_element.duration
    {
        return Err(TransitionValidationError {
            kind: TransitionValidationKind::Bounds,
            reason: "transition duration must be positive and no longer than either element"
                .to_owned(),
            path: "duration".to_owned(),
        });
    }
    if require_adjacency {
        let mut ordered = options.track_elements.iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| {
            left.start_time
                .cmp(&right.start_time)
                .then_with(|| left.id.cmp(&right.id))
        });
        let to_index = ordered
            .iter()
            .position(|element| element.id == options.to_element_id)
            .expect("validated destination endpoint");
        if to_index == 0
            || ordered[to_index - 1].id != options.from_element_id
            || from_element.start_time.checked_add(from_element.duration)
                != Some(to_element.start_time)
        {
            return Err(TransitionValidationError {
                kind: TransitionValidationKind::Invalid,
                reason: "transition elements must be consecutive and edge-adjacent".to_owned(),
                path: "fromElementId".to_owned(),
            });
        }
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
    if (from_element.element_type == "compound" || to_element.element_type == "compound")
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
    if to_element.has_masks
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
