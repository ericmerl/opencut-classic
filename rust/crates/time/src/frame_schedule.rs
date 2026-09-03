use bridge::export;
use serde::{Deserialize, Serialize};

use crate::{FrameRate, TICKS_PER_SECOND};

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleFrameRangeOptions {
    pub rate: FrameRate,
    pub scene_duration_ticks: i64,
    pub range: FrameRangeSelector,
    pub limits: FrameRangeLimits,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FrameRangeSelector {
    MediaTime {
        start_ticks: i64,
        end_ticks_exclusive: i64,
    },
    FrameIndex {
        start_frame_index: u32,
        end_frame_index_exclusive: u32,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameRangeLimits {
    pub max_duration_ticks: i64,
    pub max_frames: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FrameRangeScheduleEvaluation {
    Scheduled {
        schedule: FrameRangeSchedule,
    },
    Rejected {
        code: FrameRangeScheduleErrorCode,
        reason: String,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FrameRangeScheduleErrorCode {
    UnsupportedFrameRate,
    TimeOutOfBounds,
    InvalidRange,
    EmptyRange,
    RangeDurationLimitExceeded,
    RangeFrameLimitExceeded,
    ArithmeticOverflow,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrameRangeSchedule {
    pub schema_version: String,
    pub scene_duration_ticks: i64,
    pub rate: FrameRate,
    pub ticks_per_second: i64,
    pub ticks_per_frame: i64,
    pub endpoint_policy: String,
    pub requested_range: FrameRangeSelector,
    pub requested_duration_ticks: i64,
    pub resolved_start_ticks: i64,
    pub resolved_end_ticks_exclusive: i64,
    pub start_frame_index: u32,
    pub end_frame_index_exclusive: u32,
    pub frame_count: u32,
    pub scheduled_duration_ticks: i64,
    pub frames: Vec<ScheduledFrame>,
    pub policy: FrameRangePolicy,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledFrame {
    pub ordinal: u32,
    pub frame_index: u32,
    pub timeline_ticks: i64,
    pub output_ticks: i64,
    pub duration_ticks: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrameRangePolicy {
    pub output_cadence: String,
    pub output_frames: String,
    pub source_sampling: String,
    pub unavailable_source_frame: String,
}

#[export]
pub fn schedule_frame_range(options: ScheduleFrameRangeOptions) -> FrameRangeScheduleEvaluation {
    match schedule(options) {
        Ok(schedule) => FrameRangeScheduleEvaluation::Scheduled { schedule },
        Err((code, reason)) => FrameRangeScheduleEvaluation::Rejected { code, reason },
    }
}

fn schedule(
    options: ScheduleFrameRangeOptions,
) -> Result<FrameRangeSchedule, (FrameRangeScheduleErrorCode, String)> {
    let ticks_per_frame = options.rate.ticks_per_frame().ok_or_else(|| {
        rejected(
            FrameRangeScheduleErrorCode::UnsupportedFrameRate,
            "frame rate has no integral duration in the 120000-tick timebase",
        )
    })?;
    if options.scene_duration_ticks <= 0
        || options.scene_duration_ticks > JS_MAX_SAFE_INTEGER
        || options.limits.max_duration_ticks <= 0
        || options.limits.max_duration_ticks > JS_MAX_SAFE_INTEGER
        || options.limits.max_frames == 0
    {
        return Err(rejected(
            FrameRangeScheduleErrorCode::TimeOutOfBounds,
            "scene duration and configured limits must be positive JavaScript-safe integers",
        ));
    }

    let requested_range = options.range.clone();
    let (start_frame, end_frame, requested_duration_ticks) = match options.range {
        FrameRangeSelector::MediaTime {
            start_ticks,
            end_ticks_exclusive,
        } => {
            if start_ticks < 0 || end_ticks_exclusive > options.scene_duration_ticks {
                return Err(rejected(
                    FrameRangeScheduleErrorCode::TimeOutOfBounds,
                    "requested media-time range is outside the scene",
                ));
            }
            if end_ticks_exclusive <= start_ticks {
                return Err(rejected(
                    FrameRangeScheduleErrorCode::InvalidRange,
                    "range end must be greater than range start",
                ));
            }
            let duration = end_ticks_exclusive
                .checked_sub(start_ticks)
                .ok_or_else(|| {
                    rejected(
                        FrameRangeScheduleErrorCode::ArithmeticOverflow,
                        "requested range duration overflowed",
                    )
                })?;
            let start = div_ceil_nonnegative(start_ticks, ticks_per_frame)?;
            let end = div_ceil_nonnegative(end_ticks_exclusive, ticks_per_frame)?;
            (start, end, duration)
        }
        FrameRangeSelector::FrameIndex {
            start_frame_index,
            end_frame_index_exclusive,
        } => {
            if end_frame_index_exclusive <= start_frame_index {
                return Err(rejected(
                    FrameRangeScheduleErrorCode::InvalidRange,
                    "range end must be greater than range start",
                ));
            }
            let start = i64::from(start_frame_index);
            let end = i64::from(end_frame_index_exclusive);
            let start_ticks = start.checked_mul(ticks_per_frame).ok_or_else(|| {
                rejected(
                    FrameRangeScheduleErrorCode::ArithmeticOverflow,
                    "range start overflowed",
                )
            })?;
            let end_ticks = end.checked_mul(ticks_per_frame).ok_or_else(|| {
                rejected(
                    FrameRangeScheduleErrorCode::ArithmeticOverflow,
                    "range end overflowed",
                )
            })?;
            let scene_end_frame =
                div_ceil_nonnegative(options.scene_duration_ticks, ticks_per_frame)?;
            if start_ticks >= options.scene_duration_ticks || end > scene_end_frame {
                return Err(rejected(
                    FrameRangeScheduleErrorCode::TimeOutOfBounds,
                    "requested frame range is outside the scene",
                ));
            }
            (start, end, end_ticks - start_ticks)
        }
    };

    if requested_duration_ticks > options.limits.max_duration_ticks {
        return Err(rejected(
            FrameRangeScheduleErrorCode::RangeDurationLimitExceeded,
            "requested range exceeds the configured duration limit",
        ));
    }
    if end_frame <= start_frame {
        return Err(rejected(
            FrameRangeScheduleErrorCode::EmptyRange,
            "requested range contains no project frame timestamp",
        ));
    }
    let frame_count_i64 = end_frame.checked_sub(start_frame).ok_or_else(|| {
        rejected(
            FrameRangeScheduleErrorCode::ArithmeticOverflow,
            "frame count overflowed",
        )
    })?;
    let frame_count = u32::try_from(frame_count_i64).map_err(|_| {
        rejected(
            FrameRangeScheduleErrorCode::ArithmeticOverflow,
            "frame count cannot be represented",
        )
    })?;
    if frame_count > options.limits.max_frames {
        return Err(rejected(
            FrameRangeScheduleErrorCode::RangeFrameLimitExceeded,
            "requested range exceeds the configured frame limit",
        ));
    }

    let mut frames = Vec::with_capacity(frame_count as usize);
    for ordinal in 0..frame_count {
        let frame_index_i64 = start_frame.checked_add(i64::from(ordinal)).ok_or_else(|| {
            rejected(
                FrameRangeScheduleErrorCode::ArithmeticOverflow,
                "frame index overflowed",
            )
        })?;
        let timeline_ticks = frame_index_i64
            .checked_mul(ticks_per_frame)
            .ok_or_else(|| {
                rejected(
                    FrameRangeScheduleErrorCode::ArithmeticOverflow,
                    "frame timestamp overflowed",
                )
            })?;
        let output_ticks = i64::from(ordinal)
            .checked_mul(ticks_per_frame)
            .ok_or_else(|| {
                rejected(
                    FrameRangeScheduleErrorCode::ArithmeticOverflow,
                    "output timestamp overflowed",
                )
            })?;
        if timeline_ticks > JS_MAX_SAFE_INTEGER || output_ticks > JS_MAX_SAFE_INTEGER {
            return Err(rejected(
                FrameRangeScheduleErrorCode::ArithmeticOverflow,
                "frame schedule exceeds the JavaScript safe-integer range",
            ));
        }
        frames.push(ScheduledFrame {
            ordinal,
            frame_index: u32::try_from(frame_index_i64).map_err(|_| {
                rejected(
                    FrameRangeScheduleErrorCode::ArithmeticOverflow,
                    "frame index cannot be represented",
                )
            })?,
            timeline_ticks,
            output_ticks,
            duration_ticks: ticks_per_frame,
        });
    }
    let resolved_start_ticks = frames[0].timeline_ticks;
    let resolved_end_ticks_exclusive = frames
        .last()
        .and_then(|frame| frame.timeline_ticks.checked_add(ticks_per_frame))
        .ok_or_else(|| {
            rejected(
                FrameRangeScheduleErrorCode::ArithmeticOverflow,
                "resolved range end overflowed",
            )
        })?;
    let scheduled_duration_ticks = i64::from(frame_count)
        .checked_mul(ticks_per_frame)
        .ok_or_else(|| {
            rejected(
                FrameRangeScheduleErrorCode::ArithmeticOverflow,
                "scheduled duration overflowed",
            )
        })?;

    Ok(FrameRangeSchedule {
        schema_version: "opencut.frame-range-schedule.v1".to_owned(),
        scene_duration_ticks: options.scene_duration_ticks,
        rate: options.rate,
        ticks_per_second: TICKS_PER_SECOND,
        ticks_per_frame,
        endpoint_policy: "start-inclusive-end-exclusive".to_owned(),
        requested_range,
        requested_duration_ticks,
        resolved_start_ticks,
        resolved_end_ticks_exclusive,
        start_frame_index: u32::try_from(start_frame).map_err(|_| {
            rejected(
                FrameRangeScheduleErrorCode::ArithmeticOverflow,
                "start frame cannot be represented",
            )
        })?,
        end_frame_index_exclusive: u32::try_from(end_frame).map_err(|_| {
            rejected(
                FrameRangeScheduleErrorCode::ArithmeticOverflow,
                "end frame cannot be represented",
            )
        })?,
        frame_count,
        scheduled_duration_ticks,
        frames,
        policy: FrameRangePolicy {
            output_cadence: "constant-frame-rate".to_owned(),
            output_frames: "contiguous-once-fail-on-missing".to_owned(),
            source_sampling: "presentation-interval-containing-mapped-time".to_owned(),
            unavailable_source_frame: "fail-range".to_owned(),
        },
    })
}

fn div_ceil_nonnegative(
    numerator: i64,
    denominator: i64,
) -> Result<i64, (FrameRangeScheduleErrorCode, String)> {
    let adjusted = numerator.checked_add(denominator - 1).ok_or_else(|| {
        rejected(
            FrameRangeScheduleErrorCode::ArithmeticOverflow,
            "range endpoint overflowed",
        )
    })?;
    Ok(adjusted / denominator)
}

fn rejected(
    code: FrameRangeScheduleErrorCode,
    reason: &str,
) -> (FrameRangeScheduleErrorCode, String) {
    (code, reason.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(range: FrameRangeSelector, rate: FrameRate) -> ScheduleFrameRangeOptions {
        ScheduleFrameRangeOptions {
            rate,
            scene_duration_ticks: 2_400_000,
            range,
            limits: FrameRangeLimits {
                max_duration_ticks: 1_200_000,
                max_frames: 300,
            },
        }
    }

    fn scheduled(value: FrameRangeScheduleEvaluation) -> FrameRangeSchedule {
        match value {
            FrameRangeScheduleEvaluation::Scheduled { schedule } => schedule,
            other => panic!("expected scheduled result, got {other:?}"),
        }
    }

    fn rejected_code(value: FrameRangeScheduleEvaluation) -> FrameRangeScheduleErrorCode {
        match value {
            FrameRangeScheduleEvaluation::Rejected { code, .. } => code,
            other => panic!("expected rejected result, got {other:?}"),
        }
    }

    #[test]
    fn schedules_half_open_thirty_fps_range() {
        let schedule = scheduled(schedule_frame_range(options(
            FrameRangeSelector::MediaTime {
                start_ticks: 0,
                end_ticks_exclusive: 120_000,
            },
            FrameRate::FPS_30,
        )));
        assert_eq!(schedule.frame_count, 30);
        assert_eq!(schedule.frames.first().unwrap().timeline_ticks, 0);
        assert_eq!(schedule.frames.last().unwrap().timeline_ticks, 116_000);
        assert_eq!(schedule.resolved_end_ticks_exclusive, 120_000);
    }

    #[test]
    fn accepts_ten_seconds_at_2997_on_both_default_limits() {
        let schedule = scheduled(schedule_frame_range(options(
            FrameRangeSelector::MediaTime {
                start_ticks: 0,
                end_ticks_exclusive: 1_200_000,
            },
            FrameRate::FPS_29_97,
        )));
        assert_eq!(schedule.frame_count, 300);
        assert_eq!(schedule.frames.last().unwrap().timeline_ticks, 1_197_196);
        assert_eq!(schedule.scheduled_duration_ticks, 1_201_200);
    }

    #[test]
    fn resolves_unaligned_endpoints_without_emitting_outside_them() {
        let schedule = scheduled(schedule_frame_range(options(
            FrameRangeSelector::MediaTime {
                start_ticks: 1,
                end_ticks_exclusive: 8_001,
            },
            FrameRate::FPS_30,
        )));
        assert_eq!(
            schedule
                .frames
                .iter()
                .map(|frame| frame.timeline_ticks)
                .collect::<Vec<_>>(),
            vec![4_000, 8_000]
        );
    }

    #[test]
    fn includes_a_partial_final_scene_frame() {
        let mut input = options(
            FrameRangeSelector::MediaTime {
                start_ticks: 12_000,
                end_ticks_exclusive: 12_001,
            },
            FrameRate::FPS_30,
        );
        input.scene_duration_ticks = 12_001;
        let schedule = scheduled(schedule_frame_range(input));
        assert_eq!(schedule.frames[0].timeline_ticks, 12_000);
    }

    #[test]
    fn frame_index_selector_includes_a_partial_final_scene_frame() {
        let mut input = options(
            FrameRangeSelector::FrameIndex {
                start_frame_index: 3,
                end_frame_index_exclusive: 4,
            },
            FrameRate::FPS_30,
        );
        input.scene_duration_ticks = 12_001;
        let schedule = scheduled(schedule_frame_range(input));
        assert_eq!(schedule.frames[0].timeline_ticks, 12_000);
        assert_eq!(schedule.resolved_end_ticks_exclusive, 16_000);
    }

    #[test]
    fn enforces_duration_and_frame_limits_without_truncation() {
        let duration = rejected_code(schedule_frame_range(options(
            FrameRangeSelector::MediaTime {
                start_ticks: 0,
                end_ticks_exclusive: 1_200_001,
            },
            FrameRate::FPS_30,
        )));
        assert_eq!(
            duration,
            FrameRangeScheduleErrorCode::RangeDurationLimitExceeded
        );

        let frames = rejected_code(schedule_frame_range(options(
            FrameRangeSelector::MediaTime {
                start_ticks: 0,
                end_ticks_exclusive: 1_200_000,
            },
            FrameRate::FPS_60,
        )));
        assert_eq!(frames, FrameRangeScheduleErrorCode::RangeFrameLimitExceeded);
    }

    #[test]
    fn rejects_invalid_empty_out_of_bounds_and_unsupported_ranges() {
        for (range, code) in [
            (
                FrameRangeSelector::MediaTime {
                    start_ticks: 1,
                    end_ticks_exclusive: 1,
                },
                FrameRangeScheduleErrorCode::InvalidRange,
            ),
            (
                FrameRangeSelector::MediaTime {
                    start_ticks: -1,
                    end_ticks_exclusive: 1,
                },
                FrameRangeScheduleErrorCode::TimeOutOfBounds,
            ),
            (
                FrameRangeSelector::MediaTime {
                    start_ticks: 1,
                    end_ticks_exclusive: 3_999,
                },
                FrameRangeScheduleErrorCode::EmptyRange,
            ),
        ] {
            assert_eq!(
                rejected_code(schedule_frame_range(options(range, FrameRate::FPS_30))),
                code
            );
        }
        assert_eq!(
            rejected_code(schedule_frame_range(options(
                FrameRangeSelector::MediaTime {
                    start_ticks: 0,
                    end_ticks_exclusive: 1,
                },
                FrameRate::new(7, 3),
            ))),
            FrameRangeScheduleErrorCode::UnsupportedFrameRate
        );
    }

    #[test]
    fn serializes_a_stable_browser_contract() {
        let value = serde_json::to_value(schedule_frame_range(options(
            FrameRangeSelector::FrameIndex {
                start_frame_index: 2,
                end_frame_index_exclusive: 4,
            },
            FrameRate::FPS_30,
        )))
        .unwrap();
        assert_eq!(value["status"], "scheduled");
        assert_eq!(
            value["schedule"]["schemaVersion"],
            "opencut.frame-range-schedule.v1"
        );
        assert_eq!(value["schedule"]["frames"][0]["timelineTicks"], 8_000);
        assert_eq!(
            value["schedule"]["policy"]["outputFrames"],
            "contiguous-once-fail-on-missing"
        );
    }
}
