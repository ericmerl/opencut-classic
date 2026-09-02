# OpenCut Classic MCP capability gap audit

Date: 2026-09-01
Branch audited: `codex/issue-1-mcp-editor-bridge` at `54d3c088`

## Scope and method

This report defines "not supported by the MCP" as a capability for which the MCP server has no registered tool and no accepted `apply_edit_plan` operation. It distinguishes three cases:

1. Native editor capability not exposed through MCP.
2. MCP plumbing exists, but the capability still depends on a separately configured provider or has an operational limitation.
3. Desired workflow capability is absent from both MCP and the current native OpenCut Classic model.

The authoritative MCP surface is the registered tool list in `packages/mcp-server/src/index.ts:95-537`, the browser bridge request union in `apps/web/src/automation/bridge-client.ts:19-112`, and the edit-operation union in `apps/web/src/automation/types.ts:369-572`. The native editor comparison uses timeline types, commands, managers, registries, and renderer/export code in this repository.

## Current boundary in one sentence

The MCP can create and open projects, inspect one active scene, import local media, edit existing media/text/caption clips, apply clip effects and animation, perform several audio and matte workflows, and render durable MP4/WebM export jobs. It cannot yet construct or fully manage several native visual and organizational objects, especially graphics, stickers, masks, adjustment layers, scenes, bookmarks, tracks, project records, and multi-element editing workflows.

## Native editor capabilities that are not exposed by MCP

### 1. Graphics and stickers

- No operation inserts a native `GraphicElement`. OpenCut provides the native builder at `apps/web/src/timeline/element-utils.ts:175-194`, and graphic tracks accept graphic elements at `apps/web/src/timeline/types.ts:42-46`, but the MCP edit union has only `insert_text` and `insert_captions` insertion operations at `apps/web/src/automation/types.ts:369-401`.
- No operation inserts a native `StickerElement`. The builder exists at `apps/web/src/timeline/element-utils.ts:146-173`, and the element model stores `stickerId` plus intrinsic dimensions at `apps/web/src/timeline/types.ts:187-196`.
- No MCP tool lists graphic definitions, their parameter schemas, or previews. Native graphic lookup and default instance construction exist at `apps/web/src/graphics/index.ts:42-61`.
- No MCP tool searches or resolves stickers. Native sticker providers and resolution exist, including `resolveStickerId`, at `apps/web/src/stickers/resolver.ts:6-24`; the shapes provider maps square, circle, triangles, diamond, and star to native graphic definitions at `apps/web/src/stickers/providers/shapes.ts:21-41`.
- No MCP snapshot identifies a graphic's `definitionId`, a sticker's `stickerId`, or intrinsic sticker dimensions. `AutomationElementSnapshot` exposes generic type, name, timing, params, and optional media fields only at `apps/web/src/automation/types.ts:22-44`.

Impact: an agent cannot add callouts, boxes, circles, arrows built from shapes, flags, logos, decorative stickers, or shape-backed lower thirds without first rasterizing them externally and importing them as media.

### 2. Masks

- No operation creates, updates, reorders, inverts, or removes a native visual mask. The MCP's `remove_matte` is specifically for a generated clip matte, not the native `Mask[]` attached to video, image, and graphic elements.
- Native maskable element types are video, image, and graphic at `apps/web/src/timeline/types.ts:227-232`.
- Native OpenCut registers split, cinematic bars, rectangle, ellipse, heart, diamond, star, text, and freeform masks at `apps/web/src/masks/builtin/definitions/index.ts:41-77`.
- Native commands already support removing masks, toggling inversion, and editing freeform path points: `apps/web/src/commands/timeline/element/masks/remove-mask.ts:18`, `apps/web/src/commands/timeline/element/masks/toggle-mask-inverted.ts:29`, `apps/web/src/commands/timeline/element/masks/insert-custom-mask-point.ts:88`, and `apps/web/src/commands/timeline/element/masks/delete-custom-mask-points.ts:67`.
- No mask catalog or mask state appears in MCP project snapshots. `AutomationElementSnapshot` has `matte` but no `masks` field at `apps/web/src/automation/types.ts:22-44`.

Impact: agents cannot build split-screen composites with native masks, create shaped reveals, feather or invert a region, or edit freeform mask paths.

### 3. Adjustment layers and timeline effect elements

- No operation inserts an `EffectElement` on an effect track, even though OpenCut has a native builder at `apps/web/src/timeline/element-utils.ts:124-144`, an `EffectTrack` model at `apps/web/src/timeline/types.ts:48-52`, and an `EffectElement` model at `apps/web/src/timeline/types.ts:205-208`.
- `opencut_list_effects` and the `upsert_effect` operation address effects attached to individual visual clips. The tool explicitly calls them "clip effects" at `packages/mcp-server/src/index.ts:181-186`, and the operation requires a target `trackId` and `elementId` at `apps/web/src/automation/types.ts:469-476`.
- No operation updates parameters on an adjustment-layer effect element through its effect definition. Generic `set_params` is element-parameter based, while adjustment effects carry their definition parameters in the effect element's own `params` and require effect-aware validation.
- No snapshot field exposes `effectType` for an effect element at `apps/web/src/automation/types.ts:22-44`.

Impact: global or region-wide color grades, blurs, and future registered effects cannot be applied once as timeline layers. Agents must repeat clip effects on every target clip.

### 4. Scene management

- MCP reads only the active scene. The project snapshot contains singular `sceneId` and `sceneName` fields at `apps/web/src/automation/types.ts:148-164`.
- There is no tool to list all scenes, create a scene, switch scenes independently of projects, rename a scene, delete a scene, set the main scene, or reorder scenes.
- Native scene create, delete, and rename methods exist at `apps/web/src/core/managers/scenes-manager.ts:33-78`; native commands exist at `apps/web/src/commands/scene/create-scene.ts:6`, `apps/web/src/commands/scene/delete-scene.ts:6`, and `apps/web/src/commands/scene/rename-scene.ts:6`.

Impact: an agent cannot use scenes as alternate edits, sequences, versions, or multi-part deliverables, and cannot choose which scene is rendered through a scene-aware MCP call.

### 5. Bookmarks, notes, and edit markers

- No MCP snapshot returns bookmarks, and no operation creates, removes, moves, or updates one.
- Native bookmarks support time, optional note, color, and duration at `apps/web/src/timeline/types.ts:10-15`.
- Native scene manager methods toggle, remove, update, and move bookmarks at `apps/web/src/core/managers/scenes-manager.ts:113-158`.

Impact: agents cannot leave revision notes, mark hook/body/CTA beats, tag review issues, or preserve semantic edit markers in the project.

### 6. Project record lifecycle

- MCP can list, create, and open projects, but cannot rename, duplicate, or delete them. The registered project tools stop at open/read at `packages/mcp-server/src/index.ts:125-167`.
- Native project manager methods support delete, rename, and duplicate at `apps/web/src/core/managers/project-manager.ts:279-307`, `apps/web/src/core/managers/project-manager.ts:321-361`, and `apps/web/src/core/managers/project-manager.ts:363-482`.
- There is no MCP operation to change project name after creation.

Impact: automated variant generation cannot clone a template project or maintain project lifecycle without browser actions.

### 7. Track removal and incomplete track lifecycle

- MCP can add a caller-named track and set mute/hidden state, but cannot remove a track. Native track removal exists at `apps/web/src/commands/timeline/track/remove-track.ts:5`; native add, mute, and visibility commands are at `apps/web/src/commands/timeline/track/add-track.ts:10`, `apps/web/src/commands/timeline/track/toggle-track-mute.ts:6`, and `apps/web/src/commands/timeline/track/toggle-track-visibility.ts:6`.
- No operation changes a track's role or ordering among overlays/audio tracks. The current command set also has no dedicated durable track rename, duplicate, or reorder command, so those portions require native work as well as MCP work.
- MCP cannot explicitly designate or replace the main video track.

Impact: generated edits accumulate disposable tracks, and agents cannot deterministically control paint order or audio-track organization after creation.

### 8. Multi-element edit operations

- Delete, move, trim, split, retime, parameter, effect, and keyframe operations address one element at a time. Atomic plans can contain many operations, but there is no native-style selection set or group edit primitive.
- No MCP operation duplicates one or more elements. Native duplication exists at `apps/web/src/commands/timeline/element/duplicate-elements.ts:17-113`.
- No copy/paste operation exists. Native element paste exists at `apps/web/src/commands/timeline/clipboard/paste.ts:24-165`, and native keyframe paste exists at `apps/web/src/commands/timeline/clipboard/paste-keyframes.ts:87`.
- No group move or group resize operation preserves relative timing across selected elements. Native group movement is used by `MoveElementCommand` via `apps/web/src/commands/timeline/element/move-elements.ts:18`, and native grouped resize logic exists under `apps/web/src/timeline/group-resize/compute-resize.ts:26-151`.
- No batch trim-to-range, align, distribute, or gap-close operation is exposed.

Impact: repetitive montage construction, B-roll duplication, template repetition, and coordinated timing changes require large plans and manual ID bookkeeping.

### 9. Ripple editing

- The MCP can trim, split, delete, and move, but it cannot request ripple behavior or close downstream gaps automatically.
- Native UI state explicitly includes `rippleEditingEnabled` at `apps/web/src/timeline/timeline-store.ts:12-31`, and native ripple calculations are applied by the command manager from `apps/web/src/core/managers/commands.ts:4`.
- There is no plan-level ripple mode, ripple delete, insert edit, overwrite edit, lift, or extract operation.

Impact: dialogue cleanup and assembly edits cannot reliably preserve downstream sequence timing without calculating every subsequent move in the agent.

### 10. Media-bin management and library audio insertion

- `opencut_import_media` both imports and places one local file on the timeline at `packages/mcp-server/src/index.ts:286-305`. There is no import-to-bin-only option.
- No MCP operation inserts another timeline instance of an already imported media asset by `mediaId`.
- No MCP operation removes an unused media asset, renames it, replaces/relinks its source, or reports whether it is used. Native add and remove media commands exist at `apps/web/src/commands/media/add-media-asset.ts:12` and `apps/web/src/commands/media/remove-media-asset.ts:12`.
- The timeline model supports uploaded and library audio sources at `apps/web/src/timeline/types.ts:112-129`, but MCP accepts only an absolute local path for import and has no native library-audio browse or insert tool.

Impact: agents must re-import duplicate bytes for reuse, cannot clean the project bin, and cannot use native library sounds programmatically.

### 11. Discovery catalogs and schema introspection

Only effects have an MCP catalog. Missing catalogs include:

- graphics and graphic presets;
- stickers, providers, categories, search, and intrinsic size;
- masks, supported element types, and mask parameters;
- fonts and available font weights/styles;
- text styles and subtitle style fields;
- valid animation target paths per element/effect;
- transition types and their capability rules;
- track compatibility and element insertion rules;
- provider availability for matte generation, subject tracking, and audio cleanup.

The gap is visible at the bridge boundary: the only catalog method is `list_effects` at `apps/web/src/automation/bridge-client.ts:19-40`, dispatched at `apps/web/src/automation/bridge-client.ts:210-223`.

Impact: an agent must know undocumented internal identifiers before calling generic parameter, keyframe, transition, or asset operations. Invalid guesses are rejected only at mutation time.

### 12. Snapshot fidelity and complete round-trip state

The MCP project snapshot is not a complete serialization of the native project. It omits:

- all non-active scenes;
- scene bookmarks;
- element animations as structured channels, except the flattened `keyframes` summary;
- native masks;
- sticker IDs and intrinsic dimensions;
- graphic definition IDs;
- adjustment-layer effect types;
- track ordering metadata beyond the returned array order;
- media usage and richer source metadata;
- undo/redo depth and command history.

The snapshot contract is at `apps/web/src/automation/types.ts:22-44` and `apps/web/src/automation/types.ts:148-164`, while the native scene and element fields are at `apps/web/src/timeline/types.ts:18-25` and `apps/web/src/timeline/types.ts:165-216`.

Impact: even after new mutation operations are added, an agent cannot safely round-trip or diff these objects until the read model exposes their identity and state.

### 13. Undo/redo and history control

- MCP exposes one-step undo only at `packages/mcp-server/src/index.ts:273-284`.
- There is no redo, multi-step undo, history listing, named checkpoint, restore-to-revision, branch, or transaction preview/dry-run operation. Native redo is already available through the command manager at `apps/web/src/core/managers/commands.ts:70-87`.
- Revisions provide optimistic concurrency but are not addressable historical snapshots. The mutation result reports only current revision and current snapshot at `apps/web/src/automation/types.ts:582-603`.

Impact: agents cannot inspect what will be undone, recover an accidentally undone change, or compare alternative edit branches inside one project.

### 14. Timeline query limitations

- Query filtering is limited to time range, `trackIds`, and `elementTypes` at `apps/web/src/automation/timeline-query.ts:8-15`.
- There is no filter by media asset, name, effect, mask, tag, muted/hidden state, source URL, source fingerprint, overlap class, or semantic role.
- There is no full-text caption search, nearest-cut lookup, beat/marker query, or audio-silence query.
- Results are time-ordered with gaps/overlaps, but there is no dependency graph for transitions, mattes, replacement audio, or source-derived artifacts.

Impact: project-wide edits require fetching and filtering broad snapshots in the agent.

### 15. Advanced keyframe curve editing

- MCP supports creating, removing, and retiming keyframes, with interpolation selection, but it does not expose scalar Bezier handle editing, extrapolation modes, easing presets, copying/pasting keyframes, or bulk offset/scale of keyframe timing.
- Native animation types support linear, hold, and Bezier interpolation plus hold/linear extrapolation at `apps/web/src/animation/types.ts:59-67`.
- Native curve editing has a dedicated `UpdateScalarKeyframeCurveCommand` at `apps/web/src/commands/timeline/element/keyframes/update-scalar-keyframe-curve.ts:14`.

Impact: motion can be automated, but precise speed curves and reusable easing treatments still require UI work.

### 16. Text and subtitle workflow gaps

- Text insertion has no explicit target track, name, or initial style in its operation contract at `apps/web/src/automation/types.ts:370-375`. Styling requires a subsequent `set_params` call with pre-known internal parameter keys.
- There is no font catalog or font-loading tool.
- There is no reusable text-style preset, caption-style preset, batch restyle by predicate, or clone-style operation.
- Subtitle export supports only SRT and WebVTT at `apps/web/src/automation/types.ts:292-313`; imported ASS cannot be exported back to ASS.
- There is no operation for merging/splitting captions by words, shifting all captions, resolving overlaps, changing words-per-caption after transcription, karaoke/word highlighting, speaker assignment, or transcript correction mapped back to caption timing.
- There is no burn-in toggle because captions are ordinary rendered text elements. Excluding captions from a video export would require hiding their track before export and restoring it afterward.

Impact: caption creation is functional, but sophisticated reusable social-video subtitle treatments are not yet a high-level agent workflow.

### 17. Audio workflow gaps

- No equalizer, compressor, limiter, noise gate, de-esser, channel pan, channel mapping, pitch shift, voice isolation control, or audio-effect stack is modeled by MCP.
- `set_audio` is limited to volume, mute, and linear fade parameters at `apps/web/src/automation/types.ts:439-449`.
- Ducking accepts caller-supplied regions but there is no dialogue/activity detector tool to derive those regions automatically.
- Loudness normalization applies a uniform mix gain after analysis. It does not expose per-track buses, sidechain routing, or final limiter settings; the tool description states that it preserves relative clip levels at `packages/mcp-server/src/index.ts:203-217`.
- Clean audio is not self-contained unless a provider is configured. The tool explicitly routes through a configured external provider at `packages/mcp-server/src/index.ts:253-260`.
- Sync aligns one target to one reference by a single offset at `packages/mcp-server/src/index.ts:220-228`; there is no multicamera sync group, drift correction, time-stretch sync, or timecode sync.

Impact: the MCP covers core dialogue assembly and level normalization, but not a complete audio post-production chain.

### 18. Subject tracking and background removal limitations

- `opencut_track_subject` depends on a configured local provider at `packages/mcp-server/src/index.ts:424-431`. There is no provider discovery, model download/setup, target-object selector beyond the provider contract, multi-subject identity management, tracking correction, confidence visualization, or reusable tracking data object.
- Background removal is implemented as generating or attaching a foreground matte, not as a bundled one-click native model. `opencut_generate_matte` explicitly uses a configured external provider at `packages/mcp-server/src/index.ts:414-422`.
- The MCP has no background replacement composite operation. After attaching a matte, the agent must separately import and place the new background and manage layers.
- There is no garbage matte, edge decontamination, spill suppression, hair-detail refinement, matte paint/repair, temporal flicker repair, or matte preview/diagnostic tool.
- Attached mattes support only alpha or red channels through the native model at `apps/web/src/timeline/types.ts:101-113`.

Impact: the architecture can carry a generated background-removal matte, but dependable production background removal still requires provider setup and quality-control tooling.

### 19. Export variants and delivery packaging

- Export is limited to MP4 or WebM, four quality levels, optional supported frame rate, and include/exclude audio. The native export contract is at `apps/web/src/export/index.ts:4-21`, mirrored by the MCP schema at `packages/mcp-server/src/tool-schemas.ts:715-719`.
- There is no explicit output resolution override independent of project canvas, codec/profile/level, bitrate, CRF, pixel format, color space, HDR metadata, audio codec/bitrate/sample rate, hardware-encoder selection, keyframe interval, alpha output, GIF, image sequence, still-frame export, audio-only export, or proxy render.
- There is no one-call batch matrix for multiple aspect ratios, project variants, formats, qualities, captions-on/off, or audio-on/off. Jobs must be enqueued individually.
- A queued job can be canceled, but a running render cannot be interrupted, as stated at `packages/mcp-server/src/index.ts:478-485`.
- There is no pause/resume, retry policy, priority, concurrency setting, schedule, resource limit, or render-time estimate.
- Receipts support a single inspection status, but no structured QC annotations per frame, audio QC result, caption-safe-zone result, or automatic watermark detector. Human or vision review must be performed outside the MCP before recording status at `packages/mcp-server/src/index.ts:523-535`.
- There is no packaging tool for thumbnails, cover frames, subtitle sidecars, manifests, platform filenames, or upload-ready bundles.

Impact: one deterministic video render is supported well, but platform-scale variant generation and delivery orchestration remain manual at the tool-call level.

## Desired agentic workflow capabilities absent from both MCP and current native model

These should not be described as simple MCP exposure work because the underlying editor model does not currently provide them.

### 20. Persistent clip grouping, linking, and compound clips

- The native timeline has temporary multi-selection/group move behavior, but `TimelineElement` has no persistent group ID, link ID, parent compound ID, or nested timeline reference at `apps/web/src/timeline/types.ts:165-216`.
- Source-audio separation is a specialized video/audio relationship, not a general link model.
- There is no compound clip, nested sequence, synchronized group, multicam clip, or reusable timeline component.

### 21. Semantic editing and media intelligence

- There is no transcript-to-source search index, shot-boundary detector, scene classifier, object/face index, OCR index, semantic embedding search, duplicate-take detector, quality scorer, or automatic B-roll recommender in the native model or MCP.
- Timeline transcription produces captions from the current mix, but it does not retain word-level source provenance as an editable transcript model. Its MCP result returns transcript text, segment count, caption count, and created element IDs at `apps/web/src/automation/types.ts:326-338`.

### 22. Advanced compositing and motion graphics

- There is no chroma key, luma key, track matte routing, motion blur, 3D transform/camera, parenting, expressions, particle system, vector path animation, text-on-path, or template variable system in `TimelineElement` at `apps/web/src/timeline/types.ts:165-216`. Standard element blend modes are supported and are not a gap.
- Native masks and effects provide a foundation, but these capabilities require renderer and project-schema work before MCP tools can expose them.

### 23. Speed ramps, reverse, freeze frames, and optical flow

- Native retiming is represented by a single constant `rate` and optional `maintainPitch` at `apps/web/src/timeline/types.ts:83-86`.
- There is no time-varying speed curve, reverse flag, freeze-frame element, frame blending, or optical-flow interpolation in the current retime model.

### 24. Automated editorial decision systems

- There is no first-class edit-decision-list import/export, screenplay or storyboard binding, beat grid, silence-removal command, auto-reframe policy object, multicam switching, version comparison, or constraints-based layout engine.
- Existing low-level operations can be composed by an agent, but OpenCut does not persist these higher-level decisions or their provenance.

## Operational and protocol limitations

### 25. Active-editor architecture

- Every browser method in the bridge is tied to one connected `EditorAutomation` instance, and the request union contains no session or editor identifier at `apps/web/src/automation/bridge-client.ts:19-112`.
- A managed worker can be launched, but the MCP cannot concurrently control multiple projects in separate editor sessions through one server.
- Project mutations require the active project and exact revision. This is safe, but long-running provider work can conflict if another actor edits the project before attachment.

### 26. Local-only and provider boundary

- Media import is from absolute local paths, and the hidden editor bridge listens on localhost. There is no direct HTTP/S3/Drive/Dropbox media ingest, remote asset credential broker, or resumable upload interface in the MCP.
- Matte generation, subject tracking, and audio cleaning depend on separately configured providers. Their existence as registered tools does not mean a fresh checkout can execute those workflows without provider installation/configuration.

### 27. No capability negotiation

- Connection status reports whether an editor is authenticated, but there is no protocol version negotiation, server/editor feature flags, provider readiness matrix, renderer codec probe, GPU availability, or model readiness response.
- The server version is statically `0.1.0` at `packages/mcp-server/src/index.ts:88-93`, while callers must infer the actual feature set from tool presence and failed calls.

## Priority summary for the stated workflow

The highest-value missing work for programmatic short-form editing is:

1. Native graphics, stickers, masks, and adjustment layers, including catalogs and complete snapshot state.
2. Duplicate, bulk/group operations, and ripple editing primitives.
3. Track cleanup/order controls and reusable media-asset insertion.
4. Project duplication plus scene listing/selection for template and variant workflows.
5. Batch export matrices and structured QC packaging.
6. Provider discovery and production QC around matte generation, subject tracking, and audio cleaning.
7. Persistent grouping/linking and compound clips, which require native schema and renderer design rather than MCP wiring alone.

Background removal itself is no longer a missing transport capability because generated and precomputed mattes can be attached. The remaining gap is a ready, discoverable provider plus mask-quality repair and compositing workflows.

## Exhaustiveness boundary

This audit is exhaustive relative to the checked-out repository's registered MCP tools, bridge methods, automation edit union, native timeline object model, command set, project/scene managers, and export contract. Pure UI concerns such as zoom level, panel visibility, playhead display, selection highlighting, keyboard shortcuts, and snapping indicators are intentionally excluded unless they correspond to durable editorial state or an agent workflow outcome.
