# Approved local audio provider protocol v1

`opencut.approved-audio-provider.v1` is the pinned, offline command protocol for issue #29. The command reads one JSON request on stdin, writes one JSON response on stdout, and writes diagnostics only to stderr. OpenCut kills the process to cancel a running job; providers publish output through a temporary file and atomic rename so cancellation never exposes a partial final artifact.

The production command is configured with `OPENCUT_APPROVED_AUDIO_PROVIDER_COMMAND` and optional JSON-array `OPENCUT_APPROVED_AUDIO_PROVIDER_ARGS`. It takes precedence over the legacy unpinned `OPENCUT_AUDIO_CLEANER_COMMAND` for cleanup.

## Request

```json
{
  "protocol": "opencut.approved-audio-provider.v1",
  "operationId": "job-1",
  "task": "audio-cleanup",
  "source": { "path": "C:\\job\\source.wav", "contentSha256": "..." },
  "outputDirectory": "C:\\job\\output",
  "devicePolicy": { "kind": "cpu", "canonical": true },
  "options": {}
}
```

Tasks are `audio-cleanup`, `stem-separation`, and `voice-activity-detection`. Canonical cleanup accepts only 16 kHz mono PCM WAV speech; MetricGAN+ VoiceBank is not represented as a general-purpose music or 48 kHz restoration model. Canonical UMX-HQ accepts 44.1 kHz stereo PCM WAV. Canonical Silero VAD accepts 16 kHz mono PCM WAV and uses ONNX Runtime `CPUExecutionProvider` with one intra-op and one inter-op thread.

The provider validates the source content hash and the exact approved model artifact hash before inference. Model locations are explicit: `OPENCUT_METRICGAN_MODEL_DIRECTORY`, `OPENCUT_OPEN_UNMIX_MODEL_PATH`, and `OPENCUT_SILERO_VAD_MODEL_PATH`. No network download or revision resolution occurs during execution.

## Results

All results repeat the exact model identity, immutable revision, artifact SHA-256, runtime identity, and canonical device policy. Cleanup returns linked `before` and `after` artifacts. Separation returns sample-aligned `vocals` plus `accompaniment-residual`; accompaniment is deterministically computed as source minus vocals. VAD returns ordered, non-overlapping `[startSample,endSampleExclusive)` source-sample ranges with confidence.

OpenCut independently parses every WAV, verifies declared format and exact sample count, hashes final files, rejects paths outside the isolated output directory, and rejects any model/runtime identity other than the owner-approved pins.
