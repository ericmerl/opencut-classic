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
- `opencut_get_project`, including project and canvas settings, track roles, media assets, and element parameters
- `opencut_apply_edit_plan`, supporting canvas, frame-rate, and background settings, track creation, text and styled caption-batch insertion, delete, move, constant retiming from 0.01x through 5x with optional pitch preservation, validated parameter updates, split, and trim operations
- `opencut_undo`
- `opencut_import_media`, using an absolute local path and a one-time loopback transfer ticket, with optional placement on an explicit compatible track
- `opencut_export_project`, rendering in the connected editor and writing to a new absolute local `.mp4` or `.webm` path

The editor must be open with a project loaded. The sidecar rejects non-loopback browser origins, unauthenticated sockets, and a second editor attempting to take over an active session.

Exports never overwrite an existing file. A completed export operation can be retried with the same operation ID and identical arguments without rendering or writing it again. Export retries are remembered for the lifetime of the MCP process.
