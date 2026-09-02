# Subject tracker provider protocol

`opencut_track_subject` launches the command configured by
`OPENCUT_SUBJECT_TRACKER_COMMAND`, appends the JSON-array arguments from
`OPENCUT_SUBJECT_TRACKER_ARGS`, writes one request to stdin, and reads one JSON
response from stdout. Diagnostics belong on stderr.

The provider receives the absolute path of an isolated local copy of the source
video. It must not modify that file. All times use the declared canonical
timebase of 120,000 ticks per second. Bounding boxes use normalized source-frame
coordinates with the origin at the top left.

## Request

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

## Response

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

Samples must be strictly increasing by `sourceTime`, remain within the source
duration, and contain a normalized box entirely inside the source frame.
Confidence is optional and, when present, ranges from zero through one. The MCP
service filters samples below `minConfidence`, maps source time through clip trim
and retime, applies exponential smoothing, extends the first and last accepted
positions to the clip edges, and creates stable reframe keyframes atomically.
