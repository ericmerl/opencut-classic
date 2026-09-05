use bridge::export;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::MediaTime;

pub const TIME_MAP_SCHEMA_VERSION: &str = "opencut.time-map.v1";
const MIN_RATE: f64 = 0.01;
const MAX_RATE: f64 = 5.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FrameInterpolation {
    Nearest,
    FrameBlend,
    OpticalFlow,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameInterpolationPolicy {
    pub requested: FrameInterpolation,
    pub fallback: FrameInterpolation,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AudioHoldPolicy {
    Mute,
    HoldSample,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioTimeMapPolicy {
    pub maintain_pitch: bool,
    pub hold: AudioHoldPolicy,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeMapDirection {
    Forward,
    Reverse,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimeMapSegment {
    Speed {
        timeline_start: MediaTime,
        timeline_end: MediaTime,
        source_start: MediaTime,
        start_rate: f64,
        end_rate: f64,
        direction: TimeMapDirection,
    },
    Hold {
        timeline_start: MediaTime,
        timeline_end: MediaTime,
        source_time: MediaTime,
        frame_identity: String,
    },
}

impl TimeMapSegment {
    fn timeline_start(&self) -> MediaTime {
        match self {
            Self::Speed { timeline_start, .. } | Self::Hold { timeline_start, .. } => {
                *timeline_start
            }
        }
    }

    fn timeline_end(&self) -> MediaTime {
        match self {
            Self::Speed { timeline_end, .. } | Self::Hold { timeline_end, .. } => *timeline_end,
        }
    }

    fn source_start(&self) -> MediaTime {
        match self {
            Self::Speed { source_start, .. } => *source_start,
            Self::Hold { source_time, .. } => *source_time,
        }
    }

    fn source_at(&self, clip_time: MediaTime) -> Option<MediaTime> {
        match self {
            Self::Hold { source_time, .. } => Some(*source_time),
            Self::Speed {
                timeline_start,
                timeline_end,
                source_start,
                start_rate,
                end_rate,
                direction,
            } => {
                let duration = timeline_end
                    .as_ticks()
                    .checked_sub(timeline_start.as_ticks())?;
                let elapsed = clip_time
                    .as_ticks()
                    .checked_sub(timeline_start.as_ticks())?
                    .clamp(0, duration);
                let position = elapsed as f64 / duration as f64;
                let source_delta = duration as f64
                    * (start_rate * position + 0.5 * (end_rate - start_rate) * position * position);
                let signed_delta = match direction {
                    TimeMapDirection::Forward => source_delta,
                    TimeMapDirection::Reverse => -source_delta,
                };
                let ticks = source_start.as_ticks() as f64 + signed_delta;
                if !ticks.is_finite() || ticks < i64::MIN as f64 || ticks > i64::MAX as f64 {
                    return None;
                }
                Some(MediaTime::from_ticks(ticks.round() as i64))
            }
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Speed { .. } => "speed",
            Self::Hold { .. } => "hold",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMap {
    pub schema_version: String,
    pub frame_interpolation: FrameInterpolationPolicy,
    pub audio_policy: AudioTimeMapPolicy,
    pub segments: Vec<TimeMapSegment>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateTimeMapOptions {
    pub time_map: TimeMap,
    pub sample_clip_times: Vec<MediaTime>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTimeMapSourceTimeOptions {
    pub time_map: TimeMap,
    pub clip_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliceTimeMapOptions {
    pub time_map: TimeMap,
    pub timeline_start: MediaTime,
    pub timeline_end: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTimeMapRateOptions {
    pub time_map: TimeMap,
    pub clip_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTimeMapAudioSampleOptions {
    pub time_map: TimeMap,
    pub clip_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapAudioSample {
    pub source_time: MediaTime,
    pub muted: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTimeMapAudioOptions {
    pub time_map: TimeMap,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimeMapAudioChunk {
    Speed {
        timeline_start: MediaTime,
        timeline_end: MediaTime,
        source_start: MediaTime,
        source_end: MediaTime,
        start_rate: f64,
        end_rate: f64,
        direction: TimeMapDirection,
    },
    Hold {
        timeline_start: MediaTime,
        timeline_end: MediaTime,
        source_time: MediaTime,
        muted: bool,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapAudioPlan {
    pub audio_policy: AudioTimeMapPolicy,
    pub chunks: Vec<TimeMapAudioChunk>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DescribeTimeMapOptions {
    pub time_map: TimeMap,
    pub element_timeline_start: MediaTime,
    pub source_trim_start: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapBoundaryReadback {
    pub clip_time: MediaTime,
    pub timeline_time: MediaTime,
    pub source_time: MediaTime,
    pub absolute_source_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeMapTrimPolicy {
    SliceTimeMap,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeMapSplitPolicy {
    SliceAndRebaseTimeMap,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeMapTimelineAnchoredConsumer {
    Keyframe,
    Transition,
    Caption,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeMapSourceMappedConsumer {
    Tracker,
    Matte,
    VideoDecoder,
    Audio,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapMappingPolicy {
    pub trim: TimeMapTrimPolicy,
    pub split: TimeMapSplitPolicy,
    pub timeline_anchored: Vec<TimeMapTimelineAnchoredConsumer>,
    pub source_mapped: Vec<TimeMapSourceMappedConsumer>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapDescription {
    pub source_time_readback: Vec<TimeMapBoundaryReadback>,
    pub mapping_policy: TimeMapMappingPolicy,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTimeMapTrimOptions {
    pub time_map: TimeMap,
    pub element_start_time: MediaTime,
    pub element_duration: MediaTime,
    pub source_trim_start: MediaTime,
    pub source_trim_end: MediaTime,
    pub requested_start_time: Option<MediaTime>,
    pub requested_duration: Option<MediaTime>,
    pub requested_time_map_range: Option<TimeMapTrimRange>,
    pub requested_trim_start: MediaTime,
    pub requested_trim_end: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapTrimRange {
    pub start: MediaTime,
    pub end: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TimeMapRetimeMode {
    TimeMap,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapRetimeConfigOptions {
    pub time_map: TimeMap,
}

/// The element retime configuration a canonical time map implies. Rust owns
/// this derivation so the canonical projection and the editor never disagree.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapRetimeConfig {
    pub mode: TimeMapRetimeMode,
    pub rate: f64,
    pub maintain_pitch: bool,
    pub time_map: TimeMap,
}

/// Split planning for any retimed clip: a constant rate, or a canonical time
/// map that takes precedence over the rate.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRetimeSplitOptions {
    pub rate: f64,
    pub time_map: Option<TimeMap>,
    pub clip_duration: MediaTime,
    pub split_clip_time: MediaTime,
    pub source_trim_start: MediaTime,
    pub source_trim_end: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetimeSplitPlan {
    pub left_time_map: Option<TimeMap>,
    pub right_time_map: Option<TimeMap>,
    pub left_trim_start: MediaTime,
    pub left_trim_end: MediaTime,
    pub right_trim_start: MediaTime,
    pub right_trim_end: MediaTime,
}

/// Tracking-sample mapping for any retimed clip: a constant rate keeps the
/// tracker's own sample times, a canonical time map resamples on the interval.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapRetimeTrackingSamplesOptions {
    pub rate: f64,
    pub time_map: Option<TimeMap>,
    pub clip_duration: MediaTime,
    pub source_trim_start: MediaTime,
    pub sample_interval: MediaTime,
    pub samples: Vec<TimeMapTrackingSample>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapTrimPlan {
    pub start_time: MediaTime,
    pub duration: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    pub time_map: TimeMap,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTimeMapSplitOptions {
    pub time_map: TimeMap,
    pub split_clip_time: MediaTime,
    pub source_trim_start: MediaTime,
    pub source_trim_end: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapSplitPlan {
    pub left_time_map: TimeMap,
    pub right_time_map: TimeMap,
    pub left_trim_start: MediaTime,
    pub left_trim_end: MediaTime,
    pub right_trim_start: MediaTime,
    pub right_trim_end: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapTrackingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapTrackingSample {
    pub source_time: MediaTime,
    #[serde(rename = "box")]
    pub box_value: TimeMapTrackingBox,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapTimeMapTrackingSamplesOptions {
    pub time_map: TimeMap,
    pub clip_duration: MediaTime,
    pub source_trim_start: MediaTime,
    pub sample_interval: MediaTime,
    pub samples: Vec<TimeMapTrackingSample>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappedTimeMapTrackingSample {
    pub time: MediaTime,
    #[serde(rename = "box")]
    pub box_value: TimeMapTrackingBox,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapTrackingPlan {
    pub samples: Vec<MappedTimeMapTrackingSample>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapSourceReadback {
    pub clip_time: MediaTime,
    pub source_time: MediaTime,
    pub segment_index: usize,
    pub kind: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapDiagnostic {
    pub code: String,
    pub requested: FrameInterpolation,
    pub effective: FrameInterpolation,
    pub message: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveFrameInterpolation {
    pub requested: FrameInterpolation,
    pub effective: FrameInterpolation,
    pub fallback: FrameInterpolation,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeMapEvaluation {
    pub canonical_time_map: TimeMap,
    pub duration: MediaTime,
    pub frame_interpolation: EffectiveFrameInterpolation,
    pub audio_policy: AudioTimeMapPolicy,
    pub diagnostics: Vec<TimeMapDiagnostic>,
    pub source_time_readback: Vec<TimeMapSourceReadback>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TimeMapEvaluationResponse {
    Evaluated(TimeMapEvaluation),
    Rejected { code: String, reason: String },
}

impl TimeMap {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != TIME_MAP_SCHEMA_VERSION {
            return Err(format!(
                "unsupported time-map schemaVersion {}; expected {TIME_MAP_SCHEMA_VERSION}",
                self.schema_version
            ));
        }
        if self.segments.is_empty() {
            return Err("time map requires at least one segment".into());
        }
        if self.frame_interpolation.requested != FrameInterpolation::Nearest
            && self.frame_interpolation.fallback != FrameInterpolation::Nearest
        {
            return Err("unsupported frame interpolation requires nearest fallback".into());
        }
        let mut previous_timeline_end = MediaTime::ZERO;
        let mut previous_source_end: Option<MediaTime> = None;
        for (index, segment) in self.segments.iter().enumerate() {
            if segment.timeline_start() != previous_timeline_end {
                return Err(format!(
                    "segment {index} timelineStart must equal the previous timelineEnd"
                ));
            }
            if segment.timeline_end() <= segment.timeline_start() {
                return Err(format!(
                    "segment {index} must have positive timeline duration"
                ));
            }
            if segment.source_start() < MediaTime::ZERO {
                return Err(format!("segment {index} source time must be non-negative"));
            }
            if let Some(expected) = previous_source_end
                && segment
                    .source_start()
                    .as_ticks()
                    .abs_diff(expected.as_ticks())
                    > 1
            {
                return Err(format!(
                    "segment {index} source start must equal the previous segment source end within one canonical tick"
                ));
            }
            match segment {
                TimeMapSegment::Speed {
                    start_rate,
                    end_rate,
                    ..
                } => {
                    for (name, rate) in [("startRate", start_rate), ("endRate", end_rate)] {
                        if !rate.is_finite() || !(MIN_RATE..=MAX_RATE).contains(rate) {
                            return Err(format!(
                                "segment {index} {name} must be between {MIN_RATE} and {MAX_RATE}"
                            ));
                        }
                    }
                }
                TimeMapSegment::Hold { frame_identity, .. } => {
                    if frame_identity.trim().is_empty() {
                        return Err(format!("segment {index} frameIdentity must not be empty"));
                    }
                }
            }
            let source_end = segment
                .source_at(segment.timeline_end())
                .ok_or_else(|| format!("segment {index} source mapping overflow"))?;
            if source_end < MediaTime::ZERO {
                return Err(format!("segment {index} maps before source time zero"));
            }
            previous_timeline_end = segment.timeline_end();
            previous_source_end = Some(source_end);
        }
        Ok(())
    }

    pub fn duration(&self) -> MediaTime {
        self.segments
            .last()
            .map(TimeMapSegment::timeline_end)
            .unwrap_or(MediaTime::ZERO)
    }

    pub fn source_bounds(&self) -> Result<(MediaTime, MediaTime), String> {
        self.validate()?;
        let mut minimum = None::<MediaTime>;
        let mut maximum = None::<MediaTime>;
        for segment in &self.segments {
            for source_time in [
                segment.source_start(),
                segment
                    .source_at(segment.timeline_end())
                    .ok_or_else(|| "source mapping overflow".to_string())?,
            ] {
                minimum = Some(minimum.map_or(source_time, |value| value.min(source_time)));
                maximum = Some(maximum.map_or(source_time, |value| value.max(source_time)));
            }
        }
        Ok((
            minimum.unwrap_or(MediaTime::ZERO),
            maximum.unwrap_or(MediaTime::ZERO),
        ))
    }

    pub fn source_time_at(&self, clip_time: MediaTime) -> Result<TimeMapSourceReadback, String> {
        if clip_time < MediaTime::ZERO || clip_time > self.duration() {
            return Err(format!(
                "clip time {} is outside 0..{}",
                clip_time.as_ticks(),
                self.duration().as_ticks()
            ));
        }
        let (segment_index, segment) = self.segment_at(clip_time)?;
        let source_time = segment
            .source_at(clip_time)
            .ok_or_else(|| "source mapping overflow".to_string())?;
        Ok(TimeMapSourceReadback {
            clip_time,
            source_time,
            segment_index,
            kind: segment.kind().into(),
        })
    }

    fn segment_at(&self, clip_time: MediaTime) -> Result<(usize, &TimeMapSegment), String> {
        let last_index = self.segments.len().saturating_sub(1);
        self.segments
            .iter()
            .enumerate()
            .find(|(index, segment)| {
                clip_time >= segment.timeline_start()
                    && (clip_time < segment.timeline_end()
                        || (*index == last_index && clip_time == segment.timeline_end()))
            })
            .ok_or_else(|| "clip time does not resolve to a segment".to_string())
    }

    fn effective_rate_at(&self, clip_time: MediaTime) -> Result<f64, String> {
        let (_, segment) = self.segment_at(clip_time)?;
        match segment {
            TimeMapSegment::Hold { .. } => Ok(0.0),
            TimeMapSegment::Speed {
                timeline_start,
                timeline_end,
                start_rate,
                end_rate,
                direction,
                ..
            } => {
                let duration = (timeline_end.as_ticks() - timeline_start.as_ticks()) as f64;
                let position = (clip_time.as_ticks() - timeline_start.as_ticks()) as f64 / duration;
                let magnitude = start_rate + (end_rate - start_rate) * position.clamp(0.0, 1.0);
                Ok(match direction {
                    TimeMapDirection::Forward => magnitude,
                    TimeMapDirection::Reverse => -magnitude,
                })
            }
        }
    }

    pub fn slice(
        &self,
        timeline_start: MediaTime,
        timeline_end: MediaTime,
    ) -> Result<Self, String> {
        self.validate()?;
        if timeline_start < MediaTime::ZERO
            || timeline_end <= timeline_start
            || timeline_end > self.duration()
        {
            return Err("time-map slice must be a positive interval within the map".into());
        }
        let mut segments = Vec::new();
        for segment in &self.segments {
            let overlap_start = segment.timeline_start().max(timeline_start);
            let overlap_end = segment.timeline_end().min(timeline_end);
            if overlap_end <= overlap_start {
                continue;
            }
            let rebased_start = MediaTime::from_ticks(
                overlap_start
                    .as_ticks()
                    .checked_sub(timeline_start.as_ticks())
                    .ok_or_else(|| "time-map slice start overflow".to_string())?,
            );
            let rebased_end = MediaTime::from_ticks(
                overlap_end
                    .as_ticks()
                    .checked_sub(timeline_start.as_ticks())
                    .ok_or_else(|| "time-map slice end overflow".to_string())?,
            );
            let sliced = match segment {
                TimeMapSegment::Hold {
                    source_time,
                    frame_identity,
                    ..
                } => TimeMapSegment::Hold {
                    timeline_start: rebased_start,
                    timeline_end: rebased_end,
                    source_time: *source_time,
                    frame_identity: frame_identity.clone(),
                },
                TimeMapSegment::Speed {
                    timeline_start: segment_start,
                    timeline_end: segment_end,
                    source_start: _,
                    start_rate,
                    end_rate,
                    direction,
                } => {
                    let duration = (segment_end.as_ticks() - segment_start.as_ticks()) as f64;
                    let start_position =
                        (overlap_start.as_ticks() - segment_start.as_ticks()) as f64 / duration;
                    let end_position =
                        (overlap_end.as_ticks() - segment_start.as_ticks()) as f64 / duration;
                    TimeMapSegment::Speed {
                        timeline_start: rebased_start,
                        timeline_end: rebased_end,
                        source_start: segment
                            .source_at(overlap_start)
                            .ok_or_else(|| "time-map slice source overflow".to_string())?,
                        start_rate: start_rate + (end_rate - start_rate) * start_position,
                        end_rate: start_rate + (end_rate - start_rate) * end_position,
                        direction: *direction,
                    }
                }
            };
            segments.push(sliced);
        }
        let result = Self {
            schema_version: self.schema_version.clone(),
            frame_interpolation: self.frame_interpolation,
            audio_policy: self.audio_policy,
            segments,
        };
        result.validate()?;
        Ok(result)
    }
}

#[export]
pub fn evaluate_time_map(
    EvaluateTimeMapOptions {
        time_map,
        sample_clip_times,
    }: EvaluateTimeMapOptions,
) -> TimeMapEvaluationResponse {
    if let Err(reason) = time_map.validate() {
        return TimeMapEvaluationResponse::Rejected {
            code: "INVALID_TIME_MAP".into(),
            reason,
        };
    }
    let source_time_readback = match sample_clip_times
        .into_iter()
        .map(|time| time_map.source_time_at(time))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(readback) => readback,
        Err(reason) => {
            return TimeMapEvaluationResponse::Rejected {
                code: "INVALID_SAMPLE_TIME".into(),
                reason,
            };
        }
    };
    let requested = time_map.frame_interpolation.requested;
    let effective = if requested == FrameInterpolation::Nearest {
        FrameInterpolation::Nearest
    } else {
        time_map.frame_interpolation.fallback
    };
    let diagnostics = if requested == effective {
        vec![]
    } else {
        vec![TimeMapDiagnostic {
            code: "FRAME_INTERPOLATION_FALLBACK".into(),
            requested,
            effective,
            message: format!(
                "{requested:?} is unavailable; using the explicit {effective:?} fallback"
            ),
        }]
    };
    TimeMapEvaluationResponse::Evaluated(TimeMapEvaluation {
        canonical_time_map: time_map.clone(),
        duration: time_map.duration(),
        frame_interpolation: EffectiveFrameInterpolation {
            requested,
            effective,
            fallback: time_map.frame_interpolation.fallback,
        },
        audio_policy: time_map.audio_policy,
        diagnostics,
        source_time_readback,
    })
}

#[export]
pub fn resolve_time_map_source_time(
    ResolveTimeMapSourceTimeOptions {
        time_map,
        clip_time,
    }: ResolveTimeMapSourceTimeOptions,
) -> Option<MediaTime> {
    time_map
        .validate()
        .ok()
        .and_then(|()| time_map.source_time_at(clip_time).ok())
        .map(|readback| readback.source_time)
}

#[export]
pub fn slice_time_map(
    SliceTimeMapOptions {
        time_map,
        timeline_start,
        timeline_end,
    }: SliceTimeMapOptions,
) -> Option<TimeMap> {
    time_map.slice(timeline_start, timeline_end).ok()
}

#[export]
pub fn resolve_time_map_rate(
    ResolveTimeMapRateOptions {
        time_map,
        clip_time,
    }: ResolveTimeMapRateOptions,
) -> Option<f64> {
    time_map
        .validate()
        .ok()
        .and_then(|()| time_map.effective_rate_at(clip_time).ok())
}

#[export]
pub fn resolve_time_map_audio_sample(
    ResolveTimeMapAudioSampleOptions {
        time_map,
        clip_time,
    }: ResolveTimeMapAudioSampleOptions,
) -> Option<TimeMapAudioSample> {
    time_map.validate().ok()?;
    let readback = time_map.source_time_at(clip_time).ok()?;
    let (_, segment) = time_map.segment_at(clip_time).ok()?;
    Some(TimeMapAudioSample {
        source_time: readback.source_time,
        muted: matches!(segment, TimeMapSegment::Hold { .. })
            && time_map.audio_policy.hold == AudioHoldPolicy::Mute,
    })
}

#[export]
pub fn plan_time_map_audio(
    PlanTimeMapAudioOptions { time_map }: PlanTimeMapAudioOptions,
) -> Option<TimeMapAudioPlan> {
    time_map.validate().ok()?;
    let chunks = time_map
        .segments
        .iter()
        .map(|segment| match segment {
            TimeMapSegment::Speed {
                timeline_start,
                timeline_end,
                source_start,
                start_rate,
                end_rate,
                direction,
            } => Some(TimeMapAudioChunk::Speed {
                timeline_start: *timeline_start,
                timeline_end: *timeline_end,
                source_start: *source_start,
                source_end: segment.source_at(*timeline_end)?,
                start_rate: *start_rate,
                end_rate: *end_rate,
                direction: *direction,
            }),
            TimeMapSegment::Hold {
                timeline_start,
                timeline_end,
                source_time,
                ..
            } => Some(TimeMapAudioChunk::Hold {
                timeline_start: *timeline_start,
                timeline_end: *timeline_end,
                source_time: *source_time,
                muted: time_map.audio_policy.hold == AudioHoldPolicy::Mute,
            }),
        })
        .collect::<Option<Vec<_>>>()?;
    Some(TimeMapAudioPlan {
        audio_policy: time_map.audio_policy,
        chunks,
    })
}

#[export]
pub fn describe_time_map(
    DescribeTimeMapOptions {
        time_map,
        element_timeline_start,
        source_trim_start,
    }: DescribeTimeMapOptions,
) -> Option<TimeMapDescription> {
    time_map.validate().ok()?;
    let boundary_times = time_map
        .segments
        .iter()
        .flat_map(|segment| [segment.timeline_start(), segment.timeline_end()])
        .collect::<BTreeSet<_>>();
    let source_time_readback = boundary_times
        .into_iter()
        .map(|clip_time| {
            let source_time = time_map.source_time_at(clip_time).ok()?.source_time;
            Some(TimeMapBoundaryReadback {
                clip_time,
                timeline_time: MediaTime::from_ticks(
                    element_timeline_start
                        .as_ticks()
                        .checked_add(clip_time.as_ticks())?,
                ),
                source_time,
                absolute_source_time: MediaTime::from_ticks(
                    source_trim_start
                        .as_ticks()
                        .checked_add(source_time.as_ticks())?,
                ),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(TimeMapDescription {
        source_time_readback,
        mapping_policy: TimeMapMappingPolicy {
            trim: TimeMapTrimPolicy::SliceTimeMap,
            split: TimeMapSplitPolicy::SliceAndRebaseTimeMap,
            timeline_anchored: vec![
                TimeMapTimelineAnchoredConsumer::Keyframe,
                TimeMapTimelineAnchoredConsumer::Transition,
                TimeMapTimelineAnchoredConsumer::Caption,
            ],
            source_mapped: vec![
                TimeMapSourceMappedConsumer::Tracker,
                TimeMapSourceMappedConsumer::Matte,
                TimeMapSourceMappedConsumer::VideoDecoder,
                TimeMapSourceMappedConsumer::Audio,
            ],
        },
    })
}

#[export]
pub fn plan_time_map_trim(
    PlanTimeMapTrimOptions {
        time_map,
        element_start_time,
        element_duration,
        source_trim_start,
        source_trim_end,
        requested_start_time,
        requested_duration,
        requested_time_map_range,
        requested_trim_start,
        requested_trim_end,
    }: PlanTimeMapTrimOptions,
) -> Option<TimeMapTrimPlan> {
    time_map.validate().ok()?;
    if element_duration != time_map.duration()
        || requested_trim_start != source_trim_start
        || requested_trim_end != source_trim_end
    {
        return None;
    }
    let start_time = requested_start_time.unwrap_or(element_start_time);
    let (range_start, range_end) = requested_time_map_range
        .map(|range| (range.start, range.end))
        .unwrap_or((
            MediaTime::ZERO,
            requested_duration.unwrap_or(element_duration),
        ));
    if range_start < MediaTime::ZERO || range_end <= range_start || range_end > element_duration {
        return None;
    }
    let duration = MediaTime::from_ticks(range_end.as_ticks().checked_sub(range_start.as_ticks())?);
    if start_time < MediaTime::ZERO
        || requested_duration.is_some_and(|requested| requested != duration)
    {
        return None;
    }
    let planned_time_map = if range_start == MediaTime::ZERO && range_end == element_duration {
        time_map
    } else {
        time_map.slice(range_start, range_end).ok()?
    };
    Some(TimeMapTrimPlan {
        start_time,
        duration,
        trim_start: source_trim_start,
        trim_end: source_trim_end,
        time_map: planned_time_map,
    })
}

#[export]
pub fn plan_time_map_split(
    PlanTimeMapSplitOptions {
        time_map,
        split_clip_time,
        source_trim_start,
        source_trim_end,
    }: PlanTimeMapSplitOptions,
) -> Option<TimeMapSplitPlan> {
    time_map.validate().ok()?;
    if split_clip_time <= MediaTime::ZERO || split_clip_time >= time_map.duration() {
        return None;
    }
    Some(TimeMapSplitPlan {
        left_time_map: time_map.slice(MediaTime::ZERO, split_clip_time).ok()?,
        right_time_map: time_map.slice(split_clip_time, time_map.duration()).ok()?,
        left_trim_start: source_trim_start,
        left_trim_end: source_trim_end,
        right_trim_start: source_trim_start,
        right_trim_end: source_trim_end,
    })
}

pub fn retime_config_for_time_map(time_map: &TimeMap) -> TimeMapRetimeConfig {
    TimeMapRetimeConfig {
        mode: TimeMapRetimeMode::TimeMap,
        rate: 1.0,
        maintain_pitch: time_map.audio_policy.maintain_pitch,
        time_map: time_map.clone(),
    }
}

#[export]
pub fn time_map_retime_config(
    TimeMapRetimeConfigOptions { time_map }: TimeMapRetimeConfigOptions,
) -> Option<TimeMapRetimeConfig> {
    time_map.validate().ok()?;
    Some(retime_config_for_time_map(&time_map))
}

fn constant_rate_source_span(clip_time: MediaTime, rate: f64) -> Option<MediaTime> {
    if !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    let ticks = (clip_time.as_ticks() as f64) * rate;
    if !ticks.is_finite() || ticks < i64::MIN as f64 || ticks > i64::MAX as f64 {
        return None;
    }
    Some(MediaTime::from_ticks(ticks.round() as i64))
}

#[export]
pub fn plan_retime_split(
    PlanRetimeSplitOptions {
        rate,
        time_map,
        clip_duration,
        split_clip_time,
        source_trim_start,
        source_trim_end,
    }: PlanRetimeSplitOptions,
) -> Option<RetimeSplitPlan> {
    if let Some(time_map) = time_map {
        let plan = plan_time_map_split(PlanTimeMapSplitOptions {
            time_map,
            split_clip_time,
            source_trim_start,
            source_trim_end,
        })?;
        return Some(RetimeSplitPlan {
            left_time_map: Some(plan.left_time_map),
            right_time_map: Some(plan.right_time_map),
            left_trim_start: plan.left_trim_start,
            left_trim_end: plan.left_trim_end,
            right_trim_start: plan.right_trim_start,
            right_trim_end: plan.right_trim_end,
        });
    }
    if split_clip_time <= MediaTime::ZERO || split_clip_time >= clip_duration {
        return None;
    }
    // Snap the source-side split point once and derive the right span from the
    // total so `left + right == total` even when rounding is involved.
    let left_source_span = constant_rate_source_span(split_clip_time, rate)?;
    let total_source_span = constant_rate_source_span(clip_duration, rate)?;
    let right_source_span = MediaTime::from_ticks(
        total_source_span
            .as_ticks()
            .checked_sub(left_source_span.as_ticks())?,
    );
    Some(RetimeSplitPlan {
        left_time_map: None,
        right_time_map: None,
        left_trim_start: source_trim_start,
        left_trim_end: MediaTime::from_ticks(
            source_trim_end
                .as_ticks()
                .checked_add(right_source_span.as_ticks())?,
        ),
        right_trim_start: MediaTime::from_ticks(
            source_trim_start
                .as_ticks()
                .checked_add(left_source_span.as_ticks())?,
        ),
        right_trim_end: source_trim_end,
    })
}

#[export]
pub fn map_retime_tracking_samples(
    MapRetimeTrackingSamplesOptions {
        rate,
        time_map,
        clip_duration,
        source_trim_start,
        sample_interval,
        samples,
    }: MapRetimeTrackingSamplesOptions,
) -> Option<TimeMapTrackingPlan> {
    if let Some(time_map) = time_map {
        return map_time_map_tracking_samples(MapTimeMapTrackingSamplesOptions {
            time_map,
            clip_duration,
            source_trim_start,
            sample_interval,
            samples,
        });
    }
    if !rate.is_finite() || rate <= 0.0 || clip_duration < MediaTime::ZERO {
        return None;
    }
    let visible_source_end = source_trim_start
        .as_ticks()
        .checked_add(constant_rate_source_span(clip_duration, rate)?.as_ticks())?;
    let mapped_samples = samples
        .into_iter()
        .filter(|sample| {
            sample.source_time >= source_trim_start
                && sample.source_time.as_ticks() <= visible_source_end
        })
        .map(|sample| {
            let offset = (sample.source_time.as_ticks() - source_trim_start.as_ticks()) as f64;
            let ticks = (offset / rate).round() as i64;
            MappedTimeMapTrackingSample {
                time: MediaTime::from_ticks(ticks.clamp(0, clip_duration.as_ticks())),
                box_value: sample.box_value,
            }
        })
        .collect::<Vec<_>>();
    Some(TimeMapTrackingPlan {
        samples: mapped_samples,
    })
}

#[export]
pub fn map_time_map_tracking_samples(
    MapTimeMapTrackingSamplesOptions {
        time_map,
        clip_duration,
        source_trim_start,
        sample_interval,
        samples,
    }: MapTimeMapTrackingSamplesOptions,
) -> Option<TimeMapTrackingPlan> {
    time_map.validate().ok()?;
    if clip_duration < MediaTime::ZERO
        || clip_duration > time_map.duration()
        || sample_interval <= MediaTime::ZERO
        || samples.is_empty()
        || samples
            .windows(2)
            .any(|pair| pair[0].source_time > pair[1].source_time)
    {
        return None;
    }
    let mut clip_times = Vec::new();
    let mut time = MediaTime::ZERO;
    while time < clip_duration {
        clip_times.push(time);
        time = MediaTime::from_ticks(time.as_ticks().checked_add(sample_interval.as_ticks())?);
    }
    clip_times.push(clip_duration);
    let mapped_samples = clip_times
        .into_iter()
        .filter_map(|clip_time| {
            let mapped = time_map.source_time_at(clip_time).ok()?;
            let absolute_source_time = MediaTime::from_ticks(
                source_trim_start
                    .as_ticks()
                    .checked_add(mapped.source_time.as_ticks())?,
            );
            interpolate_tracking_box(&samples, absolute_source_time).map(|box_value| {
                MappedTimeMapTrackingSample {
                    time: clip_time,
                    box_value,
                }
            })
        })
        .collect::<Vec<_>>();
    Some(TimeMapTrackingPlan {
        samples: mapped_samples,
    })
}

fn interpolate_tracking_box(
    samples: &[TimeMapTrackingSample],
    source_time: MediaTime,
) -> Option<TimeMapTrackingBox> {
    let first = samples.first()?;
    let last = samples.last()?;
    if source_time < first.source_time || source_time > last.source_time {
        return None;
    }
    let upper_index = samples.partition_point(|sample| sample.source_time < source_time);
    let upper = samples.get(upper_index).unwrap_or(last);
    let lower = samples.get(upper_index.saturating_sub(1)).unwrap_or(first);
    if upper.source_time == lower.source_time {
        return Some(upper.box_value);
    }
    let position = (source_time.as_ticks() - lower.source_time.as_ticks()) as f64
        / (upper.source_time.as_ticks() - lower.source_time.as_ticks()) as f64;
    let interpolate =
        |left: f64, right: f64| ((left + (right - left) * position) * 1e12).round() / 1e12;
    Some(TimeMapTrackingBox {
        x: interpolate(lower.box_value.x, upper.box_value.x),
        y: interpolate(lower.box_value.y, upper.box_value.y),
        width: interpolate(lower.box_value.width, upper.box_value.width),
        height: interpolate(lower.box_value.height, upper.box_value.height),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_map() -> TimeMap {
        TimeMap {
            schema_version: TIME_MAP_SCHEMA_VERSION.into(),
            frame_interpolation: FrameInterpolationPolicy {
                requested: FrameInterpolation::Nearest,
                fallback: FrameInterpolation::Nearest,
            },
            audio_policy: AudioTimeMapPolicy {
                maintain_pitch: true,
                hold: AudioHoldPolicy::Mute,
            },
            segments: vec![
                TimeMapSegment::Speed {
                    timeline_start: MediaTime::ZERO,
                    timeline_end: MediaTime::from_ticks(120_000),
                    source_start: MediaTime::ZERO,
                    start_rate: 0.5,
                    end_rate: 1.5,
                    direction: TimeMapDirection::Forward,
                },
                TimeMapSegment::Hold {
                    timeline_start: MediaTime::from_ticks(120_000),
                    timeline_end: MediaTime::from_ticks(180_000),
                    source_time: MediaTime::from_ticks(120_000),
                    frame_identity: "source-frame:120000".into(),
                },
            ],
        }
    }

    #[test]
    fn rust_owns_effective_rate_and_audio_mapping() {
        let time_map = sample_map();
        assert_eq!(
            resolve_time_map_rate(ResolveTimeMapRateOptions {
                time_map: time_map.clone(),
                clip_time: MediaTime::from_ticks(60_000),
            }),
            Some(1.0),
        );
        assert_eq!(
            resolve_time_map_audio_sample(ResolveTimeMapAudioSampleOptions {
                time_map: time_map.clone(),
                clip_time: MediaTime::from_ticks(150_000),
            }),
            Some(TimeMapAudioSample {
                source_time: MediaTime::from_ticks(120_000),
                muted: true,
            }),
        );
        let plan = plan_time_map_audio(PlanTimeMapAudioOptions { time_map }).unwrap();
        assert_eq!(plan.chunks.len(), 2);
        assert!(matches!(
            &plan.chunks[0],
            TimeMapAudioChunk::Speed {
                start_rate,
                end_rate,
                source_end,
                ..
            } if *start_rate == 0.5 && *end_rate == 1.5 && *source_end == MediaTime::from_ticks(120_000)
        ));
    }

    #[test]
    fn rust_owns_query_description_and_mapping_policy() {
        let description = describe_time_map(DescribeTimeMapOptions {
            time_map: sample_map(),
            element_timeline_start: MediaTime::from_ticks(10_000),
            source_trim_start: MediaTime::from_ticks(20_000),
        })
        .unwrap();
        assert_eq!(description.source_time_readback.len(), 3);
        assert_eq!(
            description.source_time_readback[1],
            TimeMapBoundaryReadback {
                clip_time: MediaTime::from_ticks(120_000),
                timeline_time: MediaTime::from_ticks(130_000),
                source_time: MediaTime::from_ticks(120_000),
                absolute_source_time: MediaTime::from_ticks(140_000),
            }
        );
        assert_eq!(
            description.mapping_policy.trim,
            TimeMapTrimPolicy::SliceTimeMap
        );
    }

    #[test]
    fn moving_a_time_mapped_clip_does_not_crop_it() {
        let plan = plan_time_map_trim(PlanTimeMapTrimOptions {
            time_map: sample_map(),
            element_start_time: MediaTime::ZERO,
            element_duration: MediaTime::from_ticks(180_000),
            source_trim_start: MediaTime::from_ticks(5_000),
            source_trim_end: MediaTime::from_ticks(7_000),
            requested_start_time: Some(MediaTime::from_ticks(30_000)),
            requested_duration: None,
            requested_time_map_range: None,
            requested_trim_start: MediaTime::from_ticks(5_000),
            requested_trim_end: MediaTime::from_ticks(7_000),
        })
        .unwrap();
        assert_eq!(plan.start_time, MediaTime::from_ticks(30_000));
        assert_eq!(plan.time_map, sample_map());
    }

    #[test]
    fn trimming_a_time_mapped_clip_slices_any_timeline_boundary() {
        let plan = plan_time_map_trim(PlanTimeMapTrimOptions {
            time_map: sample_map(),
            element_start_time: MediaTime::from_ticks(10_000),
            element_duration: MediaTime::from_ticks(180_000),
            source_trim_start: MediaTime::from_ticks(5_000),
            source_trim_end: MediaTime::from_ticks(7_000),
            requested_start_time: Some(MediaTime::from_ticks(40_000)),
            requested_duration: None,
            requested_time_map_range: Some(TimeMapTrimRange {
                start: MediaTime::from_ticks(60_000),
                end: MediaTime::from_ticks(180_000),
            }),
            requested_trim_start: MediaTime::from_ticks(5_000),
            requested_trim_end: MediaTime::from_ticks(7_000),
        })
        .unwrap();
        assert_eq!(plan.start_time, MediaTime::from_ticks(40_000));
        assert_eq!(plan.duration, MediaTime::from_ticks(120_000));
        assert_eq!(plan.time_map.duration(), MediaTime::from_ticks(120_000));
        assert_eq!(
            plan.time_map
                .source_time_at(MediaTime::ZERO)
                .unwrap()
                .source_time,
            MediaTime::from_ticks(45_000),
        );
    }

    #[test]
    fn rust_maps_tracking_samples_to_timeline() {
        let mapped = map_time_map_tracking_samples(MapTimeMapTrackingSamplesOptions {
            time_map: sample_map(),
            clip_duration: MediaTime::from_ticks(120_000),
            source_trim_start: MediaTime::ZERO,
            sample_interval: MediaTime::from_ticks(60_000),
            samples: vec![
                TimeMapTrackingSample {
                    source_time: MediaTime::ZERO,
                    box_value: TimeMapTrackingBox {
                        x: 0.0,
                        y: 0.0,
                        width: 0.5,
                        height: 0.5,
                    },
                },
                TimeMapTrackingSample {
                    source_time: MediaTime::from_ticks(120_000),
                    box_value: TimeMapTrackingBox {
                        x: 1.0,
                        y: 1.0,
                        width: 0.25,
                        height: 0.25,
                    },
                },
            ],
        })
        .unwrap();
        assert_eq!(mapped.samples.len(), 3);
        assert_eq!(mapped.samples[1].time, MediaTime::from_ticks(60_000));
        assert_eq!(mapped.samples[1].box_value.x, 0.375);
    }
}

#[cfg(test)]
mod retime_planner_tests {
    use super::*;

    fn forward_map() -> TimeMap {
        TimeMap {
            schema_version: TIME_MAP_SCHEMA_VERSION.into(),
            frame_interpolation: FrameInterpolationPolicy {
                requested: FrameInterpolation::Nearest,
                fallback: FrameInterpolation::Nearest,
            },
            audio_policy: AudioTimeMapPolicy {
                maintain_pitch: true,
                hold: AudioHoldPolicy::Mute,
            },
            segments: vec![TimeMapSegment::Speed {
                timeline_start: MediaTime::ZERO,
                timeline_end: MediaTime::from_ticks(100),
                source_start: MediaTime::ZERO,
                start_rate: 2.0,
                end_rate: 2.0,
                direction: TimeMapDirection::Forward,
            }],
        }
    }

    fn tracking_box(x: f64) -> TimeMapTrackingBox {
        TimeMapTrackingBox {
            x,
            y: 0.0,
            width: 0.5,
            height: 0.5,
        }
    }

    #[test]
    fn rust_derives_the_retime_config_a_time_map_implies() {
        let config = time_map_retime_config(TimeMapRetimeConfigOptions {
            time_map: forward_map(),
        })
        .unwrap();
        assert_eq!(config.mode, TimeMapRetimeMode::TimeMap);
        assert_eq!(config.rate, 1.0);
        assert!(config.maintain_pitch);
        assert_eq!(config.time_map, forward_map());
        assert_eq!(
            serde_json::to_value(&config).unwrap()["mode"],
            serde_json::json!("time-map")
        );
        let mut invalid = forward_map();
        invalid.segments.clear();
        assert!(time_map_retime_config(TimeMapRetimeConfigOptions { time_map: invalid }).is_none());
    }

    #[test]
    fn constant_rate_split_snaps_the_source_boundary_once() {
        let plan = plan_retime_split(PlanRetimeSplitOptions {
            rate: 2.0,
            time_map: None,
            clip_duration: MediaTime::from_ticks(100),
            split_clip_time: MediaTime::from_ticks(30),
            source_trim_start: MediaTime::from_ticks(5),
            source_trim_end: MediaTime::from_ticks(7),
        })
        .unwrap();
        assert_eq!(plan.left_time_map, None);
        assert_eq!(plan.right_time_map, None);
        assert_eq!(plan.left_trim_start, MediaTime::from_ticks(5));
        assert_eq!(plan.left_trim_end, MediaTime::from_ticks(147));
        assert_eq!(plan.right_trim_start, MediaTime::from_ticks(65));
        assert_eq!(plan.right_trim_end, MediaTime::from_ticks(7));
        assert!(
            plan_retime_split(PlanRetimeSplitOptions {
                rate: 0.0,
                time_map: None,
                clip_duration: MediaTime::from_ticks(100),
                split_clip_time: MediaTime::from_ticks(30),
                source_trim_start: MediaTime::ZERO,
                source_trim_end: MediaTime::ZERO,
            })
            .is_none()
        );
    }

    #[test]
    fn time_map_split_takes_precedence_over_the_rate() {
        let plan = plan_retime_split(PlanRetimeSplitOptions {
            rate: 3.0,
            time_map: Some(forward_map()),
            clip_duration: MediaTime::from_ticks(100),
            split_clip_time: MediaTime::from_ticks(40),
            source_trim_start: MediaTime::from_ticks(5),
            source_trim_end: MediaTime::from_ticks(7),
        })
        .unwrap();
        assert_eq!(
            plan.left_time_map.unwrap().duration(),
            MediaTime::from_ticks(40)
        );
        assert_eq!(
            plan.right_time_map.unwrap().duration(),
            MediaTime::from_ticks(60)
        );
        assert_eq!(plan.left_trim_end, MediaTime::from_ticks(7));
        assert_eq!(plan.right_trim_start, MediaTime::from_ticks(5));
    }

    #[test]
    fn constant_rate_tracking_keeps_visible_sample_times() {
        let plan = map_retime_tracking_samples(MapRetimeTrackingSamplesOptions {
            rate: 2.0,
            time_map: None,
            clip_duration: MediaTime::from_ticks(100),
            source_trim_start: MediaTime::from_ticks(10),
            sample_interval: MediaTime::from_ticks(10),
            samples: vec![
                TimeMapTrackingSample {
                    source_time: MediaTime::from_ticks(4),
                    box_value: tracking_box(0.1),
                },
                TimeMapTrackingSample {
                    source_time: MediaTime::from_ticks(10),
                    box_value: tracking_box(0.2),
                },
                TimeMapTrackingSample {
                    source_time: MediaTime::from_ticks(111),
                    box_value: tracking_box(0.3),
                },
                TimeMapTrackingSample {
                    source_time: MediaTime::from_ticks(210),
                    box_value: tracking_box(0.4),
                },
                TimeMapTrackingSample {
                    source_time: MediaTime::from_ticks(300),
                    box_value: tracking_box(0.5),
                },
            ],
        })
        .unwrap();
        assert_eq!(
            plan.samples
                .iter()
                .map(|sample| (sample.time.as_ticks(), sample.box_value.x))
                .collect::<Vec<_>>(),
            vec![(0, 0.2), (51, 0.3), (100, 0.4)]
        );
    }
}
