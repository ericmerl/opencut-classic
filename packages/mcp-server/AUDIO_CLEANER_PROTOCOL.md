# OpenCut audio cleaner protocol

## Purpose

OpenCut delegates audio restoration to a user-configured command. This keeps the editor and MCP bridge independent of model runtimes, hardware, remote APIs, and model licenses.

The MCP server launches the command from `OPENCUT_AUDIO_CLEANER_COMMAND`, appends the JSON-array arguments in `OPENCUT_AUDIO_CLEANER_ARGS`, writes one protocol request to stdin, and reads one protocol response from stdout. Provider logs belong on stderr.

The command runs with its working directory set to the isolated output directory. OpenCut removes the complete job directory after the cleaned artifact has been imported.

## Version 1 request

```json
{
	"protocolVersion": 1,
	"operationId": "clean-dialogue-1",
	"timebase": { "ticksPerSecond": 120000 },
	"source": {
		"path": "C:\\temporary-job\\source-audio.wav",
		"name": "source-audio.wav",
		"mimeType": "audio/wav",
		"contentHash": "sha256-of-source-bytes",
		"sourceFingerprint": "opencut-import-fingerprint-or-null",
		"durationSeconds": 12.5
	},
	"clip": {
		"startTime": 120000,
		"duration": 600000,
		"trimStart": 24000,
		"trimEnd": 0,
		"retimeRate": 1,
		"maintainPitch": true
	},
	"cleanup": {
		"noiseReduction": 0.5,
		"deReverb": 0,
		"deEss": 0,
		"highPassHz": 80,
		"normalize": false
	},
	"outputDirectory": "C:\\temporary-job\\output",
	"requestedModel": {
		"id": "optional-model-id",
		"version": "optional-model-version"
	},
	"options": {
		"provider-specific-key": "provider-specific-value"
	}
}
```

The provider must read from `source.path`. It may run restoration locally or call a remote service. A remote provider is responsible for authentication, upload security, polling, download validation, cancellation, billing, and data-retention policy.

The provider must clean the complete source file. The `clip` object is context only. OpenCut keeps trim, retime, mute, gain, fades, ducking, and volume keyframes on the existing timeline element and substitutes the cleaned source during audio decoding.

## Version 1 response

```json
{
	"protocolVersion": 1,
	"status": "completed",
	"artifact": {
		"path": "cleaned.wav"
	},
	"model": {
		"id": "actual-model-id",
		"version": "actual-model-or-weights-version"
	},
	"warnings": []
}
```

`artifact.path` may be relative to the supplied output directory or absolute, but the resolved file must remain inside that directory. It must identify a non-empty browser-decodable audio file. The cleaned artifact must cover the complete original source duration. OpenCut validates the file again during import and rejects artifacts that are shorter by more than 50 milliseconds.

The returned model identity is persisted on the clip attachment. It must describe the model and weights that actually produced the artifact, even when they differ from the requested model.

## Control interpretation

`noiseReduction`, `deReverb`, and `deEss` range from zero through one. Zero disables that stage. One requests the provider's strongest supported processing. `highPassHz` ranges from zero through 300, with zero disabling the filter. `normalize` asks the provider to normalize the cleaned source before it is reattached. Providers should document the exact algorithms and output target represented by these normalized controls.

Provider-specific options may add controls but must not silently reinterpret the five standard controls.

## Failures and timeouts

A successful provider exits with code 0 and returns the response above. For a failure, exit nonzero and write a concise diagnostic to stderr. OpenCut terminates the command when the tool's `timeoutSeconds` value expires.

The MCP tool operation ID is idempotent for the life of the MCP process. Reusing it with different arguments is rejected. A successful retry with identical arguments returns `replayed` without rerunning restoration.
