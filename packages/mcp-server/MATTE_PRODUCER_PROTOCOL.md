# OpenCut matte producer protocol

## Purpose

OpenCut delegates model inference to a user-configured command. This keeps the editor and MCP bridge independent of model runtimes, hardware, remote APIs, and model licenses.

The MCP server launches the command from `OPENCUT_MATTE_PRODUCER_COMMAND`, appends the JSON-array arguments in `OPENCUT_MATTE_PRODUCER_ARGS`, writes one protocol request to stdin, and reads one protocol response from stdout. Provider logs belong on stderr.

The command runs with its working directory set to the isolated output directory. OpenCut removes the complete job directory after the generated artifact has been imported.

## Version 1 request

```json
{
	"protocolVersion": 1,
	"operationId": "caller-selected-id",
	"source": {
		"path": "C:\\temporary-job\\source-video.mp4",
		"name": "source-video.mp4",
		"mimeType": "video/mp4",
		"contentHash": "sha256-of-source-bytes",
		"sourceFingerprint": "opencut-import-fingerprint-or-null",
		"width": 1080,
		"height": 1920,
		"duration": 12.5,
		"fps": 30
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

The provider must read from `source.path`. It may run inference locally or call a remote service. A remote provider is responsible for authentication, upload security, polling, download validation, cancellation, billing, and data-retention policy.

## Version 1 response

```json
{
	"protocolVersion": 1,
	"status": "completed",
	"artifact": {
		"path": "matte.webm",
		"channel": "red"
	},
	"model": {
		"id": "actual-model-id",
		"version": "actual-model-or-weights-version"
	},
	"warnings": []
}
```

`artifact.path` may be relative to the supplied output directory or absolute, but the resolved file must remain inside that directory. It must identify a non-empty image or browser-decodable video. Use `red` for an opaque grayscale artifact and `alpha` for an RGBA artifact.

The returned model identity is persisted on the clip matte attachment. It must describe the model and weights that actually produced the artifact, even when they differ from the requested model.

## Timing and dimensions

Video matte artifacts must cover the complete source-media duration and use the source aspect ratio. Generate in source time, not timeline time. OpenCut handles clip trims, splits, and constant retiming when it reads the matte.

OpenCut verifies the artifact again during import. A provider should preserve fractional opacity values, exact frame timing, output dimensions, and deterministic results for the same source hash, model version, and options.

## Failures and timeouts

A successful provider exits with code 0 and returns the response above. For a failure, exit nonzero and write a concise diagnostic to stderr. OpenCut terminates the command when the tool's `timeoutSeconds` value expires.

The MCP tool operation ID is idempotent for the life of the MCP process. Reusing it with different arguments is rejected. A successful retry with identical arguments returns `replayed` without rerunning inference.

## Integration fixture

[`examples/synthetic-matte-provider.ts`](./examples/synthetic-matte-provider.ts) implements the protocol with FFmpeg and generates a centered rectangular matte. It is only an integration fixture, not a segmentation model. Configure it with Bun to verify a complete installation:

```powershell
$env:OPENCUT_MATTE_PRODUCER_COMMAND = "C:\Users\you\.bun\bin\bun.exe"
$env:OPENCUT_MATTE_PRODUCER_ARGS = '["C:\path\to\opencut\packages\mcp-server\examples\synthetic-matte-provider.ts"]'
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
```
