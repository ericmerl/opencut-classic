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
- `opencut_get_project`
- `opencut_apply_edit_plan`
- `opencut_undo`

The editor must be open with a project loaded. The sidecar rejects non-loopback browser origins, unauthenticated sockets, and a second editor attempting to take over an active session.
