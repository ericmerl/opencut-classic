# Background removal scope for OpenCut Classic MCP

## Decision summary

Background removal is not one feature. It has two separable layers:

1. **Matte consumption**, meaning attach a precomputed per-frame alpha matte to a clip and render it consistently in preview and export. This is a contained OpenCut feature.
2. **Matte generation**, meaning decode a source video, run an ML model over every source frame, preserve temporal coherence, cache results, report progress, recover from cancellation, package a runtime, and manage model licenses. Production-quality generation is a separate project.

The recommended sequence is to build the model-independent matte contract first, prove it with synthetic and externally generated mattes, then add a browser person-segmentation prototype. A production local inference sidecar should follow only after choosing an acceptable model and license. General-object removal should remain a later interactive tracking and matting project.

## What OpenCut already provides

OpenCut is unusually close to supporting the consumption half:

- Every rendered visual layer already accepts one `LayerMaskDescriptor` containing a mask texture, feather amount, and inversion flag ([TypeScript descriptor](../../apps/web/src/services/renderer/compositor/types.ts), [Rust frame descriptor](../../rust/crates/compositor/src/frame.rs)).
- The compositor's mask shader multiplies the layer alpha by the uploaded mask texture's alpha channel ([`mask.wgsl`](../../rust/crates/compositor/src/shaders/mask.wgsl)). Existing geometric masks are rasterized into a canvas texture before the compositor runs ([`frame-descriptor.ts`](../../apps/web/src/services/renderer/compositor/frame-descriptor.ts)).
- Video frames are already decoded on demand to canvas objects through MediaBunny and cached by media ID and source time ([video cache](../../apps/web/src/services/video-cache/service.ts)). Export advances deterministically through timeline ticks, renders every frame, and feeds the canvas to MediaBunny ([scene exporter](../../apps/web/src/services/renderer/scene-exporter.ts)). A matte can therefore use the same source-time mapping as its clip, including trim and retime.
- The MCP sidecar already has a token-authenticated local WebSocket bridge, one-shot local media tickets, long-running editor requests, revision checks, and export uploads ([editor bridge](./src/editor-bridge.ts), [media tickets](./src/media-tickets.ts), [MCP server](./src/index.ts)). These are the right primitives for an asynchronous matte job and browser import, though the current media ticket is consumed once and is not a random-access frame service.

Important gaps in the current code:

- A clip snapshot and MCP edit plan expose effects and keyframes, but not masks or a background-removal attachment ([automation types](../../apps/web/src/automation/types.ts), [snapshot builder](../../apps/web/src/automation/editor-automation.ts)).
- The renderer uses only `masks[0]`, and a wipe transition temporarily replaces that mask. A generated matte must compose with geometric masks and transition masks instead of competing for the single slot ([mask selection](../../apps/web/src/services/renderer/compositor/frame-descriptor.ts)).
- The shader reads the mask texture's alpha channel. A conventional opaque grayscale mask video stores the matte in a color channel, so the descriptor needs a channel selector or the browser must convert luminance to alpha before upload. A channel selector avoids a full-frame CPU pixel conversion.
- An imported matte must be a reference asset, not a visible timeline clip. The project needs attachment metadata, persistence, removal, snapshot exposure, undo, source-fingerprint invalidation, and cleanup of orphaned artifacts.

## Feasible generation approaches

### 1. Browser person segmentation for a fast draft

Google's MediaPipe Image Segmenter has Web support, accepts decoded video frames, and can return either a `uint8` category mask or `float32` confidence masks. Its official person model is only 256 by 256 (or 144 by 256 landscape), Apache-2.0 licensed, and specifically optimized for real-time browser and mobile use ([Web guide](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter/web_js), [model overview and benchmarks](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter), [official model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf)). The model card also says that thin features may be missed, masks are not pixel-perfect, and quality degrades with fast motion, noise, and large occluders.

This is the smallest end-to-end prototype after the matte substrate exists. It should run in a worker because Google's Web API calls are synchronous and block the calling thread. It should precompute and persist the matte before export rather than run inference inside the export loop. The documented model consumes one frame tensor and does not document recurrent temporal state, so video mode alone should not be treated as a temporal-consistency guarantee.

OpenCut already depends on Transformers.js, whose official pipeline API supports background removal, but a compatible model's own license still governs its use ([Transformers.js pipeline docs](https://huggingface.co/docs/transformers.js/pipelines)). For example, BRIA RMBG 1.4 is supported by Transformers.js but its official model card limits the downloadable weights to noncommercial use without a separate commercial agreement ([RMBG 1.4 model card](https://huggingface.co/briaai/RMBG-1.4)). A convenient JavaScript API is not a license decision.

Browser inference can use WebAssembly broadly or WebGPU on supported Chromium systems. ONNX Runtime's official compatibility table shows broad WASM support, narrower WebGPU support, and WebGL in maintenance mode ([ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html), [WebGPU guide](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)). This makes browser inference good for an optional local draft path, but not a dependable production backend across all OpenCut deployment targets.

### 2. Local sidecar for production human matting

[Robust Video Matting](https://github.com/PeterL1n/RobustVideoMatting) is technically well aligned with presenter and influencer footage. Its recurrent architecture carries temporal memory and outputs an alpha matte without a trimap or clean background; the original paper reports substantially better temporal coherence than independent frame processing ([paper](https://arxiv.org/abs/2108.11515)). The repository provides PyTorch, TensorFlow, TensorFlow.js, ONNX, and CoreML paths.

RVM is not a drop-in dependency for this MIT-licensed project because its official repository and published pretrained implementation are GPL-3.0. Bundling, linking, or distributing it needs an explicit licensing decision. Keeping a separately installed external worker behind a stable adapter makes replacement easier, but it is not a substitute for reviewing the obligations of the chosen distribution.

[MODNet](https://github.com/ZHKKKe/MODNet) is a lighter Apache-2.0 portrait-matting option. It takes a single RGB image and the official repository includes video demos and an ONNX export path ([paper](https://arxiv.org/abs/2011.11961)). Its official webcam guidance warns about semantic errors in challenging scenes and fast motion. Because the core model is frame-based rather than recurrent, temporal stabilization and shot-boundary handling remain OpenCut's responsibility.

For controlled tripod footage with a clean background plate, [Background Matting V2](https://github.com/PeterL1n/BackgroundMattingV2) is MIT licensed, produces a true alpha matte and foreground, and reports real-time HD and 4K tensor throughput. It requires an additional background image, and its authors explicitly say the supplied video conversion script is not a production real-time pipeline. This is a valuable optional adapter, not a general default.

The sidecar should therefore expose a model-neutral adapter contract rather than hard-code one model:

```text
input: source media, source fingerprint, source time range, model ID/version, options
output: 8-bit matte video or equivalent indexed matte artifact, exact frame timing,
        foreground class, model metadata, warnings, content hash
control: progress, cancellation, resumable cache lookup, structured failure
```

Inference must run sequentially in source time for recurrent models. Recurrent state must reset on discontinuities and shot boundaries. Cache keys must include the source fingerprint, model and weight version, preprocessing options, output dimensions, and source frame-time map. Timeline trim, split, and speed changes should reuse the source-time matte rather than regenerate timeline frames.

### 3. General-object removal and tracking

[SAM 2](https://github.com/facebookresearch/sam2) is an Apache-2.0 promptable image and video segmentation system. It accepts points, boxes, or masks, uses streaming memory to track selected objects, and supports later corrective prompts ([official overview](https://ai.meta.com/research/sam2/)). It is useful for removing or retaining arbitrary objects, especially with occlusion.

SAM 2 produces object segmentation masks, not hair-quality fractional alpha mattes. A CapCut-like general-object workflow therefore also needs prompt UI or MCP prompt geometry, identity tracking, correction frames, and a mask-to-matte refinement stage. That is a separate project, not an extension of a one-click person model.

## Matte artifact and renderer contract

The safest initial transport is a browser-decodable grayscale matte video whose red channel carries an 8-bit opacity value, plus exact timing metadata. It avoids alpha-codec interoperability and avoids thousands of individual PNG requests. The compositor should gain a mask-channel selector and multiply all active mask sources:

```text
final alpha = clip opacity
            * generated matte at source time
            * geometric mask
            * transition mask
```

The visual element should reference a persisted matte asset and provenance record, not embed frames in project JSON. A minimal record should contain `matteAssetId`, `sourceMediaId`, `sourceFingerprint`, `modelId`, `modelVersion`, `artifactHash`, `width`, `height`, `frameRate`, `sourceStart`, `sourceDuration`, `enabled`, and optional edge controls. Project snapshots must expose this record so an agent can determine whether a matte exists, is stale, or failed.

Do not stream raw frame masks through MCP JSON. Use MCP only for job control and metadata. Transfer source and artifact bytes over short-lived authenticated HTTP tickets, then persist the imported matte in OpenCut's normal media storage. For sources that exist only in browser storage, add a browser-to-sidecar upload ticket analogous to the existing export upload route.

## Temporal and quality requirements

A useful video result requires more than a good still mask:

- Preserve fractional alpha. Do not threshold the entire matte to binary.
- Upsample with source-guided edge refinement or a matting model. Ordinary bilinear scaling of a 256-pixel person mask will soften hair and fingers.
- Evaluate temporal stability separately from per-frame edge quality. A per-pixel exponential moving average is acceptable only as an optional draft stabilizer because it creates trails when the subject moves.
- Process recurrent models monotonically by source frame. Preview seeking should read cached matte frames, not mutate recurrent state by random access.
- Define state resets at source discontinuities, scene cuts, missing frames, and model errors.
- Ensure preview and export select the same source and matte timestamps. Trim, split, speed changes, duplicated frames, and non-integer frame rates need deterministic fixtures.
- Make edge controls such as erode, dilate, feather, spill suppression, and decontamination explicit and keyframable later. They cannot repair a fundamentally incorrect matte.

## Effort boundaries

These are rough engineering ranges after the current MCP branch is stable:

| Scope                                                                                                                                                                    |                           Effort | Classification                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------: | ------------------------------------ |
| Attach or detach a precomputed static matte, expose it in MCP snapshots, persist and undo it, and composite it with existing masks                                       |             2 to 4 engineer-days | Small                                |
| Decode a time-varying grayscale matte asset by source time, compose it with geometric and transition masks, cover trim, split, retime, preview, and export               |                     1 to 2 weeks | Medium, model-independent foundation |
| MediaPipe worker prototype with precompute, progress, cancellation, cache, and quality fixtures                                                                          | 3 to 7 days after the foundation | Bounded prototype, human-only        |
| Production local inference worker with packaging, GPU and CPU execution, source upload, resumable jobs, cache eviction, model adapters, diagnostics, and installation UX |                     3 to 8 weeks | Separate project                     |
| Promptable general-object tracking plus correction workflow and matte refinement                                                                                         |            4 to 10 or more weeks | Separate product capability          |

The estimates exclude model training, dataset acquisition, and provider-specific commercial licenses.

## Staged acceptance criteria

### Stage A: model-independent matte substrate

- MCP can attach, inspect, enable, disable, replace, and remove a precomputed matte using operation IDs and expected revisions.
- State survives save and reload, is undoable, appears in project snapshots, and identifies stale source fingerprints.
- A synthetic moving soft-edge matte produces byte-stable preview and export results.
- Generated, geometric, inverted, feathered, and transition masks compose instead of replacing one another.
- Trim, split, move, and speed changes select the same source matte frame as the decoded source video.
- Removing a source or matte handles shared references and orphan cleanup without deleting unrelated media.

### Stage B: browser draft removal

- A worker precomputes MediaPipe confidence masks for a human clip without blocking editor interaction.
- The job reports progress, supports cancellation, and resumes from a content-addressed cache.
- Export performs no ML inference and matches preview timing exactly.
- Test footage covers hair, hands, fast movement, partial occlusion, multiple people, portrait and landscape framing, and frames with no person.
- The UI and MCP result label this route as person segmentation and report model limitations rather than promising general background removal.

### Stage C: production local adapter

- A separately versioned worker implements the model-neutral job contract and can be installed, detected, health-checked, and upgraded without changing project files.
- The selected model and weights have a documented redistribution and commercial-use decision.
- Sequential recurrent processing, state reset rules, deterministic cache keys, progress, cancellation, retry, and structured out-of-memory errors are covered by integration tests.
- CPU fallback is functional, while GPU acceleration and memory usage are benchmarked at 720p, 1080p, and the target vertical-video resolution.
- Representative exports pass edge-quality, temporal-flicker, audio-sync, and watermark inspection.

### Stage D: general objects

- MCP can define an initial point, box, or mask prompt and add correction prompts at later source frames.
- Object identity remains stable through occlusion and re-entry on the agreed benchmark set.
- A refinement stage converts tracked binary masks into suitable fractional mattes where soft edges are required.
- Prompt history, model provenance, correction frames, and cache invalidation survive save and reload.

## Recommended next implementation boundary

Implement Stage A only in the current OpenCut MCP workstream. Use an externally generated synthetic matte video to prove the complete persistence, source-time, compositing, and export contract. After that lands, Stage B is a safe experiment because it cannot corrupt the editing architecture. Treat Stage C and Stage D as separately planned projects with explicit runtime and licensing choices.
