# OpenCut MCP server

This local Windows sidecar exposes OpenCut Classic tools over MCP stdio and
relays calls to one authenticated browser editor over a loopback-only
WebSocket. The MCP client owns the stdio process; the supplied launcher keeps
that process attached to the client while hiding its console window.

## Fresh Windows installation

Use Windows 10 or 11 and install these prerequisites. Run the version commands
after installation so a failed upgrade never depends on an implicit executable.

| Runtime            | Supported version                               | Check                                            |
| ------------------ | ----------------------------------------------- | ------------------------------------------------ |
| Bun                | 1.2.18 (the version pinned by `packageManager`) | `bun --version`                                  |
| Rust               | 1.85 or newer with Cargo (edition 2024 support) | `rustc --version`; `cargo --version`             |
| wasm-pack          | 0.13 or newer                                   | `wasm-pack --version`                            |
| Chrome or Edge     | A current stable Windows release with WebGPU    | `chrome.exe --version` or `msedge.exe --version` |
| FFmpeg and FFprobe | Matching 6.x or newer builds                    | `ffmpeg -version`; `ffprobe -version`            |

Install the locked JavaScript dependencies from a tracked clone. The verified
build runs after the instance and secret are configured below.

```powershell
git clone https://github.com/ericmerl/opencut-classic.git
Set-Location opencut-classic
bun install --frozen-lockfile
```

The upgrade/build script later builds WASM, copies it into the dependency tree,
builds the web app, and runs `bun run test`, the repository's one unattended
test command. That command runs the MCP suite, isolated web suites, and Rust
workspace tests. The optional real-video milestone is included when its
documented integration variables are set.

### Configure instance 1

Copy the tracked example outside the repository so upgrades cannot overwrite
local paths. `%LOCALAPPDATA%` is expanded by the launcher; an empty browser path
enables automatic Chrome/Edge discovery.

```powershell
$configRoot = Join-Path $env:LOCALAPPDATA "OpenCut\mcp\config"
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
Copy-Item packages/mcp-server/config/windows-instance.example.json `
  (Join-Path $configRoot "instance-1.json")

$tokenBytes = [byte[]]::new(32)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($tokenBytes)
$random.Dispose()
$token = [BitConverter]::ToString($tokenBytes).Replace("-", "").ToLowerInvariant()
[Environment]::SetEnvironmentVariable("OPENCUT_BRIDGE_TOKEN", $token, "User")
```

Open a new PowerShell window and restart the MCP client after setting the user
variable. The bridge token must contain at least 32 characters, must be
identical in the web and MCP processes, and must never be committed or passed
on a command line.

Build and verify the fresh installation. This is the same safe path used for
later upgrades:

```powershell
$env:OPENCUT_BRIDGE_TOKEN = [Environment]::GetEnvironmentVariable("OPENCUT_BRIDGE_TOKEN", "User")
$config = Join-Path $env:LOCALAPPDATA "OpenCut\mcp\config\instance-1.json"
powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden `
  -File packages/mcp-server/scripts/Upgrade-OpenCutMcp.ps1 -Config $config
```

This offline build probe only validates the replacement MCP process; it does
not start the managed editor or mutate a project. The operational start order
remains web editor first, MCP client second.

Now start the web editor by hand and leave this foreground process running.
The tracked helper supplies the complete local editor environment, including
the matching `NEXT_PUBLIC_` bridge values, without an untracked `.env.local`:

```powershell
& packages/mcp-server/scripts/Start-OpenCutWeb.ps1 -Config $config
```

The placeholder database, Redis, CMS, and sound-service values are sufficient
for the local editor and MCP routes. Configure real services before using the
site's account, feedback, CMS, or online sound-library routes.

Then let the MCP client launch the server with the tracked launcher. A generic
stdio client entry is shown below; replace only the repository and config paths.
The PowerShell flags and `windowsHide` keep every console process hidden and
non-interactive while preserving MCP stdin/stdout.

```json
{
	"mcpServers": {
		"opencut-1": {
			"command": "powershell.exe",
			"args": [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-WindowStyle",
				"Hidden",
				"-File",
				"C:\\source\\opencut-classic\\packages\\mcp-server\\scripts\\Start-OpenCutMcp.ps1",
				"-Config",
				"%LOCALAPPDATA%\\OpenCut\\mcp\\config\\instance-1.json"
			],
			"windowsHide": true
		}
	}
}
```

The exact configuration envelope varies by MCP client. The executable, flags,
launcher arguments, inherited token, working directory, and hidden-window
setting are the required values. Do not run the `.ps1` through a `.bat` or
interactive console wrapper.

Call `opencut_capabilities` first. Before the web editor connects it deliberately
reports `editor.status: "unavailable"` and the plain reason “OpenCut web editor
is not running or connected.” After connection, verify the reported bridge
port, profile directory, state directory, build commit, WASM SHA-256, media
tools, renderer, and fonts. Use `opencut_start_editor_worker` to start the hidden
managed renderer and `opencut_stop_editor_worker` before shutting down the MCP
client. MCP diagnostics go to the client's stderr log.

Operational commands are intentionally small: run `Start-OpenCutWeb.ps1` and
connect the configured MCP client to start; call `opencut_stop_editor_worker`,
disconnect the MCP client, and press Ctrl+C in the web shell to stop; call
`opencut_capabilities` for health; inspect the MCP client's stderr for service
logs and `<state>\runtime\upgrade-capability.log` for the last upgrade probe.

### Instance N

Every simultaneous editor requires a separate MCP process, loopback port,
browser profile, and state directory. Copy the example to `instance-2.json`, use
another unoccupied port such as `32192`, and change both paths from
`instances\\1` to `instances\\2`. Start a second web process with the matching
`NEXT_PUBLIC_OPENCUT_BRIDGE_PORT`, and add a second MCP-client entry using that
configuration.

Browser profiles own separate IndexedDB project libraries. Instances therefore
cannot open or modify one another's projects by ID; move media or an exported
project explicitly when work must cross that boundary. Multiple instances also
share the PC's GPU, so render throughput is not expected to scale linearly.

### Configuration reference

The runtime uses the variables below. The instance JSON accepts the non-secret,
MCP-side settings from this table; the token and web-side `NEXT_PUBLIC_` values
are inherited or set in the web shell instead.

| Variable                                                                           | Purpose                                                                                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCUT_BRIDGE_TOKEN` / `NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN`                        | Required shared secret (32+ characters); MCP/web names respectively.                                                             |
| `OPENCUT_BRIDGE_PORT` / `NEXT_PUBLIC_OPENCUT_BRIDGE_PORT`                          | Required matching loopback port for each MCP/web pair.                                                                           |
| `OPENCUT_RECEIPT_DIR`                                                              | Instance state root. Jobs, receipts, ledgers, preview evidence, provider records, and the default browser profile live below it. |
| `OPENCUT_HEADLESS_PROFILE_DIR`                                                     | Dedicated Chrome/Edge profile and project library; defaults below the state root.                                                |
| `OPENCUT_HEADLESS_EDITOR_URL`                                                      | Web editor base URL; enables the managed browser worker.                                                                         |
| `OPENCUT_HEADLESS_BROWSER_PATH`                                                    | Optional absolute Chrome/Edge path; empty means automatic discovery.                                                             |
| `OPENCUT_HEADLESS_CONNECTION_TIMEOUT_MS`                                           | Optional managed-editor connection timeout.                                                                                      |
| `OPENCUT_FFMPEG_PATH`, `OPENCUT_FFPROBE_PATH`                                      | Executable name on `PATH` or absolute path.                                                                                      |
| `OPENCUT_RENDERER_CLASS`                                                           | `software` (the deterministic default) or explicitly declared `hardware`.                                                        |
| `OPENCUT_PREVIEW_EVIDENCE_DIR`, `OPENCUT_OPERATION_LEDGER_DIR`                     | Optional overrides; normally leave both under the state root.                                                                    |
| `OPENCUT_WASM_ARTIFACT_PATH`, `OPENCUT_WASM_PACKAGE_VERSION`                       | Optional WASM identity overrides for a custom deployment.                                                                        |
| `OPENCUT_AUDIO_CLEANER_*`, `OPENCUT_MATTE_PRODUCER_*`, `OPENCUT_SUBJECT_TRACKER_*` | Optional external-provider command and JSON-array arguments.                                                                     |

Protocol-v1 mutation remains disabled unless
`OPENCUT_ENABLE_PROTOCOL_V1_MUTATION=1`; do not enable it in a production
instance. `OPENCUT_BUILD_COMMIT` and `OPENCUT_BUILD_TIMESTAMP` are deployment
identity overrides for packaged trees without Git metadata. Test-only variables
are intentionally excluded from the instance file.

### Persistent data, retention, and recovery

Without an instance file, Windows state defaults to
`%LOCALAPPDATA%\OpenCut\mcp\receipts` and the browser profile defaults to its
`headless-profile` child. The documented instance layout instead uses
`%LOCALAPPDATA%\OpenCut\mcp\instances\N\state` and a sibling
`browser-profile`. Treat those two directories as one recovery unit.

Retain the complete state and browser-profile directories for at least 90 days
after the last operation or project that refers to them. OpenCut does not prune
them automatically. Back up both directories while the instance is stopped;
restoring only receipts or only the browser profile can leave durable hashes
without their matching project library. To recover, restore the pair, use the
same instance configuration and token, start the web editor, reconnect MCP, call
`opencut_capabilities`, and read the relevant operation/save/export receipt.

Provider model caches are owned by their configured provider commands, not by
OpenCut. Record their locations with those provider installations and retain
them under the same 90-day policy when replay depends on a model. The selected
caption font bundle and local AI models are deliberately deferred to issues #21
and #29; capability readiness reports their current state rather than assuming
an untracked cache.

### Upgrade

Commit or stash intentional source changes, pull the desired commit, and run:

```powershell
$config = Join-Path $env:LOCALAPPDATA "OpenCut\mcp\config\instance-1.json"
powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden `
  -File packages/mcp-server/scripts/Upgrade-OpenCutMcp.ps1 -Config $config
```

The script installs the locked dependencies, builds the local WASM package,
copies that package into the web/MCP dependency tree, builds the web app, runs
`bun run test`, stops only a listener proven to be this checkout's MCP process,
and launches a replacement MCP/capability probe with `-WindowStyle Hidden` and
`windowsHide`. Upgrade success is written under
`<state>\runtime\upgrades\<commit>.json` only after the public capability tool
reports the expected 40-character commit. Because MCP is stdio, that verification
process exits after the probe; reconnecting the configured MCP client launches
the same verified build as the new client-owned service process. The probe log
is `<state>\runtime\upgrade-capability.log`.

If install was already completed from the same lockfile, `-SkipInstall` is
available. It does not skip either build, the full test command, hidden restart,
or capability verification.

Protocol v1 reads remain available, but mutation is disabled by default because
it has no connection affinity or retry-stable operation identity. Use explicit
protocol v2 requests for mutation. For temporary legacy compatibility only, set
`OPENCUT_ENABLE_PROTOCOL_V1_MUTATION=1`; `opencut_connection_status` will then
report the compatibility mode as `degraded`.

For local development, the MCP process also accepts the matching `NEXT_PUBLIC_`
token and port variables as fallbacks, so one ignored environment file can
configure both processes.

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
- `opencut_preflight_edit_plan`, evaluating a complete v2 plan against a verified saved project without mutation and returning an immutable receipt
- `opencut_get_edit_plan_preflight` and `opencut_list_edit_plan_preflights`, reading durable preflight evidence across MCP and editor restarts
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

Protocol-v2 edit plans must be preflighted before `opencut_apply_edit_plan`; receipt-less applies fail with `PREFLIGHT_REQUIRED`. Preflight capability requirements are derived from the same snapshot returned by `opencut_capabilities`. Provider execution is forbidden during edit-plan evaluation, so its cost is currently always `not-applicable`. The `costPolicy` request field is reserved and intentionally inert until paid operations are admitted to edit plans.

Keyframe times are relative to the element start and use canonical media ticks. Stable caller-selected IDs make later updates deterministic. Built-in keyframe paths include position, scale, rotation, opacity, normalized crop, focal-point and target rectangles, volume, text color, and text-background geometry and color. Keyframable graphic and effect parameters use their registered parameter paths.

Audio analysis measures the unmastered timeline mix. Normalization shifts every audible clip base level and volume keyframe by the same dB value, preserving the relative mix. The applied gain is limited by the requested true-peak ceiling, maximum boost, and OpenCut's volume-control range. The normalization response includes measurements from before and after the mutation.

Effect instances use caller-selected stable IDs. The project snapshot returns each instance, its type, enabled state, and current parameters. Effect parameters use the general keyframe path `effects.<effectId>.params.<paramKey>`, so they can be created, updated, retimed, and removed through the same keyframe operations as transforms and opacity. Removing an effect also removes its parameter keyframes.

Timeline queries accept optional track IDs, element types, and start and end ticks. Results include elements that intersect the requested range. Gap coverage is clipped to that range, and relationships are computed between consecutive returned elements. Omitting the range queries the complete project duration.

Transitions link two consecutive, edge-adjacent video or image clips on one video track. Their duration cannot exceed either clip. The transition occupies the beginning of the incoming clip while the outgoing clip remains available for compositing. Wipe transitions currently reject masked incoming clips instead of replacing their authored mask.

Caption `fontSize` values use OpenCut app units rather than output pixels. Typical captions use values from `4` through `8`; the default is `5`.

Exports never overwrite an existing file. FFmpeg and FFprobe are preflighted before rendering. A completed export is accepted only after its container and stream metadata match the request, the complete file decodes without an FFmpeg error, and opening, middle, and ending full-frame PNG samples have been extracted and hashed. The immutable core receipt and separately updateable watermark-inspection record are stored under `OPENCUT_RECEIPT_DIR`. Retrying the same operation ID and identical arguments after an MCP restart verifies the output size and SHA-256 before returning the durable result.

Persistent export jobs use append-only revisions under the receipt directory. A queued job opens its target project before rendering, runs in FIFO order, and returns to the queue if the editor disconnects. A job found in the running state after an MCP restart is also recovered to queued. Job state does not require an open editor tab, but rendering currently waits for an authenticated editor worker to connect.
