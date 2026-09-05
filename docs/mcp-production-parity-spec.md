# OpenCut Classic MCP production parity specification

Status: revised draft, 2026-09-02 adversarial review findings and owner decisions applied
Normative target: production-ready MCP parity for a local, single-user Windows installation
Status authority: [`docs/mcp-capability-gap-audit.md`](./mcp-capability-gap-audit.md)
Execution order: the audit dependency map, current owner direction, and this specification
Draft date: 2026-09-02
Deployment context: one Windows PC, personal use, never hosted or shared, operated by agents. One editor per MCP instance; concurrency by running additional instances. The owner decisions that fixed this scope are recorded in the audit under `Review corrections and owner decisions` and are not reopened here.

## 1. How to read this document

This document defines the stable product and engineering contract for the OpenCut Classic MCP system we are building. It explains the intended behavior, invariants, trust boundaries, capability families, evidence, deployment gates, and end-to-end acceptance workflows.

The capability audit remains authoritative for the current backlog, priority, classification, acceptance evidence, and current file-and-line references. In particular:

- Audit sections A through L are the requirement records.
- `Exact Simple Media workflow gaps` identifies the remaining workflow blockers.
- `Prioritized requirements backlog` identifies P0, P1, and P2 scope.
- `Dependency map` determines the required order where one feature supplies evidence or state for another.
- `Definition of production-ready MCP parity` is the final release threshold.

This specification does not promote a capability from unsupported or partial to fully supported. Only validated implementation evidence recorded in the audit may do that. If this specification and the audit appear to disagree about current status, the audit governs current status and this specification governs the target behavior. If acceptance requirements conflict, the stricter requirement applies until the documents are reconciled.

Normative terms have their conventional meanings:

- **MUST** is required for production parity.
- **MUST NOT** is prohibited for production parity.
- **SHOULD** is expected unless a documented constraint justifies a different implementation.
- **MAY** is optional.

## 2. Current implementation boundary

This is a status snapshot, not a completion claim. The current branch contains pushed milestones for reconnect-safe identity, hash-verified saves, the durable operation ledger, and exact-time single-frame preview evidence. The 2026-09-02 review confirmed the ledger, identity, and preview evidence as implemented and reclassified the save barrier and revision-checked edit plans as partially supported (audit section A, `Review corrections and owner decisions`).

The edit-plan preflight milestone now spans Rust, the web editor, and the MCP service: all 41 operation variants are simulated, identifiers are deterministic, apply is one native transaction with prediction-hash verification, receipts are durable and restart-safe, non-active scenes are preserved correctly, and v2 apply requires a receipt. Caption font readiness remains a separate follow-up under the caption milestone.

The running MCP can lag the task branch. Branch completion and upgrade completion are separate states. The service MUST report the running build identity and capability set so callers never infer running behavior from repository state.

## 3. Purpose

OpenCut Classic MCP is a deterministic, inspectable, restart-safe editing control plane for OpenCut. It allows an MCP client to build, modify, validate, render, review, export, and package a real video project without manual browser editing.

The system is intended to support the complete Simple Media workflows described by the audit, including:

1. Discovering whether the editor, renderer, codecs, models, and providers are actually ready.
2. Creating or duplicating projects and managing scenes, tracks, bookmarks, and media assets.
3. Evaluating a complete edit plan without mutation.
4. Applying exactly the evaluated plan atomically and idempotently.
5. Saving, reopening, and verifying canonical project bytes and media identities.
6. Rendering exact frames, ranges, comparisons, and structured review evidence.
7. Running long work as durable jobs with cancellation, retry, recovery, diagnostics, and provenance.
8. Producing captions, treatments, motion, audio, retiming, and variants with preview/export parity.
9. Performing structured QC and producing a deterministic delivery package.
10. Editing semantically from transcripts, silence ranges, and reusable editorial decisions.

## 4. Non-goals and scope limits

The production parity baseline does not require:

- Reproducing transient UI state such as panel visibility, hover state, scroll position, or selection styling unless it affects durable state or review evidence.
- Supporting every professional codec, NLE plugin, model provider, motion-graphics primitive, or cloud asset source. Delivery formats are MP4 and WebM only.
- Multiple simultaneous editor sessions within one MCP instance. Each instance owns exactly one editor. Parallel work is achieved by running additional instances, each with its own bridge port, browser profile, and state directory (section 8).
- Remote or resumable cloud ingest. Every source is a local file.
- Browser-independent rendering. The hidden managed browser is the production renderer (section 6.1).
- Hosted-service hardening: MCP transport authentication, provider sandboxing, filtered child environments, private-path redaction, disk quotas, rate limits, allowlisted filesystem roots, atomic runtime promotion, deployment receipts, and metrics. The machine is isolated and single-user (section 21).
- Nested-clip editing beyond create and break apart, shot and take analysis, drift or timecode or multicamera sync, multicam, insert/overwrite/lift/extract primitives, advanced keyframe curve editing, optical flow, semantic vision indexes, 3D, particles, expressions, or other P2 features before parity.
- Non-Windows installation.

Bundled background-removal generation, matte edge refinement, temporal correction, repair paint, and garbage mattes are outside the parity definition. They form the first project after parity (section 22). Attachment of a precomputed matte and the external provider protocol remain required and MUST keep passing their regression coverage.

## 5. Definition of production-ready MCP parity

Production-ready MCP parity exists only when every audit row whose classification text marks it as required for parity (all P0 and P1 items) meets its objective acceptance criteria on a fresh documented installation of the owner's Windows PC, and the audit contains no stale claims. Bundled background removal (section 22) and every P2 item are excluded from the definition. The audit's `Definition of production-ready MCP parity` is the single authoritative list; this section restates it.

At minimum, the installation MUST complete the audit's eleven parity outcomes without manual browser editing, with starting the web editor by hand as the only permitted manual step:

1. Capability, provider, font, and build-identity discovery before work begins.
2. Full project, scene, track, bookmark, and asset lifecycle needed by the workflow.
3. Typed, revision-checked, hash-checked, dry-runnable, idempotent editing.
4. Exact Simple Media visual, caption, audio, mask, tracking, reframe, retime, and transition behavior, plus attachment of a precomputed matte.
5. Save as a verified no-op when nothing changed, reload, and canonical hash verification.
6. Exact preview frames, bounded ranges, before/after comparisons from retained snapshots, and structured review evidence.
7. Durable, cancellable, recoverable jobs with provider and model provenance under one job model.
8. Non-destructive platform variants.
9. Decode, recorded encoder settings, visual, decoded audio, caption, safe-zone, watermark with human final review, and platform QC.
10. A durable delivery package with manifests, sidecars, evidence, hashes, and operation history.
11. Preview and export through the hidden managed browser with a pinned compositor backend recorded in every render receipt.

The following do not constitute acceptance on their own:

- A registered MCP tool.
- A TypeScript or Zod schema.
- A Rust type or WASM export.
- A synthetic fixture.
- A provider command placeholder.
- An in-memory replay map.
- A renderer code path that has not rendered and decoded real media.
- A successful mutation without durable readback.
- A successful preview without export parity.
- A successful export without source, provider, and receipt provenance.
- A test that passes only in isolation, only with an opt-in flag outside the standard test command, or only on one developer's machine.

## 6. Architecture and ownership boundaries

### 6.1 Logical components

The target system has these components:

1. **MCP transport and tool service.** Validates typed public inputs, enforces protocol and operation policy, records durable operations, routes requests, and returns typed results.
2. **Editor bridge.** Maintains a negotiated, authenticated connection to an editor instance and rejects stale or incorrectly targeted work.
3. **Rust domain core.** Owns platform-neutral project semantics, edit-plan evaluation, canonical state rules, deterministic identifiers, diff rules, time mapping, and reusable analysis logic.
4. **Web editor adapter.** Owns browser-specific rendering, font and text measurement, media APIs, IndexedDB access, interaction state, and invocation of native editor commands.
5. **Persistent stores.** Hold project snapshots, media bytes or immutable references, save receipts, operation history, preflight receipts, jobs, artifacts, review evidence, QC results, and delivery manifests.
6. **Renderer.** The hidden managed browser produces frames, ranges, audio, and exports from hash-locked project state. It MUST be launched with a pinned software rasterizer or a declared GPU class, and every render receipt MUST record the compositor backend, surface format, browser version, and WASM artifact hash actually used. No manually operated browser is involved.
7. **Provider adapters and supervisors.** Execute matte, tracking, cleanup, transcription, analysis, or other model work with readiness, provenance, bounded inputs, durable checkpoints, and recovery.
8. **Validation and packaging services.** Inspect artifacts, record QC evidence, and assemble deterministic delivery packages.

### 6.2 Code ownership rule

Platform-neutral business logic belongs in `rust/`. Apps are replaceable UI and platform adapters. Browser-specific text measurement, WebCodecs behavior, DOM or canvas integration, and IndexedDB access may remain in the web adapter, but they MUST expose typed inputs and outputs to the domain contract. The browser MUST NOT silently invent domain decisions that differ from the Rust evaluator.

### 6.3 Trust boundaries

The system MUST treat these as distinct trust domains:

- MCP client input is untrusted and schema-validated.
- Bridge identity is routing affinity, not authentication.
- Authentication tokens are secrets and remain separate from editor/session identity.
- Browser state is mutable and MUST be revalidated before and after material work.
- Persisted project state is authoritative only after a verified save barrier.
- Local file paths are trusted host inputs on this isolated machine, but the bytes an operation hashes MUST be the bytes it uses, and no operation may overwrite an existing export or fetch a remote URL found in project state (section 21).
- Provider processes and their output files are untrusted until validated and hashed.
- Rendered artifacts are untrusted until decoded, inspected according to policy, and bound to their source receipt.
- SQLite and IndexedDB records MUST be checksummed, versioned, and fail closed on corruption or unsupported versions.

## 7. Versioned protocol and capability negotiation

Audit reference: section A, `Stable editor and session identity` and `Capability negotiation and provider readiness`; section K, `Runtime diagnostics`.

### 7.1 Protocol envelope

Every v2 project-scoped request MUST carry:

- MCP contract version.
- Bridge protocol version.
- Expected server instance ID.
- Expected durable editor instance ID.
- Expected editor session ID.
- Expected connection generation.
- Project ID and, where applicable, scene ID.
- Expected session revision.
- Expected canonical project content hash for operations bound to saved content.
- Expected durable write version where persisted content is involved.
- Caller-supplied operation, preflight, job, or evidence identity as appropriate.

The server MUST reject version mismatches and stale connection affinity before dispatching work. Responses MUST state both the requested and execution identities. Disconnect MUST make outstanding nonterminal requests uncertain rather than falsely successful.

### 7.2 Capability discovery

A single non-mutating capability tool MUST return a machine-readable snapshot containing:

- MCP server build identity: repository commit, dirty flag, build timestamp, and schema versions.
- Instance identity: bridge port, browser profile directory, and state directory, so that several instances on one PC are distinguishable.
- Supported bridge protocol versions and negotiated version.
- Stable server/editor/session/generation identity, and editor reachability with a plain reason when the web editor is not running.
- WASM artifact hash actually loaded by the editor, and the compositor backend actually selected with whether it matches the pinned backend.
- Registered tools and versions.
- Supported edit-plan operation variants and contract versions.
- Project projection and hash versions.
- Receipt, job, preview, comparison, review, QC, and package schema versions.
- Renderer modes and readiness.
- Managed browser readiness.
- FFmpeg and FFprobe versions, supported containers, codecs, pixel formats, color spaces, and acceleration paths.
- WebCodecs, WASM, GPU adapter, memory, disk, and media decoder readiness.
- Fonts required by named presets, matched descriptors, and whether exact faces are loaded.
- Every model/provider with state, provider ID, model ID/version, license or distribution mode where relevant, cache state, acceleration, CPU fallback, limits, and degraded reason.
- Maximum accepted plan size, range duration, render dimensions, concurrent jobs, storage limits, and timeouts.

Readiness states MUST distinguish at least `ready`, `degraded`, `unavailable`, `misconfigured`, and `unknown`. Presence of a command path is not readiness. A readiness probe MUST validate enough of the dependency to predict whether the operation can begin, while avoiding paid provider work.

The capability response MUST be hashable. Operations whose behavior depends on capabilities MUST record the capability snapshot hash and reject incompatible changes when exact repeatability requires it. The snapshot MUST be produced by this tool; no evaluator, preflight, or job may synthesize its own capability snapshot.

### 7.3 Provider selection and provenance

Provider choice MUST be explicit or deterministically resolved from a documented policy. Every result MUST retain:

- Provider and adapter identity.
- Model/tool name and exact version.
- Model or binary hash when obtainable.
- Runtime and acceleration mode.
- Semantic input hash and bounded options.
- Source content identity.
- Output artifact hashes.
- Start, progress, completion, and retry events.
- Cost status and exact or bounded amount where applicable.
- Warnings, degraded behavior, and fallback reason.

Secrets, signed URLs, tokens, and raw credentials MUST NOT appear in provenance or diagnostics.

Model files MUST be pinned by content hash, resolved from a service-managed cache directory declared in section 25.1, and recorded in every result together with the execution device actually selected. A model identifier that resolves to different bytes on different days is not provenance. Model selection itself is deferred (audit owner decision 8); this rule applies to whichever models are later chosen and to the already bundled Whisper path.

### 7.4 Backward compatibility

Protocol v1 mutation MUST be disabled by default in a parity deployment. It MAY be enabled only by an explicit configuration flag whose presence is reported in the capability snapshot as `degraded`. Parity evidence MUST be collected with v1 mutation disabled. V1 reads MAY remain available. V1 omission MUST never be interpreted as v2 safety. New contracts MUST use explicit version discriminators. Breaking semantic changes require a new contract, projection, or receipt version, not a silent reinterpretation of an existing version.

## 8. Stable editor, session, and connection identity

Audit reference: section A, `Stable editor and session identity`; section K, `Multiple simultaneous editor sessions`.

The identity model MUST distinguish:

- `serverInstanceId`: the currently running MCP server process or logical service instance.
- `editorInstanceId`: a durable editor installation/profile identity that survives browser restart.
- `editorSessionId`: a browser-process session identity that changes on browser restart.
- `connectionGeneration`: a monotonic generation that changes on reconnect.
- `projectId`: durable project identity.
- `sceneId`: durable scene identity.

Identity fields prevent cross-editor and stale-socket execution. They do not authorize a caller. Token authentication and local access policy remain independent controls.

Every targeted v2 request MUST be dispatched only to the exact negotiated connection. The bridge MUST reject:

- A different editor instance.
- A stale session or generation.
- A response carrying a different execution identity.
- An explicit protocol version different from the negotiated version.
- A second live editor. Every MCP instance owns exactly one active editor.

Durable work MAY rebind after restart only if its contract allows rebinding, the durable editor instance matches, the persisted canonical hash and write version recorded when the work was queued match the fresh readback, and the receipt records both the original and recovery execution identities. A bare string match on the editor instance ID is not sufficient on its own. The editor instance ID SHOULD be bound to a server-issued secret stored in the editor profile and proven on handshake. Session-local revision MUST NOT be confused with durable write version.

### 8.1 Instances

Concurrency is achieved by running more than one MCP instance on the PC. Each instance MUST be configurable with its own bridge port, browser profile directory, and state directory, and MUST report those in its capability response. Each browser profile owns a separate project library, so two instances cannot operate on the same project; the documentation MUST say so. Two instances share one GPU, so throughput is not expected to scale linearly. Within one instance, renders are serialized by the compositor lease and jobs run as a queue (section 17).

## 9. Canonical project state, revisions, and hashes

Audit reference: section A, `Revision durability and coverage` and `Project content hash`.

### 9.1 State clocks

The system MUST keep these concepts separate:

- **Session revision:** an optimistic concurrency clock for the active editor session. It may reset when the editor restarts.
- **Durable write version:** a monotonic per-project storage commit version. It survives restart.
- **Canonical content hash:** a content identity derived from all durable editorial state and immutable media identities.
- **Save receipt identity:** proof that a specific content hash and write version were reloaded and verified.

A request MUST declare the clock or identity it relies on. Recovery MUST not reject a correct saved project merely because a session revision reset, and MUST not accept a project whose hash or write version differs.

### 9.2 Canonical projection

The versioned canonical project projection MUST include, at minimum:

- Project ID, name, settings, active scene, and main scene. Projection version 1 omits the project ID; version 2 MUST include it so that duplicated projects hash differently (audit owner decision 12).
- Every scene in deterministic order.
- Every bookmark with stable identity, time/range, note, and color. The native bookmark model has no ID today; the ID MUST be added to the native model before bookmarks are projected by identity, and the projection version MUST be bumped when that happens.
- Every track in deterministic order, including type, role, name, mute, hidden, locked if supported, and main-track semantics.
- Every transition in deterministic order.
- Every element recursively, including compounds.
- Element timing, source timing, trim, retime, relationship, parameter, visual, audio, effect, mask, keyframe, reframe, matte, and replacement state.
- Group and link identities.
- Media-bin assets and immutable local or provider identities.
- Attachment identities and provider provenance that affect the rendered result.

The projection MUST exclude transient URLs, in-memory handles, selection state, playback state, and other nondurable details. Maps and sets MUST have a declared deterministic order. Numeric formatting MUST be identical across Rust, JavaScript, storage, and MCP serialization, including negative zero and exponent thresholds. Invalid Unicode, unsafe integers, non-finite numbers, or fields that cannot be projected safely MUST fail closed with a typed blocker.

### 9.3 Hash behavior

The canonical hash MUST be SHA-256 over versioned canonical UTF-8 bytes. The response MUST state the projection name and version. Every relevant mutation, save, preflight, preview, export, comparison, QC result, and package manifest MUST include the source and result hash as appropriate.

Golden fixtures MUST prove byte-for-byte parity across Rust, browser JavaScript, MCP TypeScript, persisted reload, and process restart, for both Rust-authored fixture bytes and a projection built by the JavaScript adapter from real editor state. Every fingerprint that is compared across the bridge MUST use the canonical serializer; locale-dependent ordering is prohibited.

### 9.4 Snapshot retention

The persistence layer MUST retain a content-addressed canonical project snapshot, keyed by canonical hash, for every verified save, for 90 days (audit owner decision 9). Comparison, review, and package operations MUST resolve historical states from this store or from a preflight receipt's embedded before and predicted snapshots. An operation whose required historical state cannot be loaded MUST fail with `COMPARISON_SOURCE_UNAVAILABLE`; it MUST NOT substitute the current state.

## 10. Explicit save barrier and reload verification

Audit reference: section A, `Save barrier`.

The save tool is a correctness barrier, not a UI shortcut. It MUST:

1. Validate exact project, scene, connection identity, revision, and expected canonical hash.
2. Join all earlier queued writes for the project.
3. Prevent an autosave or later dirty event from being mistaken for completion of the requested barrier.
4. Atomically persist project state, media identities, and storage metadata.
5. Open fresh storage handles after commit.
6. Reload project and referenced media without activating or mutating the editor.
7. Recompute the canonical hash from fresh readback.
8. Verify the requested hash, persisted hash, and readback hash are identical.
9. Return only after an immutable save receipt is durably committed.
10. Be a no-op when nothing changed. If no dirty generation is pending and the last committed envelope's canonical hash equals the requested hash, the barrier MUST NOT create a new write version. It MUST still verify by fresh readback and MUST return a receipt bound to the existing write version. An explicit save MUST NOT invalidate a preflight receipt for an unchanged project.
11. Commit the save receipt atomically with the project envelope, or embed the receipt identity in the envelope so that a retry after receipt loss reconstructs an identical receipt.

The receipt MUST include project and scene identity, source session revision, durable write version, canonical hash, readback hash, storage schema version, operation ID, receipt ID, connection identity, persisted/completed timestamps, and checksum.

Exact retry of a completed save MUST return the same result, including the same write version and receipt ID, even when the receipt commit was lost. Changed reuse of an operation ID MUST be rejected. Corrupt, truncated, deleted-middle, or unsupported-version receipts MUST fail explicitly. Export, preview, preflight, comparison, QC, and packaging MUST bind to a verified save receipt unless their contract creates and verifies an equivalent barrier itself.

## 11. Durable idempotency and operation history

Audit reference: section A, `Idempotency` and `Operation history and audit trail`.

### 11.1 Mutation boundary

Every mutation of editor state, provider state, filesystem artifacts, worker state, jobs, batches, review records, or packages MUST cross one durable operation boundary before its first side effect.

The boundary MUST:

- Require an explicit operation ID for v2 mutations.
- Compute a semantic request fingerprint that excludes only documented transport locations.
- Claim operation identity atomically across processes.
- Return the exact terminal result for an exact retry.
- Reject changed semantic reuse.
- Fence stale workers and live owners.
- Represent uncertain completion after process or connection loss.
- Recover using durable receipts and authoritative readback without blindly redispatching side effects.
- Offer a typed resolution operation for an operation left uncertain: it compares fresh readback with the recorded before state and marks the operation applied, not-applied, or conflicted, appending the decision to history.

The ledger MUST also support a non-mutating `verification` operation kind that records tool calls, receipt identities, capability hash, and outcome without a mutation boundary, so that read-only acceptance runs (section 26.1) leave durable history.

### 11.2 Ledger durability

The ledger MUST use an append-only, versioned, checksummed record and event model. It MUST survive MCP restart and concurrent processes. Reads MUST validate integrity, including event-chain and head/tail consistency. Schema migrations MUST be transactional and versioned. Busy handling MUST be bounded and diagnosable. Lease fencing MUST use a heartbeat timestamp in addition to process liveness so that a reused process ID cannot fence an operation forever.

### 11.3 Operation record

Each record MUST expose:

- Actor and operation identity.
- Tool and semantic request fingerprint.
- Project and scene identity.
- Requested and execution connection identity.
- Before and after session revision, write version, and canonical hash where applicable.
- Status and disposition.
- Affected objects derived from authoritative before/after state.
- Native command, undo, redo, checkpoint, job, provider, save, and artifact relationships.
- Provider and renderer provenance.
- Terminal diagnostics and typed errors.
- Timestamps and immutable event sequence.

History queries MUST support bounded pagination and stable cursors. A filtered history result MUST never omit records because of process-memory state.

## 12. Dry-run validation and deterministic plan diffs

Audit reference: section A, `Dry-run and plan validation`; section C for timeline expansion; audit dependency map.

### 12.1 Separate preflight contract

Dry-run MUST be a separate public operation, not a boolean on the mutation tool. A preflight evaluates a complete raw edit plan against an exact, verified, saved source and returns a durable immutable receipt. It MUST NOT mutate project state, media state, persistence, playback, selection, history, undo/redo, or provider state.

The request MUST bind:

- Contract and bridge protocol v2.
- Exact connection identity.
- Preflight ID.
- Project and scene ID.
- Session revision.
- Canonical project content hash.
- Durable write version.
- Save operation and receipt IDs.
- Human description.
- Ordered raw operations.
- Warning policy.
- Provider execution policy, which MUST be `forbidden` for edit-plan preflight.
- Cost policy. On edit-plan preflight this field is reserved and has no effect, because provider execution is forbidden and cost is therefore always not applicable; it exists for a future job-planning preflight kind.

The scene ID MAY name a non-active scene. Preflight MUST evaluate against the persisted state of that scene without activating it; the predicted snapshot MUST preserve the persisted active scene; and the diff MUST list the target scene as a changed object.

### 12.2 Deterministic evaluation

The Rust domain evaluator MUST simulate operations sequentially. Later operations observe earlier predicted results. It MUST cover every edit-plan operation variant accepted by the corresponding apply contract.

Evaluation MUST:

- Validate every reference, range, track role, relationship, transition, mask, effect, media identity, and invariant.
- Allocate stable deterministic IDs for every created top-level and nested object.
- Resolve implicit placement, automatic tracks, ripple expansion, group/link expansion, compound membership, keyframe splitting, transition changes, source-audio changes, and other ambient editor behavior into explicit operations.
- Reject a plan containing a semantically invalid operation.
- Reject unintended silent no-ops, while allowing only explicitly declared idempotent no-op semantics.
- Produce a complete predicted canonical project projection and hash.
- Produce a deterministic diff and summary from canonical before and predicted state.
- Report warnings, provider requirements, the capability snapshot obtained from the section 7.2 tool (never synthesized), and exact, bounded, unavailable, or not-applicable cost.

### 12.3 Browser-materialized caption layout

Text wrapping and caption geometry depend on actual font readiness and browser measurement. The browser adapter MUST materialize this platform-specific evidence without taking ownership of domain policy.

For any plan that inserts or changes text, captions, font descriptors, canvas geometry, safe zones, or per-line bubble settings, preflight MUST:

1. Require the exact font family, style, weight, and stretch descriptors to be loaded, using the same readiness procedure as section 16.1 (load, check, exact face match).
2. Record matched-face metadata with the same identity scheme as preview receipts, and a byte hash when the face was loaded from bundled bytes (section 18.1).
3. Measure wrapping and line boxes by calling the identical exported measurement function the renderer uses, named in the versioned contract, on a context configured identically. A separate measurement implementation that agrees by convention is not acceptable.
4. Return per-line text, line count, per-line bounds, baselines, per-line bubble geometry, overflow/clipping status, safe-zone intersections, and measurement environment provenance.
5. Incorporate materialized layout results into the predicted state or a hash-bound layout evidence attachment, according to the versioned contract.
6. Recompute or reject if canvas, font readiness, renderer, or content changes before apply.

The result MUST be deterministic for the recorded environment. A browser layout result that differs from the Rust evaluator's structural assumptions MUST reject the preflight rather than silently substituting behavior. A golden test MUST prove, for every caption fixture, that the materialized geometry equals the geometry the renderer measures at render time, including animation-resolved background parameters.

### 12.4 Deterministic diff

The preflight result MUST contain:

- Full canonical before and predicted snapshots, or content-addressed references to them.
- Before and predicted canonical hashes.
- Plan hash, preflight hash, diff hash, capability snapshot hash, and request fingerprint.
- Created, deleted, updated, moved, trimmed, split, related, and reordered object IDs.
- Field-level old and new values.
- Timing changes in canonical ticks.
- Ripple consequences and gap/overlap changes.
- Group, link, compound, transition, mask, effect, keyframe, and attachment consequences.
- Track and scene consequences.
- Duration and canvas consequences.
- Warnings and rejected constraints.
- Browser-materialized caption layout evidence when relevant.
- Provider requirements and cost result.
- A no-mutation proof.

Ordering MUST be canonical and independent of map insertion order, locale, process, operating system, or database row order.

### 12.5 No-mutation proof

Preflight MUST sample a before and after observation containing at least:

- Active project and scene.
- Session revision, durable write version, canonical hash, and persistence fingerprint. The persistence fingerprint is the canonical hash of the persisted envelope metadata, the save receipt identity, and the sorted list of media asset identity records (ID, byte size, last-modified, source fingerprint, source identity).
- Save receipt identity.
- Connection identity.
- Playhead and playback state.
- Selection fingerprint.
- History, undo, and redo fingerprint.

Any change MUST return `STATE_CHANGED_DURING_PREFLIGHT` or a more specific typed conflict. No validated receipt may be written for a changed observation.

### 12.6 Durable preflight receipt

The receipt MUST be written before the public response. It MUST be immutable, checksummed, independently queryable, restart-safe, and append-only. An exact request after response loss MUST recover the receipt without reevaluating. Changed reuse of a preflight ID MUST fail. Concurrent claims MUST evaluate at most once.

Preflight receipts are read-only evidence and MUST remain separate from the mutation ledger, while carrying links sufficient to connect a later apply operation.

## 13. Exact apply atomicity, rollback, and undo

Audit reference: section A, `Revision-checked atomic edit plans`, `Idempotency`, and `Undo`; section C for edit behavior.

A v2 apply MUST consume an exact validated preflight receipt. Until the preflight milestone is deployed, a v2 apply without a preflight receipt MUST verify `expectedProjectContentHash` against the live canonical hash in the browser before any command executes and MUST reject on mismatch with `CONTENT_HASH_CONFLICT`. Once the preflight milestone is deployed, `opencut_apply_edit_plan` MUST reject any v2 request without a preflight receipt with `PREFLIGHT_REQUIRED`. With a receipt, it MUST verify:

- Receipt integrity and schema version.
- Plan, preflight, diff, capability, source, and request hashes.
- Exact project, scene, editor instance, current session/generation policy, session revision, canonical hash, durable write version, and save receipt binding.
- Browser-materialized layout evidence when applicable.
- The complete ordered resolved operation list, including deterministic object IDs.

Apply MUST use explicit resolved behavior. It MUST NOT depend on unrecorded ambient ripple, automatic track selection, random IDs, selection state, playhead, UI focus, or current locale.

The complete plan MUST execute as one native command transaction and create exactly one undo entry. If any operation fails before commit, the editor MUST restore the exact before state with no history entry, revision change, save, or partial side effect. If post-apply reconciliation does not produce the predicted canonical hash, the transaction MUST roll back and return a typed prediction mismatch. If rollback itself fails, the operation MUST become a high-severity uncertain state with diagnostics and no false success.

Before committing the native transaction, apply MUST cross the explicit save barrier and verify the persisted readback; nothing fallible may run after the commit. The terminal result MUST include the resulting revision, canonical hash, write version, save receipt, authoritative affected objects, and operation record. Exact retry MUST not execute a second native command or create a second undo entry.

Apply MUST accept a receipt whose durable write version, canonical hash, and save receipt match the fresh persisted readback even when the live session revision differs after an editor restart, provided the live canonical hash equals the receipt's source hash. It MUST reject when the live hash differs. Apply MUST accept a non-active target scene and MUST leave the previously active scene active afterwards.

Production parity MUST include history listing with operation IDs, descriptions, and affected objects, redo, bounded multi-step undo, and named checkpoint and restore. Each MUST be ledgered, revision-checked, hash-aware, and readable in history.

Implementation status (2026-09-04, issue #25): the browser automation bridge now
exposes its exact native command-history state and performs bounded undo, redo,
and position restore. MCP persists checksum-verified named checkpoint metadata and
the normal append-only operation records across server restarts. Native command
objects remain editor-session-local: restore requires the recorded editor session
and a reconstructible ordered command chain, and returns `history-diverged` after
reload, session loss, or chain divergence rather than attempting to rebuild
project data from metadata. Public stdio coverage exercises the complete workflow,
operation-history relationships/affected objects, restart persistence, and this
fail-closed boundary against managed Chrome.

## 14. Project, scene, bookmark, track, and media lifecycle

Audit reference: section B.

### 14.1 Projects

MCP MUST support list, create, open, read, rename, duplicate, and delete.

- Project IDs are durable and never inferred from names.
- Rename defines normalization and collision behavior.
- Duplicate defines whether media bytes are shared by content identity or copied, while producing independent project and scene identities.
- Delete defines active-project fallback and recoverability.
- Every mutation is ledgered, idempotent, save-verified, and readable.

### 14.2 Scenes

MCP MUST list every scene and expose current/main flags, deterministic order, canonical hash, and duration. It MUST create, clone, switch, rename, delete, set main, and reorder scenes.

Preflight, apply, preview, export, comparison, QC, and package operations MUST accept explicit scene identity and MUST work for a non-active scene without mutating active UI state. Deleting the main or active scene requires a typed replacement policy.

### 14.3 Bookmarks, notes, and markers

Bookmarks MUST have stable IDs, scene identity, exact time or range, color, note, and deterministic order. The stable ID MUST be added to the native model first (section 9.2). CRUD and query are revision-checked and appear in canonical state. Review annotations MAY link to project bookmarks, but the review record remains immutable evidence and the bookmark remains editable project state.

### 14.4 Tracks

MCP MUST support add, remove, rename, reorder, duplicate, mute, hide, legal role changes, and main-video-track control.

- Removing an occupied track requires an explicit reject, move, delete, or cascade policy.
- Track order is canonical and renderer-significant.
- Main-track replacement MUST validate duration, canvas, and downstream relationship consequences.
- Track mutations MUST be visible in snapshots and dry-run diffs.

### 14.5 Media bin

MCP MUST support:

- Import without timeline placement.
- Instantiate an existing asset by stable asset ID.
- List assets and every usage, including timeline, compound, matte, replacement, provider, and package references.
- Rename metadata without changing byte identity.
- Relink or replace with compatibility checks and an explicit consequence diff.
- Delete unused assets and explicitly cascade used assets only when requested.

Every local asset MUST have a content identity. Remote ingest is out of scope (section 4).

## 15. Timeline construction and organization

Audit reference: section C.

All existing and new timeline behavior MUST be represented in typed preflight and resolved-apply contracts. Production parity includes:

- Typed insertion for text, captions, graphics, stickers, adjustment layers, and media instances.
- Move, trim, split, delete, constant retime, parameters, and relationship scopes.
- Relationship-aware ripple delete, trim, and split.
- Duplication, groups, links, and compounds.
- Insert, overwrite, lift, extract, close-selected-gap, and close-all-gaps primitives.
- Stable selector expansion and richer queries.
- Align, distribute, batch trim, batch style, and batch timing transforms.

Timeline queries MUST support bounded results, stable pagination, exact revision binding, range relationships, dependency graphs, nearest-cut queries, caption search, and filters by ID, name, media identity, effect, mask, group, link, role, mute/hidden state, and source fingerprint.

Compound behavior MUST preserve recursive canonical state. Advanced nested-timeline editing and reusable component workflows remain governed by their audit classification and MUST not be implied by basic create/break-apart support.

## 16. Preview, comparison, and review evidence

Audit reference: section I and the preview branch of the audit dependency map.

### 16.1 Exact-time frame

An exact frame request MUST bind project, scene, connection identity, revision, canonical hash, write version, save receipt, exact rational or canonical-tick time, canvas, renderer configuration, and output format.

The renderer MUST use the export-quality composition path and shared integer frame scheduler. It MUST not seek approximately or infer a display playhead. It MUST preserve active project, scene, playback, selection, and history state.

The durable receipt MUST include:

- Source and execution bindings.
- Requested time and resolved source/frame timing.
- Canvas and pixel format.
- Font readiness and matched-face provenance, with a byte hash for every face served from bundled bytes.
- Renderer and capability provenance, including a render-environment fingerprint: compositor backend and adapter, surface texture format, browser version, and WASM artifact hash.
- PNG hash, decoded RGBA hash, dimensions, byte count, and artifact location.
- Editor-state before/after evidence using the same observation set as section 12.5, including active scene and history activity sequence.
- Checksum and operation linkage.

### 16.2 Range preview

A range request MUST produce a bounded frame sequence or short review clip with exact per-frame timestamps and hashes. It MUST support cancellation and progress, preserve audio when requested, and record frame schedule, dropped/duplicated-frame policy, codec, and artifacts. The range MUST be bounded by configuration with defaults of 10 seconds and 300 frames so it cannot accidentally become an unbounded export; the limits MUST appear in the capability response.

### 16.3 Before/after comparison

A comparison MUST bind two immutable revision/hash/save-receipt sources, each loaded from the snapshot store of section 9.4, and render the same declared times or range with compatible renderer settings and the same frame schedule. It MUST produce:

- Both source artifacts.
- Side-by-side or wipe artifact where requested.
- Pixel diff artifact.
- Per-frame and aggregate metrics, including declared tolerance.
- Regions exceeding tolerance.
- Audio comparison metrics when audio behavior changed.
- A durable receipt linking both project states and their operation history.

A comparison is invalid if it silently scales, color-converts, substitutes fonts, or changes frame timing between sides. Any normalization MUST be explicit and recorded.

### 16.4 Structured review annotations

Annotations MUST be immutable, append-versioned records tied to a hash-locked frame, range, or export. They MUST support timestamp or range, normalized region, category, severity, status, reviewer, notes, resolution operation, replacement evidence, and optional bookmark link.

The system MUST distinguish automated findings from human findings and record the detector/model provenance of automated findings. Resolution MUST append a new state rather than rewrite history.

### 16.5 Watermark evidence

Watermark inspection MUST support a declared sampling policy, full-frame samples at required opening, middle, and ending points, and explicit inspection of all four corners. The final exported bytes require their own inspection even if previews were clean. Automated detection MAY assist but does not replace a required human review unless the configured policy explicitly permits it.

## 17. Persistent jobs, recovery, diagnostics, and provenance

Audit reference: sections J and K.

### 17.1 Generic job model

All long-running export, matte, tracking, transcription, cleanup, analysis, synchronization, range preview, QC, comparison, and package work MUST use one durable job model.

A job MUST include:

- Job and operation identity.
- Type and schema version.
- Project, scene, revision, canonical hash, write version, and save receipt preconditions.
- Semantic input hash and capability snapshot hash.
- Provider and renderer policy.
- Priority, resource class, concurrency group, and optional schedule.
- Attempt policy, retryable error classes, maximum attempts, and bounded backoff.
- Progress units, phase, completed/total, ETA confidence, and heartbeat.
- Checkpoints, logs, diagnostics, artifacts, and provenance.
- Cancellation request and observation timestamps.
- Terminal state and attachment transaction, if any.

### 17.2 Lifecycle

Required states include `queued`, `starting`, `running`, `cancelling`, `cancelled`, `succeeded`, `failed`, `blocked`, and `recovery-required`, with explicitly legal transitions.

On restart, the supervisor MUST distinguish a dead worker from a slow or disconnected observer. Interrupted work MUST resume from a verified checkpoint, restart a safe attempt, or enter recovery-required. It MUST never be reported successful from a stale heartbeat, and it MUST NOT requeue a running job without first reconciling any partial artifact against the job's staging manifest.

A job in `recovery-required`, or whose provider outcome is unknown, MUST be resolvable through a typed operation, `rerun-as-new-attempt` or `mark-failed`, that preserves the original attempt history under the same job identity. A job MUST never become a permanent dead end.

### 17.3 Cancellation

Cancellation MUST work for queued and running jobs. A running renderer or provider MUST observe a cancellation signal within a declared bound. The contract MUST define whether partial artifacts are deleted, quarantined, or retained for diagnostics. Terminal cancellation is durable and idempotent. Cancellation MUST not leave a partially attached project artifact.

### 17.4 Retry and queue policy

Retry MUST be explicit for failed jobs, limited by typed policy, and preserve attempt history. Within one instance, jobs run as an ordered queue because the compositor is a single exclusive lease; the queue depth, running job, and estimates MUST be discoverable. Parallelism is achieved with additional instances (section 8.1). Resource exhaustion MUST produce an actionable degraded or blocked reason, not an indefinite hang.

### 17.5 Runtime diagnostics

The health surface is the capability tool of section 7.2. It MUST report build identity, instance identity, storage integrity, schema versions, bridge identity, editor reachability with a plain reason when the web editor is not running, compositor backend and whether it is the pinned one, WASM status and hash, codecs, font readiness, provider/model cache, disk capacity, job queue state, and recent bounded failures. It SHOULD provide a non-mutating sample decode/render/probe. Output MUST redact secrets.

## 18. Production editing behavior

Audit reference: sections D through H and J, plus `Exact Simple Media workflow gaps`.

### 18.1 Captions, text, and subtitle files

Production parity MUST include:

- Caption insertion and direct correction.
- Deterministic target track, name, initial style, and font descriptor.
- Font catalog and readiness checks.
- Reusable social-caption style presets.
- Merge, split, rechunk, shift, overlap repair, reading-speed enforcement, and selector-based restyling.
- Speaker styling and word-level highlighting.
- Independent per-line caption bubbles with measured padding, radius, fill, and opacity.
- Safe-zone and clipping validation.
- Captions-on and captions-off render overlays without project mutation.
- SRT and WebVTT behavior already present, plus ASS round-trip for the supported style subset enumerated in the audit row `Subtitle import`, with a structured loss report for every feature that row lists as dropped.
- Sidecar and transcript JSON output when required by a delivery package.

Fonts required by named presets MUST be bundled with the service, served from local files, and hashed by bytes; the managed editor MUST NOT fetch fonts from third-party hosts at run time. The owner chose the font set on 2026-09-04 (issues #14 and #21): TikTok Sans and Montserrat, both under the SIL Open Font License, bundled under `apps/web/public/fonts/bundled` and pinned by SHA-256 in `apps/web/src/fonts/bundled-fonts.ts` (audit owner decision 6). No commercial face is bundled.

Preview and export MUST use the same font descriptors, wrapping rules, line geometry, and bubble geometry. Browser-materialized preflight evidence in section 12.3 is required before a caption-heavy plan can be considered deterministic.

### 18.2 Visual effects and color

The exact realistic filter values already represented in the audit MUST remain discoverable as a stable preset and render identically in preview and export.

Production parity also requires stable, discoverable, typed implementations of the named Simple Media treatments identified in audit section E: Film Frame, Play Pendulum, Technicolor Flash, Scanner Bar, Glitch, Chromatic, Dark Night, Mirror, required body or meme treatments, and exact Pull In, Pull Out, and Swipe Left behavior.

Each treatment MUST define defaults, parameter ranges, applicability, persistence, renderer behavior, and reference visual tolerances. A similarly named effect is not sufficient. Implementation of a treatment MUST NOT start until its audit row records the owner-supplied reference clip or frame and a numeric tolerance (audit owner decision 5). This work is low priority and is scheduled after the foundations, lifecycle, evidence, and job milestones.

### 18.3 Transitions, keyframes, motion, and compositing

Transitions MUST be discoverable through a catalog with stable IDs, constraints, duration rules, and compound-boundary policy. Preview and export parity MUST be tested across boundaries.

Existing simple keyframes remain backward compatible. Advanced curve editing, tangent and extrapolation controls, keyframe copy/paste, time transforms, and reusable motion presets are optional for the first release (audit owner decision 4).

Chroma key and track mattes are production-critical at low priority for green-screen work and are scheduled last in the production-editing sequence (audit owner decision 2). Broader 3D, parenting, motion blur, expressions, particles, and richer graphics remain P2.

Authored masks MUST retain stable IDs, deterministic stack order, typed geometry and feather/expand/invert controls, keyframes, snapshot readback, and preview/export parity. Mask-to-tracker binding MUST be explicit and reversible. Repair paint and garbage mattes belong to the post-parity background-removal project (section 22).

Subject tracking is not part of the background-removal deferral. Production parity requires a ready bundled tracker with model provenance, CPU fallback, deterministic caching, first/last sample validation, and real-video evidence. Raw boxes, confidence, occlusion state, source-time mapping, correction keys, and provider provenance MUST persist as a reusable project object. Reframe, masks, and effects MUST be able to reference that object without discarding its samples.

Background replacement with a precomputed matte MUST be available before bundled matte generation. A high-level atomic operation MUST create or reuse the background layer, align range and duration, establish deterministic stacking, apply the matte attachment, and return comparison evidence. Deferred generation and refinement MUST return a truthful unavailable or provider-dependent status rather than weakening attachment behavior.

### 18.4 Audio

Production parity MUST include:

- Source-audio separation and non-destructive replacement.
- Clip volume, mute, fades, keyframed ducking, and mix gain.
- Loudness analysis and normalization.
- Waveform synchronization.
- Bundled audio cleanup with CPU fallback, cache, A/B evidence, and provenance.
- Stem separation or voice isolation with aligned linked outputs.
- Ordered editable clip, track, and master processing sufficient for dialogue, including EQ, dynamics, limiting, gating, de-essing, pan/channel behavior, and automation as required.
- Dialogue/activity-derived ducking from persistent VAD ranges.
- Audio QC with LUFS, true peak, clipping, channel layout, sample rate, silence, sync, expected-audio rules, and audible start/end checks.

Preview and export audio MUST be tolerance-tested against the same automation and effect graph. The mastering chain MUST be the same graph with the same parameters in preview and export, or the preview receipt MUST declare the difference. The export receipt MUST record whether mastering was applied and its parameters, and mastering must not contradict requested output specifications. Drift correction, timecode, and multicamera sync are optional (audit owner decision 3).

### 18.5 Retiming

Production parity MUST add a durable source-to-timeline time map for speed ramps, reverse, and freeze frames. It MUST define trim, split, keyframe, transition, caption, tracker, matte, and audio mapping at every boundary.

The model MUST represent the exact Montage behavior required by the workflow, independent pitch policy, and frame interpolation mode. The Montage curve is a named treatment under section 18.2 and its reference and tolerance MUST be recorded before implementation. Frame blending and optical flow remain optional, but fallback and diagnostic behavior MUST be explicit.

Implementation status (2026-09-04, issue #26): `opencut.time-map.v1` and `set_time_map` implement the general durable model, Rust-owned boundary/trim/split/query/tracker/audio semantics, independent dynamic pitch policy, source-time readback, and explicit nearest-frame fallback. `startTime` repositions a mapped clip without changing its map, `duration` crops only the right timeline edge, source trims remain fixed, and split slices/rebases both maps. Real Chrome evidence compares ramp, freeze, and reverse preview frames with export and compares the pitch-preserved preview audio with export. The named Montage treatment remains intentionally unspecified and unimplemented until the required owner reference and numeric tolerance are recorded.

### 18.6 Variant exports

Variants MUST use immutable render overlays rather than destructively rewriting the source project. An overlay MUST support:

- Canvas and safe zones.
- Per-element layout and reframe.
- Subject-safe focal policy.
- Track inclusion and exclusion.
- Caption style and position.
- Captions-on or captions-off selection.
- Thumbnail or cover-frame selection.
- Format, codec, FPS, quality, audio, and color settings.

Each receipt MUST record the requested overlay and fully resolved render specification, including the frame schedule. Export MUST build the scene from the same persisted readback bound by the save receipt, never from unpinned live editor state. Platform batches MUST produce independent results and failures without losing the batch manifest.

Delivery formats are MP4 and WebM only (audit owner decision 7). Encoding controls MUST be capability-probed and typed. The request and receipt MUST distinguish container, video codec, profile/level, rate-control mode, bitrate or quality target, pixel format, color primaries/transfer/matrix/range, audio codec/bitrate/sample rate/channel layout, and GOP policy. Unsupported combinations MUST be rejected or resolved through an explicit caller-approved fallback; the AAC-or-Opus fallback in particular MUST be recorded. The validator MUST report the actual encoder settings as read back from ffprobe, and MUST fail when audio was requested and no audio stream is present.

### 18.7 Structured QC

QC MUST be policy-driven by a versioned policy schema with numeric thresholds per check, and return pass, warn, or fail for each check. Required checks include:

- Container, codec, dimensions, frame rate, duration, and full decode.
- Video and audio stream presence according to expectation.
- File and sampled-frame hashes.
- Black and frozen frames.
- Caption clipping, text overflow, safe zones, and readable duration.
- Color range and requested color-space properties.
- Audio loudness, peak, clipping, channels, sample rate, silence, and sync.
- Transition, matte, and compositing artifacts where required.
- Watermark evidence and inspection status.
- Platform-specific limits.

Findings MUST identify exact timestamps or ranges, normalized regions where relevant, thresholds, measured values, and evidence artifacts.

### 18.8 Delivery package

The package service MUST create a collision-safe directory with deterministic naming and an immutable receipt. A package may contain:

- Source master and platform variants.
- Clean and burned-in-caption versions.
- Subtitle and transcript sidecars.
- Cover frames and thumbnails.
- Preview, comparison, review, QC, and watermark evidence.
- A manifest of source project, scene, hashes, save receipts, operations, jobs, providers, renderers, variants, files, byte sizes, and SHA-256 values.

The package MUST be verifiable after restart and on a fresh process. Missing, changed, or extra required files MUST fail validation.

## 19. Semantic transcript editing, silence, and editorial decisions

Audit reference: section L and the transcript branch of the audit dependency map.

### 19.1 Persistent transcript model

A transcript MUST be a first-class durable object rather than only generated text elements. It MUST contain stable segment and word IDs, source asset and clip identity, source and timeline timestamps, speaker, confidence, correction history, provider/model provenance, content hash, and mapping to generated captions and cuts.

Corrections MUST propagate according to an explicit policy. The original recognition result and correction history remain inspectable.

### 19.2 Search and word editing

MCP MUST search source and timeline transcripts with bounded results and stable selectors. A caller MUST be able to select words or ranges, preview the resulting edit decision, and apply it through the same deterministic preflight and atomic apply system.

Filler-word removal MUST be a reversible editorial decision, not an opaque destructive text transform.

### 19.3 Silence and speech detection

VAD/silence analysis MUST accept typed threshold, minimum duration, padding, channel, and source/range policy. It MUST return exact ranges, confidence, model provenance, and source mapping. Silence removal MUST first produce a dry-run cut plan with ripple and relationship consequences, then apply atomically with readback.

The same persistent speech ranges SHOULD be reusable for audio ducking, captioning, and editorial queries.

### 19.4 Reusable editorial decisions and EDL

Editorial decisions MUST be durable objects with stable identity, source ranges, intended targets, constraints, rationale, provenance, status, and generated edit operations. They MUST support revision-aware reapply and diff.

The system MUST support a versioned JSON interchange. EDL import/export MUST be added to the extent required by the active workflows, with an explicit loss report for concepts the target format cannot represent.

Shot/take analysis, OCR/object/face indexing, and multicam remain under their audit classifications. They MUST not block parity unless a production-critical workflow requires them.

## 20. Typed schemas, errors, readback, and compatibility

### 20.1 Schemas

Every public request, response, receipt, artifact manifest, event, and persisted record MUST have a strict versioned schema. Unknown fields SHOULD be rejected in v2 mutation contracts. IDs, hashes, times, bounded strings, collection sizes, and numeric ranges MUST be validated.

Generated types may bridge Rust and TypeScript, but runtime validation remains required at trust boundaries. The checked-in or built WASM declaration MUST match runtime output, including explicit `null` versus omitted fields.

### 20.2 Error taxonomy

Errors MUST be machine-actionable and distinguish:

- Schema or unsupported-version error.
- Capability unavailable or degraded.
- Authentication failure.
- Connection affinity conflict.
- Project, scene, revision, hash, write-version, or save-receipt conflict.
- Operation or preflight ID reuse.
- Validation rejection or warning-policy rejection.
- Provider blocked, failed, timed out, or cancelled.
- Renderer failed or parity mismatch.
- Persistence busy, corrupt, unsupported, or integrity failure.
- Apply rollback, prediction mismatch, or uncertain completion.
- Artifact missing, changed, invalid, or unsafe.
- QC failure and delivery-package failure.

Errors MUST include safe diagnostics, retryability, and the next permitted action. They MUST NOT expose secrets.

### 20.3 Readback

Every successful mutation MUST provide or link to authoritative readback. Every durable artifact MUST be queryable by stable ID after restart. List APIs MUST use bounded output and stable cursor pagination. Deletion or lifecycle APIs MUST define tombstone and historical-record behavior.

### 20.4 Compatibility

Existing v1 callers MUST continue to work unless a separately documented versioned contract change intentionally ends support. New v2 safety fields MUST not be silently optional. Persisted schema migrations MUST preserve old records or fail with an explicit supported migration path.

## 21. Security and local-file boundaries

The deployment is an isolated single-user PC (audit owner decision 13). Hosted-service hardening is out of scope. The remaining rules protect against the agent's own mistakes and against silent data drift, not against hostile users. The system MUST:

- Keep the bridge bound to loopback and authenticated with the existing token, so that a stray local process cannot drive the editor.
- Require absolute local paths and reject a path that does not exist or is not a regular file.
- Serve to the editor exactly the bytes that were hashed; import and provider attachment MUST read from an immutable staged copy, never from a path that may change between hashing and use.
- Never overwrite an existing export, subtitle, or package file.
- Never fetch remote media or fonts implicitly from a URL embedded in project state. Library audio whose bytes are absent MUST fail with a typed error, not a network fetch.
- Avoid shell interpolation. Provider protocols use structured arguments and stdin.
- Redact tokens and credentials from every log, receipt, and diagnostic.
- Apply bounded timeouts to every bridge request, provider invocation, and render.

Paid or credit-consuming operations require an explicit caller policy and cost evidence before execution.

## 22. Post-parity background-removal project

Audit reference: section F and the `Post-parity project` backlog entry.

The following work is outside the parity definition (audit owner decision 1) and forms the first project after parity is reached:

- Bundled background-removal model distribution and execution.
- Typed edge refinement beyond the preserved provider protocol.
- Temporal matte stabilization and frame-range regeneration.
- Repair paint, garbage mattes, and propagated repair.

Subject tracking is not part of this project; it remains a parity requirement under section 18.3, at low priority and with model selection deferred.

Throughout, the system MUST preserve:

- Absolute local precomputed matte attachment.
- Matte asset and source identities.
- Artifact hash and fingerprint.
- Channel and enabled state.
- Model ID/version and provider provenance.
- Persistence, canonical projection, snapshot readback, preview, and export behavior.
- The existing external matte provider protocol and its durable operation semantics.

Changes elsewhere MUST keep the following regression tests passing: matte attach and detach through the public transport; save, reload, and hash equality with an attached matte; preflight and apply of a plan touching a matte-bearing element; preview and export of a frame inside the matte range with a pixel comparison against a fixture; matte, wipe, and geometric masks composing together; and history readback of the attachment operation. The audit classification of the deferred rows remains unchanged until the post-parity project delivers them.

## 23. P2 posture

P2 begins only after every production-critical requirement satisfies its objective acceptance criteria and the Simple Media workflows pass on a fresh installation.

P2 currently includes:

- Multiple simultaneous editor sessions within one instance.
- Remote/resumable cloud ingest.
- Advanced nested sequences and reusable components.
- Insert/overwrite/lift/extract/close-gap primitives, alignment, and bulk timing/style transforms.
- Advanced keyframe curve editing and reusable motion presets.
- Drift correction, timecode, multicamera sync, shot and take analysis, OCR, object, face, and semantic indexing, and multicam.
- Parenting, motion blur, 3D, expressions, particles, and richer motion graphics.
- Optical flow and frame interpolation.
- Browser-independent rendering.
- MOV, HEVC, HDR, alpha, proxy, image sequence, still, and audio-only output.

An optional feature MUST NOT weaken a P0/P1 invariant, delay a production-critical dependency, or be described as parity evidence unless a named workflow has elevated it.

## 24. Test and evidence strategy

Audit reference: requirement-record conventions, every capability row's acceptance evidence, and the final parity definition.

### 24.1 Test pyramid

Every capability receives tests proportional to its risk:

1. **Domain unit tests.** Rust semantics, canonical ordering, ID allocation, validation, diffs, time maps, and invariants.
2. **Adapter unit tests.** Browser translation, layout materialization, command construction, rollback, renderer inputs, and storage adapters.
3. **Schema and contract tests.** Strict acceptance/rejection, version behavior, unknown fields, bounds, unsafe values, and Rust/TypeScript parity.
4. **Persistence tests.** Process restart, exact replay, changed reuse, concurrent claims, transaction faults, corruption, deletion, schema version, and stable pagination.
5. **Integration tests.** MCP handler through bridge, native editor commands, storage, provider supervisor, renderer, validators, and receipts.
6. **Public transport tests.** Invoke registered MCP tools over the actual stdio or deployed transport, never internal service methods only.
7. **Real renderer tests.** Use actual video, audio, fonts, effects, transitions, mattes, captions, save/reload, preview, export, full decode, and measured comparison.
8. **Fresh-install workflow tests.** Build and configure from documented prerequisites, discover readiness, edit through MCP, and produce the delivery result without manual browser editing.

All acceptance tests cited in the audit MUST pass in one unattended run from one documented command on the owner's PC, with no machine-specific paths and no order-dependent failures. Module mocks MUST be file-scoped or the affected suites MUST run in separate processes. The real-video milestone test MUST be part of that command, not an opt-in flag. The audit MUST cite the run that produced its evidence.

### 24.2 Required fault cases

Relevant milestones MUST test:

- Browser disconnect before dispatch, during work, and after durable receipt commit but before public response.
- MCP process termination and restart.
- Managed editor termination and restart.
- SQLite concurrent writers, busy timeout, stale lease, live owner, corruption, and unsupported schema.
- IndexedDB transaction abort, blocked upgrade, fresh handle readback, and corrupt receipt.
- Changed operation/preflight input reuse.
- Same editor with new session/revision and unchanged durable state.
- Wrong editor, project, scene, hash, write version, save receipt, capability snapshot, or artifact.
- Provider timeout, malformed output, partial output, cancellation, and recovery.
- Renderer cancellation, partial file, decode failure, font mismatch, and source state change.
- Apply failure in the first, middle, and final operation, plus prediction mismatch and rollback failure.
- Save receipt commit lost after the project envelope commit; exact retry returns identical write version and receipt ID.
- Browser crash after the project commit and before the operation receipt commit; the operation is resolvable through the typed resolution operation.
- Export process death with a partial upload; the retry reconciles the partial artifact and does not collide with the output path.
- Provider supervisor death; the job is resolvable through rerun-as-new-attempt.
- Lease owner process ID reused by an unrelated process.
- Copied browser profile presenting the same editor instance ID.
- File replaced between hashing and use.
- IndexedDB eviction or quota failure in the managed profile.
- Disk full during ledger append or artifact publication.
- GPU initialization failure; the capability response reports the renderer as unavailable rather than every render failing.
- Font missing from the bundled set; readiness fails rather than substituting a face.

### 24.3 Preview/export parity

Any capability affecting pixels or audio MUST be tested in both preview and export. Each tolerance MUST be stated per metric with the reason bitwise equality is or is not expected. Frames at opening, middle, and ending MUST be compared between preview and export, not only hashed. Visual evidence MUST also cover operation boundaries, effect peaks, caption wraps, transition intervals, matte edges, and safe-zone regions once those features exist. Audio MUST be verified by decoded-sample comparison against the preview mix at declared boundaries, plus integrated loudness and true peak within declared tolerance; a missing audio stream when audio was requested MUST fail.

### 24.4 Milestone end-to-end gate

Every milestone ends with an actual end-to-end video edit through public MCP tools. At minimum it MUST:

1. Start from a real local video with audio and immutable content identity.
2. Discover the running capability set.
3. Open or create the project.
4. Preflight a visible and audible edit when the preflight milestone is available.
5. Apply the exact plan atomically.
6. Save and reload through a fresh editor/storage context.
7. Prove the canonical hash.
8. Render exact frame evidence at relevant times.
9. Export and fully decode the complete result.
10. Verify decoded audio and compare opening, middle, and ending frames between preview and export.
11. Query the durable operation and artifact receipts after restart.

A milestone that changes renderer behavior MUST add direct preview/export comparison. A milestone that changes lifecycle or persistence MUST demonstrate restart readback. A milestone that changes providers or jobs MUST demonstrate durable progress, recovery, cancellation, and provenance as applicable.

## 25. Fresh installation, deployment, and runtime promotion

### 25.1 Documented fresh installation

The repository MUST document and automate, where practical, for Windows 10 and 11 only (audit owner decision 14):

- Runtime versions for Rust, Bun, Chrome or Edge, FFmpeg/FFprobe, and WASM tooling.
- Build commands, including the WASM build, and the rule that the WASM artifact hash is pinned in the build identity and verified at editor boot.
- Configuration files, environment variables, and the bridge token.
- Model cache paths and readiness probes (model selection deferred).
- Bundled font location (font set to be supplied by the owner).
- The start sequence: start the web editor by hand, then start MCP. The capability response MUST say plainly when the editor is not reachable.
- Instance-N configuration: bridge port, browser profile directory, and state directory per instance.
- MCP client configuration.
- Persistent data locations, 90-day retention, and recovery.
- Service start, stop, health, log, and upgrade commands.

A clean user profile on the owner's PC MUST be able to follow the documentation without relying on untracked files, a globally implicit command, a hardcoded developer path, or private process state.

### 25.2 Build identity

The running service MUST expose repository commit, dirty flag, build timestamp, WASM artifact hash, schema versions, and migration state through the capability tool.

### 25.3 Upgrade

Upgrading the running MCP is a documented script that builds, runs the full test command of section 24.1, restarts MCP hidden and non-interactively, and verifies the capability response reports the expected commit. Repository success MUST NOT be reported as an upgrade success until that verification passes.

## 26. Simple Media end-to-end acceptance workflows

Audit reference: `Exact Simple Media workflow gaps` and `Definition of production-ready MCP parity`.

### 26.1 Non-mutating v8b preflight

After the no-op save barrier, exact-time preview, dry-run, the capability tool, and build identity are implemented, validated, committed, pushed, and running, launch a fresh v8b preflight. The prior v8a operation has a durable blocked receipt and MUST NOT be reused or rewritten. V8a and v8b receipts are ledger records of the `verification` kind (section 11.1) under the versioned namespace `simple-media-preflight/v8`.

V8b MUST:

- Use new job, preflight, operation, and receipt identities in that namespace.
- Call only an explicit allowlist of capability, read, receipt-lookup, and dry-run tools.
- Make zero paid provider calls and consume zero generation credits.
- Apply no edit plan, create no timeline/project content mutation, run no production export, and perform no save. If no valid save receipt exists for the project, v8b MUST record a blocked result rather than save.
- Bind to the running server build identity and capability snapshot hash.
- Verify the deployed names and contracts for save, exact-time preview, edit-plan preflight, and capability rather than stale aliases.
- Prove the project canonical hash and durable write version are unchanged before and after the run.
- Execute a representative non-mutating dry-run and verify its no-mutation proof.
- Persist a terminal `verification` receipt that directly links the capability and preflight receipt identities and SHA-256 values.
- Verify terminal receipt lookup after a fresh MCP process read.

If any capability is absent or degraded, v8b MUST create a new blocked result with exact evidence. It MUST not alter v8a.

### 26.2 Complete production workflow

The final Simple Media workflow MUST run solely through MCP and durable jobs:

1. Discover readiness and prove every required dependency is ready.
2. Duplicate or create a project from a clean template.
3. Import source media into the bin, place and organize it across scenes/tracks, and add bookmarks.
4. Create a transcript, search/select source content, detect silence, and persist editorial decisions.
5. Preflight and atomically apply the complete edit.
6. Apply the exact realistic filter and required named effects, transitions, motion, masks, a precomputed matte, tracking, reframe, audio, retime, graphics, and captions.
7. Save, restart, reload, and verify the same canonical hash and write version.
8. Render exact frames, ranges, and before/after comparisons.
9. Record and resolve structured review evidence.
10. Render platform variants through immutable overlays.
11. Run structured video, audio, caption, safe-zone, watermark, and platform QC.
12. Produce and re-verify the delivery package after restart.

No manual browser edit, UI selection, timeline drag, hidden provider setup, unrecorded file substitution, or receipt repair is permitted. Starting the web editor by hand before the run is the only permitted manual step.

## 27. Observability

The system MUST make the following inspectable through MCP tools without reading internal source:

- Current build and capability hash.
- Connected editor identity and negotiated protocol.
- Active and recent operations with state, age, actor, project/scene, and disposition.
- Preflight receipts and no-mutation evidence.
- Save, preview, comparison, review, export, QC, and package receipts.
- Jobs with phase, progress, attempts, provider, artifacts, and cancellation state.
- Storage integrity and migration status.
- Provider and renderer readiness.
- Bounded recent diagnostics with correlation IDs.

Logs MUST use stable correlation IDs linking MCP request, operation, preflight, bridge request, native command, save, job, provider, renderer, artifact, and receipt, and MUST redact secrets. Metrics are not required.

## 28. Acceptance and release gates

A capability may be classified `Fully supported` only when all applicable gates pass:

1. **Contract gate:** strict typed schemas, version behavior, bounds, and errors.
2. **Native behavior gate:** real editor behavior exists and matches the contract.
3. **Persistence gate:** required state and receipts survive restart and corruption is detected.
4. **Safety gate:** identity, revision, hash, write version, save receipt, idempotency, and local-file policy are enforced.
5. **Readback gate:** public MCP readback proves the result.
6. **Capability gate:** discovery reports actual readiness and provenance.
7. **Preview/export gate:** visual or audio behavior matches through real rendering.
8. **Fault gate:** relevant disconnect, crash, cancellation, retry, and rollback scenarios pass.
9. **Public transport gate:** registered tools pass through the real MCP transport.
10. **Milestone E2E gate:** a real video edit completes, saves, reloads, previews, exports, decodes, and replays receipts after restart.
11. **Audit gate:** the audit row is immediately updated with classification, objective evidence, tests, current file-and-line references, and the identifier of the test run that produced the evidence.
12. **Delivery gate:** the coherent commit is pushed to the task branch and the running MCP is upgraded per section 25.3 when it affects the running service.

Production-ready parity has additional global gates:

- Every parity-required audit row (all P0 and P1) passes.
- No stale audit claim remains.
- The fresh-install instructions succeed on a clean user profile of the owner's PC.
- The complete Simple Media workflow succeeds without manual browser editing, with the hand-started web editor as the only manual step.
- The running MCP reports the expected build and capability set.
- Genuine external blockers are recorded with evidence and no unsupported completion claim.

## 29. Current delivery sequence

The implementation sequence follows dependency order, even where an older priority label reflects a broader release grouping:

1. Fix the correctness defects found by the 2026-09-02 review: hash verification on receipt-less v2 apply, no-op idempotent save, v1 mutation off by default, projection version 2 with the project ID, and test discipline (one unattended command, no order-dependent failures, no machine-specific paths).
2. Capability, readiness, and build-identity tool with pinned compositor backend and WASM hash.
3. Finish and validate deterministic preflight with receipt-consuming apply, non-active scene support, and caption materialization with font readiness.
4. Content-addressed snapshot retention, range preview, and before/after comparison on top of exact-time frame rendering.
5. One durable job model with running cancellation, explicit retry, progress, recovery, and resolution of uncertain outcomes.
6. Project, scene, bookmark, track, media-bin, and timeline lifecycle.
7. Production editing: captions and fonts (after the owner supplies the font set), variants, encoder recording, structured QC, delivery packaging, transcript and silence editing, redo and checkpoints, speed ramps, review annotations, then named treatments (after references are recorded), tracking and audio providers (after models are chosen), and finally chroma key.
8. Reaudit every requirement and run the fresh-install Simple Media workflow.
9. Begin P2 and the post-parity background-removal project only after parity is proven.

The immediate Simple Media gate is the validated combination of no-op explicit save, exact-time preview, deterministic dry-run, the capability tool, and build identity. All five MUST be present in the running capability response before v8b launches.

## 30. Decisions and open questions

These decisions are already part of this specification:

- The audit remains the status tracker; this document is the stable review contract.
- Dry-run is a separate operation with a durable receipt.
- V2 apply consumes the exact preflight receipt and resolved operation IDs.
- Rust owns platform-neutral semantics.
- Browser-specific caption/font layout is materialized and hash-bound, not guessed by Rust or omitted.
- Apply is one transaction, one undo entry, and prediction-checked.
- Save, preview, export, and artifacts are bound to canonical state and durable receipts.
- Long work converges on one generic durable job model.
- Variants are immutable render overlays.
- Every milestone ends with a public MCP real-video edit and renderer validation.
- Background-removal generation and refinement are outside parity and form the first post-parity project; matte attachment and provider protocols are preserved.
- P2 cannot displace parity-required work.
- The deployment is one Windows PC, personal use, one editor per instance, more instances for concurrency.
- The fourteen owner decisions of 2026-09-02 recorded in the audit are settled.

The following remain open and MUST be resolved before their dependent contracts freeze:

1. The reference clip or frame and numeric tolerance for each named Simple Media effect, motion preset, transition, and the Montage curve. Owner supplies from the course material; recorded per audit row before implementation.
2. The bundled font set. Owner supplies; the implementing agent asks before caption-preset work.
3. Which local provider models are approved for subject tracking, audio cleanup, stem separation, and VAD. Deferred; low priority.
4. Whether renders must be bitwise reproducible across driver updates on this PC or only within declared tolerance with a recorded environment fingerprint. Deferred; the fingerprint is required either way.
5. Which transcript or EDL interchange formats are required beyond the versioned internal JSON contract.

An unanswered question MUST become a typed unavailable or policy-required result where it affects execution. It MUST not be filled by an undocumented default.

## 31. Reviewer checklist

An adversarial reviewer should answer every item with `pass`, `fail`, `unclear`, or `not applicable`, and cite evidence for each nontrivial answer.

### Product and scope

- Does the specification exactly preserve the audit as current-status authority?
- Does the parity definition cover every production-critical audit row and every Simple Media blocker?
- Are non-goals and P2 boundaries narrow enough that they cannot hide a required workflow?
- Is deferred background removal described honestly and compatibly?

### State and safety

- Are server, editor, session, connection generation, project, and scene identities distinct?
- Are session revision, durable write version, canonical hash, and save receipt distinct?
- Does every mutation cross a durable idempotency boundary before side effects?
- Can exact retries recover after browser, MCP, or worker failure without duplicate effects?
- Can changed reuse, stale affinity, wrong hash, wrong write version, and corrupt evidence ever be accepted?

### Dry-run and apply

- Does preflight cover every apply operation with sequential semantics?
- Are deterministic IDs allocated for all created and nested objects?
- Are ripple, relationship, compound, transition, keyframe, mask, effect, audio, and track consequences explicit?
- Is browser-materialized caption layout bound to exact font and renderer evidence?
- Is the no-mutation proof complete?
- Does apply consume the exact receipt, create one undo entry, and roll back on any mismatch?
- Is a post-apply canonical hash compared with the predicted hash before success?

### Lifecycle and editing breadth

- Can projects, scenes, bookmarks, tracks, media-bin assets, and timeline objects complete their required lifecycles?
- Are clean templates and independent platform variants possible without destructive source edits?
- Do caption, visual, motion, transition, audio, and retime contracts reproduce the named workflows exactly?
- Are semantic transcript, silence, and editorial decisions durable, searchable, and reversible?

### Rendering and evidence

- Are exact frames and ranges scheduled deterministically?
- Do comparisons bind immutable before/after states and compatible render settings?
- Are review annotations immutable and resolvable through linked evidence?
- Does every visual/audio feature prove preview/export parity with declared tolerances?
- Are watermark, caption, safe-zone, video, audio, and platform checks represented in structured QC?

### Jobs, providers, and runtime

- Can all long work survive restart with truthful state?
- Can running work be cancelled and partial artifacts handled safely?
- Are retry, progress, resource limits, and provenance explicit?
- Does readiness prove actual provider/model/codec/renderer availability without paid work?
- Does every render receipt record the compositor backend, browser version, and WASM hash actually used?
- Can the running MCP be upgraded with the documented script and verified through its capability response?
- Can a fresh installation succeed without untracked developer state, with starting the web editor as the only manual step?
- Can several instances run side by side with distinct ports, profiles, and state directories?

### Tests and release

- Does each milestone include a real video/audio edit through public MCP transport?
- Are crash, response-loss, concurrent-writer, corruption, rollback, and changed-input cases tested?
- Are readback and receipts verified after restart?
- Are audit classifications changed only after all gates pass?
- Are commits coherent, pushed, deployed, and tied to the running build identity?
- Does v8b use fresh identities, preserve v8a, avoid credits, avoid content mutation, and record durable evidence?

Any `fail` or unresolved `unclear` on a production-critical item blocks a production-parity claim.
