# MCP command gateway prototype

This is a throwaway logic prototype. It asks one question:

> Can a revision-checked, idempotent, single-writer command gateway apply an agent edit plan atomically and preserve one-step undo?

Run it from the repository root:

```sh
bun run prototype:mcp
```

Use `bun run prototype:mcp --demo` for the deterministic scripted walkthrough.

The prototype models a tiny timeline and demonstrates:

- optimistic concurrency through `expectedRevision`
- idempotent retries through `operationId`
- rejection when one operation ID is reused for a different plan
- validation of all operations before committing any state
- one serialized mutation stream
- one history entry for a multi-operation plan
- undo as a new revision

It deliberately does not include MCP transport, WebSockets, persistence, media, rendering, or OpenCut UI integration. If the contract proves useful, the implementation should move into an automation facade beside `EditorCore`, with an MCP stdio sidecar acting only as a transport adapter.

## Result

The scripted walkthrough answers the prototype question with a qualified yes. The contract prevents duplicate retries, rejects stale and competing writers, validates a complete plan before committing, and restores a multi-operation edit with one undo. The remaining implementation risk is adapting these semantics to Classic's mutable `EditorCore` managers and flushing IndexedDB before a tool reports durable success.
