#!/usr/bin/env python3
"""Pinned, offline SAM 2.1 Hiera Small command provider.

The provider deliberately imports no ML package until the approved model bytes and
facebookresearch/sam2 checkout have passed their immutable identity checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 2
MODEL_ID = "facebook/sam2.1-hiera-small"
MODEL_REVISION = "ee5bba1d82bb8749febdf90f45e84b687142ba03"
MODEL_ARTIFACT = "model.safetensors"
MODEL_SHA256 = "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60"
SAM2_CODE_REVISION = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
SAM2_CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"
LICENSE = "Apache-2.0"
TICKS_PER_SECOND = 120_000
VERSION = (
    f"opencut-sam21-provider/{PROTOCOL_VERSION} {MODEL_ID}@{MODEL_REVISION} "
    f"facebookresearch/sam2@{SAM2_CODE_REVISION}"
)


class ProviderError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_install(model_path: Path, code_dir: Path, device: str) -> dict[str, Any]:
    if not model_path.is_file():
        raise ProviderError("MODEL_NOT_FOUND", f"approved model artifact is missing: {model_path}")
    actual_hash = sha256_file(model_path)
    if actual_hash != MODEL_SHA256:
        raise ProviderError(
            "MODEL_HASH_MISMATCH",
            f"model SHA-256 is {actual_hash}; expected {MODEL_SHA256}",
        )
    if not code_dir.is_dir():
        raise ProviderError("SAM2_CODE_NOT_FOUND", f"pinned SAM 2 checkout is missing: {code_dir}")
    try:
        revision = subprocess.run(
            ["git", "-C", str(code_dir), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise ProviderError("SAM2_CODE_UNVERIFIABLE", f"cannot verify SAM 2 checkout: {error}") from error
    if revision != SAM2_CODE_REVISION:
        raise ProviderError(
            "SAM2_CODE_REVISION_MISMATCH",
            f"SAM 2 code revision is {revision}; expected {SAM2_CODE_REVISION}",
        )
    if device == "cuda":
        if os.name == "nt" or "microsoft" not in os.uname().release.lower():
            raise ProviderError(
                "CUDA_REQUIRES_WSL2",
                "SAM CUDA execution is allowed only inside WSL2/Ubuntu",
            )
        if os.environ.get("OPENCUT_SAM21_CUDA_CONFORMANCE") != MODEL_SHA256:
            raise ProviderError(
                "CUDA_CONFORMANCE_REQUIRED",
                "CUDA remains disabled until CPU/CUDA golden conformance is recorded for this model hash",
            )
    try:
        sys.path.insert(0, str(code_dir))
        import decord  # noqa: F401
        import safetensors.torch  # noqa: F401
        import torch
        import sam2  # noqa: F401
    except Exception as error:
        raise ProviderError("RUNTIME_DEPENDENCY_MISSING", f"SAM 2 runtime import failed: {error}") from error
    if device == "cuda" and not torch.cuda.is_available():
        raise ProviderError("CUDA_UNAVAILABLE", "PyTorch cannot access CUDA in this WSL2 runtime")
    conformance_key = f"OPENCUT_SAM21_{device.upper()}_CONFORMANCE"
    conformance_verified = os.environ.get(conformance_key) == MODEL_SHA256
    return {
        "status": "ready" if conformance_verified else "degraded",
        "canExecute": conformance_verified,
        "code": None if conformance_verified else "DETERMINISTIC_CONFORMANCE_REQUIRED",
        "reason": None if conformance_verified else (
            f"{device.upper()} repeated-run golden conformance is not recorded for the approved model hash"
        ),
        "providerProtocolVersion": PROTOCOL_VERSION,
        "model": model_identity(),
        "runtime": {
            "framework": "facebookresearch/sam2",
            "codeRevision": SAM2_CODE_REVISION,
            "device": device,
            "cpuFallback": True,
            "deterministic": True,
            "conformanceVerified": conformance_verified,
        },
    }


def model_identity() -> dict[str, str]:
    return {
        "id": MODEL_ID,
        "revision": MODEL_REVISION,
        "artifact": MODEL_ARTIFACT,
        "sha256": MODEL_SHA256,
        "codeRevision": SAM2_CODE_REVISION,
        "license": LICENSE,
    }


def require_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProviderError("INVALID_REQUEST", f"{label} must be an object")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ProviderError("INVALID_REQUEST", f"{label} must be an integer >= {minimum}")
    return value


def require_box(value: Any, label: str) -> dict[str, float]:
    box = require_record(value, label)
    result = {}
    for key in ("x", "y", "width", "height"):
        number = box.get(key)
        if not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(number):
            raise ProviderError("INVALID_REQUEST", f"{label}.{key} must be finite")
        result[key] = float(number)
    if (
        result["x"] < 0
        or result["y"] < 0
        or result["width"] <= 0
        or result["height"] <= 0
        or result["x"] + result["width"] > 1
        or result["y"] + result["height"] > 1
    ):
        raise ProviderError("INVALID_REQUEST", f"{label} must fit normalized source coordinates")
    return result


def validate_request(request: Any) -> dict[str, Any]:
    request = require_record(request, "request")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProviderError("UNSUPPORTED_PROTOCOL", "SAM provider requires protocolVersion 2")
    timebase = require_record(request.get("timebase"), "timebase")
    if timebase.get("ticksPerSecond") != TICKS_PER_SECOND:
        raise ProviderError("UNSUPPORTED_TIMEBASE", "SAM provider requires 120000 ticks per second")
    source = require_record(request.get("source"), "source")
    path = Path(str(source.get("path", ""))).resolve()
    if not path.is_file():
        raise ProviderError("SOURCE_NOT_FOUND", f"source video is missing: {path}")
    if sha256_file(path) != source.get("contentHash"):
        raise ProviderError("SOURCE_HASH_MISMATCH", "source bytes changed after request hashing")
    if source.get("mimeType") != "video/mp4" or path.suffix.lower() != ".mp4":
        raise ProviderError("UNSUPPORTED_SOURCE", "pinned SAM 2 runtime accepts MP4 video only")
    fps = source.get("fps")
    if not isinstance(fps, (int, float)) or isinstance(fps, bool) or not math.isfinite(fps) or fps <= 0:
        raise ProviderError("INVALID_REQUEST", "source.fps must be a positive finite number")
    duration = require_int(source.get("durationTicks"), "source.durationTicks", 1)
    coverage = require_record(request.get("coverage"), "coverage")
    start = require_int(coverage.get("startTicks"), "coverage.startTicks")
    end = require_int(coverage.get("endTicks"), "coverage.endTicks", 1)
    if end <= start or end > duration:
        raise ProviderError("INVALID_REQUEST", "coverage must be non-empty and within source duration")
    sampling = require_record(request.get("sampling"), "sampling")
    interval = require_int(sampling.get("intervalTicks"), "sampling.intervalTicks", 1)
    max_samples = require_int(sampling.get("maxSamples"), "sampling.maxSamples", 2)
    expected_count = ((end - start - 1) // interval) + 2
    if expected_count > max_samples:
        raise ProviderError("SAMPLE_LIMIT_EXCEEDED", "requested coverage exceeds maxSamples")
    subject = require_record(request.get("subject"), "subject")
    initial_box = subject.get("initialBox")
    if initial_box is None:
        raise ProviderError(
            "SPATIAL_PROMPT_REQUIRED",
            "SAM 2.1 does not ground text; subject.initialBox is required and prompt is retained only as a label",
        )
    subject["initialBox"] = require_box(initial_box, "subject.initialBox")
    corrections = subject.get("corrections", [])
    if not isinstance(corrections, list):
        raise ProviderError("INVALID_REQUEST", "subject.corrections must be an array")
    for index, correction in enumerate(corrections):
        correction = require_record(correction, f"subject.corrections[{index}]")
        correction["sourceTimeTicks"] = require_int(
            correction.get("sourceTimeTicks"), f"subject.corrections[{index}].sourceTimeTicks"
        )
        if not start <= correction["sourceTimeTicks"] <= end:
            raise ProviderError("INVALID_REQUEST", "correction lies outside requested coverage")
        correction["box"] = require_box(correction.get("box"), f"subject.corrections[{index}].box")
        if not isinstance(correction.get("correctionId"), str) or not correction["correctionId"]:
            raise ProviderError("INVALID_REQUEST", "correctionId is required")
        if not isinstance(correction.get("note"), str) or not correction["note"]:
            raise ProviderError("INVALID_REQUEST", "correction note is required")
    output_directory = Path(str(request.get("outputDirectory", ""))).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    requested_model = require_record(request.get("requestedModel"), "requestedModel")
    expected = {
        "id": MODEL_ID,
        "revision": MODEL_REVISION,
        "artifactSha256": MODEL_SHA256,
        "codeRevision": SAM2_CODE_REVISION,
    }
    for key, expected_value in expected.items():
        if requested_model.get(key) != expected_value:
            raise ProviderError("UNAPPROVED_MODEL", f"requestedModel.{key} is not the approved immutable value")
    return request


def inverse_huggingface_state_dict(state: dict[str, Any]) -> dict[str, Any]:
    """Invert Hugging Face's published SAM2 conversion into the pinned Meta keyspace."""
    result: dict[str, Any] = {}
    point_embed = state.pop("prompt_encoder.point_embed.weight", None)
    state.pop("shared_image_embedding.positional_embedding", None)
    for key, value in state.items():
        key = _inverse_special_layers(key)
        key = key.replace("vision_encoder.backbone.", "image_encoder.trunk.")
        key = key.replace("vision_encoder.neck.", "image_encoder.neck.")
        key = key.replace("patch_embed.projection", "patch_embed.proj")
        key = key.replace(".layer_norm", ".norm")
        key = key.replace(".o_proj", ".out_proj")
        key = key.replace("no_memory_embedding", "no_mem_embed")
        key = key.replace("no_memory_positional_encoding", "no_mem_pos_enc")
        key = key.replace("memory_temporal_positional_encoding", "maskmem_tpos_enc")
        key = key.replace("temporal_positional_encoding_projection_layer", "obj_ptr_tpos_proj")
        key = key.replace("occlusion_spatial_embedding_parameter", "no_obj_embed_spatial")
        key = key.replace("object_pointer", "obj_ptr")
        key = key.replace("feature_projection", "pix_feat_proj")
        key = key.replace("memory_fuser", "fuser")
        key = key.replace("depthwise_conv", "dwconv")
        key = key.replace("pointwise_conv", "pwconv")
        key = key.replace("prompt_encoder", "sam_prompt_encoder")
        key = key.replace("mask_decoder", "sam_mask_decoder")
        key = key.replace(".scale", ".gamma")
        result[key] = value
    if point_embed is None or point_embed.shape[0] != 4:
        raise ProviderError("INCOMPATIBLE_MODEL_FORMAT", "converted point embeddings are absent or malformed")
    for index in range(4):
        result[f"sam_prompt_encoder.point_embeddings.{index}.weight"] = point_embed[index : index + 1]
    return result


def _inverse_special_layers(key: str) -> str:
    replacements = (
        ("mask_decoder.upscale_conv1", "mask_decoder.output_upscaling.0"),
        ("mask_decoder.upscale_layer_norm", "mask_decoder.output_upscaling.1"),
        ("mask_decoder.upscale_conv2", "mask_decoder.output_upscaling.3"),
        ("mask_embed.conv1", "mask_downscaling.0"),
        ("mask_embed.layer_norm1", "mask_downscaling.1"),
        ("mask_embed.conv2", "mask_downscaling.3"),
        ("mask_embed.layer_norm2", "mask_downscaling.4"),
        ("mask_embed.conv3", "mask_downscaling.6"),
    )
    for converted, original in replacements:
        key = key.replace(converted, original)
    key = re.sub(r"^(mask_decoder\.iou_prediction_head)\.layers\.0\.", r"\1.layers.1.", key)
    key = re.sub(r"^(mask_decoder\.iou_prediction_head)\.proj_in\.", r"\1.layers.0.", key)
    key = re.sub(r"^(mask_decoder\.iou_prediction_head)\.proj_out\.", r"\1.layers.2.", key)
    key = re.sub(
        r"^(mask_decoder\.output_hypernetworks_mlps\.\d+)\.layers\.0\.",
        r"\1.layers.1.",
        key,
    )
    key = re.sub(
        r"^(mask_decoder\.output_hypernetworks_mlps\.\d+)\.proj_in\.",
        r"\1.layers.0.",
        key,
    )
    key = re.sub(
        r"^(mask_decoder\.output_hypernetworks_mlps\.\d+)\.proj_out\.",
        r"\1.layers.2.",
        key,
    )
    key = re.sub(r"^(mask_decoder\.transformer\.layers\.\d+\.mlp)\.proj_in\.", r"\1.layers.0.", key)
    key = re.sub(r"^(mask_decoder\.transformer\.layers\.\d+\.mlp)\.proj_out\.", r"\1.layers.1.", key)
    key = re.sub(r"^(mask_decoder\.pred_obj_score_head)\.layers\.0\.", r"\1.layers.1.", key)
    key = re.sub(r"^(mask_decoder\.pred_obj_score_head)\.proj_in\.", r"\1.layers.0.", key)
    key = re.sub(r"^(mask_decoder\.pred_obj_score_head)\.proj_out\.", r"\1.layers.2.", key)
    key = re.sub(r"^(vision_encoder\.backbone\.blocks\.\d+\.mlp)\.proj_in\.", r"\1.layers.0.", key)
    key = re.sub(r"^(vision_encoder\.backbone\.blocks\.\d+\.mlp)\.proj_out\.", r"\1.layers.1.", key)
    key = re.sub(r"^vision_encoder\.neck\.convs\.(\d+)\.(weight|bias)$", r"vision_encoder.neck.convs.\1.conv.\2", key)
    key = key.replace("memory_encoder.projection.", "memory_encoder.o_proj.")
    key = re.sub(r"^(object_pointer_proj)\.layers\.0\.", r"\1.layers.1.", key)
    key = re.sub(r"^(object_pointer_proj)\.proj_in\.", r"\1.layers.0.", key)
    key = re.sub(r"^(object_pointer_proj)\.proj_out\.", r"\1.layers.2.", key)
    key = re.sub(r"^memory_encoder\.mask_downsampler\.layers\.(\d+)\.conv\.", lambda m: f"memory_encoder.mask_downsampler.encoder.{int(m.group(1)) * 3}.", key)
    key = re.sub(r"^memory_encoder\.mask_downsampler\.layers\.(\d+)\.layer_norm\.", lambda m: f"memory_encoder.mask_downsampler.encoder.{int(m.group(1)) * 3 + 1}.", key)
    key = key.replace("memory_encoder.mask_downsampler.final_conv.", "memory_encoder.mask_downsampler.encoder.12.")
    key = key.replace(
        "prompt_encoder.shared_embedding.positional_embedding",
        "prompt_encoder.pe_layer.positional_encoding_gaussian_matrix",
    )
    return key


def load_predictor(model_path: Path, code_dir: Path, device: str):
    sys.path.insert(0, str(code_dir))
    import torch
    from safetensors.torch import load_file
    from sam2.build_sam import build_sam2_video_predictor

    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    if device == "cuda":
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    predictor = build_sam2_video_predictor(
        SAM2_CONFIG,
        ckpt_path=None,
        device=device,
        apply_postprocessing=False,
        vos_optimized=False,
    )
    state = inverse_huggingface_state_dict(dict(load_file(str(model_path), device="cpu")))
    missing, unexpected = predictor.load_state_dict(state, strict=False)
    if missing or unexpected:
        raise ProviderError(
            "INCOMPATIBLE_MODEL_FORMAT",
            f"approved safetensors cannot populate pinned SAM 2 exactly; missing={missing}, unexpected={unexpected}",
        )
    predictor.eval()
    return predictor


def box_pixels(box: dict[str, float], width: int, height: int):
    return [
        box["x"] * width,
        box["y"] * height,
        (box["x"] + box["width"]) * width,
        (box["y"] + box["height"]) * height,
    ]


def target_ticks(start: int, end: int, interval: int) -> list[int]:
    ticks = list(range(start, end, interval))
    if not ticks or ticks[-1] != end:
        ticks.append(end)
    return ticks


def mask_measurement(mask: Any) -> tuple[dict[str, float], float, str, bytes]:
    import torch

    logits = mask.detach().to("cpu", dtype=torch.float32).squeeze()
    binary = logits > 0
    height, width = binary.shape
    coordinates = torch.nonzero(binary, as_tuple=False)
    if coordinates.numel() == 0:
        return {"x": 0.0, "y": 0.0, "width": 1.0 / width, "height": 1.0 / height}, 0.0, "occluded", bytes((height * width + 7) // 8)
    y0, x0 = coordinates.min(dim=0).values.tolist()
    y1, x1 = coordinates.max(dim=0).values.tolist()
    area = int(binary.sum().item())
    box_area = (x1 - x0 + 1) * (y1 - y0 + 1)
    solidity = area / box_area
    confidence = float(torch.sigmoid(logits[binary]).mean().item())
    occlusion = "visible" if solidity >= 0.55 else "partial"
    packed = bytearray((height * width + 7) // 8)
    for index, enabled in enumerate(binary.flatten().tolist()):
        if enabled:
            packed[index // 8] |= 1 << (7 - (index % 8))
    return (
        {"x": x0 / width, "y": y0 / height, "width": (x1 - x0 + 1) / width, "height": (y1 - y0 + 1) / height},
        confidence,
        occlusion,
        bytes(packed),
    )


def write_mask_sequence(path: Path, width: int, height: int, frames: list[tuple[int, bytes]]) -> None:
    offset = 0
    entries = []
    payload = bytearray()
    for ticks, packed in frames:
        entries.append({"sourceTimeTicks": ticks, "offset": offset, "bytes": len(packed)})
        payload.extend(packed)
        offset += len(packed)
    header = json.dumps(
        {"schemaVersion": "opencut.binary-mask-sequence.v1", "width": width, "height": height, "frames": entries},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    with path.open("wb") as output:
        output.write(b"OCMASK01")
        output.write(struct.pack("<Q", len(header)))
        output.write(header)
        output.write(payload)


def run_inference(request: dict[str, Any], model_path: Path, code_dir: Path, device: str) -> dict[str, Any]:
    import torch

    source = request["source"]
    coverage = request["coverage"]
    subject = request["subject"]
    fps = float(source["fps"])
    width, height = int(source["width"]), int(source["height"])
    predictor = load_predictor(model_path, code_dir, device)
    state = predictor.init_state(
        str(Path(source["path"]).resolve()),
        offload_video_to_cpu=True,
        offload_state_to_cpu=device == "cpu",
    )
    start_frame = round(coverage["startTicks"] * fps / TICKS_PER_SECOND)
    predictor.add_new_points_or_box(
        state, frame_idx=start_frame, obj_id=1, box=box_pixels(subject["initialBox"], width, height)
    )
    for correction in subject.get("corrections", []):
        frame = round(correction["sourceTimeTicks"] * fps / TICKS_PER_SECOND)
        predictor.add_new_points_or_box(
            state, frame_idx=frame, obj_id=1, box=box_pixels(correction["box"], width, height)
        )
    produced: dict[int, Any] = {}
    end_frame = min(state["num_frames"] - 1, math.ceil(coverage["endTicks"] * fps / TICKS_PER_SECOND))
    with torch.inference_mode():
        for frame, object_ids, masks in predictor.propagate_in_video(
            state, start_frame_idx=start_frame, max_frame_num_to_track=end_frame - start_frame
        ):
            object_index = list(object_ids).index(1)
            produced[frame] = masks[object_index]
    wanted = target_ticks(coverage["startTicks"], coverage["endTicks"], request["sampling"]["intervalTicks"])
    samples, mask_frames = [], []
    for index, ticks in enumerate(wanted):
        frame = min(produced, key=lambda candidate: (abs(candidate * TICKS_PER_SECOND / fps - ticks), candidate))
        box, confidence, occlusion, packed = mask_measurement(produced[frame])
        samples.append({
            "sampleId": f"subject-1:{index:06d}",
            "sourceTimeTicks": ticks,
            "box": box,
            "confidence": confidence,
            "occlusion": occlusion,
        })
        mask_frames.append((ticks, packed))
    output_path = Path(request["outputDirectory"]) / "subject-1.ocmask"
    write_mask_sequence(output_path, width, height, mask_frames)
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "status": "completed",
        "coordinateSpace": "normalized-source",
        "coverage": coverage,
        "subjects": [{
            "subjectId": "subject-1",
            **({"label": subject["prompt"]} if subject.get("prompt") else {}),
            "samples": samples,
            "corrections": subject.get("corrections", []),
        }],
        "artifacts": [{
            "artifactId": "subject-1-mask",
            "kind": "binary-mask-sequence",
            "path": output_path.name,
            "contentSha256": sha256_file(output_path),
            "bytes": output_path.stat().st_size,
        }],
        "model": model_identity(),
        "runtime": {"device": device, "framework": "facebookresearch/sam2", "deterministic": True},
        "warnings": [
            "confidence is mean sigmoid mask probability, not a calibrated object-detection score",
            "occlusion is a deterministic empty-mask/solidity classification",
        ],
    }


def unavailable(error: ProviderError) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "canExecute": False,
        "code": error.code,
        "reason": str(error),
        "providerProtocolVersion": PROTOCOL_VERSION,
        "model": model_identity(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--probe-json", action="store_true")
    parser.add_argument("--model-path", type=Path)
    parser.add_argument("--sam2-code-dir", type=Path)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.version:
        print(VERSION)
        return 0
    if args.model_path is None or args.sam2_code_dir is None:
        parser.error("--model-path and --sam2-code-dir are required")
    try:
        readiness = verify_install(args.model_path.resolve(), args.sam2_code_dir.resolve(), args.device)
        if args.probe_json:
            print(json.dumps(readiness, sort_keys=True, separators=(",", ":")))
            return 0
        request = validate_request(json.load(sys.stdin))
        response = run_inference(request, args.model_path.resolve(), args.sam2_code_dir.resolve(), args.device)
        print(json.dumps(response, sort_keys=True, separators=(",", ":")))
        return 0
    except ProviderError as error:
        if args.probe_json:
            print(json.dumps(unavailable(error), sort_keys=True, separators=(",", ":")))
            return 0
        print(f"{error.code}: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        if args.probe_json:
            wrapped = ProviderError("PROBE_FAILED", f"{type(error).__name__}: {error}")
            print(json.dumps(unavailable(wrapped), sort_keys=True, separators=(",", ":")))
            return 0
        print(f"PROVIDER_FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
