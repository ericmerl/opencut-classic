# OpenCut MCP server

This local sidecar exposes OpenCut Classic tools over MCP stdio and relays calls to one authenticated browser editor over a loopback-only WebSocket.

Set the same token in the MCP process and the OpenCut web build. Use at least 32 random characters and do not commit it.

```powershell
$env:OPENCUT_BRIDGE_TOKEN = "replace-with-a-random-secret-of-at-least-32-characters"
$env:NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN = $env:OPENCUT_BRIDGE_TOKEN
bun run mcp
```

The bridge defaults to `127.0.0.1:32191`. Override both sides with `OPENCUT_BRIDGE_PORT` and `NEXT_PUBLIC_OPENCUT_BRIDGE_PORT`.

The repository's complete unattended test command is `bun test` from the
repository root. It includes the MCP server suite, isolated web suites, and
`cargo test`. To include the real-video MCP milestone, first start the web editor
(the only manual step), then configure `OPENCUT_HEADLESS_INTEGRATION_URL`,
`OPENCUT_HEADLESS_BROWSER_PATH`, and ffmpeg/ffprobe as described below. The test
command preflights the editor URL and tools before launching the milestone.

For local development, the MCP process also accepts the matching `NEXT_PUBLIC_` token and port variables as fallbacks, so one ignored environment file can configure both processes.

Background removal is intentionally staged separately. See [BACKGROUND_REMOVAL_SCOPE.md](./BACKGROUND_REMOVAL_SCOPE.md) for the model-independent matte foundation, browser prototype boundary, production inference requirements, and acceptance criteria.

`opencut_generate_matte` uses an external command provider so OpenCut does not bundle or license a particular segmentation model. Configure the provider executable and optional arguments before starting the MCP server:

```powershell
$env:OPENCUT_MATTE_PRODUCER_COMMAND = "C:\path\to\python.exe"
$env:OPENCUT_MATTE_PRODUCER_ARGS = '["C:\path\to\provider.py"]'
```

The provider receives one JSON request on stdin and must return one JSON response on stdout. Write diagnostics to stderr. See [MATTE_PRODUCER_PROTOCOL.md](./MATTE_PRODUCER_PROTOCOL.md) for the versioned contract.

`opencut_clean_audio` uses the same isolated-command model for restoration. Configure its provider before starting the MCP server:

```powershell
$env:OPENCUT_AUDIO_CLEANER_COMMAND = "C:\path\to\python.exe"
$env:OPENCUT_AUDIO_CLEANER_ARGS = '["C:\path\to\audio-cleaner.py"]'
```

See [AUDIO_CLEANER_PROTOCOL.md](./AUDIO_CLEANER_PROTOCOL.md) for the complete request and response contract.

Validated export requires FFmpeg and FFprobe. Put both executables on `PATH`, or configure their absolute paths. Durable receipts default to the operating system's per-user application-state directory and can be relocated explicitly:

```powershell
$env:OPENCUT_FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
$env:OPENCUT_FFPROBE_PATH = "C:\path\to\ffprobe.exe"
$env:OPENCUT_RECEIPT_DIR = "C:\path\to\private-opencut-receipts"
```

To let MCP launch its own hidden editor worker, run this fork's OpenCut web app locally and configure its URL. Chrome or Edge is discovered automatically; the executable and persistent automation profile can also be selected explicitly:

```powershell
$env:OPENCUT_HEADLESS_EDITOR_URL = "http://127.0.0.1:3000"
$env:OPENCUT_HEADLESS_BROWSER_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:OPENCUT_HEADLESS_PROFILE_DIR = "C:\path\to\private-opencut-profile"
```

The worker receives its bridge credential through a one-time localhost bootstrap ticket, so the credential is not placed in the browser command line. OpenCut project data remains browser-profile-local. Projects created and edited through the managed profile persist across worker restarts, but a project stored only in a different Chrome profile is not automatically visible in the managed profile.

Subject tracking uses the same local command-provider pattern. Configure
`OPENCUT_SUBJECT_TRACKER_COMMAND` and optional JSON-array
`OPENCUT_SUBJECT_TRACKER_ARGS`. See
[SUBJECT_TRACKER_PROTOCOL.md](./SUBJECT_TRACKER_PROTOCOL.md) for the normalized
bounding-box and canonical-time contract.

Available tools:

- `opencut_connection_status`
- `opencut_start_editor_worker` and `opencut_stop_editor_worker`, launching or stopping a hidden persistent-profile Chrome or Edge editor without requiring a manually open tab
- `opencut_list_projects`, returning saved-project metadata and the active project ID
- `opencut_create_project`, creating and activating a named project with an idempotent operation ID
- `opencut_open_project`, opening a saved project with an idempotent operation ID
- `opencut_get_project`, including project and canvas settings, track roles, media assets, and element parameters
- `opencut_query_timeline`, returning compact ordered elements, uncovered gaps, pairwise overlaps, and cut, gap, or overlap relationships for a revision-stable time range
- `opencut_list_effects`, returning the connected editor's supported effect catalog and validated parameter metadata
- `opencut_analyze_audio`, measuring integrated LUFS, sample peak, estimated true peak, and available uniform mix-gain range before export mastering
- `opencut_normalize_audio`, applying revision-safe loudness normalization with a target LUFS value, true-peak ceiling, and maximum boost
- `opencut_sync_audio`, decoding two selected clip sources locally, estimating their waveform lag with bounded normalized cross-correlation, and moving the target clip into synchronization
- `opencut_attach_clean_audio`, attaching a complete precomputed cleaned-audio source while preserving the selected clip's timing and audio automation
- `opencut_clean_audio`, transferring a complete uploaded source to the configured cleaner and attaching its output non-destructively with model provenance
- `opencut_apply_edit_plan`, supporting canvas, frame-rate, and background settings, track creation, deterministic track mute and visibility, normalized crop and focal-point reframing, contain, cover, stretch, split-screen, and picture-in-picture layouts, source-audio separation, cleaned-source enablement and detachment, non-destructive dialogue ducking with attack and release ramps, per-clip audio gain, mute, linear fades, uniform mix gain, stable-ID clip effect creation, update, ordering, enablement, and removal, general keyframe creation, update, retiming, and removal, crossfade, fade-through-black, slide, wipe, and zoom transitions, text and styled caption-batch insertion, delete, same-track or cross-track move, constant retiming from 0.01x through 5x with optional pitch preservation, validated parameter updates, split, and source-edge trim operations
- `opencut_undo`
- `opencut_import_media`, using an absolute local path and a one-time loopback transfer ticket, with optional placement on an explicit compatible track. Imports preserve project canvas and frame rate by default; set `adoptMediaSettings` to `true` to adopt them from the first visual asset.
- `opencut_export_project`, rendering in the connected editor, writing to a new absolute local `.mp4` or `.webm` path, fully decoding and probing it, extracting opening, middle, and ending frame samples, and persisting a durable SHA-256 receipt
- `opencut_queue_export`, persisting an export job that survives MCP restarts and runs automatically when an authenticated editor worker connects
- `opencut_get_export_job`, `opencut_list_export_jobs`, `opencut_cancel_export_job`, and `opencut_run_export_jobs`, for durable queue inspection and control
- `opencut_get_export_receipt`, reading a durable validation and watermark-inspection receipt after an MCP restart
- `opencut_record_export_inspection`, recording a hash-locked verified-clean or rejected watermark review after the sampled full frames and all four corners have been inspected
- `opencut_attach_matte`, attaching an existing image or video matte with explicit model provenance
- `opencut_generate_matte`, securely transferring a selected clip source to the configured provider, generating a matte, and attaching it in one revision-safe operation
- `opencut_track_subject`, transferring a selected video source to the configured tracker, validating and smoothing normalized subject boxes, mapping source samples through clip trim and retime, and atomically creating focal-point or crop reframe keyframes

The editor must be open with a project loaded. Creating or opening a project automatically updates the connected editor route. The sidecar rejects non-loopback browser origins, unauthenticated sockets, and a second editor attempting to take over an active session.

OpenCut removes empty overlay and audio tracks. To create a durable track through MCP, include `add_track` with a caller-selected `trackId` and a later `move` targeting that ID in the same edit plan.

Keyframe times are relative to the element start and use canonical media ticks. Stable caller-selected IDs make later updates deterministic. Built-in keyframe paths include position, scale, rotation, opacity, normalized crop, focal-point and target rectangles, volume, text color, and text-background geometry and color. Keyframable graphic and effect parameters use their registered parameter paths.

Audio analysis measures the unmastered timeline mix. Normalization shifts every audible clip base level and volume keyframe by the same dB value, preserving the relative mix. The applied gain is limited by the requested true-peak ceiling, maximum boost, and OpenCut's volume-control range. The normalization response includes measurements from before and after the mutation.

Effect instances use caller-selected stable IDs. The project snapshot returns each instance, its type, enabled state, and current parameters. Effect parameters use the general keyframe path `effects.<effectId>.params.<paramKey>`, so they can be created, updated, retimed, and removed through the same keyframe operations as transforms and opacity. Removing an effect also removes its parameter keyframes.

Timeline queries accept optional track IDs, element types, and start and end ticks. Results include elements that intersect the requested range. Gap coverage is clipped to that range, and relationships are computed between consecutive returned elements. Omitting the range queries the complete project duration.

Transitions link two consecutive, edge-adjacent video or image clips on one video track. Their duration cannot exceed either clip. The transition occupies the beginning of the incoming clip while the outgoing clip remains available for compositing. Wipe transitions currently reject masked incoming clips instead of replacing their authored mask.

Caption `fontSize` values use OpenCut app units rather than output pixels. Typical captions use values from `4` through `8`; the default is `5`.

Exports never overwrite an existing file. FFmpeg and FFprobe are preflighted before rendering. A completed export is accepted only after its container and stream metadata match the request, the complete file decodes without an FFmpeg error, and opening, middle, and ending full-frame PNG samples have been extracted and hashed. The immutable core receipt and separately updateable watermark-inspection record are stored under `OPENCUT_RECEIPT_DIR`. Retrying the same operation ID and identical arguments after an MCP restart verifies the output size and SHA-256 before returning the durable result.

Persistent export jobs use append-only revisions under the receipt directory. A queued job opens its target project before rendering, runs in FIFO order, and returns to the queue if the editor disconnects. A job found in the running state after an MCP restart is also recovered to queued. Job state does not require an open editor tab, but rendering currently waits for an authenticated editor worker to connect.
