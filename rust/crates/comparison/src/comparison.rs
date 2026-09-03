use bridge::export;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use time::{
    FrameRangeLimits, FrameRangeSchedule, FrameRangeScheduleErrorCode,
    FrameRangeScheduleEvaluation, FrameRangeSelector, FrameRate, ScheduleFrameRangeOptions,
    schedule_frame_range,
};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonCanvas {
    pub width: u32,
    pub height: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonRenderSource {
    pub canvas: ComparisonCanvas,
    pub rate: FrameRate,
    pub scene_duration_ticks: i64,
    pub renderer_settings_digest: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanComparisonOptions {
    pub before: ComparisonRenderSource,
    pub after: ComparisonRenderSource,
    pub range: FrameRangeSelector,
    pub limits: FrameRangeLimits,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonPlan {
    pub schema_version: String,
    pub canvas: ComparisonCanvas,
    pub rate: FrameRate,
    pub renderer_settings_digest: String,
    pub before_scene_duration_ticks: i64,
    pub after_scene_duration_ticks: i64,
    pub common_scene_duration_ticks: i64,
    pub normalization_policy: String,
    pub schedule: FrameRangeSchedule,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ComparisonPlanEvaluation {
    Planned {
        plan: ComparisonPlan,
    },
    Rejected {
        code: ComparisonErrorCode,
        reason: String,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ComparisonErrorCode {
    InvalidCanvas,
    CanvasMismatch,
    FrameRateMismatch,
    RendererSettingsMismatch,
    InvalidRendererSettingsDigest,
    InvalidBufferShape,
    ShapeMismatch,
    ResourceLimitExceeded,
    ArithmeticOverflow,
    ScheduleRejected,
}

#[export]
pub fn plan_comparison(options: PlanComparisonOptions) -> ComparisonPlanEvaluation {
    if options.before.canvas.width == 0
        || options.before.canvas.height == 0
        || options.after.canvas.width == 0
        || options.after.canvas.height == 0
    {
        return plan_rejected(
            ComparisonErrorCode::InvalidCanvas,
            "canvas dimensions must be positive",
        );
    }
    if options.before.canvas != options.after.canvas {
        return plan_rejected(
            ComparisonErrorCode::CanvasMismatch,
            "canvas dimensions must match exactly; normalization is forbidden",
        );
    }
    if options.before.rate != options.after.rate {
        return plan_rejected(
            ComparisonErrorCode::FrameRateMismatch,
            "frame rates must match exactly; normalization is forbidden",
        );
    }
    if !is_sha256(&options.before.renderer_settings_digest)
        || !is_sha256(&options.after.renderer_settings_digest)
    {
        return plan_rejected(
            ComparisonErrorCode::InvalidRendererSettingsDigest,
            "renderer settings digests must be lowercase SHA-256 values",
        );
    }
    if options.before.renderer_settings_digest != options.after.renderer_settings_digest {
        return plan_rejected(
            ComparisonErrorCode::RendererSettingsMismatch,
            "renderer settings must match exactly; normalization is forbidden",
        );
    }

    let common_scene_duration_ticks = options
        .before
        .scene_duration_ticks
        .min(options.after.scene_duration_ticks);
    let schedule = match schedule_frame_range(ScheduleFrameRangeOptions {
        rate: options.before.rate,
        scene_duration_ticks: common_scene_duration_ticks,
        range: options.range,
        limits: options.limits,
    }) {
        FrameRangeScheduleEvaluation::Scheduled { schedule } => schedule,
        FrameRangeScheduleEvaluation::Rejected { code, reason } => {
            return ComparisonPlanEvaluation::Rejected {
                code: map_schedule_code(code),
                reason,
            };
        }
    };

    ComparisonPlanEvaluation::Planned {
        plan: ComparisonPlan {
            schema_version: "opencut.comparison-plan.v1".into(),
            canvas: options.before.canvas,
            rate: options.before.rate,
            renderer_settings_digest: options.before.renderer_settings_digest,
            before_scene_duration_ticks: options.before.scene_duration_ticks,
            after_scene_duration_ticks: options.after.scene_duration_ticks,
            common_scene_duration_ticks,
            normalization_policy: "exact-no-normalization".into(),
            schedule,
        },
    }
}

fn plan_rejected(code: ComparisonErrorCode, reason: &str) -> ComparisonPlanEvaluation {
    ComparisonPlanEvaluation::Rejected {
        code,
        reason: reason.into(),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn map_schedule_code(code: FrameRangeScheduleErrorCode) -> ComparisonErrorCode {
    match code {
        FrameRangeScheduleErrorCode::ArithmeticOverflow => ComparisonErrorCode::ArithmeticOverflow,
        _ => ComparisonErrorCode::ScheduleRejected,
    }
}

const MAX_RGBA_PIXELS: u64 = 16_777_216;
const DEFAULT_MAX_REGIONS: u32 = 256;
const MAX_RETAINED_REGIONS: u32 = 10_000;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ToleranceBoundary {
    /// Equality is tolerated: a pixel exceeds tolerance only when its largest
    /// straight-RGBA channel delta is strictly greater than `pixel_tolerance`.
    Inclusive,
    /// Equality is not tolerated: a pixel exceeds tolerance when its largest
    /// straight-RGBA channel delta is greater than or equal to `pixel_tolerance`.
    Exclusive,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareRgbaOptions {
    /// Straight, unpremultiplied RGBA bytes. Color bytes remain significant even
    /// when alpha is zero; all four stored channels are compared independently.
    pub before: Vec<u8>,
    pub after: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pixel_tolerance: u8,
    pub tolerance_boundary: ToleranceBoundary,
    #[serde(default)]
    pub max_regions: Option<u32>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ratio {
    pub numerator: u64,
    pub denominator: u64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RgbaFrameMetrics {
    pub pixel_count: u64,
    pub exceeding_pixel_count: u64,
    pub absolute_channel_delta_sums: [u64; 4],
    pub max_channel_deltas: [u8; 4],
    pub absolute_delta_sum: u64,
    pub channel_sample_count: u64,
    pub mean_absolute_delta: Ratio,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PixelBounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PixelRegion {
    pub bounds: PixelBounds,
    pub pixel_count: u64,
    pub max_channel_delta: u8,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PixelRegions {
    pub connectivity: String,
    pub total_region_count: u64,
    pub retained_region_count: u32,
    pub truncated: bool,
    pub items: Vec<PixelRegion>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RgbaComparison {
    pub schema_version: String,
    pub semantics: String,
    pub tolerance_boundary: ToleranceBoundary,
    pub pixel_tolerance: u8,
    pub metrics: RgbaFrameMetrics,
    pub regions: PixelRegions,
    /// Component-wise absolute deltas `[|dr|, |dg|, |db|, |da|]`.
    pub diff_rgba: Vec<u8>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RgbaComparisonEvaluation {
    Compared {
        comparison: RgbaComparison,
    },
    Rejected {
        code: ComparisonErrorCode,
        reason: String,
    },
}

#[export]
pub fn compare_rgba(options: CompareRgbaOptions) -> RgbaComparisonEvaluation {
    let pixel_count = match validated_pixel_count(options.width, options.height) {
        Ok(value) => value,
        Err((code, reason)) => return rgba_rejected(code, &reason),
    };
    let expected_len = match pixel_count
        .checked_mul(4)
        .and_then(|value| usize::try_from(value).ok())
    {
        Some(value) => value,
        None => {
            return rgba_rejected(
                ComparisonErrorCode::ArithmeticOverflow,
                "RGBA byte length overflowed",
            );
        }
    };
    if options.before.len() != expected_len || options.after.len() != expected_len {
        return rgba_rejected(
            ComparisonErrorCode::InvalidBufferShape,
            "each RGBA buffer length must equal width * height * 4",
        );
    }
    let max_regions = options.max_regions.unwrap_or(DEFAULT_MAX_REGIONS);
    if max_regions == 0 || max_regions > MAX_RETAINED_REGIONS {
        return rgba_rejected(
            ComparisonErrorCode::ResourceLimitExceeded,
            "maxRegions must be between 1 and 10000",
        );
    }

    let mut diff_rgba = Vec::with_capacity(expected_len);
    let mut exceeding = vec![false; pixel_count as usize];
    let mut absolute_channel_delta_sums = [0_u64; 4];
    let mut max_channel_deltas = [0_u8; 4];
    let mut exceeding_pixel_count = 0_u64;
    for pixel in 0..pixel_count as usize {
        let mut pixel_max = 0_u8;
        for channel in 0..4 {
            let offset = pixel * 4 + channel;
            let delta = options.before[offset].abs_diff(options.after[offset]);
            diff_rgba.push(delta);
            absolute_channel_delta_sums[channel] += u64::from(delta);
            max_channel_deltas[channel] = max_channel_deltas[channel].max(delta);
            pixel_max = pixel_max.max(delta);
        }
        if exceeds(
            pixel_max,
            options.pixel_tolerance,
            options.tolerance_boundary,
        ) {
            exceeding[pixel] = true;
            exceeding_pixel_count += 1;
        }
    }
    let absolute_delta_sum = absolute_channel_delta_sums.iter().sum();
    let channel_sample_count = pixel_count * 4;
    let regions = find_regions(
        &exceeding,
        &diff_rgba,
        options.width,
        options.height,
        max_regions,
    );

    RgbaComparisonEvaluation::Compared {
        comparison: RgbaComparison {
            schema_version: "opencut.rgba-comparison.v1".into(),
            semantics: "straight-rgba8-componentwise-absolute-delta".into(),
            tolerance_boundary: options.tolerance_boundary,
            pixel_tolerance: options.pixel_tolerance,
            metrics: RgbaFrameMetrics {
                pixel_count,
                exceeding_pixel_count,
                absolute_channel_delta_sums,
                max_channel_deltas,
                absolute_delta_sum,
                channel_sample_count,
                mean_absolute_delta: Ratio {
                    numerator: absolute_delta_sum,
                    denominator: channel_sample_count,
                },
            },
            regions,
            diff_rgba,
        },
    }
}

fn validated_pixel_count(width: u32, height: u32) -> Result<u64, (ComparisonErrorCode, String)> {
    if width == 0 || height == 0 {
        return Err((
            ComparisonErrorCode::InvalidCanvas,
            "canvas dimensions must be positive".into(),
        ));
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_RGBA_PIXELS {
        return Err((
            ComparisonErrorCode::ResourceLimitExceeded,
            format!("canvas exceeds the {MAX_RGBA_PIXELS}-pixel comparison limit"),
        ));
    }
    Ok(pixels)
}

fn exceeds(delta: u8, tolerance: u8, boundary: ToleranceBoundary) -> bool {
    match boundary {
        ToleranceBoundary::Inclusive => delta > tolerance,
        ToleranceBoundary::Exclusive => delta >= tolerance,
    }
}

fn find_regions(
    exceeding: &[bool],
    diff_rgba: &[u8],
    width: u32,
    height: u32,
    max_regions: u32,
) -> PixelRegions {
    let mut visited = vec![false; exceeding.len()];
    let mut items = Vec::new();
    let mut total_region_count = 0_u64;
    for start in 0..exceeding.len() {
        if !exceeding[start] || visited[start] {
            continue;
        }
        total_region_count += 1;
        let mut queue = VecDeque::from([start]);
        visited[start] = true;
        let mut min_x = u32::MAX;
        let mut min_y = u32::MAX;
        let mut max_x = 0_u32;
        let mut max_y = 0_u32;
        let mut region_pixels = 0_u64;
        let mut max_delta = 0_u8;
        while let Some(index) = queue.pop_front() {
            let x = index as u32 % width;
            let y = index as u32 / width;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            region_pixels += 1;
            max_delta = max_delta.max(*diff_rgba[index * 4..index * 4 + 4].iter().max().unwrap());
            for neighbor in neighbors_4(x, y, width, height).into_iter().flatten() {
                if exceeding[neighbor] && !visited[neighbor] {
                    visited[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        if items.len() < max_regions as usize {
            items.push(PixelRegion {
                bounds: PixelBounds {
                    x: min_x,
                    y: min_y,
                    width: max_x - min_x + 1,
                    height: max_y - min_y + 1,
                },
                pixel_count: region_pixels,
                max_channel_delta: max_delta,
            });
        }
    }
    PixelRegions {
        connectivity: "4-connected-row-major".into(),
        total_region_count,
        retained_region_count: items.len() as u32,
        truncated: total_region_count > u64::from(max_regions),
        items,
    }
}

fn neighbors_4(x: u32, y: u32, width: u32, height: u32) -> [Option<usize>; 4] {
    [
        (x > 0).then(|| (y * width + x - 1) as usize),
        (x + 1 < width).then(|| (y * width + x + 1) as usize),
        (y > 0).then(|| ((y - 1) * width + x) as usize),
        (y + 1 < height).then(|| ((y + 1) * width + x) as usize),
    ]
}

fn rgba_rejected(code: ComparisonErrorCode, reason: &str) -> RgbaComparisonEvaluation {
    RgbaComparisonEvaluation::Rejected {
        code,
        reason: reason.into(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregateFrameMetricsOptions {
    pub per_frame: Vec<RgbaFrameMetrics>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FrameMetricsAggregationEvaluation {
    Aggregated {
        metrics: RgbaFrameMetrics,
    },
    Rejected {
        code: ComparisonErrorCode,
        reason: String,
    },
}

#[export]
pub fn aggregate_frame_metrics(
    options: AggregateFrameMetricsOptions,
) -> FrameMetricsAggregationEvaluation {
    if options.per_frame.is_empty() {
        return aggregate_rejected("at least one frame metric is required");
    }
    let mut result = RgbaFrameMetrics {
        pixel_count: 0,
        exceeding_pixel_count: 0,
        absolute_channel_delta_sums: [0; 4],
        max_channel_deltas: [0; 4],
        absolute_delta_sum: 0,
        channel_sample_count: 0,
        mean_absolute_delta: Ratio {
            numerator: 0,
            denominator: 0,
        },
    };
    for frame in options.per_frame {
        if frame.pixel_count == 0
            || frame.channel_sample_count != frame.pixel_count.saturating_mul(4)
            || frame.exceeding_pixel_count > frame.pixel_count
            || frame.absolute_delta_sum != frame.absolute_channel_delta_sums.iter().sum::<u64>()
            || frame.mean_absolute_delta.numerator != frame.absolute_delta_sum
            || frame.mean_absolute_delta.denominator != frame.channel_sample_count
        {
            return aggregate_rejected("frame metrics are internally inconsistent");
        }
        result.pixel_count = match result.pixel_count.checked_add(frame.pixel_count) {
            Some(value) => value,
            None => return aggregate_overflow(),
        };
        result.exceeding_pixel_count = match result
            .exceeding_pixel_count
            .checked_add(frame.exceeding_pixel_count)
        {
            Some(value) => value,
            None => return aggregate_overflow(),
        };
        result.channel_sample_count = match result
            .channel_sample_count
            .checked_add(frame.channel_sample_count)
        {
            Some(value) => value,
            None => return aggregate_overflow(),
        };
        for channel in 0..4 {
            result.absolute_channel_delta_sums[channel] = match result.absolute_channel_delta_sums
                [channel]
                .checked_add(frame.absolute_channel_delta_sums[channel])
            {
                Some(value) => value,
                None => return aggregate_overflow(),
            };
            result.max_channel_deltas[channel] =
                result.max_channel_deltas[channel].max(frame.max_channel_deltas[channel]);
        }
    }
    result.absolute_delta_sum = match result
        .absolute_channel_delta_sums
        .iter()
        .try_fold(0_u64, |sum, value| sum.checked_add(*value))
    {
        Some(value) => value,
        None => return aggregate_overflow(),
    };
    result.mean_absolute_delta = Ratio {
        numerator: result.absolute_delta_sum,
        denominator: result.channel_sample_count,
    };
    FrameMetricsAggregationEvaluation::Aggregated { metrics: result }
}

fn aggregate_rejected(reason: &str) -> FrameMetricsAggregationEvaluation {
    FrameMetricsAggregationEvaluation::Rejected {
        code: ComparisonErrorCode::InvalidBufferShape,
        reason: reason.into(),
    }
}

fn aggregate_overflow() -> FrameMetricsAggregationEvaluation {
    FrameMetricsAggregationEvaluation::Rejected {
        code: ComparisonErrorCode::ArithmeticOverflow,
        reason: "aggregate frame metrics overflowed".into(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RgbaCompositionMode {
    SideBySide,
    /// Columns with `x < position` come from `before`; remaining columns
    /// come from `after`. The integer split is never interpolated or scaled.
    Wipe {
        position: u32,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeRgbaOptions {
    pub before: Vec<u8>,
    pub after: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub mode: RgbaCompositionMode,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RgbaComposition {
    pub schema_version: String,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RgbaCompositionEvaluation {
    Composed {
        composition: RgbaComposition,
    },
    Rejected {
        code: ComparisonErrorCode,
        reason: String,
    },
}

#[export]
pub fn compose_rgba(options: ComposeRgbaOptions) -> RgbaCompositionEvaluation {
    let source_pixels = match validated_pixel_count(options.width, options.height) {
        Ok(value) => value,
        Err((code, reason)) => return composition_rejected(code, &reason),
    };
    let source_len = match source_pixels
        .checked_mul(4)
        .and_then(|value| usize::try_from(value).ok())
    {
        Some(value) => value,
        None => {
            return composition_rejected(
                ComparisonErrorCode::ArithmeticOverflow,
                "RGBA byte length overflowed",
            );
        }
    };
    if options.before.len() != source_len || options.after.len() != source_len {
        return composition_rejected(
            ComparisonErrorCode::InvalidBufferShape,
            "each RGBA buffer length must equal width * height * 4",
        );
    }

    let (output_width, rgba) = match options.mode {
        RgbaCompositionMode::SideBySide => {
            let output_width = match options.width.checked_mul(2) {
                Some(value) => value,
                None => {
                    return composition_rejected(
                        ComparisonErrorCode::ArithmeticOverflow,
                        "side-by-side width overflowed",
                    );
                }
            };
            if let Err((code, reason)) = validated_pixel_count(output_width, options.height) {
                return composition_rejected(code, &reason);
            }
            let row_len = options.width as usize * 4;
            let mut output = Vec::with_capacity(source_len * 2);
            for row in 0..options.height as usize {
                let start = row * row_len;
                let end = start + row_len;
                output.extend_from_slice(&options.before[start..end]);
                output.extend_from_slice(&options.after[start..end]);
            }
            (output_width, output)
        }
        RgbaCompositionMode::Wipe { position } => {
            if position > options.width {
                return composition_rejected(
                    ComparisonErrorCode::InvalidCanvas,
                    "wipe position must be within the canvas width",
                );
            }
            let mut output = Vec::with_capacity(source_len);
            for pixel in 0..source_pixels as usize {
                let x = pixel as u32 % options.width;
                let source = if x < position {
                    &options.before
                } else {
                    &options.after
                };
                output.extend_from_slice(&source[pixel * 4..pixel * 4 + 4]);
            }
            (options.width, output)
        }
    };
    RgbaCompositionEvaluation::Composed {
        composition: RgbaComposition {
            schema_version: "opencut.rgba-composition.v1".into(),
            width: output_width,
            height: options.height,
            rgba,
        },
    }
}

fn composition_rejected(code: ComparisonErrorCode, reason: &str) -> RgbaCompositionEvaluation {
    RgbaCompositionEvaluation::Rejected {
        code,
        reason: reason.into(),
    }
}

const MAX_PCM_SAMPLES: usize = 2_000_000;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparePcmI16Options {
    /// Aligned interleaved signed 16-bit PCM samples. Both buffers share this
    /// exact channel layout and sample rate; resampling and channel conversion
    /// are deliberately forbidden.
    pub before: Vec<i16>,
    pub after: Vec<i16>,
    pub channels: u32,
    pub sample_rate: u32,
    /// Equality is tolerated. A sample exceeds tolerance only when its absolute
    /// delta is strictly greater than this value.
    pub sample_tolerance: u16,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PcmI16Metrics {
    pub schema_version: String,
    pub semantics: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub sample_count: u64,
    pub sample_frame_count: u64,
    pub sample_tolerance: u16,
    pub exceeding_sample_count: u64,
    pub max_absolute_delta: u32,
    pub absolute_delta_sum: u64,
    pub squared_delta_sum: u64,
    pub mean_absolute_delta: Ratio,
    pub mean_squared_delta: Ratio,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PcmComparisonEvaluation {
    Compared {
        metrics: PcmI16Metrics,
    },
    Rejected {
        code: ComparisonErrorCode,
        reason: String,
    },
}

#[export]
pub fn compare_pcm_i16(options: ComparePcmI16Options) -> PcmComparisonEvaluation {
    if options.channels == 0 || options.sample_rate == 0 {
        return pcm_rejected(
            ComparisonErrorCode::InvalidBufferShape,
            "channels and sampleRate must be positive",
        );
    }
    if options.before.len() != options.after.len() {
        return pcm_rejected(
            ComparisonErrorCode::ShapeMismatch,
            "PCM buffers must have exactly the same sample count",
        );
    }
    if options.before.is_empty() || options.before.len() % options.channels as usize != 0 {
        return pcm_rejected(
            ComparisonErrorCode::InvalidBufferShape,
            "PCM buffers must contain complete non-empty interleaved sample frames",
        );
    }
    if options.before.len() > MAX_PCM_SAMPLES {
        return pcm_rejected(
            ComparisonErrorCode::ResourceLimitExceeded,
            "PCM buffers exceed the 2000000-sample comparison limit",
        );
    }

    let mut exceeding_sample_count = 0_u64;
    let mut max_absolute_delta = 0_u32;
    let mut absolute_delta_sum = 0_u64;
    let mut squared_delta_sum = 0_u64;
    for (before, after) in options.before.iter().zip(&options.after) {
        let delta = u32::from(before.abs_diff(*after));
        if delta > u32::from(options.sample_tolerance) {
            exceeding_sample_count += 1;
        }
        max_absolute_delta = max_absolute_delta.max(delta);
        absolute_delta_sum += u64::from(delta);
        squared_delta_sum += u64::from(delta) * u64::from(delta);
    }
    let sample_count = options.before.len() as u64;
    PcmComparisonEvaluation::Compared {
        metrics: PcmI16Metrics {
            schema_version: "opencut.pcm-i16-comparison.v1".into(),
            semantics: "aligned-interleaved-pcm-i16-absolute-delta-inclusive-tolerance".into(),
            channels: options.channels,
            sample_rate: options.sample_rate,
            sample_count,
            sample_frame_count: sample_count / u64::from(options.channels),
            sample_tolerance: options.sample_tolerance,
            exceeding_sample_count,
            max_absolute_delta,
            absolute_delta_sum,
            squared_delta_sum,
            mean_absolute_delta: Ratio {
                numerator: absolute_delta_sum,
                denominator: sample_count,
            },
            mean_squared_delta: Ratio {
                numerator: squared_delta_sum,
                denominator: sample_count,
            },
        },
    }
}

fn pcm_rejected(code: ComparisonErrorCode, reason: &str) -> PcmComparisonEvaluation {
    PcmComparisonEvaluation::Rejected {
        code,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::{FrameRangeLimits, FrameRangeSelector, FrameRate};

    #[test]
    fn plans_one_shared_half_open_schedule_without_normalization() {
        let evaluation = plan_comparison(PlanComparisonOptions {
            before: ComparisonRenderSource {
                canvas: ComparisonCanvas {
                    width: 1920,
                    height: 1080,
                },
                rate: FrameRate::FPS_30,
                scene_duration_ticks: 240_000,
                renderer_settings_digest:
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            },
            after: ComparisonRenderSource {
                canvas: ComparisonCanvas {
                    width: 1920,
                    height: 1080,
                },
                rate: FrameRate::FPS_30,
                scene_duration_ticks: 120_001,
                renderer_settings_digest:
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            },
            range: FrameRangeSelector::MediaTime {
                start_ticks: 0,
                end_ticks_exclusive: 120_001,
            },
            limits: FrameRangeLimits {
                max_duration_ticks: 1_200_000,
                max_frames: 300,
            },
        });

        let ComparisonPlanEvaluation::Planned { plan } = evaluation else {
            panic!("expected comparison plan");
        };
        assert_eq!(plan.common_scene_duration_ticks, 120_001);
        assert_eq!(plan.schedule.frame_count, 31);
        assert_eq!(plan.schedule.frames[30].timeline_ticks, 120_000);
        assert_eq!(plan.normalization_policy, "exact-no-normalization");
    }

    #[test]
    fn compares_straight_rgba_bytes_and_returns_bounded_four_connected_regions() {
        let before = vec![
            10, 20, 30, 40, 10, 20, 30, 40, 10, 20, 30, 40, 10, 20, 30, 40,
        ];
        let after = vec![
            10, 20, 30, 40, 15, 20, 30, 40, 10, 20, 30, 43, 10, 26, 30, 40,
        ];
        let evaluation = compare_rgba(CompareRgbaOptions {
            before,
            after,
            width: 2,
            height: 2,
            pixel_tolerance: 5,
            tolerance_boundary: ToleranceBoundary::Inclusive,
            max_regions: Some(8),
        });

        let RgbaComparisonEvaluation::Compared { comparison } = evaluation else {
            panic!("expected RGBA comparison");
        };
        assert_eq!(comparison.metrics.pixel_count, 4);
        assert_eq!(comparison.metrics.exceeding_pixel_count, 1);
        assert_eq!(comparison.metrics.absolute_channel_delta_sums, [5, 6, 0, 3]);
        assert_eq!(comparison.metrics.absolute_delta_sum, 14);
        assert_eq!(
            comparison.metrics.mean_absolute_delta,
            Ratio {
                numerator: 14,
                denominator: 16
            }
        );
        assert_eq!(comparison.regions.total_region_count, 1);
        assert_eq!(
            comparison.regions.items[0].bounds,
            PixelBounds {
                x: 1,
                y: 1,
                width: 1,
                height: 1
            }
        );
        assert_eq!(
            comparison.diff_rgba,
            vec![0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 3, 0, 6, 0, 0]
        );
    }

    #[test]
    fn aggregates_frame_metrics_by_pixel_and_channel_count() {
        let evaluation = aggregate_frame_metrics(AggregateFrameMetricsOptions {
            per_frame: vec![
                RgbaFrameMetrics {
                    pixel_count: 1,
                    exceeding_pixel_count: 1,
                    absolute_channel_delta_sums: [4, 0, 0, 0],
                    max_channel_deltas: [4, 0, 0, 0],
                    absolute_delta_sum: 4,
                    channel_sample_count: 4,
                    mean_absolute_delta: Ratio {
                        numerator: 4,
                        denominator: 4,
                    },
                },
                RgbaFrameMetrics {
                    pixel_count: 3,
                    exceeding_pixel_count: 1,
                    absolute_channel_delta_sums: [0, 12, 0, 0],
                    max_channel_deltas: [0, 7, 0, 0],
                    absolute_delta_sum: 12,
                    channel_sample_count: 12,
                    mean_absolute_delta: Ratio {
                        numerator: 12,
                        denominator: 12,
                    },
                },
            ],
        });
        let FrameMetricsAggregationEvaluation::Aggregated { metrics } = evaluation else {
            panic!("expected aggregate metrics");
        };
        assert_eq!(metrics.pixel_count, 4);
        assert_eq!(metrics.exceeding_pixel_count, 2);
        assert_eq!(metrics.absolute_delta_sum, 16);
        assert_eq!(
            metrics.mean_absolute_delta,
            Ratio {
                numerator: 16,
                denominator: 16
            }
        );
        assert_eq!(metrics.max_channel_deltas, [4, 7, 0, 0]);
    }

    #[test]
    fn composes_side_by_side_and_integer_column_wipe_without_scaling() {
        let before = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let after = vec![11, 12, 13, 14, 15, 16, 17, 18];
        let side = composed(compose_rgba(ComposeRgbaOptions {
            before: before.clone(),
            after: after.clone(),
            width: 2,
            height: 1,
            mode: RgbaCompositionMode::SideBySide,
        }));
        assert_eq!((side.width, side.height), (4, 1));
        assert_eq!(
            side.rgba,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18]
        );

        let wipe = composed(compose_rgba(ComposeRgbaOptions {
            before,
            after,
            width: 2,
            height: 1,
            mode: RgbaCompositionMode::Wipe { position: 1 },
        }));
        assert_eq!((wipe.width, wipe.height), (2, 1));
        assert_eq!(wipe.rgba, vec![1, 2, 3, 4, 15, 16, 17, 18]);
    }

    #[test]
    fn compares_aligned_interleaved_pcm_i16_without_overflow() {
        let evaluation = compare_pcm_i16(ComparePcmI16Options {
            before: vec![i16::MIN, 100, 0, 1_000],
            after: vec![i16::MAX, 103, -4, 990],
            channels: 2,
            sample_rate: 48_000,
            sample_tolerance: 3,
        });
        let PcmComparisonEvaluation::Compared { metrics } = evaluation else {
            panic!("expected PCM metrics");
        };
        assert_eq!(metrics.sample_count, 4);
        assert_eq!(metrics.sample_frame_count, 2);
        assert_eq!(metrics.exceeding_sample_count, 3);
        assert_eq!(metrics.max_absolute_delta, 65_535);
        assert_eq!(metrics.absolute_delta_sum, 65_552);
        assert_eq!(metrics.squared_delta_sum, 4_294_836_350);
        assert_eq!(
            metrics.mean_absolute_delta,
            Ratio {
                numerator: 65_552,
                denominator: 4
            }
        );
    }

    #[test]
    fn rejects_implicit_renderer_canvas_and_rate_normalization() {
        let base = ComparisonRenderSource {
            canvas: ComparisonCanvas {
                width: 16,
                height: 9,
            },
            rate: FrameRate::FPS_30,
            scene_duration_ticks: 120_000,
            renderer_settings_digest: "a".repeat(64),
        };
        let options = |after: ComparisonRenderSource| PlanComparisonOptions {
            before: base.clone(),
            after,
            range: FrameRangeSelector::FrameIndex {
                start_frame_index: 0,
                end_frame_index_exclusive: 1,
            },
            limits: FrameRangeLimits {
                max_duration_ticks: 120_000,
                max_frames: 30,
            },
        };
        assert!(matches!(
            plan_comparison(options(ComparisonRenderSource {
                canvas: ComparisonCanvas {
                    width: 17,
                    height: 9
                },
                ..base.clone()
            })),
            ComparisonPlanEvaluation::Rejected {
                code: ComparisonErrorCode::CanvasMismatch,
                ..
            }
        ));
        assert!(matches!(
            plan_comparison(options(ComparisonRenderSource {
                rate: FrameRate {
                    numerator: 24,
                    denominator: 1
                },
                ..base.clone()
            })),
            ComparisonPlanEvaluation::Rejected {
                code: ComparisonErrorCode::FrameRateMismatch,
                ..
            }
        ));
        assert!(matches!(
            plan_comparison(options(ComparisonRenderSource {
                renderer_settings_digest: "b".repeat(64),
                ..base
            })),
            ComparisonPlanEvaluation::Rejected {
                code: ComparisonErrorCode::RendererSettingsMismatch,
                ..
            }
        ));
    }

    #[test]
    fn tolerance_boundary_shape_and_region_limits_are_explicit() {
        let evaluate = |boundary| {
            compare_rgba(CompareRgbaOptions {
                before: vec![0, 0, 0, 255],
                after: vec![5, 0, 0, 255],
                width: 1,
                height: 1,
                pixel_tolerance: 5,
                tolerance_boundary: boundary,
                max_regions: Some(1),
            })
        };
        let RgbaComparisonEvaluation::Compared { comparison } =
            evaluate(ToleranceBoundary::Inclusive)
        else {
            panic!("expected inclusive comparison");
        };
        assert_eq!(comparison.metrics.exceeding_pixel_count, 0);
        let RgbaComparisonEvaluation::Compared { comparison } =
            evaluate(ToleranceBoundary::Exclusive)
        else {
            panic!("expected exclusive comparison");
        };
        assert_eq!(comparison.metrics.exceeding_pixel_count, 1);

        assert!(matches!(
            compare_rgba(CompareRgbaOptions {
                before: vec![0; 3],
                after: vec![0; 4],
                width: 1,
                height: 1,
                pixel_tolerance: 0,
                tolerance_boundary: ToleranceBoundary::Inclusive,
                max_regions: Some(1),
            }),
            RgbaComparisonEvaluation::Rejected {
                code: ComparisonErrorCode::InvalidBufferShape,
                ..
            }
        ));

        let RgbaComparisonEvaluation::Compared { comparison } = compare_rgba(CompareRgbaOptions {
            before: vec![0; 12],
            after: vec![1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
            width: 3,
            height: 1,
            pixel_tolerance: 0,
            tolerance_boundary: ToleranceBoundary::Inclusive,
            max_regions: Some(1),
        }) else {
            panic!("expected bounded region comparison");
        };
        assert_eq!(comparison.regions.total_region_count, 2);
        assert_eq!(comparison.regions.retained_region_count, 1);
        assert!(comparison.regions.truncated);
    }

    fn composed(evaluation: RgbaCompositionEvaluation) -> RgbaComposition {
        match evaluation {
            RgbaCompositionEvaluation::Composed { composition } => composition,
            other => panic!("expected composition, got {other:?}"),
        }
    }
}
