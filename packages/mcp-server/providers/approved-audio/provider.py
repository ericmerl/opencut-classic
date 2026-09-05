#!/usr/bin/env python3
"""Offline pinned providers for OpenCut's approved audio protocol v1."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import struct
import sys
import wave

import numpy as np


PROTOCOL = "opencut.approved-audio-provider.v1"
METRICGAN = {
    "id": "speechbrain/metricgan-plus-voicebank",
    "revision": "a196ce26b3bdace6fa1d819017584bdbcce462a8",
    "artifactSha256": "147bfb866bac8264603546e035bf283370e716ed2f4b7412d308d2bcee88304f",
}
METRICGAN_RUNTIME = {
    "id": "speechbrain/speechbrain",
    "version": "1.1.1",
    "revision": "89ead74d163463d30c62329a09cfdb4c54f5abc1",
}
OPEN_UNMIX = {
    "id": "sigsep/open-unmix-umxhq-vocals",
    "revision": "1.0.1",
    "artifactSha256": "b62c91cedbc7a066f1778ead5b5cecb377aa3a46a31af1cce7c5c8769339d083",
}
OPEN_UNMIX_RUNTIME = {
    "id": "sigsep/open-unmix-pytorch",
    "version": "1.3.0",
    "revision": "814f144e34b2d1ed517eb605ce928dcb838abbed",
}
SILERO = {
    "id": "silero-vad",
    "revision": "7e30209a3e901f9842f81b225f3e93d8199902b1",
    "artifactSha256": "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, expected_sha256: str, label: str) -> Path:
    if not path.is_file():
        raise RuntimeError(f"{label} is missing: {path}")
    actual = sha256(path)
    if actual != expected_sha256:
        raise RuntimeError(
            f"{label} SHA-256 mismatch: expected {expected_sha256}, got {actual}"
        )
    return path


def require_source(request: dict) -> tuple[Path, np.ndarray, int]:
    source = request.get("source")
    if not isinstance(source, dict):
        raise ValueError("source must be an object")
    path = Path(str(source.get("path", ""))).resolve(strict=True)
    expected = str(source.get("contentSha256", ""))
    if len(expected) != 64 or sha256(path) != expected:
        raise RuntimeError("source SHA-256 does not match the request")
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        rate = wav.getframerate()
        width = wav.getsampwidth()
        frames = wav.getnframes()
        compression = wav.getcomptype()
        payload = wav.readframes(frames)
    if width != 2 or compression != "NONE":
        raise ValueError("source must be uncompressed 16-bit PCM WAV")
    audio = np.frombuffer(payload, dtype="<i2").astype(np.float32)
    audio = (audio.reshape(frames, channels) / 32768.0).copy()
    return path, audio, rate


def atomic_float_wave(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    """Write IEEE float32 WAV with an atomic final rename."""
    if audio.ndim == 1:
        audio = audio[:, None]
    samples, channels = audio.shape
    payload = np.asarray(audio, dtype="<f4").tobytes(order="C")
    fmt = struct.pack("<HHIIHH", 3, channels, sample_rate,
                      sample_rate * channels * 4, channels * 4, 32)
    riff_size = 4 + (8 + len(fmt)) + (8 + len(payload))
    content = (
        b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
        + b"fmt " + struct.pack("<I", len(fmt)) + fmt
        + b"data" + struct.pack("<I", len(payload)) + payload
    )
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def artifact(path: Path, role: str, rate: int, audio: np.ndarray) -> dict:
    channels = 1 if audio.ndim == 1 else int(audio.shape[1])
    return {
        "path": str(path),
        "role": role,
        "sampleRate": rate,
        "channels": channels,
        "sampleCount": int(audio.shape[0]),
    }


def require_cpu(request: dict) -> None:
    if request.get("devicePolicy") != {"kind": "cpu", "canonical": True}:
        raise ValueError("only the canonical CPU device policy is currently approved")


def cleanup(request: dict, source_path: Path, audio: np.ndarray, rate: int) -> dict:
    if rate != 16000 or audio.shape[1] != 1:
        raise ValueError("MetricGAN+ VoiceBank requires 16 kHz mono speech")
    model_dir = Path(os.environ["OPENCUT_METRICGAN_MODEL_DIRECTORY"]).resolve()
    require_file(model_dir / "enhance_model.ckpt", METRICGAN["artifactSha256"],
                 "MetricGAN+ checkpoint")
    if importlib.metadata.version("speechbrain") != METRICGAN_RUNTIME["version"]:
        raise RuntimeError("SpeechBrain runtime is not the approved 1.1.1 version")
    import torch
    from speechbrain.inference.enhancement import SpectralMaskEnhancement

    enhancer = SpectralMaskEnhancement.from_hparams(
        source=str(model_dir), savedir=str(model_dir), run_opts={"device": "cpu"}
    )
    waveform = torch.from_numpy(audio[:, 0]).unsqueeze(0)
    with torch.inference_mode():
        enhanced = enhancer.enhance_batch(waveform, lengths=torch.ones(1))
    cleaned = enhanced.detach().cpu().numpy().reshape(-1).astype(np.float32)
    if cleaned.shape[0] < audio.shape[0]:
        cleaned = np.pad(cleaned, (0, audio.shape[0] - cleaned.shape[0]))
    cleaned = cleaned[: audio.shape[0], None]
    output = Path(request["outputDirectory"]).resolve() / "metricgan-cleaned.wav"
    atomic_float_wave(output, cleaned, rate)
    return {
        "task": "audio-cleanup",
        "model": METRICGAN,
        "runtime": METRICGAN_RUNTIME,
        "device": {"kind": "cpu", "runtime": "torch", "canonical": True},
        "artifacts": {
            "original": artifact(source_path, "before", rate, audio),
            "cleaned": artifact(output, "after", rate, cleaned),
        },
        "warnings": [
            "MetricGAN+ VoiceBank is approved only for 16 kHz mono speech; no general-audio claim is made."
        ],
    }


def separate(request: dict, _source_path: Path, audio: np.ndarray, rate: int) -> dict:
    if rate != 44100 or audio.shape[1] != 2:
        raise ValueError("Open-Unmix UMX-HQ requires 44.1 kHz stereo audio")
    model_path = require_file(
        Path(os.environ["OPENCUT_OPEN_UNMIX_MODEL_PATH"]).resolve(),
        OPEN_UNMIX["artifactSha256"], "Open-Unmix vocals checkpoint"
    )
    if importlib.metadata.version("openunmix") != OPEN_UNMIX_RUNTIME["version"]:
        raise RuntimeError("Open-Unmix runtime is not the approved 1.3.0 version")
    import torch
    from openunmix import predict

    waveform = torch.from_numpy(audio.T.copy())
    with torch.inference_mode():
        estimates = predict.separate(
            waveform,
            rate=rate,
            model_str_or_path=str(model_path),
            targets=["vocals"],
            residual=False,
            device="cpu",
        )
    vocals_tensor = estimates["vocals"]
    while vocals_tensor.ndim > 2:
        vocals_tensor = vocals_tensor[0]
    vocals = vocals_tensor.detach().cpu().numpy().T.astype(np.float32)
    if vocals.shape[0] < audio.shape[0]:
        vocals = np.pad(vocals, ((0, audio.shape[0] - vocals.shape[0]), (0, 0)))
    vocals = vocals[: audio.shape[0], : audio.shape[1]]
    accompaniment = np.subtract(audio, vocals, dtype=np.float32)
    root = Path(request["outputDirectory"]).resolve()
    vocals_path = root / "umxhq-vocals.wav"
    accompaniment_path = root / "umxhq-accompaniment-residual.wav"
    atomic_float_wave(vocals_path, vocals, rate)
    atomic_float_wave(accompaniment_path, accompaniment, rate)
    return {
        "task": "stem-separation",
        "model": OPEN_UNMIX,
        "runtime": OPEN_UNMIX_RUNTIME,
        "device": {"kind": "cpu", "runtime": "torch", "canonical": True},
        "residualPolicy": "sample-wise-source-minus-vocals-f32-v1",
        "artifacts": {
            "vocals": artifact(vocals_path, "vocals", rate, vocals),
            "accompaniment": artifact(
                accompaniment_path, "accompaniment-residual", rate, accompaniment
            ),
        },
        "warnings": [],
    }


def merge_padded_ranges(ranges: list[dict], samples: int, padding: int) -> list[dict]:
    merged: list[dict] = []
    for candidate in ranges:
        item = {
            "startSample": max(0, candidate["startSample"] - padding),
            "endSampleExclusive": min(samples, candidate["endSampleExclusive"] + padding),
            "confidence": candidate["confidence"],
        }
        if merged and item["startSample"] <= merged[-1]["endSampleExclusive"]:
            merged[-1]["endSampleExclusive"] = max(
                merged[-1]["endSampleExclusive"], item["endSampleExclusive"]
            )
            merged[-1]["confidence"] = max(
                merged[-1]["confidence"], item["confidence"]
            )
        else:
            merged.append(item)
    return merged


def vad(request: dict, _source_path: Path, audio: np.ndarray, rate: int) -> dict:
    if rate != 16000 or audio.shape[1] != 1:
        raise ValueError("Silero VAD requires 16 kHz mono audio")
    model_path = require_file(
        Path(os.environ["OPENCUT_SILERO_VAD_MODEL_PATH"]).resolve(),
        SILERO["artifactSha256"], "Silero VAD ONNX model"
    )
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )
    if session.get_providers()[0] != "CPUExecutionProvider":
        raise RuntimeError("Silero canonical CPUExecutionProvider is unavailable")
    task_options = request.get("options", {})
    threshold = float(task_options.get("threshold", 0.5))
    minimum = int(task_options.get("minimumSpeechSamples", 1))
    padding = int(task_options.get("paddingSamples", 0))
    if not 0 <= threshold <= 1 or minimum <= 0 or padding < 0:
        raise ValueError("invalid VAD threshold/minimum/padding options")
    signal = audio[:, 0]
    state = np.zeros((2, 1, 128), dtype=np.float32)
    sample_rate = np.asarray(16000, dtype=np.int64)
    windows: list[tuple[int, int, float]] = []
    for start in range(0, signal.shape[0], 512):
        end = min(signal.shape[0], start + 512)
        chunk = np.zeros((1, 512), dtype=np.float32)
        chunk[0, : end - start] = signal[start:end]
        outputs = session.run(None, {"input": chunk, "state": state, "sr": sample_rate})
        probability = float(np.asarray(outputs[0]).reshape(-1)[0])
        state = np.asarray(outputs[1], dtype=np.float32)
        windows.append((start, end, probability))
    raw: list[dict] = []
    active_start: int | None = None
    active_confidence = 0.0
    for start, end, probability in windows:
        if probability >= threshold:
            if active_start is None:
                active_start = start
            active_confidence = max(active_confidence, probability)
        elif active_start is not None:
            if start - active_start >= minimum:
                raw.append({"startSample": active_start, "endSampleExclusive": start,
                            "confidence": active_confidence})
            active_start = None
            active_confidence = 0.0
    if active_start is not None and signal.shape[0] - active_start >= minimum:
        raw.append({"startSample": active_start,
                    "endSampleExclusive": int(signal.shape[0]),
                    "confidence": active_confidence})
    ranges = merge_padded_ranges(raw, int(signal.shape[0]), padding)
    return {
        "task": "voice-activity-detection",
        "model": SILERO,
        "runtime": {"id": "onnxruntime", "version": importlib.metadata.version("onnxruntime")},
        "device": {
            "kind": "cpu", "runtime": "onnxruntime", "canonical": True,
            "executionProvider": "CPUExecutionProvider",
            "intraOpThreads": 1, "interOpThreads": 1,
        },
        "sampleRate": rate,
        "sampleCount": int(signal.shape[0]),
        "ranges": ranges,
        "warnings": [],
    }


def main() -> None:
    request = json.load(sys.stdin)
    if request.get("protocol") != PROTOCOL:
        raise ValueError("unsupported protocol")
    require_cpu(request)
    output = Path(str(request.get("outputDirectory", ""))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_path, audio, rate = require_source(request)
    task = request.get("task")
    if task == "audio-cleanup":
        result = cleanup(request, source_path, audio, rate)
    elif task == "stem-separation":
        result = separate(request, source_path, audio, rate)
    elif task == "voice-activity-detection":
        result = vad(request, source_path, audio, rate)
    else:
        raise ValueError("unsupported task")
    print(json.dumps({"protocol": PROTOCOL, "status": "completed", **result}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # provider failures belong on stderr
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
