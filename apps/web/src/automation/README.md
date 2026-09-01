# Editor automation facade

This module is the transport-independent boundary for agent edits. It is intentionally unaware of MCP and WebSockets.

The first slice provides:

- canonical timeline snapshots in media ticks
- serialized mutation execution
- revision conflicts that detect UI edits between agent calls
- idempotent operation retries
- atomic text insertion, move, and trim plans through one `BatchCommand`
- one-step undo
- explicit `SaveManager.flush()` before mutation success

The next slice should add an authenticated loopback browser bridge and a local MCP stdio sidecar. Transport handlers should call this facade and return its structured results without reaching into `EditorCore` directly.
