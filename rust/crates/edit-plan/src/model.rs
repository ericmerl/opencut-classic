use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ops::{Deref, DerefMut},
};
use time::{FrameRate, MediaTime};

pub const CONTRACT_VERSION: &str = "opencut.edit-plan-preflight.v2";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Scalar {
    String(String),
    Number(f64),
    Boolean(bool),
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct Params(
    #[cfg_attr(feature = "wasm", tsify(type = "Record<string, Scalar>"))]
    pub  BTreeMap<String, Scalar>,
);

impl Params {
    pub const fn new() -> Self {
        Self(BTreeMap::new())
    }
}

impl Deref for Params {
    type Target = BTreeMap<String, Scalar>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for Params {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl FromIterator<(String, Scalar)> for Params {
    fn from_iter<T: IntoIterator<Item = (String, Scalar)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

impl IntoIterator for Params {
    type Item = (String, Scalar);
    type IntoIter = std::collections::btree_map::IntoIter<String, Scalar>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl<'a> IntoIterator for &'a Params {
    type Item = (&'a String, &'a Scalar);
    type IntoIter = std::collections::btree_map::Iter<'a, String, Scalar>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FreeformPathPoint {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub in_x: f64,
    pub in_y: f64,
    pub out_x: f64,
    pub out_y: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum MaskParamValue {
    String(String),
    Number(f64),
    Boolean(bool),
    Path(Vec<FreeformPathPoint>),
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct MaskParams(
    #[cfg_attr(feature = "wasm", tsify(type = "Record<string, MaskParamValue>"))]
    pub  BTreeMap<String, MaskParamValue>,
);

impl MaskParams {
    pub const fn new() -> Self {
        Self(BTreeMap::new())
    }
}

impl Deref for MaskParams {
    type Target = BTreeMap<String, MaskParamValue>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for MaskParams {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl FromIterator<(String, MaskParamValue)> for MaskParams {
    fn from_iter<T: IntoIterator<Item = (String, MaskParamValue)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

impl<'a> IntoIterator for &'a MaskParams {
    type Item = (&'a String, &'a MaskParamValue);
    type IntoIter = std::collections::btree_map::Iter<'a, String, MaskParamValue>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

/// JSON-domain value used by the canonical project projection. This deliberately
/// excludes undefined, non-finite numbers, host objects, and raw serde/JS values.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CanonicalValue {
    Null(#[cfg_attr(feature = "wasm", tsify(type = "null"))] ()),
    Boolean(bool),
    Integer(i64),
    Unsigned(u64),
    Number(f64),
    String(String),
    Array(Vec<CanonicalValue>),
    Object(BTreeMap<String, CanonicalValue>),
}

pub type CanonicalObject = BTreeMap<String, CanonicalValue>;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementRef {
    pub track_id: String,
    pub element_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum AllocationRole {
    Element,
    CaptionTrack,
    CaptionElement,
    Track,
    CompoundElement,
    CompoundAutoTrack,
    CompoundEmptyMainTrack,
    SourceAudioTrack,
    SourceAudioElement,
    SourceAudioLink,
    ElementAutoTrack,
    Effect,
    Keyframe,
    Transition,
    Mask,
    Group,
    Link,
    DuplicateElement,
    DuplicateTrack,
    DuplicateTransition,
    DuplicateGroup,
    DuplicateLink,
    DuplicateEffect,
    DuplicateMask,
    DuplicateKeyframe,
    DuplicateNestedKeyframe,
    DuplicateNestedTrack,
    DuplicateNestedElement,
    DuplicateNestedTransition,
    Bookmark,
    BreakApartElement,
    SplitRight,
    SplitGroup,
    SplitLink,
    SplitEffect,
    SplitMask,
    SplitLeftBoundaryKeyframe,
    SplitRightBoundaryKeyframe,
    SplitNestedKeyframe,
    SplitNestedTrack,
    SplitNestedElement,
    SplitNestedTransition,
    DurationClampLeftBoundaryKeyframe,
    DurationClampRightBoundaryKeyframe,
}

impl AllocationRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Element => "element",
            Self::CaptionTrack => "caption-track",
            Self::CaptionElement => "caption-element",
            Self::Track => "track",
            Self::CompoundElement => "compound-element",
            Self::CompoundAutoTrack => "compound-auto-track",
            Self::CompoundEmptyMainTrack => "compound-empty-main-track",
            Self::SourceAudioTrack => "source-audio-track",
            Self::SourceAudioElement => "source-audio-element",
            Self::SourceAudioLink => "source-audio-link",
            Self::ElementAutoTrack => "element-auto-track",
            Self::Effect => "effect",
            Self::Keyframe => "keyframe",
            Self::Transition => "transition",
            Self::Mask => "mask",
            Self::Group => "group",
            Self::Link => "link",
            Self::DuplicateElement => "duplicate-element",
            Self::DuplicateTrack => "duplicate-track",
            Self::DuplicateTransition => "duplicate-transition",
            Self::DuplicateGroup => "duplicate-group",
            Self::DuplicateLink => "duplicate-link",
            Self::DuplicateEffect => "duplicate-effect",
            Self::DuplicateMask => "duplicate-mask",
            Self::DuplicateKeyframe => "duplicate-keyframe",
            Self::DuplicateNestedKeyframe => "duplicate-nested-keyframe",
            Self::DuplicateNestedTrack => "duplicate-nested-track",
            Self::DuplicateNestedElement => "duplicate-nested-element",
            Self::DuplicateNestedTransition => "duplicate-nested-transition",
            Self::Bookmark => "bookmark",
            Self::BreakApartElement => "break-apart-element",
            Self::SplitRight => "split-right",
            Self::SplitGroup => "split-group",
            Self::SplitLink => "split-link",
            Self::SplitEffect => "split-effect",
            Self::SplitMask => "split-mask",
            Self::SplitLeftBoundaryKeyframe => "split-left-boundary-keyframe",
            Self::SplitRightBoundaryKeyframe => "split-right-boundary-keyframe",
            Self::SplitNestedKeyframe => "split-nested-keyframe",
            Self::SplitNestedTrack => "split-nested-track",
            Self::SplitNestedElement => "split-nested-element",
            Self::SplitNestedTransition => "split-nested-transition",
            Self::DurationClampLeftBoundaryKeyframe => "duration-clamp-left-boundary-keyframe",
            Self::DurationClampRightBoundaryKeyframe => "duration-clamp-right-boundary-keyframe",
        }
    }

    pub fn from_name(value: &str) -> Option<Self> {
        ALL_ALLOCATION_ROLES
            .iter()
            .copied()
            .find(|role| role.as_str() == value)
    }
}

const ALL_ALLOCATION_ROLES: &[AllocationRole] = &[
    AllocationRole::Element,
    AllocationRole::CaptionTrack,
    AllocationRole::CaptionElement,
    AllocationRole::Track,
    AllocationRole::CompoundElement,
    AllocationRole::CompoundAutoTrack,
    AllocationRole::CompoundEmptyMainTrack,
    AllocationRole::SourceAudioTrack,
    AllocationRole::SourceAudioElement,
    AllocationRole::SourceAudioLink,
    AllocationRole::ElementAutoTrack,
    AllocationRole::Effect,
    AllocationRole::Keyframe,
    AllocationRole::Transition,
    AllocationRole::Mask,
    AllocationRole::Group,
    AllocationRole::Link,
    AllocationRole::DuplicateElement,
    AllocationRole::DuplicateTrack,
    AllocationRole::DuplicateTransition,
    AllocationRole::DuplicateGroup,
    AllocationRole::DuplicateLink,
    AllocationRole::DuplicateEffect,
    AllocationRole::DuplicateMask,
    AllocationRole::DuplicateKeyframe,
    AllocationRole::DuplicateNestedKeyframe,
    AllocationRole::DuplicateNestedTrack,
    AllocationRole::DuplicateNestedElement,
    AllocationRole::DuplicateNestedTransition,
    AllocationRole::Bookmark,
    AllocationRole::BreakApartElement,
    AllocationRole::SplitRight,
    AllocationRole::SplitGroup,
    AllocationRole::SplitLink,
    AllocationRole::SplitEffect,
    AllocationRole::SplitMask,
    AllocationRole::SplitLeftBoundaryKeyframe,
    AllocationRole::SplitRightBoundaryKeyframe,
    AllocationRole::SplitNestedKeyframe,
    AllocationRole::SplitNestedTrack,
    AllocationRole::SplitNestedElement,
    AllocationRole::SplitNestedTransition,
    AllocationRole::DurationClampLeftBoundaryKeyframe,
    AllocationRole::DurationClampRightBoundaryKeyframe,
];

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectIdAllocation {
    pub role: AllocationRole,
    pub source_id: String,
    pub resolved_id: String,
}

/// One caption the evaluator resolved for `rechunk_captions`: its id (a
/// targeted caption's, reused in timeline order, or a freshly allocated one),
/// the caption whose style it inherits, and its text and timing.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedCaptionChunk {
    pub element_id: String,
    pub source_element_id: String,
    pub text: String,
    pub start_time: MediaTime,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RelationshipScope {
    Element,
    Group,
    Link,
    All,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackType {
    Video,
    Text,
    Audio,
    Graphic,
    Effect,
}

impl TrackType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Text => "text",
            Self::Audio => "audio",
            Self::Graphic => "graphic",
            Self::Effect => "effect",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TransitionType {
    Crossfade,
    FadeThroughBlack,
    Slide,
    Wipe,
    Zoom,
}

impl TransitionType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Crossfade => "crossfade",
            Self::FadeThroughBlack => "fade-through-black",
            Self::Slide => "slide",
            Self::Wipe => "wipe",
            Self::Zoom => "zoom",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeyframeInterpolation {
    Linear,
    Hold,
    Bezier,
}

impl KeyframeInterpolation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Linear => "linear",
            Self::Hold => "hold",
            Self::Bezier => "bezier",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RetainSide {
    Both,
    Left,
    Right,
}

impl RetainSide {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReframeMode {
    Fit,
    Fill,
    Contain,
    Cover,
    Stretch,
}

impl ReframeMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fit => "fit",
            Self::Fill => "fill",
            Self::Contain => "contain",
            Self::Cover => "cover",
            Self::Stretch => "stretch",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReframeLayout {
    FullFrame,
    SplitLeft,
    SplitRight,
    SplitTop,
    SplitBottom,
    PipTopLeft,
    PipTopRight,
    PipBottomLeft,
    PipBottomRight,
}

impl ReframeLayout {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FullFrame => "full-frame",
            Self::SplitLeft => "split-left",
            Self::SplitRight => "split-right",
            Self::SplitTop => "split-top",
            Self::SplitBottom => "split-bottom",
            Self::PipTopLeft => "pip-top-left",
            Self::PipTopRight => "pip-top-right",
            Self::PipBottomLeft => "pip-bottom-left",
            Self::PipBottomRight => "pip-bottom-right",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MaskType {
    Split,
    CinematicBars,
    Rectangle,
    Ellipse,
    Heart,
    Diamond,
    Star,
    Text,
    Freeform,
}

impl MaskType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Split => "split",
            Self::CinematicBars => "cinematic-bars",
            Self::Rectangle => "rectangle",
            Self::Ellipse => "ellipse",
            Self::Heart => "heart",
            Self::Diamond => "diamond",
            Self::Star => "star",
            Self::Text => "text",
            Self::Freeform => "freeform",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fade {
    pub in_duration: MediaTime,
    pub out_duration: MediaTime,
    pub floor_db: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reframe {
    pub mode: Option<String>,
    pub crop: Option<Rect>,
    pub focal_point: Option<Point>,
    pub target_rect: Option<Rect>,
    pub layout: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Caption {
    pub element_id: Option<String>,
    pub text: String,
    pub start_time: MediaTime,
    pub duration: MediaTime,
    /// Speaker label stored as the `caption.speaker` text param, which
    /// `restyle_captions` and `rechunk_captions` can select by.
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_params: Option<CanonicalValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_layout_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_layout_engine: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TextDecoration {
    None,
    Underline,
    LineThrough,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextFontWeight {
    Normal,
    Bold,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextFontStyle {
    Normal,
    Italic,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextOutlineJoin {
    Round,
    Bevel,
    Miter,
}

pub const DEFAULT_TEXT_OUTLINE_COLOR: &str = "#000000";
pub const DEFAULT_TEXT_OUTLINE_WIDTH: f64 = 0.0;
pub const DEFAULT_TEXT_OUTLINE_JOIN: TextOutlineJoin = TextOutlineJoin::Round;
pub const TEXT_OUTLINE_WIDTH_MIN: f64 = 0.0;
pub const TEXT_OUTLINE_WIDTH_MAX: f64 = 64.0;
pub const TEXT_OUTLINE_MITER_LIMIT: f64 = 2.0;
pub const DEFAULT_TEXT_SHADOW_COLOR: &str = "#00000000";
pub const DEFAULT_TEXT_SHADOW_OFFSET_X: f64 = 0.0;
pub const DEFAULT_TEXT_SHADOW_OFFSET_Y: f64 = 0.0;
pub const DEFAULT_TEXT_SHADOW_BLUR: f64 = 0.0;
pub const TEXT_SHADOW_OFFSET_MIN: f64 = -256.0;
pub const TEXT_SHADOW_OFFSET_MAX: f64 = 256.0;
pub const TEXT_SHADOW_BLUR_MIN: f64 = 0.0;
pub const TEXT_SHADOW_BLUR_MAX: f64 = 64.0;
pub const TEXT_STYLE_SCALE_REFERENCE: f64 = 90.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutline {
    pub color: String,
    pub width: f64,
    pub join: TextOutlineJoin,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextShadow {
    pub color: String,
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NumericControlRange {
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutlineControlContract {
    pub default: TextOutline,
    pub width: NumericControlRange,
    pub joins: Vec<TextOutlineJoin>,
    pub miter_limit: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextShadowControlContract {
    pub default: TextShadow,
    pub offset: NumericControlRange,
    pub blur: NumericControlRange,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextStyleContract {
    pub scale_reference: f64,
    pub outline: TextOutlineControlContract,
    pub shadow: TextShadowControlContract,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTextEffectGeometryOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<TextOutline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TextShadow>,
    pub pixels_per_unit: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTextEffectParamsOptions {
    pub params: Params,
    pub pixels_per_unit: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextEffectExtents {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedTextEffectGeometry {
    pub outline: TextOutline,
    pub shadow: TextShadow,
    pub miter_limit: f64,
    pub extents: TextEffectExtents,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResolveTextEffectGeometryResponse {
    Resolved {
        geometry: ResolvedTextEffectGeometry,
    },
    Rejected {
        reason: String,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextEffectRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTextEffectBoundsOptions {
    pub text: TextEffectRect,
    pub base_visual: TextEffectRect,
    pub extents: TextEffectExtents,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedTextEffectBounds {
    pub decorated_text: TextEffectRect,
    pub visual: TextEffectRect,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResolveTextEffectBoundsResponse {
    Resolved { bounds: ResolvedTextEffectBounds },
    Rejected { reason: String },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapAssTextEffectsOptions {
    pub outline: Option<String>,
    pub outline_colour: Option<String>,
    pub shadow: Option<String>,
    pub back_colour: Option<String>,
    pub border_style: Option<String>,
    pub play_res_y: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MapAssTextEffectsResponse {
    Mapped { style: SubtitleStyleOverrides },
    Rejected { reason: String },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapTextEffectsToAssOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<TextOutline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TextShadow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<SubtitleBackground>,
    pub play_res_y: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssTextEffectLoss {
    pub feature: String,
    pub reason: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssTextEffectMapping {
    pub primary_colour: String,
    pub outline_colour: String,
    pub back_colour: String,
    pub border_style: u8,
    pub outline: f64,
    pub shadow: f64,
    pub losses: Vec<AssTextEffectLoss>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MapTextEffectsToAssResponse {
    Mapped { mapping: AssTextEffectMapping },
    Rejected { reason: String },
}

pub fn compute_text_effect_geometry(
    options: ResolveTextEffectGeometryOptions,
) -> Result<ResolvedTextEffectGeometry, String> {
    if !options.pixels_per_unit.is_finite()
        || options.pixels_per_unit <= 0.0
        || options.pixels_per_unit > 1_000.0
    {
        return Err("pixelsPerUnit must be finite and between 0 and 1000".into());
    }
    let contract = text_style_contract();
    let mut style = SubtitleStyleOverrides {
        outline: Some(options.outline.unwrap_or(contract.outline.default)),
        shadow: Some(options.shadow.unwrap_or(contract.shadow.default)),
        ..Default::default()
    };
    canonicalize_text_effects(&mut style)?;
    let mut outline = style.outline.expect("outline retained");
    let mut shadow = style.shadow.expect("shadow retained");
    outline.width *= options.pixels_per_unit;
    shadow.offset_x *= options.pixels_per_unit;
    shadow.offset_y *= options.pixels_per_unit;
    shadow.blur *= options.pixels_per_unit;
    let outline_extent = if color_is_visible(&outline.color) {
        let join_factor = if outline.join == TextOutlineJoin::Miter {
            TEXT_OUTLINE_MITER_LIMIT
        } else {
            1.0
        };
        (outline.width / 2.0) * join_factor
    } else {
        0.0
    };
    let shadow_visible = color_is_visible(&shadow.color);
    let shadow_left = if shadow_visible {
        (shadow.blur - shadow.offset_x).max(0.0)
    } else {
        0.0
    };
    let shadow_top = if shadow_visible {
        (shadow.blur - shadow.offset_y).max(0.0)
    } else {
        0.0
    };
    let shadow_right = if shadow_visible {
        (shadow.blur + shadow.offset_x).max(0.0)
    } else {
        0.0
    };
    let shadow_bottom = if shadow_visible {
        (shadow.blur + shadow.offset_y).max(0.0)
    } else {
        0.0
    };
    Ok(ResolvedTextEffectGeometry {
        outline,
        shadow,
        miter_limit: TEXT_OUTLINE_MITER_LIMIT,
        extents: TextEffectExtents {
            left: outline_extent.max(shadow_left),
            top: outline_extent.max(shadow_top),
            right: outline_extent.max(shadow_right),
            bottom: outline_extent.max(shadow_bottom),
        },
    })
}

pub fn compute_text_effect_params(
    options: ResolveTextEffectParamsOptions,
) -> Result<ResolvedTextEffectGeometry, String> {
    let contract = text_style_contract();
    let outline = TextOutline {
        color: text_effect_string_param(
            &options.params,
            "outline.color",
            &contract.outline.default.color,
        )?,
        width: text_effect_number_param(
            &options.params,
            "outline.width",
            contract.outline.default.width,
        )?,
        join: match text_effect_string_param(
            &options.params,
            "outline.join",
            match contract.outline.default.join {
                TextOutlineJoin::Round => "round",
                TextOutlineJoin::Bevel => "bevel",
                TextOutlineJoin::Miter => "miter",
            },
        )?
        .as_str()
        {
            "round" => TextOutlineJoin::Round,
            "bevel" => TextOutlineJoin::Bevel,
            "miter" => TextOutlineJoin::Miter,
            _ => return Err("outline.join must be round, bevel, or miter".into()),
        },
    };
    let shadow = TextShadow {
        color: text_effect_string_param(
            &options.params,
            "shadow.color",
            &contract.shadow.default.color,
        )?,
        offset_x: text_effect_number_param(
            &options.params,
            "shadow.offsetX",
            contract.shadow.default.offset_x,
        )?,
        offset_y: text_effect_number_param(
            &options.params,
            "shadow.offsetY",
            contract.shadow.default.offset_y,
        )?,
        blur: text_effect_number_param(
            &options.params,
            "shadow.blur",
            contract.shadow.default.blur,
        )?,
    };
    compute_text_effect_geometry(ResolveTextEffectGeometryOptions {
        outline: Some(outline),
        shadow: Some(shadow),
        pixels_per_unit: options.pixels_per_unit,
    })
}

fn text_effect_string_param(params: &Params, key: &str, fallback: &str) -> Result<String, String> {
    match params.get(key) {
        None => Ok(fallback.to_owned()),
        Some(Scalar::String(value)) => Ok(value.clone()),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn text_effect_number_param(params: &Params, key: &str, fallback: f64) -> Result<f64, String> {
    match params.get(key) {
        None => Ok(fallback),
        Some(Scalar::Number(value)) if value.is_finite() => Ok(*value),
        Some(_) => Err(format!("{key} must be a finite number")),
    }
}

pub fn compute_text_effect_bounds(
    options: ResolveTextEffectBoundsOptions,
) -> Result<ResolvedTextEffectBounds, String> {
    validate_text_effect_rect(&options.text, "text")?;
    validate_text_effect_rect(&options.base_visual, "baseVisual")?;
    for (name, value) in [
        ("extents.left", options.extents.left),
        ("extents.top", options.extents.top),
        ("extents.right", options.extents.right),
        ("extents.bottom", options.extents.bottom),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!("{name} must be finite and non-negative"));
        }
    }
    let decorated_text = TextEffectRect {
        left: options.text.left - options.extents.left,
        top: options.text.top - options.extents.top,
        width: options.text.width + options.extents.left + options.extents.right,
        height: options.text.height + options.extents.top + options.extents.bottom,
    };
    let left = options.base_visual.left.min(decorated_text.left);
    let top = options.base_visual.top.min(decorated_text.top);
    let right = (options.base_visual.left + options.base_visual.width)
        .max(decorated_text.left + decorated_text.width);
    let bottom = (options.base_visual.top + options.base_visual.height)
        .max(decorated_text.top + decorated_text.height);
    Ok(ResolvedTextEffectBounds {
        decorated_text,
        visual: TextEffectRect {
            left,
            top,
            width: right - left,
            height: bottom - top,
        },
    })
}

fn validate_text_effect_rect(rect: &TextEffectRect, name: &str) -> Result<(), String> {
    if ![rect.left, rect.top, rect.width, rect.height]
        .into_iter()
        .all(f64::is_finite)
        || rect.width < 0.0
        || rect.height < 0.0
    {
        return Err(format!("{name} must be a finite non-negative rectangle"));
    }
    Ok(())
}

fn color_is_visible(color: &str) -> bool {
    color.len() == 7 || &color[7..9] != "00"
}

pub fn compute_ass_text_effects(
    options: MapAssTextEffectsOptions,
) -> Result<SubtitleStyleOverrides, String> {
    if !options.play_res_y.is_finite() || options.play_res_y <= 0.0 {
        return Err("playResY must be finite and positive".into());
    }
    let border_style = parse_optional_ass_number(options.border_style.as_deref(), "BorderStyle")?
        .unwrap_or(1.0)
        .round() as i32;
    let outline_value = parse_optional_ass_number(options.outline.as_deref(), "Outline")?;
    let shadow_value = parse_optional_ass_number(options.shadow.as_deref(), "Shadow")?;
    if outline_value.is_some_and(|value| value < 0.0) {
        return Err("Outline must be non-negative".into());
    }
    if shadow_value.is_some_and(|value| value < 0.0) {
        return Err("Shadow must be non-negative".into());
    }
    let scale = TEXT_STYLE_SCALE_REFERENCE / options.play_res_y;
    let outline = if outline_value.is_some() || options.outline_colour.is_some() {
        Some(TextOutline {
            color: options
                .outline_colour
                .as_deref()
                .map(parse_ass_color)
                .transpose()?
                .unwrap_or_else(|| DEFAULT_TEXT_OUTLINE_COLOR.into()),
            width: outline_value.unwrap_or(0.0) * scale,
            join: TextOutlineJoin::Round,
        })
    } else {
        None
    };
    let mapped_back = options
        .back_colour
        .as_deref()
        .map(parse_ass_color)
        .transpose()?;
    let shadow = if shadow_value.is_some() || (border_style != 3 && mapped_back.is_some()) {
        let offset = shadow_value.unwrap_or(0.0) * scale;
        Some(TextShadow {
            color: mapped_back
                .clone()
                .unwrap_or_else(|| DEFAULT_TEXT_SHADOW_COLOR.into()),
            offset_x: offset,
            offset_y: offset,
            blur: 0.0,
        })
    } else {
        None
    };
    let background = if border_style == 3 {
        mapped_back.map(|color| SubtitleBackground {
            enabled: color_is_visible(&color),
            color,
            per_line: None,
            corner_radius: None,
            padding_x: None,
            padding_y: None,
            offset_x: None,
            offset_y: None,
        })
    } else {
        None
    };
    resolve_caption_style(&SubtitleStyleOverrides {
        outline,
        shadow,
        background,
        ..Default::default()
    })
}

pub fn compute_text_effects_to_ass(
    options: MapTextEffectsToAssOptions,
) -> Result<AssTextEffectMapping, String> {
    if !options.play_res_y.is_finite() || options.play_res_y <= 0.0 {
        return Err("playResY must be finite and positive".into());
    }
    let mut style = resolve_caption_style(&SubtitleStyleOverrides {
        outline: options.outline,
        shadow: options.shadow,
        background: options.background,
        ..Default::default()
    })?;
    let outline = style.outline.take();
    let shadow = style.shadow.take();
    let visible_background = style
        .background
        .as_ref()
        .filter(|background| background.enabled && css_color_is_visible(&background.color));
    let scale = options.play_res_y / TEXT_STYLE_SCALE_REFERENCE;
    let primary_colour = css_color_to_ass(options.primary_color.as_deref().unwrap_or("#ffffff"))?;
    let mut losses = Vec::new();
    if outline
        .as_ref()
        .is_some_and(|outline| outline.join != TextOutlineJoin::Round)
    {
        losses.push(AssTextEffectLoss {
            feature: "outline.join".into(),
            reason: "ASS styles do not encode outline joins".into(),
        });
    }
    if let Some(shadow) = &shadow {
        if shadow.blur != 0.0 {
            losses.push(AssTextEffectLoss {
                feature: "shadow.blur".into(),
                reason: "ASS styles do not encode shadow blur".into(),
            });
        }
        if shadow.offset_x != shadow.offset_y {
            losses.push(AssTextEffectLoss {
                feature: "shadow.offset".into(),
                reason: "ASS styles encode one shared shadow offset".into(),
            });
        }
        if style
            .background
            .as_ref()
            .is_some_and(|background| background.enabled)
        {
            losses.push(AssTextEffectLoss {
                feature: "shadow".into(),
                reason: "ASS uses BackColour for both opaque boxes and shadows".into(),
            });
        }
    }
    let outline_colour = outline
        .as_ref()
        .map(|outline| css_color_to_ass(&outline.color))
        .transpose()?
        .unwrap_or_else(|| "&H00000000".into());
    let back_colour = if let Some(background) = visible_background {
        css_color_to_ass(&background.color)?
    } else if let Some(shadow) = &shadow {
        css_color_to_ass(&shadow.color)?
    } else {
        "&H00000000".into()
    };
    Ok(AssTextEffectMapping {
        primary_colour,
        outline_colour,
        back_colour,
        border_style: if visible_background.is_some() { 3 } else { 1 },
        outline: outline.map_or(0.0, |outline| outline.width * scale),
        shadow: if visible_background.is_some() {
            0.0
        } else {
            shadow.map_or(0.0, |shadow| shadow.offset_x * scale)
        },
        losses,
    })
}

fn css_color_to_ass(value: &str) -> Result<String, String> {
    let value = value.trim();
    let (red, green, blue, alpha) = if let Ok(color) = canonical_text_effect_color(value, "color") {
        (
            u8::from_str_radix(&color[1..3], 16).map_err(|_| "invalid red")?,
            u8::from_str_radix(&color[3..5], 16).map_err(|_| "invalid green")?,
            u8::from_str_radix(&color[5..7], 16).map_err(|_| "invalid blue")?,
            if color.len() == 9 {
                f64::from(u8::from_str_radix(&color[7..9], 16).map_err(|_| "invalid alpha")?)
                    / 255.0
            } else {
                1.0
            },
        )
    } else {
        parse_css_rgb(value)?
    };
    let ass_alpha = ((1.0 - alpha) * 255.0).round().clamp(0.0, 255.0) as u8;
    Ok(format!("&H{ass_alpha:02x}{blue:02x}{green:02x}{red:02x}"))
}

fn css_color_is_visible(value: &str) -> bool {
    let value = value.trim();
    if value.eq_ignore_ascii_case("transparent") {
        return false;
    }
    if let Ok((_, _, _, alpha)) = parse_css_rgb(value) {
        return alpha > 0.0;
    }
    let digits = value.strip_prefix('#').unwrap_or("");
    digits.len() != 8 || &digits[6..8] != "00"
}

fn parse_css_rgb(value: &str) -> Result<(u8, u8, u8, f64), String> {
    let lower = value.to_ascii_lowercase();
    let (body, has_alpha) = if let Some(body) = lower
        .strip_prefix("rgba(")
        .and_then(|body| body.strip_suffix(')'))
    {
        (body, true)
    } else if let Some(body) = lower
        .strip_prefix("rgb(")
        .and_then(|body| body.strip_suffix(')'))
    {
        (body, false)
    } else {
        return Err(format!("unsupported colour for ASS export: {value}"));
    };
    let fields = body.split(',').map(str::trim).collect::<Vec<_>>();
    if fields.len() != if has_alpha { 4 } else { 3 } {
        return Err(format!("unsupported colour for ASS export: {value}"));
    }
    let channel = |index: usize| -> Result<u8, String> {
        fields[index]
            .parse::<u8>()
            .map_err(|_| format!("unsupported colour for ASS export: {value}"))
    };
    let alpha = if has_alpha {
        fields[3]
            .parse::<f64>()
            .map_err(|_| format!("unsupported colour for ASS export: {value}"))?
    } else {
        1.0
    };
    if !alpha.is_finite() || !(0.0..=1.0).contains(&alpha) {
        return Err(format!("unsupported colour for ASS export: {value}"));
    }
    Ok((channel(0)?, channel(1)?, channel(2)?, alpha))
}

fn parse_optional_ass_number(value: Option<&str>, field: &str) -> Result<Option<f64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let parsed = value
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("{field} must be numeric"))?;
    if !parsed.is_finite() {
        return Err(format!("{field} must be finite"));
    }
    Ok(Some(parsed))
}

fn parse_ass_color(value: &str) -> Result<String, String> {
    let normalized = value
        .trim()
        .trim_start_matches('&')
        .trim_start_matches(|character| character == 'H' || character == 'h');
    if normalized.len() > 8 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("ASS color must be &HAABBGGRR hexadecimal".into());
    }
    let padded = format!("{normalized:0>8}");
    let alpha = 255_u8
        - u8::from_str_radix(&padded[0..2], 16).map_err(|_| "ASS alpha is invalid".to_owned())?;
    let red = &padded[6..8];
    let green = &padded[4..6];
    let blue = &padded[2..4];
    let rgb = format!("#{red}{green}{blue}").to_ascii_lowercase();
    Ok(if alpha == 255 {
        rgb
    } else {
        format!("{rgb}{alpha:02x}")
    })
}

pub fn text_style_contract() -> TextStyleContract {
    TextStyleContract {
        scale_reference: TEXT_STYLE_SCALE_REFERENCE,
        outline: TextOutlineControlContract {
            default: TextOutline {
                color: DEFAULT_TEXT_OUTLINE_COLOR.into(),
                width: DEFAULT_TEXT_OUTLINE_WIDTH,
                join: DEFAULT_TEXT_OUTLINE_JOIN,
            },
            width: NumericControlRange {
                min: TEXT_OUTLINE_WIDTH_MIN,
                max: TEXT_OUTLINE_WIDTH_MAX,
                step: 0.1,
            },
            joins: vec![
                TextOutlineJoin::Round,
                TextOutlineJoin::Bevel,
                TextOutlineJoin::Miter,
            ],
            miter_limit: TEXT_OUTLINE_MITER_LIMIT,
        },
        shadow: TextShadowControlContract {
            default: TextShadow {
                color: DEFAULT_TEXT_SHADOW_COLOR.into(),
                offset_x: DEFAULT_TEXT_SHADOW_OFFSET_X,
                offset_y: DEFAULT_TEXT_SHADOW_OFFSET_Y,
                blur: DEFAULT_TEXT_SHADOW_BLUR,
            },
            offset: NumericControlRange {
                min: TEXT_SHADOW_OFFSET_MIN,
                max: TEXT_SHADOW_OFFSET_MAX,
                step: 0.1,
            },
            blur: NumericControlRange {
                min: TEXT_SHADOW_BLUR_MIN,
                max: TEXT_SHADOW_BLUR_MAX,
                step: 0.1,
            },
        },
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VerticalAlign {
    Top,
    Middle,
    Bottom,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitleBackground {
    pub enabled: bool,
    pub color: String,
    /// One bubble per wrapped line instead of one block behind all lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_line: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_y: Option<f64>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitlePlacementStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_align: Option<VerticalAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_left_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_right_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_vertical_ratio: Option<f64>,
}

/// Word-by-word emphasis: the word being spoken takes `color` while the
/// caption is on screen. Word timing follows character share of the caption's
/// duration, the interpolation `rechunk_captions` uses, so preview, export,
/// and the evaluator agree on which word is current.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitleHighlight {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitleStyleOverrides {
    /// Id of a reusable caption preset (`caption_style_presets`) whose style
    /// applies underneath every explicit override in this object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_ratio_of_play_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<SubtitleBackground>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_align: Option<TextAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<TextFontWeight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_style: Option<TextFontStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_decoration: Option<TextDecoration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<SubtitlePlacementStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<SubtitleHighlight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<TextOutline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TextShadow>,
}

/// A reusable social-caption style. The table lives in Rust so the editor,
/// the MCP server, and any other shell resolve the same style for an id.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionStylePreset {
    pub id: String,
    pub description: String,
    pub style: SubtitleStyleOverrides,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionStylePresetList {
    pub presets: Vec<CaptionStylePreset>,
}

fn bundled_caption_background(color: &str) -> SubtitleBackground {
    SubtitleBackground {
        enabled: true,
        color: color.to_owned(),
        per_line: Some(true),
        corner_radius: Some(8.0),
        padding_x: Some(16.0),
        padding_y: Some(8.0),
        offset_x: None,
        offset_y: None,
    }
}

/// The reusable caption presets. Every face they name ships with the editor
/// (TikTok Sans and Montserrat, both OFL). The styles follow the owner's
/// course guidance for social captions: bold, high contrast, no decorative
/// face, centred in the lower safe area.
pub fn caption_style_presets() -> CaptionStylePresetList {
    let tiktok = |background_color: &str| SubtitleStyleOverrides {
        preset: None,
        font_size: Some(6.0),
        font_size_ratio_of_play_height: None,
        font_family: Some("TikTok Sans".to_owned()),
        color: Some("#ffffff".to_owned()),
        background: Some(bundled_caption_background(background_color)),
        text_align: Some(TextAlign::Center),
        font_weight: Some(TextFontWeight::Bold),
        font_style: Some(TextFontStyle::Normal),
        text_decoration: Some(TextDecoration::None),
        letter_spacing: None,
        line_height: None,
        placement: Some(SubtitlePlacementStyle {
            vertical_align: Some(VerticalAlign::Bottom),
            margin_left_ratio: None,
            margin_right_ratio: None,
            margin_vertical_ratio: Some(0.12),
        }),
        highlight: None,
        outline: None,
        shadow: None,
    };
    CaptionStylePresetList {
        presets: vec![
            CaptionStylePreset {
                id: "tiktok-classic".to_owned(),
                description:
                    "Bold white TikTok Sans on a black block, centred above the lower edge."
                        .to_owned(),
                style: tiktok("#000000"),
            },
            CaptionStylePreset {
                id: "tiktok-classic-red".to_owned(),
                description:
                    "Bold white TikTok Sans on a red block, the high-contrast hook treatment."
                        .to_owned(),
                style: tiktok("#ff0000"),
            },
            CaptionStylePreset {
                id: "tiktok-karaoke".to_owned(),
                description: "The classic black block with the spoken word picked out in yellow."
                    .to_owned(),
                style: SubtitleStyleOverrides {
                    highlight: Some(SubtitleHighlight {
                        enabled: true,
                        color: Some("#ffd400".to_owned()),
                    }),
                    ..tiktok("#000000")
                },
            },
            CaptionStylePreset {
                id: "tiktok-outline-shadow".to_owned(),
                description: "Bold white TikTok Sans with a black outline and soft offset shadow."
                    .to_owned(),
                style: SubtitleStyleOverrides {
                    background: None,
                    outline: Some(TextOutline {
                        color: "#000000".to_owned(),
                        width: 2.0,
                        join: TextOutlineJoin::Round,
                    }),
                    shadow: Some(TextShadow {
                        color: "#00000099".to_owned(),
                        offset_x: 2.0,
                        offset_y: 3.0,
                        blur: 3.0,
                    }),
                    ..tiktok("#000000")
                },
            },
            CaptionStylePreset {
                id: "montserrat-clean".to_owned(),
                description: "Bold white Montserrat with no block, for quieter narrative captions."
                    .to_owned(),
                style: SubtitleStyleOverrides {
                    preset: None,
                    font_size: Some(5.0),
                    font_size_ratio_of_play_height: None,
                    font_family: Some("Montserrat".to_owned()),
                    color: Some("#ffffff".to_owned()),
                    background: None,
                    text_align: Some(TextAlign::Center),
                    font_weight: Some(TextFontWeight::Bold),
                    font_style: Some(TextFontStyle::Normal),
                    text_decoration: Some(TextDecoration::None),
                    letter_spacing: None,
                    line_height: None,
                    placement: Some(SubtitlePlacementStyle {
                        vertical_align: Some(VerticalAlign::Bottom),
                        margin_left_ratio: None,
                        margin_right_ratio: None,
                        margin_vertical_ratio: Some(0.12),
                    }),
                    highlight: None,
                    outline: None,
                    shadow: None,
                },
            },
        ],
    }
}

/// True when `id` names a preset in `caption_style_presets`.
pub fn is_caption_style_preset(id: &str) -> bool {
    caption_style_presets()
        .presets
        .iter()
        .any(|preset| preset.id == id)
}

/// Expands `style.preset` into the preset's style with every explicit field
/// of `style` applied on top; nested background and placement merge field by
/// field. The result never carries a preset id.
pub fn resolve_caption_style(
    style: &SubtitleStyleOverrides,
) -> Result<SubtitleStyleOverrides, String> {
    let base = if let Some(preset_id) = style.preset.as_deref() {
        caption_style_presets()
            .presets
            .into_iter()
            .find(|preset| preset.id == preset_id)
            .ok_or_else(|| format!("unknown caption style preset: {preset_id}"))?
            .style
    } else {
        SubtitleStyleOverrides::default()
    };
    let background = match (&base.background, &style.background) {
        (_, None) => base.background.clone(),
        (None, Some(override_)) => Some(override_.clone()),
        (Some(base), Some(override_)) => Some(SubtitleBackground {
            enabled: override_.enabled,
            color: override_.color.clone(),
            per_line: override_.per_line.or(base.per_line),
            corner_radius: override_.corner_radius.or(base.corner_radius),
            padding_x: override_.padding_x.or(base.padding_x),
            padding_y: override_.padding_y.or(base.padding_y),
            offset_x: override_.offset_x.or(base.offset_x),
            offset_y: override_.offset_y.or(base.offset_y),
        }),
    };
    let placement = match (&base.placement, &style.placement) {
        (_, None) => base.placement.clone(),
        (None, Some(override_)) => Some(override_.clone()),
        (Some(base), Some(override_)) => Some(SubtitlePlacementStyle {
            vertical_align: override_.vertical_align.or(base.vertical_align),
            margin_left_ratio: override_.margin_left_ratio.or(base.margin_left_ratio),
            margin_right_ratio: override_.margin_right_ratio.or(base.margin_right_ratio),
            margin_vertical_ratio: override_
                .margin_vertical_ratio
                .or(base.margin_vertical_ratio),
        }),
    };
    let highlight = match (&base.highlight, &style.highlight) {
        (_, None) => base.highlight.clone(),
        (None, Some(override_)) => Some(override_.clone()),
        (Some(base), Some(override_)) => Some(SubtitleHighlight {
            enabled: override_.enabled,
            color: override_.color.clone().or_else(|| base.color.clone()),
        }),
    };
    let mut resolved = SubtitleStyleOverrides {
        preset: None,
        font_size: style.font_size.or(base.font_size),
        font_size_ratio_of_play_height: style
            .font_size_ratio_of_play_height
            .or(base.font_size_ratio_of_play_height),
        font_family: style.font_family.clone().or(base.font_family),
        color: style.color.clone().or(base.color),
        background,
        text_align: style.text_align.or(base.text_align),
        font_weight: style.font_weight.or(base.font_weight),
        font_style: style.font_style.or(base.font_style),
        text_decoration: style.text_decoration.or(base.text_decoration),
        letter_spacing: style.letter_spacing.or(base.letter_spacing),
        line_height: style.line_height.or(base.line_height),
        placement,
        highlight,
        outline: style.outline.clone().or(base.outline),
        shadow: style.shadow.clone().or(base.shadow),
    };
    canonicalize_text_effects(&mut resolved)?;
    Ok(resolved)
}

fn canonicalize_text_effects(style: &mut SubtitleStyleOverrides) -> Result<(), String> {
    if let Some(outline) = &mut style.outline {
        outline.color = canonical_text_effect_color(&outline.color, "outline.color")?;
        outline.width = bounded_text_effect_number(
            outline.width,
            TEXT_OUTLINE_WIDTH_MIN,
            TEXT_OUTLINE_WIDTH_MAX,
            "outline.width",
        )?;
    }
    if let Some(shadow) = &mut style.shadow {
        shadow.color = canonical_text_effect_color(&shadow.color, "shadow.color")?;
        shadow.offset_x = bounded_text_effect_number(
            shadow.offset_x,
            TEXT_SHADOW_OFFSET_MIN,
            TEXT_SHADOW_OFFSET_MAX,
            "shadow.offsetX",
        )?;
        shadow.offset_y = bounded_text_effect_number(
            shadow.offset_y,
            TEXT_SHADOW_OFFSET_MIN,
            TEXT_SHADOW_OFFSET_MAX,
            "shadow.offsetY",
        )?;
        shadow.blur = bounded_text_effect_number(
            shadow.blur,
            TEXT_SHADOW_BLUR_MIN,
            TEXT_SHADOW_BLUR_MAX,
            "shadow.blur",
        )?;
    }
    Ok(())
}

/// The text element params a caption style sets. Placement and play-height
/// sizes need a canvas and are refused; the browser materializes those only
/// when it inserts a caption.
pub fn caption_style_params(style: &SubtitleStyleOverrides) -> Result<Params, String> {
    if style.placement.is_some() {
        return Err("restyle cannot change caption placement".into());
    }
    if style.font_size_ratio_of_play_height.is_some() {
        return Err("restyle cannot size captions by play height".into());
    }
    // A preset's placement only applies when a caption is inserted; restyle
    // leaves existing positions alone.
    let style = resolve_caption_style(style)?;
    let mut params = std::collections::BTreeMap::new();
    put_string(&mut params, "fontFamily", style.font_family.clone());
    put_string(&mut params, "color", style.color.clone());
    put_string(
        &mut params,
        "textAlign",
        style.text_align.map(|value| match value {
            TextAlign::Left => "left".to_owned(),
            TextAlign::Center => "center".to_owned(),
            TextAlign::Right => "right".to_owned(),
        }),
    );
    put_string(
        &mut params,
        "fontWeight",
        style.font_weight.map(|value| match value {
            TextFontWeight::Normal => "normal".to_owned(),
            TextFontWeight::Bold => "bold".to_owned(),
        }),
    );
    put_string(
        &mut params,
        "fontStyle",
        style.font_style.map(|value| match value {
            TextFontStyle::Normal => "normal".to_owned(),
            TextFontStyle::Italic => "italic".to_owned(),
        }),
    );
    put_string(
        &mut params,
        "textDecoration",
        style.text_decoration.map(|value| match value {
            TextDecoration::None => "none".to_owned(),
            TextDecoration::Underline => "underline".to_owned(),
            TextDecoration::LineThrough => "line-through".to_owned(),
        }),
    );
    put_number(&mut params, "fontSize", style.font_size);
    put_number(&mut params, "letterSpacing", style.letter_spacing);
    put_number(&mut params, "lineHeight", style.line_height);
    if let Some(background) = &style.background {
        params.insert(
            "background.enabled".to_owned(),
            Scalar::Boolean(background.enabled),
        );
        params.insert(
            "background.color".to_owned(),
            Scalar::String(background.color.clone()),
        );
        if let Some(per_line) = background.per_line {
            params.insert("background.perLine".to_owned(), Scalar::Boolean(per_line));
        }
        put_number(
            &mut params,
            "background.cornerRadius",
            background.corner_radius,
        );
        put_number(&mut params, "background.paddingX", background.padding_x);
        put_number(&mut params, "background.paddingY", background.padding_y);
        put_number(&mut params, "background.offsetX", background.offset_x);
        put_number(&mut params, "background.offsetY", background.offset_y);
    }
    if let Some(highlight) = &style.highlight {
        params.insert(
            "highlight.enabled".to_owned(),
            Scalar::Boolean(highlight.enabled),
        );
        put_string(&mut params, "highlight.color", highlight.color.clone());
    }
    if let Some(outline) = &style.outline {
        params.insert(
            "outline.color".to_owned(),
            Scalar::String(canonical_text_effect_color(
                &outline.color,
                "outline.color",
            )?),
        );
        params.insert(
            "outline.width".to_owned(),
            Scalar::Number(bounded_text_effect_number(
                outline.width,
                TEXT_OUTLINE_WIDTH_MIN,
                TEXT_OUTLINE_WIDTH_MAX,
                "outline.width",
            )?),
        );
        params.insert(
            "outline.join".to_owned(),
            Scalar::String(
                match outline.join {
                    TextOutlineJoin::Round => "round",
                    TextOutlineJoin::Bevel => "bevel",
                    TextOutlineJoin::Miter => "miter",
                }
                .to_owned(),
            ),
        );
    }
    if let Some(shadow) = &style.shadow {
        params.insert(
            "shadow.color".to_owned(),
            Scalar::String(canonical_text_effect_color(&shadow.color, "shadow.color")?),
        );
        for (key, value, min, max) in [
            (
                "shadow.offsetX",
                shadow.offset_x,
                TEXT_SHADOW_OFFSET_MIN,
                TEXT_SHADOW_OFFSET_MAX,
            ),
            (
                "shadow.offsetY",
                shadow.offset_y,
                TEXT_SHADOW_OFFSET_MIN,
                TEXT_SHADOW_OFFSET_MAX,
            ),
            (
                "shadow.blur",
                shadow.blur,
                TEXT_SHADOW_BLUR_MIN,
                TEXT_SHADOW_BLUR_MAX,
            ),
        ] {
            params.insert(
                key.to_owned(),
                Scalar::Number(bounded_text_effect_number(value, min, max, key)?),
            );
        }
    }
    if params.is_empty() {
        return Err("restyle sets no caption params".into());
    }
    Ok(Params(params))
}

fn canonical_text_effect_color(value: &str, path: &str) -> Result<String, String> {
    let value = value.trim();
    let digits = value.strip_prefix('#').unwrap_or("");
    if !matches!(digits.len(), 6 | 8) || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "{path} must be a six- or eight-digit hexadecimal color"
        ));
    }
    Ok(format!("#{}", digits.to_ascii_lowercase()))
}

fn bounded_text_effect_number(value: f64, min: f64, max: f64, path: &str) -> Result<f64, String> {
    if !value.is_finite() || value < min || value > max {
        return Err(format!("{path} must be between {min} and {max}"));
    }
    Ok(if value == 0.0 { 0.0 } else { value })
}

fn put_string(
    params: &mut std::collections::BTreeMap<String, Scalar>,
    key: &str,
    value: Option<String>,
) {
    if let Some(value) = value {
        params.insert(key.to_owned(), Scalar::String(value));
    }
}

fn put_number(
    params: &mut std::collections::BTreeMap<String, Scalar>,
    key: &str,
    value: Option<f64>,
) {
    if let Some(value) = value {
        params.insert(key.to_owned(), Scalar::Number(value));
    }
}

/// Input of the exported `resolve_caption_style`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveCaptionStyleOptions {
    pub style: SubtitleStyleOverrides,
}

/// Result of `resolve_caption_style` in transport form.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResolveCaptionStyleResponse {
    Resolved { style: SubtitleStyleOverrides },
    Rejected { reason: String },
}

/// Result of resolving a caption style directly to canonical flat element params.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[cfg_attr(feature = "wasm", tsify(hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResolveCaptionStyleParamsResponse {
    Resolved { params: Params },
    Rejected { reason: String },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Region {
    pub start_time: MediaTime,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[cfg_attr(feature = "wasm", tsify(hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EditOperation {
    InsertText {
        element_id: Option<String>,
        content: String,
        start_time: MediaTime,
        duration: MediaTime,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<SubtitleStyleOverrides>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    InsertGraphic {
        element_id: Option<String>,
        definition_id: String,
        name: Option<String>,
        start_time: MediaTime,
        duration: MediaTime,
        track_id: Option<String>,
        params: Option<Params>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    InsertSticker {
        element_id: Option<String>,
        sticker_id: String,
        name: Option<String>,
        start_time: MediaTime,
        duration: MediaTime,
        track_id: Option<String>,
        params: Option<Params>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    InsertAdjustmentLayer {
        element_id: Option<String>,
        effect_type: String,
        name: Option<String>,
        start_time: MediaTime,
        duration: MediaTime,
        track_id: Option<String>,
        params: Option<Params>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    AddTrack {
        track_type: TrackType,
        track_id: String,
    },
    SetTrackState {
        track_id: String,
        muted: Option<bool>,
        hidden: Option<bool>,
    },
    RenameTrack {
        track_id: String,
        name: String,
    },
    ReorderTracks {
        overlay_track_ids: Option<Vec<String>>,
        audio_track_ids: Option<Vec<String>>,
    },
    RemoveTrack {
        track_id: String,
        #[serde(default)]
        occupied: RemoveTrackOccupiedPolicy,
        target_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_cascade_element_ids: Option<Vec<String>>,
    },
    DuplicateTrack {
        track_id: String,
        new_track_id: Option<String>,
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    SetMainTrack {
        track_id: String,
    },
    SetTrackMatte {
        track_id: String,
        routing: TrackMatteRouting,
    },
    RemoveTrackMatte {
        track_id: String,
    },
    AddBookmark {
        bookmark_id: Option<String>,
        time: MediaTime,
        duration: Option<MediaTime>,
        note: Option<String>,
        color: Option<String>,
    },
    UpdateBookmark {
        bookmark_id: String,
        note: Option<String>,
        color: Option<String>,
        duration: Option<MediaTime>,
        #[serde(default)]
        clear: Vec<BookmarkField>,
    },
    MoveBookmark {
        bookmark_id: String,
        time: MediaTime,
    },
    RemoveBookmark {
        bookmark_id: String,
    },
    InstantiateAsset {
        asset_id: String,
        element_id: Option<String>,
        name: Option<String>,
        start_time: MediaTime,
        duration: Option<MediaTime>,
        track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    SetProjectSettings {
        fps: Option<FrameRate>,
        canvas_size: Option<CanvasSize>,
        background: Option<Background>,
    },
    InsertCaptions {
        track_id: Option<String>,
        captions: Vec<Caption>,
        style: Option<SubtitleStyleOverrides>,
    },
    UpdateCaption {
        track_id: String,
        element_id: String,
        text: Option<String>,
        start_time: Option<MediaTime>,
        duration: Option<MediaTime>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<SubtitleStyleOverrides>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_params: Option<Params>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    /// Moves every caption on the track (or the listed ones) by `delta`.
    ShiftCaptions {
        track_id: String,
        delta: MediaTime,
        element_ids: Option<Vec<String>>,
    },
    /// Joins two or more captions on one track into the earliest of them.
    MergeCaptions {
        track_id: String,
        element_ids: Vec<String>,
        separator: Option<String>,
    },
    /// Splits a caption's text at a character index into two captions whose
    /// durations share the original in proportion to their text.
    SplitCaption {
        track_id: String,
        element_id: String,
        split_index: usize,
        right_element_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    /// Applies a caption style (optionally from a preset) to every caption on
    /// the track or to the listed ones; the evaluator resolves the params.
    RestyleCaptions {
        track_id: String,
        element_ids: Option<Vec<String>>,
        /// Selects the captions whose `caption.speaker` param equals this.
        speaker: Option<String>,
        style: SubtitleStyleOverrides,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_params: Option<Params>,
    },
    /// Re-segments every caption on the track (or the listed ones) into
    /// chunks of at most `max_chars` characters that read no faster than
    /// `max_chars_per_second`; the evaluator resolves the exact chunks.
    RechunkCaptions {
        track_id: String,
        element_ids: Option<Vec<String>>,
        /// Selects the captions whose `caption.speaker` param equals this.
        speaker: Option<String>,
        max_chars: Option<u32>,
        max_chars_per_second: Option<f64>,
        max_duration: Option<MediaTime>,
        max_gap: Option<MediaTime>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_chunks: Option<Vec<ResolvedCaptionChunk>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    /// Shortens each caption that runs into the next one so consecutive
    /// captions on the track are separated by at least `min_gap`.
    RepairCaptionOverlaps {
        track_id: String,
        element_ids: Option<Vec<String>>,
        min_gap: Option<MediaTime>,
    },
    Delete {
        track_id: String,
        element_id: String,
        ripple: bool,
        relationship_scope: RelationshipScope,
    },
    DuplicateElements {
        elements: Vec<ElementRef>,
        duplicate_ids: Option<Vec<String>>,
        relationship_scope: RelationshipScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    CreateCompound {
        compound_id: String,
        name: Option<String>,
        elements: Vec<ElementRef>,
        relationship_scope: RelationshipScope,
        target_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        empty_main_track_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    BreakApartCompound {
        track_id: String,
        element_id: String,
        restored_element_ids: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    SetGroup {
        group_id: String,
        elements: Vec<ElementRef>,
    },
    ClearGroup {
        group_id: String,
    },
    SetLink {
        link_id: String,
        elements: Vec<ElementRef>,
    },
    ClearLink {
        link_id: String,
    },
    Move {
        track_id: String,
        target_track_id: Option<String>,
        element_id: String,
        start_time: MediaTime,
        relationship_scope: RelationshipScope,
    },
    SetParams {
        track_id: String,
        element_id: String,
        params: Params,
    },
    SetReframe {
        track_id: String,
        element_id: String,
        mode: Option<ReframeMode>,
        crop: Option<Rect>,
        focal_point: Option<Point>,
        target_rect: Option<Rect>,
        layout: Option<ReframeLayout>,
    },
    SetAudio {
        track_id: String,
        element_id: String,
        volume_db: Option<f64>,
        muted: Option<bool>,
        fade: Option<Fade>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    SeparateSourceAudio {
        track_id: String,
        element_id: String,
        audio_track_id: Option<String>,
        audio_element_id: Option<String>,
        link_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    DuckAudio {
        track_id: String,
        element_id: String,
        regions: Vec<Region>,
        reduction_db: f64,
        attack_duration: MediaTime,
        release_duration: MediaTime,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    AdjustMixGain {
        gain_db: f64,
    },
    UpsertEffect {
        track_id: String,
        element_id: String,
        effect_id: String,
        effect_type: String,
        params: Option<Params>,
        enabled: Option<bool>,
    },
    RemoveEffect {
        track_id: String,
        element_id: String,
        effect_id: String,
    },
    ReorderEffects {
        track_id: String,
        element_id: String,
        effect_ids: Vec<String>,
    },
    UpsertKeyframe {
        track_id: String,
        element_id: String,
        property_path: String,
        time: MediaTime,
        value: Scalar,
        interpolation: Option<KeyframeInterpolation>,
        keyframe_id: Option<String>,
    },
    RemoveKeyframe {
        track_id: String,
        element_id: String,
        property_path: String,
        keyframe_id: String,
    },
    RetimeKeyframe {
        track_id: String,
        element_id: String,
        property_path: String,
        keyframe_id: String,
        time: MediaTime,
    },
    UpsertTransition {
        track_id: String,
        transition_id: String,
        from_element_id: String,
        to_element_id: String,
        transition_type: TransitionType,
        duration: MediaTime,
    },
    RemoveTransition {
        track_id: String,
        transition_id: String,
    },
    SetRetime {
        track_id: String,
        element_id: String,
        rate: f64,
        maintain_pitch: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    Trim {
        track_id: String,
        element_id: String,
        start_time: Option<MediaTime>,
        duration: Option<MediaTime>,
        trim_start: MediaTime,
        trim_end: MediaTime,
        ripple: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    Split {
        track_id: String,
        element_id: String,
        split_time: MediaTime,
        right_element_id: Option<String>,
        retain_side: Option<RetainSide>,
        ripple: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
    },
    SetMatteState {
        track_id: String,
        element_id: String,
        enabled: bool,
    },
    RemoveMatte {
        track_id: String,
        element_id: String,
    },
    SetKey {
        track_id: String,
        element_id: String,
        key: CompositingKey,
    },
    RemoveKey {
        track_id: String,
        element_id: String,
    },
    SetMask {
        track_id: String,
        element_id: String,
        mask_id: String,
        mask_type: MaskType,
        params: Option<MaskParams>,
    },
    RemoveMask {
        track_id: String,
        element_id: String,
        mask_id: String,
    },
    SetAudioReplacementState {
        track_id: String,
        element_id: String,
        enabled: bool,
    },
    RemoveAudioReplacement {
        track_id: String,
        element_id: String,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasSize {
    pub width: u32,
    pub height: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Background {
    Color { color: String },
    Blur { blur_intensity: u32 },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(hashmap_as_object))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    pub fps: FrameRate,
    pub canvas_size: CanvasSize,
    pub background: Background,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_size_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_custom_canvas_size: Option<CanvasSize>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub track_id: String,
    pub name: String,
    pub track_type: String,
    pub role: String,
    pub muted: Option<bool>,
    pub hidden: Option<bool>,
    #[serde(default)]
    pub track_matte: Option<TrackMatteRouting>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackMatteRouting {
    pub source_track_id: String,
    pub mode: TrackMatteMode,
    pub inverted: bool,
    pub enabled: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackMatteMode {
    Alpha,
    Luma,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Effect {
    pub effect_id: String,
    pub effect_type: String,
    pub enabled: bool,
    pub params: Params,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Keyframe {
    pub keyframe_id: String,
    pub property_path: String,
    pub time: MediaTime,
    pub value: Scalar,
    pub interpolation: String,
    pub left_handle: Option<KeyframeHandle>,
    pub right_handle: Option<KeyframeHandle>,
    pub tangent_mode: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyframeHandle {
    pub dt: MediaTime,
    pub dv: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Element {
    pub element_id: String,
    pub track_id: String,
    pub element_type: String,
    pub name: String,
    pub definition_id: Option<String>,
    pub sticker_id: Option<String>,
    pub effect_type: Option<String>,
    pub start_time: MediaTime,
    pub duration: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    pub source_duration: Option<MediaTime>,
    pub text: Option<String>,
    pub params: Params,
    pub canonical_params: CanonicalValue,
    pub canonical_source: Option<CanonicalElement>,
    pub reframe: Option<Reframe>,
    pub volume_db: Option<f64>,
    pub muted: Option<bool>,
    pub fade: Option<Fade>,
    pub retime_rate: Option<f64>,
    pub maintain_pitch: Option<bool>,
    pub effects: Vec<Effect>,
    pub keyframes: Vec<Keyframe>,
    pub masks: Vec<Mask>,
    #[serde(default)]
    pub key: Option<CompositingKey>,
    pub matte_enabled: Option<bool>,
    pub audio_replacement_enabled: Option<bool>,
    pub source_audio_separated: Option<bool>,
    #[serde(default)]
    pub ducking: Vec<DuckingRegion>,
    pub group_id: Option<String>,
    pub link_id: Option<String>,
    pub compound_tracks: Vec<Track>,
    pub compound_transitions: Vec<Transition>,
    pub compound_members: Vec<Element>,
    pub compound_empty_main_track_id: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuckingRegion {
    pub start_time: MediaTime,
    pub duration: MediaTime,
    pub reduction_db: f64,
    pub attack_duration: MediaTime,
    pub release_duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mask {
    pub mask_id: String,
    pub mask_type: String,
    pub params: MaskParams,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transition {
    pub transition_id: String,
    pub track_id: String,
    pub from_element_id: String,
    pub to_element_id: String,
    pub transition_type: String,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActiveSceneSnapshot {
    pub schema_version: String,
    pub project_id: String,
    pub project_name: String,
    pub project_version: u64,
    pub scene_id: String,
    pub scene_name: String,
    pub settings: ProjectSettings,
    pub tracks: Vec<Track>,
    pub transitions: Vec<Transition>,
    pub elements: Vec<Element>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}

pub const PROJECT_CONTENT_PROJECTION: &str = "opencut-project-content";
pub const PROJECT_CONTENT_PROJECTION_VERSION: u32 = 1;
/// Version 2 added project identity; version 3 adds stable bookmark ids.
pub const PROJECT_CONTENT_PROJECTION_VERSION_2: u32 = 2;
pub const CURRENT_PROJECT_CONTENT_PROJECTION_VERSION: u32 = 3;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object, missing_as_null)
)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSnapshot {
    pub projection: String,
    pub projection_version: u32,
    pub project: CanonicalProject,
    pub media_assets: Vec<CanonicalMediaAsset>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalProject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub active_scene_id: String,
    pub main_scene_id: Option<String>,
    #[cfg_attr(feature = "wasm", tsify(type = "Record<string, CanonicalValue>"))]
    pub settings: CanonicalObject,
    pub scenes: Vec<CanonicalScene>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalScene {
    pub order: usize,
    pub id: String,
    pub name: String,
    pub is_main: bool,
    pub bookmarks: Vec<CanonicalBookmark>,
    pub tracks: Vec<CanonicalTrack>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalBookmark {
    pub order: usize,
    /// Stable bookmark identity, present from projection version 3 onward.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub time: MediaTime,
    #[cfg_attr(feature = "wasm", tsify(type = "MediaTime | null"))]
    pub duration: Option<MediaTime>,
    #[cfg_attr(feature = "wasm", tsify(type = "string | null"))]
    pub note: Option<String>,
    #[cfg_attr(feature = "wasm", tsify(type = "string | null"))]
    pub color: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalTrack {
    pub role: String,
    pub order: usize,
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub track_type: String,
    pub muted: Option<bool>,
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_matte: Option<TrackMatteRouting>,
    pub transitions: Vec<CanonicalTransition>,
    pub elements: Vec<CanonicalElement>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalTransition {
    pub order: usize,
    pub id: String,
    pub from_element_id: String,
    pub to_element_id: String,
    #[serde(rename = "type")]
    pub transition_type: String,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalEffect {
    pub order: usize,
    pub id: String,
    #[serde(rename = "type")]
    pub effect_type: String,
    pub enabled: bool,
    pub params: CanonicalValue,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMask {
    pub order: usize,
    pub id: String,
    #[serde(rename = "type")]
    pub mask_type: String,
    pub params: CanonicalValue,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalAttachment {
    pub asset_id: String,
    pub source_media_id: String,
    #[cfg_attr(feature = "wasm", tsify(type = "string | null"))]
    pub source_fingerprint: Option<String>,
    pub artifact_hash: String,
    pub artifact_fingerprint: String,
    pub model_id: String,
    pub model_version: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalElementCommon {
    pub order: usize,
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub link_id: Option<String>,
    pub start_time: MediaTime,
    pub duration: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    pub source_duration: Option<MediaTime>,
    pub params: CanonicalValue,
    pub animations: CanonicalValue,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CompositingKey {
    Chroma {
        key_color: String,
        similarity: f64,
        softness: f64,
        spill_suppression: f64,
        enabled: bool,
    },
    Luma {
        low: f64,
        high: f64,
        softness: f64,
        inverted: bool,
        enabled: bool,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CanonicalElement {
    Audio {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        source_type: String,
        media_id: Option<String>,
        source_url: Option<String>,
        retime: CanonicalValue,
        audio_replacement: Option<Box<CanonicalAttachment>>,
    },
    Video {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        media_id: String,
        hidden: Option<bool>,
        is_source_audio_enabled: Option<bool>,
        retime: CanonicalValue,
        effects: Vec<CanonicalEffect>,
        masks: Vec<CanonicalMask>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<Box<CompositingKey>>,
        matte: Option<Box<CanonicalAttachment>>,
        audio_replacement: Option<Box<CanonicalAttachment>>,
    },
    Image {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        media_id: String,
        hidden: Option<bool>,
        effects: Vec<CanonicalEffect>,
        masks: Vec<CanonicalMask>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<Box<CompositingKey>>,
    },
    Text {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        hidden: Option<bool>,
        effects: Vec<CanonicalEffect>,
    },
    Sticker {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        sticker_id: String,
        intrinsic_width: Option<u32>,
        intrinsic_height: Option<u32>,
        hidden: Option<bool>,
        effects: Vec<CanonicalEffect>,
    },
    Graphic {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        definition_id: String,
        hidden: Option<bool>,
        effects: Vec<CanonicalEffect>,
        masks: Vec<CanonicalMask>,
    },
    Effect {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        effect_type: String,
    },
    Compound {
        #[serde(flatten)]
        common: Box<CanonicalElementCommon>,
        hidden: Option<bool>,
        tracks: Vec<CanonicalTrack>,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalMediaAsset {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub size: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub fps: Option<f64>,
    pub has_audio: Option<bool>,
    pub source_fingerprint: Option<String>,
    pub source: CanonicalMediaSource,
    pub role: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CanonicalMediaSource {
    Local {
        content_hash: Option<ImmutableHash>,
    },
    Provider {
        source_url: String,
        provider: Option<String>,
        provider_version: Option<String>,
        content_hash: Option<ImmutableHash>,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImmutableHash {
    pub algorithm: String,
    pub digest: String,
}

/// What `remove_track` does when the track still carries elements.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoveTrackOccupiedPolicy {
    /// Reject the removal while any element remains on the track.
    #[default]
    Reject,
    /// Delete the track together with every element on it.
    Delete,
    /// Move every element onto `targetTrackId` before removing the track.
    Move,
    /// Delete the track elements and every transitively grouped or linked element.
    Cascade,
}

/// Optional bookmark fields that `update_bookmark` can clear.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BookmarkField {
    Note,
    Color,
    Duration,
}

/// Active-scene bookmark. The identity is only present for projection
/// version 3 snapshots; bookmark operations require it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bookmark {
    pub bookmark_id: Option<String>,
    pub time: MediaTime,
    pub duration: Option<MediaTime>,
    pub note: Option<String>,
    pub color: Option<String>,
}
