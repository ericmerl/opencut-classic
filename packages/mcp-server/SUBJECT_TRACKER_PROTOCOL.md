# Subject tracker provider protocol

Production subject tracking uses protocol v2 and the immutable Stack A provider:

- `facebook/sam2.1-hiera-small` at revision
  `ee5bba1d82bb8749febdf90f45e84b687142ba03`;
- `model.safetensors` SHA-256
  `0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60`;
- `facebookresearch/sam2` code at
  `2b90b9f5ceec907a1c18123530e92e794ad901a4`;
- Apache-2.0 code and weights.

The provider fails closed if any identity differs. CPU is canonical. CUDA is
allowed only through WSL2/Ubuntu after a CPU/CUDA golden-conformance record for
the exact model hash. `packages/mcp-server/providers/sam21_hiera_small.py`
verifies the model bytes and code checkout before importing the ML runtime.

`opencut_track_subject` launches the command configured by
`OPENCUT_SUBJECT_TRACKER_COMMAND`, appends the JSON-array arguments from
`OPENCUT_SUBJECT_TRACKER_ARGS`, writes one request to stdin, and reads one JSON
response from stdout. Diagnostics belong on stderr.

The provider receives the absolute path of an isolated local copy of the source
video. It must not modify that file. All times use the declared canonical
timebase of 120,000 ticks per second. Bounding boxes use normalized source-frame
coordinates with the origin at the top left.

## Production request (v2)

V2 adds an exact source coverage, a durable output directory, correction boxes,
and complete immutable model identity to the v1 envelope. `subject.initialBox`
is required: SAM 2 is spatially prompted and does not ground a text prompt. The
optional text is retained only as the subject label.

```json
{
	"protocolVersion": 2,
	"operationId": "track-presenter-1",
	"timebase": { "ticksPerSecond": 120000 },
	"source": {
		"path": "C:\\Temp\\opencut-track-job\\source-video.mp4",
		"name": "video.mp4",
		"mimeType": "video/mp4",
		"contentHash": "sha256",
		"sourceFingerprint": "fingerprint",
		"width": 1920,
		"height": 1080,
		"durationTicks": 1200000,
		"fps": 30
	},
	"clip": { "trimStart": 0, "trimEnd": 0, "duration": 1200000, "retimeRate": 1 },
	"coverage": { "startTicks": 0, "endTicks": 1200000 },
	"sampling": { "intervalTicks": 12000, "maxSamples": 2000 },
	"subject": {
		"prompt": "primary presenter",
		"initialBox": { "x": 0.2, "y": 0.1, "width": 0.3, "height": 0.8 },
		"corrections": [{
			"correctionId": "presenter-correction-1",
			"sourceTimeTicks": 600000,
			"box": { "x": 0.25, "y": 0.1, "width": 0.3, "height": 0.8 },
			"note": "reacquire after occlusion"
		}]
	},
	"requestedModel": {
		"id": "facebook/sam2.1-hiera-small",
		"revision": "ee5bba1d82bb8749febdf90f45e84b687142ba03",
		"artifactSha256": "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
		"codeRevision": "2b90b9f5ceec907a1c18123530e92e794ad901a4"
	},
	"outputDirectory": "C:\\OpenCut\\provider-results\\track-presenter-1",
	"options": {}
}
```

## Production response (v2)

```json
{
	"protocolVersion": 2,
	"status": "completed",
	"coordinateSpace": "normalized-source",
	"coverage": { "startTicks": 0, "endTicks": 1200000 },
	"subjects": [{
		"subjectId": "subject-1",
		"label": "primary presenter",
		"samples": [{
			"sampleId": "subject-1:000000",
			"sourceTimeTicks": 0,
			"box": { "x": 0.2, "y": 0.1, "width": 0.3, "height": 0.8 },
			"confidence": 0.98,
			"occlusion": "visible"
		}],
		"corrections": []
	}],
	"artifacts": [{
		"artifactId": "subject-1-mask",
		"kind": "binary-mask-sequence",
		"path": "subject-1.ocmask",
		"contentSha256": "sha256",
		"bytes": 1234
	}],
	"model": {
		"id": "facebook/sam2.1-hiera-small",
		"revision": "ee5bba1d82bb8749febdf90f45e84b687142ba03",
		"artifact": "model.safetensors",
		"sha256": "0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60",
		"codeRevision": "2b90b9f5ceec907a1c18123530e92e794ad901a4",
		"license": "Apache-2.0"
	},
	"runtime": { "device": "cpu", "framework": "facebookresearch/sam2", "deterministic": true },
	"warnings": []
}
```

The `.ocmask` artifact is an `OCMASK01` deterministic binary mask sequence:
8-byte magic, little-endian unsigned 64-bit canonical-JSON header length,
canonical JSON frame index, then uncompressed row-major packed mask bits. The
adapter verifies containment, byte length, and SHA-256 before accepting it.

Every subject must contain unique, strictly increasing samples at the exact
first and last coverage ticks. Boxes are normalized source coordinates.
Confidence is the mean sigmoid probability across positive mask pixels (not a
calibrated detector score). Occlusion is a deterministic empty-mask/shape
solidity classification. Corrections remain inspectable in the response.

## Legacy request (v1)

```json
{
	"protocolVersion": 1,
	"operationId": "track-presenter-1",
	"timebase": { "ticksPerSecond": 120000 },
	"source": {
		"path": "C:\\Temp\\opencut-track-job\\source-video.mp4",
		"name": "video.mp4",
		"mimeType": "video/mp4",
		"contentHash": "sha256",
		"sourceFingerprint": "fingerprint",
		"width": 1920,
		"height": 1080,
		"durationTicks": 1200000,
		"fps": 30
	},
	"clip": {
		"trimStart": 120000,
		"trimEnd": 0,
		"duration": 540000,
		"retimeRate": 2
	},
	"sampling": {
		"intervalTicks": 12000,
		"maxSamples": 2000
	},
	"subject": {
		"prompt": "primary presenter",
		"initialBox": { "x": 0.2, "y": 0.1, "width": 0.3, "height": 0.8 }
	},
	"requestedModel": { "id": "tracker", "version": "1" },
	"options": {}
}
```

`subject`, `requestedModel`, `source.fps`, and
`source.sourceFingerprint` may be absent or null as indicated by their values.
The provider should sample the complete source timeline so the same result is
valid for trimmed and retimed clip instances.

## Legacy response (v1)

```json
{
	"protocolVersion": 1,
	"status": "completed",
	"coordinateSpace": "normalized-source",
	"samples": [
		{
			"sourceTime": 0,
			"box": { "x": 0.2, "y": 0.1, "width": 0.3, "height": 0.8 },
			"confidence": 0.98
		}
	],
	"model": { "id": "tracker", "version": "1" },
	"warnings": []
}
```

V1 remains parseable only for explicitly v1 jobs and cannot satisfy the
production SAM contract. Samples must be strictly increasing by `sourceTime`, remain within the source
duration, and contain a normalized box entirely inside the source frame.
Confidence is optional and, when present, ranges from zero through one. The MCP
service filters samples below `minConfidence`, maps source time through clip trim
and retime, applies exponential smoothing, extends the first and last accepted
positions to the clip edges, and creates stable reframe keyframes atomically.
