//! Project-state policy shared by native and WASM callers.

use bridge::export;
use serde::{Deserialize, Serialize};

pub const PROJECT_SNAPSHOT_RETENTION_DAYS: u64 = 90;
pub const PROJECT_SNAPSHOT_RETENTION_MS: u64 =
    PROJECT_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

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
        "sync_audio"
        | "attach_clean_audio"
        | "apply_edit_plan"
        | "import_media"
        | "import_subtitles"
        | "transcribe_timeline"
        | "attach_matte" => matches!(options.status.as_str(), "applied" | "replayed"),
        "undo" => options.status == "undone",
        "render_preview_frame" => matches!(options.status.as_str(), "rendered" | "replayed"),
        "render_preview_range" => {
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
            "open_project" | "render_preview_frame" | "render_preview_range"
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
