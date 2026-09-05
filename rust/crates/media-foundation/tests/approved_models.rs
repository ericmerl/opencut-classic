use media_foundation::{
    ApprovedModelReadinessInput, ApprovedRuntimeProbe, ModelArtifactProbe, approved_model_catalog,
    validate_approved_model_readiness,
};
use std::{fs, path::Path};

const SAM: &str = "opencut.task.subject-tracking.v1";
const SILERO: &str = "opencut.task.voice-activity-detection.v1";

#[test]
fn approved_catalog_pins_owner_selected_artifacts_and_policies() {
    let catalog = approved_model_catalog();
    assert_eq!(catalog.schema_version, "opencut.approved-models.v1");
    assert_eq!(catalog.models.len(), 4);
    let sam = catalog
        .models
        .iter()
        .find(|model| model.task_id == SAM)
        .unwrap();
    assert_eq!(sam.model_id, "facebook/sam2.1-hiera-small");
    assert_eq!(
        sam.model_version,
        "ee5bba1d82bb8749febdf90f45e84b687142ba03"
    );
    assert_eq!(
        sam.artifact.sha256,
        "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60"
    );
    assert_eq!(sam.license.spdx, "Apache-2.0");
    assert_eq!(
        sam.execution_policy.windows_cuda,
        "wsl2-ubuntu-only-after-conformance"
    );
    let cleanup = catalog
        .models
        .iter()
        .find(|model| model.task_id == "opencut.task.audio-cleanup.v1")
        .unwrap();
    assert_eq!(cleanup.model_id, "speechbrain/metricgan-plus-voicebank");
    assert_eq!(
        cleanup.model_version,
        "a196ce26b3bdace6fa1d819017584bdbcce462a8"
    );
    assert_eq!(
        cleanup.artifact.sha256,
        "147bfb866bac8264603546e035bf283370e716ed2f4b7412d308d2bcee88304f"
    );
    assert_eq!(
        cleanup.runtime.revision,
        Some("89ead74d163463d30c62329a09cfdb4c54f5abc1")
    );
    let stems = catalog
        .models
        .iter()
        .find(|model| model.task_id == "opencut.task.stem-separation.v1")
        .unwrap();
    assert_eq!(stems.model_id, "sigsep/open-unmix-umxhq-vocals");
    assert_eq!(stems.model_version, "1.0.1");
    assert_eq!(
        stems.artifact.sha256,
        "b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083"
    );
    assert_eq!(
        stems.runtime.revision,
        Some("814f144e34b2d1ed517eb605ce928dcb838abbed")
    );
    let silero = catalog
        .models
        .iter()
        .find(|model| model.task_id == SILERO)
        .unwrap();
    assert_eq!(
        silero.model_version,
        "7e30209a3e901f9842f81b225f3e93d8199902b1"
    );
    assert_eq!(
        silero.artifact.sha256,
        "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
    );
    assert_eq!(silero.execution_policy.canonical_device, "cpu");
    assert_eq!(silero.execution_policy.canonical_threads, Some(1));
}

#[test]
fn every_approved_model_has_redistributable_license_and_notice_bytes() {
    let vendor = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/approved-models");
    for model in approved_model_catalog().models {
        let license = fs::read_to_string(vendor.join(model.license.bundled_license_path)).unwrap();
        let notice = fs::read_to_string(vendor.join(model.license.bundled_notice_path)).unwrap();
        let license_title = if model.license.spdx == "Apache-2.0" {
            "Apache License"
        } else {
            "MIT License"
        };
        assert!(license.contains(license_title));
        assert!(license.len() > 1_000);
        assert!(notice.contains("Approved local model notices"));
        assert!(notice.len() > 1_000);
    }
}

#[test]
fn readiness_fails_closed_for_hash_and_execution_policy_mismatches() {
    let wrong_hash = validate_approved_model_readiness(ApprovedModelReadinessInput {
        task_id: SILERO.into(),
        artifact: Some(ModelArtifactProbe {
            sha256: "0".repeat(64),
            bytes: 1,
        }),
        runtime: None,
    });
    assert_eq!(wrong_hash.status(), "rejected");
    assert_eq!(wrong_hash.code(), Some("MODEL_ARTIFACT_HASH_MISMATCH"));

    let wrong_threads = validate_approved_model_readiness(ApprovedModelReadinessInput {
        task_id: SILERO.into(),
        artifact: Some(ModelArtifactProbe {
            sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3".into(),
            bytes: 2_327_524,
        }),
        runtime: Some(ApprovedRuntimeProbe {
            runtime_id: "onnxruntime".into(),
            runtime_version: "1.22.1".into(),
            device: "cpu".into(),
            host_os: "windows".into(),
            environment: "native".into(),
            threads: Some(2),
            deterministic_conformance: true,
        }),
    });
    assert_eq!(wrong_threads.status(), "rejected");
    assert_eq!(
        wrong_threads.code(),
        Some("MODEL_EXECUTION_POLICY_VIOLATION")
    );
}

#[test]
fn readiness_distinguishes_verified_cache_from_runtime_readiness() {
    let cached = validate_approved_model_readiness(ApprovedModelReadinessInput {
        task_id: SAM.into(),
        artifact: Some(ModelArtifactProbe {
            sha256: "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60".into(),
            bytes: 184_305_280,
        }),
        runtime: None,
    });
    assert_eq!(cached.status(), "readiness");
    assert_eq!(cached.readiness().unwrap().status, "degraded");
    assert!(!cached.readiness().unwrap().can_execute);

    let native_windows_cuda = validate_approved_model_readiness(ApprovedModelReadinessInput {
        task_id: SAM.into(),
        artifact: Some(ModelArtifactProbe {
            sha256: "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60".into(),
            bytes: 184_305_280,
        }),
        runtime: Some(ApprovedRuntimeProbe {
            runtime_id: "sam2".into(),
            runtime_version: "2b90b9f5ceec907a1c18123530e92e794ad901a4".into(),
            device: "cuda".into(),
            host_os: "windows".into(),
            environment: "native".into(),
            threads: None,
            deterministic_conformance: true,
        }),
    });
    assert_eq!(
        native_windows_cuda.code(),
        Some("MODEL_EXECUTION_POLICY_VIOLATION")
    );
}
