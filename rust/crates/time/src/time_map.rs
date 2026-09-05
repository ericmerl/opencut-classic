use bridge::export;
use serde::{Deserialize, Serialize};

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
        let last_index = self.segments.len().saturating_sub(1);
        let (segment_index, segment) = self
            .segments
            .iter()
            .enumerate()
            .find(|(index, segment)| {
                clip_time < segment.timeline_end()
                    || (*index == last_index && clip_time == segment.timeline_end())
            })
            .ok_or_else(|| "clip time does not resolve to a segment".to_string())?;
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
