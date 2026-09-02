# OpenCut MCP server

This local sidecar exposes OpenCut Classic tools over MCP stdio and relays calls to one authenticated browser editor over a loopback-only WebSocket.

Set the same token in the MCP process and the OpenCut web build. Use at least 32 random characters and do not commit it.

```powershell
$env:OPENCUT_BRIDGE_TOKEN = "replace-with-a-random-secret-of-at-least-32-characters"
$env:NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN = $env:OPENCUT_BRIDGE_TOKEN
bun run mcp
```

The bridge defaults to `127.0.0.1:32191`. Override both sides with `OPENCUT_BRIDGE_PORT` and `NEXT_PUBLIC_OPENCUT_BRIDGE_PORT`.

Background removal is intentionally staged separately. See [BACKGROUND_REMOVAL_SCOPE.md](./BACKGROUND_REMOVAL_SCOPE.md) for the model-independent matte foundation, browser prototype boundary, production inference requirements, and acceptance criteria.

`opencut_generate_matte` uses an external command provider so OpenCut does not bundle or license a particular segmentation model. Configure the provider executable and optional arguments before starting the MCP server:

```powershell
$env:OPENCUT_MATTE_PRODUCER_COMMAND = "C:\path\to\python.exe"
$env:OPENCUT_MATTE_PRODUCER_ARGS = '["C:\path\to\provider.py"]'
```

The provider receives one JSON request on stdin and must return one JSON response on stdout. Write diagnostics to stderr. See [MATTE_PRODUCER_PROTOCOL.md](./MATTE_PRODUCER_PROTOCOL.md) for the versioned contract.

Available tools:

- `opencut_connection_status`
- `opencut_list_projects`, returning saved-project metadata and the active project ID
- `opencut_create_project`, creating and activating a named project with an idempotent operation ID
- `opencut_open_project`, opening a saved project with an idempotent operation ID
- `opencut_get_project`, including project and canvas settings, track roles, media assets, and element parameters
- `opencut_query_timeline`, returning compact ordered elements, uncovered gaps, pairwise overlaps, and cut, gap, or overlap relationships for a revision-stable time range
- `opencut_list_effects`, returning the connected editor's supported effect catalog and validated parameter metadata
- `opencut_analyze_audio`, measuring integrated LUFS, sample peak, estimated true peak, and available uniform mix-gain range before export mastering
- `opencut_normalize_audio`, applying revision-safe loudness normalization with a target LUFS value, true-peak ceiling, and maximum boost
- `opencut_apply_edit_plan`, supporting canvas, frame-rate, and background settings, track creation, deterministic track mute and visibility, per-clip audio gain, mute, linear fades, uniform mix gain, stable-ID clip effect creation, update, ordering, enablement, and removal, general keyframe creation, update, retiming, and removal, crossfade, fade-through-black, slide, wipe, and zoom transitions, text and styled caption-batch insertion, delete, same-track or cross-track move, constant retiming from 0.01x through 5x with optional pitch preservation, validated parameter updates, split, and source-edge trim operations
- `opencut_undo`
- `opencut_import_media`, using an absolute local path and a one-time loopback transfer ticket, with optional placement on an explicit compatible track. Imports preserve project canvas and frame rate by default; set `adoptMediaSettings` to `true` to adopt them from the first visual asset.
- `opencut_export_project`, rendering in the connected editor and writing to a new absolute local `.mp4` or `.webm` path
- `opencut_attach_matte`, attaching an existing image or video matte with explicit model provenance
- `opencut_generate_matte`, securely transferring a selected clip source to the configured provider, generating a matte, and attaching it in one revision-safe operation

The editor must be open with a project loaded. Creating or opening a project automatically updates the connected editor route. The sidecar rejects non-loopback browser origins, unauthenticated sockets, and a second editor attempting to take over an active session.

OpenCut removes empty overlay and audio tracks. To create a durable track through MCP, include `add_track` with a caller-selected `trackId` and a later `move` targeting that ID in the same edit plan.

Keyframe times are relative to the element start and use canonical media ticks. Stable caller-selected IDs make later updates deterministic. Built-in keyframe paths include position, scale, rotation, opacity, volume, text color, and text-background geometry and color. Keyframable graphic and effect parameters use their registered parameter paths.

Audio analysis measures the unmastered timeline mix. Normalization shifts every audible clip base level and volume keyframe by the same dB value, preserving the relative mix. The applied gain is limited by the requested true-peak ceiling, maximum boost, and OpenCut's volume-control range. The normalization response includes measurements from before and after the mutation.

Effect instances use caller-selected stable IDs. The project snapshot returns each instance, its type, enabled state, and current parameters. Effect parameters use the general keyframe path `effects.<effectId>.params.<paramKey>`, so they can be created, updated, retimed, and removed through the same keyframe operations as transforms and opacity. Removing an effect also removes its parameter keyframes.

Timeline queries accept optional track IDs, element types, and start and end ticks. Results include elements that intersect the requested range. Gap coverage is clipped to that range, and relationships are computed between consecutive returned elements. Omitting the range queries the complete project duration.

Transitions link two consecutive, edge-adjacent video or image clips on one video track. Their duration cannot exceed either clip. The transition occupies the beginning of the incoming clip while the outgoing clip remains available for compositing. Wipe transitions currently reject masked incoming clips instead of replacing their authored mask.

Caption `fontSize` values use OpenCut app units rather than output pixels. Typical captions use values from `4` through `8`; the default is `5`.

Exports never overwrite an existing file. A completed export operation can be retried with the same operation ID and identical arguments without rendering or writing it again. Export retries are remembered for the lifetime of the MCP process.
