# OpenCut MCP server

This local sidecar exposes OpenCut Classic tools over MCP stdio and relays calls to one authenticated browser editor over a loopback-only WebSocket.

Set the same token in the MCP process and the OpenCut web build. Use at least 32 random characters and do not commit it.

```powershell
$env:OPENCUT_BRIDGE_TOKEN = "replace-with-a-random-secret-of-at-least-32-characters"
$env:NEXT_PUBLIC_OPENCUT_BRIDGE_TOKEN = $env:OPENCUT_BRIDGE_TOKEN
bun run mcp
```

The bridge defaults to `127.0.0.1:32191`. Override both sides with `OPENCUT_BRIDGE_PORT` and `NEXT_PUBLIC_OPENCUT_BRIDGE_PORT`.

Available tools:

- `opencut_connection_status`
- `opencut_list_projects`, returning saved-project metadata and the active project ID
- `opencut_create_project`, creating and activating a named project with an idempotent operation ID
- `opencut_open_project`, opening a saved project with an idempotent operation ID
- `opencut_get_project`, including project and canvas settings, track roles, media assets, and element parameters
- `opencut_list_effects`, returning the connected editor's supported effect catalog and validated parameter metadata
- `opencut_analyze_audio`, measuring integrated LUFS, sample peak, estimated true peak, and available uniform mix-gain range before export mastering
- `opencut_normalize_audio`, applying revision-safe loudness normalization with a target LUFS value, true-peak ceiling, and maximum boost
- `opencut_apply_edit_plan`, supporting canvas, frame-rate, and background settings, track creation, deterministic track mute and visibility, per-clip audio gain, mute, linear fades, uniform mix gain, stable-ID clip effect creation, update, ordering, enablement, and removal, general keyframe creation, update, retiming, and removal, crossfade, fade-through-black, slide, wipe, and zoom transitions, text and styled caption-batch insertion, delete, same-track or cross-track move, constant retiming from 0.01x through 5x with optional pitch preservation, validated parameter updates, split, and source-edge trim operations
- `opencut_undo`
- `opencut_import_media`, using an absolute local path and a one-time loopback transfer ticket, with optional placement on an explicit compatible track. Imports preserve project canvas and frame rate by default; set `adoptMediaSettings` to `true` to adopt them from the first visual asset.
- `opencut_export_project`, rendering in the connected editor and writing to a new absolute local `.mp4` or `.webm` path

The editor must be open with a project loaded. Creating or opening a project automatically updates the connected editor route. The sidecar rejects non-loopback browser origins, unauthenticated sockets, and a second editor attempting to take over an active session.

OpenCut removes empty overlay and audio tracks. To create a durable track through MCP, include `add_track` with a caller-selected `trackId` and a later `move` targeting that ID in the same edit plan.

Keyframe times are relative to the element start and use canonical media ticks. Stable caller-selected IDs make later updates deterministic. Built-in keyframe paths include position, scale, rotation, opacity, volume, text color, and text-background geometry and color. Keyframable graphic and effect parameters use their registered parameter paths.

Audio analysis measures the unmastered timeline mix. Normalization shifts every audible clip base level and volume keyframe by the same dB value, preserving the relative mix. The applied gain is limited by the requested true-peak ceiling, maximum boost, and OpenCut's volume-control range. The normalization response includes measurements from before and after the mutation.

Effect instances use caller-selected stable IDs. The project snapshot returns each instance, its type, enabled state, and current parameters. Effect parameters use the general keyframe path `effects.<effectId>.params.<paramKey>`, so they can be created, updated, retimed, and removed through the same keyframe operations as transforms and opacity. Removing an effect also removes its parameter keyframes.

Transitions link two consecutive, edge-adjacent video or image clips on one video track. Their duration cannot exceed either clip. The transition occupies the beginning of the incoming clip while the outgoing clip remains available for compositing. Wipe transitions currently reject masked incoming clips instead of replacing their authored mask.

Caption `fontSize` values use OpenCut app units rather than output pixels. Typical captions use values from `4` through `8`; the default is `5`.

Exports never overwrite an existing file. A completed export operation can be retried with the same operation ID and identical arguments without rendering or writing it again. Export retries are remembered for the lifetime of the MCP process.
