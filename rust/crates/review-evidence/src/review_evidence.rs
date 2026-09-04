use bridge::export;
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewAnnotationValidationInput {
    pub location: ReviewLocation,
    pub region: NormalizedRegion,
    pub finding: ReviewFinding,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewLocation {
    Time {
        ticks: i64,
    },
    Range {
        start_ticks: i64,
        end_ticks_exclusive: i64,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewFinding {
    Human,
    Automated {
        detector: Option<DetectorProvenance>,
    },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetectorProvenance {
    pub provider: String,
    pub model_id: String,
    pub model_version: String,
    pub options_fingerprint: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewAnnotationValidation {
    Valid,
    Rejected { code: String, reason: String },
}

#[export]
pub fn validate_review_annotation(
    input: ReviewAnnotationValidationInput,
) -> ReviewAnnotationValidation {
    let region = input.region;
    if region.x < 0.0
        || region.y < 0.0
        || region.width <= 0.0
        || region.height <= 0.0
        || region.x + region.width > 1.0
        || region.y + region.height > 1.0
    {
        return rejected(
            "REGION_OUTSIDE_FRAME",
            "normalized region must fit entirely inside the frame",
        );
    }
    let location_result = match input.location {
        ReviewLocation::Time { ticks } if ticks < 0 => {
            rejected("INVALID_TIME", "annotation time must be nonnegative")
        }
        ReviewLocation::Range {
            start_ticks,
            end_ticks_exclusive,
        } if start_ticks < 0 || end_ticks_exclusive <= start_ticks => rejected(
            "EMPTY_TIME_RANGE",
            "annotation range must be a nonempty half-open range",
        ),
        _ => ReviewAnnotationValidation::Valid,
    };
    if location_result != ReviewAnnotationValidation::Valid {
        return location_result;
    }
    match input.finding {
        ReviewFinding::Automated { detector: None } => rejected(
            "DETECTOR_PROVENANCE_REQUIRED",
            "automated findings require detector and model provenance",
        ),
        ReviewFinding::Automated {
            detector: Some(detector),
        } if detector.provider.trim().is_empty()
            || detector.model_id.trim().is_empty()
            || detector.model_version.trim().is_empty() =>
        {
            rejected(
                "DETECTOR_PROVENANCE_REQUIRED",
                "automated findings require detector and model provenance",
            )
        }
        _ => ReviewAnnotationValidation::Valid,
    }
}

fn rejected(code: &str, reason: &str) -> ReviewAnnotationValidation {
    ReviewAnnotationValidation::Rejected {
        code: code.into(),
        reason: reason.into(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSignoffInput {
    pub review_kind: ReviewKind,
    pub full_frame_samples: Vec<String>,
    pub inspected_corners: Vec<String>,
    pub final_export_bytes_inspected: bool,
    pub final_export_bytes_clean: bool,
    pub unresolved_blocking_findings: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewKind {
    Human,
    Automated,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ExportSignoffEvaluation {
    Eligible,
    Rejected { code: String, reason: String },
}

#[export]
pub fn evaluate_export_signoff(input: ExportSignoffInput) -> ExportSignoffEvaluation {
    if input.review_kind != ReviewKind::Human {
        return signoff_rejected(
            "HUMAN_REVIEW_REQUIRED",
            "automated detection does not satisfy required human review",
        );
    }
    if !contains_all(&input.full_frame_samples, &["opening", "middle", "ending"])
        || !contains_all(
            &input.inspected_corners,
            &["top-left", "top-right", "bottom-left", "bottom-right"],
        )
    {
        return signoff_rejected(
            "WATERMARK_EVIDENCE_INCOMPLETE",
            "opening, middle, ending, and four-corner inspection are required",
        );
    }
    if !input.final_export_bytes_inspected {
        return signoff_rejected(
            "FINAL_EXPORT_BYTES_NOT_INSPECTED",
            "final exported bytes require a separate inspection",
        );
    }
    if !input.final_export_bytes_clean {
        return signoff_rejected(
            "WATERMARK_FOUND",
            "final exported bytes are not verified clean",
        );
    }
    if input.unresolved_blocking_findings > 0 {
        return signoff_rejected(
            "UNRESOLVED_BLOCKING_FINDINGS",
            "blocking review findings must be resolved before sign-off",
        );
    }
    ExportSignoffEvaluation::Eligible
}

fn contains_all(values: &[String], required: &[&str]) -> bool {
    required
        .iter()
        .all(|required_value| values.iter().any(|value| value == required_value))
}

fn signoff_rejected(code: &str, reason: &str) -> ExportSignoffEvaluation {
    ExportSignoffEvaluation::Rejected {
        code: code.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ExportSignoffEvaluation, ExportSignoffInput, ReviewAnnotationValidation,
        ReviewAnnotationValidationInput, evaluate_export_signoff, validate_review_annotation,
    };

    #[test]
    fn validates_normalized_regions_and_half_open_time_ranges() {
        let valid: ReviewAnnotationValidationInput = serde_json::from_value(serde_json::json!({
            "location": { "kind": "range", "startTicks": 120000, "endTicksExclusive": 240000 },
            "region": { "x": 0.7, "y": 0.6, "width": 0.3, "height": 0.4 },
            "finding": { "kind": "human" }
        }))
        .expect("valid annotation validation input");
        assert_eq!(
            validate_review_annotation(valid),
            ReviewAnnotationValidation::Valid
        );

        let outside: ReviewAnnotationValidationInput = serde_json::from_value(serde_json::json!({
            "location": { "kind": "time", "ticks": 120000 },
            "region": { "x": 0.8, "y": 0.2, "width": 0.3, "height": 0.4 },
            "finding": { "kind": "human" }
        }))
        .expect("structurally valid input");
        assert!(matches!(
            validate_review_annotation(outside),
            ReviewAnnotationValidation::Rejected { code, .. }
                if code == "REGION_OUTSIDE_FRAME"
        ));

        let empty: ReviewAnnotationValidationInput = serde_json::from_value(serde_json::json!({
            "location": { "kind": "range", "startTicks": 120000, "endTicksExclusive": 120000 },
            "region": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
            "finding": { "kind": "human" }
        }))
        .expect("structurally valid input");
        assert!(matches!(
            validate_review_annotation(empty),
            ReviewAnnotationValidation::Rejected { code, .. }
                if code == "EMPTY_TIME_RANGE"
        ));
    }

    #[test]
    fn automated_findings_require_detector_and_model_provenance() {
        let missing_detector: ReviewAnnotationValidationInput =
            serde_json::from_value(serde_json::json!({
                "location": { "kind": "time", "ticks": 120000 },
                "region": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
                "finding": { "kind": "automated" }
            }))
            .expect("structurally valid automated input");
        assert!(matches!(
            validate_review_annotation(missing_detector),
            ReviewAnnotationValidation::Rejected { code, .. }
                if code == "DETECTOR_PROVENANCE_REQUIRED"
        ));

        let complete: ReviewAnnotationValidationInput = serde_json::from_value(serde_json::json!({
            "location": { "kind": "time", "ticks": 120000 },
            "region": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
            "finding": {
                "kind": "automated",
                "detector": {
                    "provider": "local-detector",
                    "modelId": "watermark-net",
                    "modelVersion": "2026-09-04"
                }
            }
        }))
        .expect("complete automated input");
        assert_eq!(
            validate_review_annotation(complete),
            ReviewAnnotationValidation::Valid
        );
    }

    #[test]
    fn final_signoff_requires_complete_human_export_evidence_and_no_blockers() {
        let complete_human = serde_json::json!({
            "reviewKind": "human",
            "fullFrameSamples": ["opening", "middle", "ending"],
            "inspectedCorners": ["top-left", "top-right", "bottom-left", "bottom-right"],
            "finalExportBytesInspected": true,
            "finalExportBytesClean": true,
            "unresolvedBlockingFindings": 0
        });
        let eligible: ExportSignoffInput =
            serde_json::from_value(complete_human.clone()).expect("complete signoff input");
        assert_eq!(
            evaluate_export_signoff(eligible),
            ExportSignoffEvaluation::Eligible
        );

        for (changed, expected_code) in [
            (
                serde_json::json!({ "reviewKind": "automated" }),
                "HUMAN_REVIEW_REQUIRED",
            ),
            (
                serde_json::json!({
                    "inspectedCorners": ["top-left", "top-right", "bottom-left"]
                }),
                "WATERMARK_EVIDENCE_INCOMPLETE",
            ),
            (
                serde_json::json!({ "finalExportBytesInspected": false }),
                "FINAL_EXPORT_BYTES_NOT_INSPECTED",
            ),
            (
                serde_json::json!({ "unresolvedBlockingFindings": 1 }),
                "UNRESOLVED_BLOCKING_FINDINGS",
            ),
        ] {
            let mut candidate = complete_human.clone();
            for (key, value) in changed.as_object().expect("object override") {
                candidate[key] = value.clone();
            }
            let input: ExportSignoffInput =
                serde_json::from_value(candidate).expect("signoff candidate");
            assert!(matches!(
                evaluate_export_signoff(input),
                ExportSignoffEvaluation::Rejected { code, .. }
                    if code == expected_code
            ));
        }
    }
}
