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
        resolved_allocations: Option<Vec<ObjectIdAllocation>>,
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
