use bridge::export;
use serde::{Deserialize, Serialize};

pub const APPROVED_MODEL_CATALOG_SCHEMA: &str = "opencut.approved-models.v1";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedModelCatalog {
    pub schema_version: &'static str,
    pub models: Vec<ApprovedModel>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedModel {
    pub task_id: &'static str,
    pub provider_id: &'static str,
    pub model_id: &'static str,
    pub model_version: &'static str,
    pub artifact: ApprovedArtifact,
    pub code: Option<ApprovedSourcePin>,
    pub runtime: ApprovedRuntimePin,
    pub license: ApprovedLicense,
    pub execution_policy: ApprovedExecutionPolicy,
    pub output_policy: &'static str,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedArtifact {
    pub filename: &'static str,
    pub source_url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub cache_key: &'static str,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedSourcePin {
    pub repository: &'static str,
    pub revision: &'static str,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedRuntimePin {
    pub runtime_id: &'static str,
    pub repository: &'static str,
    pub revision: Option<&'static str>,
    pub release: Option<&'static str>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedLicense {
    pub spdx: &'static str,
    pub model_notice: &'static str,
    pub bundled_license_path: &'static str,
    pub bundled_notice_path: &'static str,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedExecutionPolicy {
    pub canonical_device: &'static str,
    pub canonical_threads: Option<u32>,
    pub cpu_fallback: &'static str,
    pub cuda: &'static str,
    pub windows_cuda: &'static str,
    pub conformance_required: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedModelReadinessInput {
    pub task_id: String,
    pub artifact: Option<ModelArtifactProbe>,
    pub runtime: Option<ApprovedRuntimeProbe>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelArtifactProbe {
    pub sha256: String,
    pub bytes: u64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedRuntimeProbe {
    pub runtime_id: String,
    pub runtime_version: String,
    pub device: String,
    pub host_os: String,
    pub environment: String,
    pub threads: Option<u32>,
    pub deterministic_conformance: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ApprovedModelReadinessResponse {
    Readiness { readiness: ModelReadiness },
    Rejected { code: &'static str, reason: String },
}

impl ApprovedModelReadinessResponse {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Readiness { .. } => "readiness",
            Self::Rejected { .. } => "rejected",
        }
    }
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Readiness { .. } => None,
            Self::Rejected { code, .. } => Some(code),
        }
    }
    pub fn readiness(&self) -> Option<&ModelReadiness> {
        match self {
            Self::Readiness { readiness } => Some(readiness),
            Self::Rejected { .. } => None,
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReadiness {
    pub status: &'static str,
    pub can_execute: bool,
    pub reason: &'static str,
    pub artifact_status: &'static str,
    pub device: Option<String>,
}

#[export]
pub fn approved_model_catalog() -> ApprovedModelCatalog {
    ApprovedModelCatalog {
        schema_version: APPROVED_MODEL_CATALOG_SCHEMA,
        models: models(),
    }
}

#[export]
pub fn validate_approved_model_readiness(
    input: ApprovedModelReadinessInput,
) -> ApprovedModelReadinessResponse {
    let Some(model) = models()
        .into_iter()
        .find(|candidate| candidate.task_id == input.task_id)
    else {
        return reject("UNKNOWN_MEDIA_TASK_ID", "unknown media task ID");
    };
    let Some(artifact) = input.artifact else {
        return readiness(
            "unavailable",
            false,
            "The approved model artifact is not present in the managed cache.",
            "missing",
            None,
        );
    };
    if artifact.sha256 != model.artifact.sha256 {
        return reject(
            "MODEL_ARTIFACT_HASH_MISMATCH",
            "Cached model bytes do not match the owner-approved SHA-256.",
        );
    }
    if artifact.bytes != model.artifact.bytes {
        return reject(
            "MODEL_ARTIFACT_SIZE_MISMATCH",
            "Cached model byte count does not match the immutable artifact.",
        );
    }
    let Some(runtime) = input.runtime else {
        return readiness(
            "degraded",
            false,
            "The artifact is verified, but the pinned runtime has not passed a real readiness probe.",
            "ready",
            None,
        );
    };
    if runtime.runtime_id != model.runtime.runtime_id || runtime.runtime_version.trim().is_empty() {
        return reject(
            "MODEL_RUNTIME_MISMATCH",
            "The runtime identity does not match the approved provider policy.",
        );
    }
    if let Some(revision) = model.runtime.revision
        && runtime.runtime_version != revision
    {
        return reject(
            "MODEL_RUNTIME_MISMATCH",
            "The runtime revision does not match the immutable approved pin.",
        );
    }
    if !runtime.deterministic_conformance {
        return reject(
            "MODEL_CONFORMANCE_REQUIRED",
            "Execution remains disabled until deterministic conformance passes.",
        );
    }
    match runtime.device.as_str() {
        "cpu" => {
            if model.execution_policy.canonical_threads.is_some()
                && runtime.threads != model.execution_policy.canonical_threads
            {
                return reject(
                    "MODEL_EXECUTION_POLICY_VIOLATION",
                    "The canonical CPU thread policy was not honored.",
                );
            }
        }
        "cuda" => {
            if runtime.host_os == "windows"
                && model.task_id == "opencut.task.subject-tracking.v1"
                && runtime.environment != "wsl2-ubuntu"
            {
                return reject(
                    "MODEL_EXECUTION_POLICY_VIOLATION",
                    "SAM CUDA on Windows is permitted only through WSL2/Ubuntu.",
                );
            }
        }
        _ => {
            return reject(
                "MODEL_EXECUTION_POLICY_VIOLATION",
                "Only the approved CPU and CUDA device policies are supported.",
            );
        }
    }
    readiness(
        "ready",
        true,
        "Artifact, runtime, device policy, and deterministic conformance are verified.",
        "ready",
        Some(runtime.device),
    )
}

fn reject(code: &'static str, reason: &str) -> ApprovedModelReadinessResponse {
    ApprovedModelReadinessResponse::Rejected {
        code,
        reason: reason.into(),
    }
}

fn readiness(
    status: &'static str,
    can_execute: bool,
    reason: &'static str,
    artifact_status: &'static str,
    device: Option<String>,
) -> ApprovedModelReadinessResponse {
    ApprovedModelReadinessResponse::Readiness {
        readiness: ModelReadiness {
            status,
            can_execute,
            reason,
            artifact_status,
            device,
        },
    }
}

pub(crate) fn model_for_task(task_id: &str) -> Option<ApprovedModel> {
    models().into_iter().find(|model| model.task_id == task_id)
}

fn models() -> Vec<ApprovedModel> {
    vec![
        model(
            "opencut.task.subject-tracking.v1",
            "opencut-sam21-local",
            "facebook/sam2.1-hiera-small",
            "ee5bba1d82bb8749febdf90f45e84b687142ba03",
            "model.safetensors",
            "https://huggingface.co/facebook/sam2.1-hiera-small/resolve/ee5bba1d82bb8749febdf90f45e84b687142ba03/model.safetensors?download=true",
            "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
            184_305_280,
            Some((
                "https://github.com/facebookresearch/sam2",
                "2b90b9f5ceec907a1c18123530e92e794ad901a4",
            )),
            (
                "sam2",
                "https://github.com/facebookresearch/sam2",
                Some("2b90b9f5ceec907a1c18123530e92e794ad901a4"),
                None,
            ),
            "Apache-2.0",
            "SAM 2.1 Hiera Small code and weights",
            "APACHE-2.0.txt",
            "THIRD-PARTY-NOTICES.md",
            "cpu",
            None,
            "required-offline",
            "optional-after-deterministic-conformance",
            "wsl2-ubuntu-only-after-conformance",
            "tracking object with deterministic masks",
        ),
        model(
            "opencut.task.audio-cleanup.v1",
            "opencut-metricgan-plus-local",
            "speechbrain/metricgan-plus-voicebank",
            "a196ce26b3bdace6fa1d819017584bdbcce462a8",
            "enhance_model.ckpt",
            "https://huggingface.co/speechbrain/metricgan-plus-voicebank/resolve/a196ce26b3bdace6fa1d819017584bdbcce462a8/enhance_model.ckpt?download=true",
            "147bfb866bac8264603546e035bf283370e716ed2f4b7412d308d2bcee88304f",
            7_586_021,
            None,
            (
                "speechbrain",
                "https://github.com/speechbrain/speechbrain",
                Some("89ead74d163463d30c62329a09cfdb4c54f5abc1"),
                Some("1.1.1"),
            ),
            "Apache-2.0",
            "MetricGAN+ VoiceBank model and SpeechBrain runtime; 16 kHz mono speech domain",
            "APACHE-2.0.txt",
            "THIRD-PARTY-NOTICES.md",
            "cpu",
            None,
            "required-canonical",
            "optional-after-deterministic-conformance",
            "optional-after-deterministic-conformance",
            "non-destructive clean audio plus A/B artifacts",
        ),
        model(
            "opencut.task.stem-separation.v1",
            "opencut-open-unmix-local",
            "sigsep/open-unmix-umxhq-vocals",
            "1.0.1",
            "vocals-b62c91ce.pth",
            "https://zenodo.org/records/3370489/files/vocals-b62c91ce.pth?download=1",
            "b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
            35_637_796,
            Some((
                "https://github.com/sigsep/open-unmix-pytorch",
                "814f144e34b2d1ed517eb605ce928dcb838abbed",
            )),
            (
                "open-unmix-pytorch",
                "https://github.com/sigsep/open-unmix-pytorch",
                Some("814f144e34b2d1ed517eb605ce928dcb838abbed"),
                Some("1.3.0"),
            ),
            "MIT",
            "Open-Unmix UMX-HQ vocals, Zenodo record 3370489, DOI 10.5281/zenodo.3370489",
            "OPEN-UNMIX-MIT.txt",
            "THIRD-PARTY-NOTICES.md",
            "cpu",
            None,
            "required-offline",
            "optional-after-aligned-output-conformance",
            "optional-after-aligned-output-conformance",
            "vocals plus deterministic residual accompaniment",
        ),
        model(
            "opencut.task.voice-activity-detection.v1",
            "opencut-silero-vad-local",
            "silero-vad",
            "7e30209a3e901f9842f81b225f3e93d8199902b1",
            "silero_vad.onnx",
            "https://raw.githubusercontent.com/snakers4/silero-vad/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx",
            "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
            2_327_524,
            Some((
                "https://github.com/snakers4/silero-vad",
                "7e30209a3e901f9842f81b225f3e93d8199902b1",
            )),
            ("onnxruntime", "https://onnxruntime.ai/", None, None),
            "MIT",
            "Silero VAD v6.2.1 code and included ONNX weights",
            "SILERO-MIT.txt",
            "THIRD-PARTY-NOTICES.md",
            "cpu",
            Some(1),
            "required-canonical-onnxruntime-cpuexecutionprovider",
            "optional-after-exact-sample-boundary-conformance",
            "optional-after-exact-sample-boundary-conformance",
            "persistent exact sample-boundary activity ranges",
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn model(
    task_id: &'static str,
    provider_id: &'static str,
    model_id: &'static str,
    model_version: &'static str,
    filename: &'static str,
    source_url: &'static str,
    sha256: &'static str,
    bytes: u64,
    code: Option<(&'static str, &'static str)>,
    runtime: (
        &'static str,
        &'static str,
        Option<&'static str>,
        Option<&'static str>,
    ),
    spdx: &'static str,
    notice: &'static str,
    license_path: &'static str,
    notice_path: &'static str,
    canonical_device: &'static str,
    canonical_threads: Option<u32>,
    cpu_fallback: &'static str,
    cuda: &'static str,
    windows_cuda: &'static str,
    output_policy: &'static str,
) -> ApprovedModel {
    ApprovedModel {
        task_id,
        provider_id,
        model_id,
        model_version,
        artifact: ApprovedArtifact {
            filename,
            source_url,
            sha256,
            bytes,
            cache_key: sha256,
        },
        code: code.map(|(repository, revision)| ApprovedSourcePin {
            repository,
            revision,
        }),
        runtime: ApprovedRuntimePin {
            runtime_id: runtime.0,
            repository: runtime.1,
            revision: runtime.2,
            release: runtime.3,
        },
        license: ApprovedLicense {
            spdx,
            model_notice: notice,
            bundled_license_path: license_path,
            bundled_notice_path: notice_path,
        },
        execution_policy: ApprovedExecutionPolicy {
            canonical_device,
            canonical_threads,
            cpu_fallback,
            cuda,
            windows_cuda,
            conformance_required: true,
        },
        output_policy,
    }
}
