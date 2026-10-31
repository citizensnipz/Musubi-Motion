# Validation record — 2026-10-31

This records the local development checkpoint, not a production rollout or a
cross-browser certification. No deployment, push, or paid service was introduced.
The particle checkpoint adds one pinned package, described below.

## Sampled IK-to-FK bake checkpoint

The full suite passed **547 tests across 52 files**, TypeScript, and the Vite
production build. Browser checks used `index-NNbune82.js`. The existing chunk-size
warning remains; this checkpoint adds no dependencies.

The shared asynchronous command plans bounded samples, builds all joint rotation
tracks from the immutable original, disables the selected handle, and verifies
all object/joint world matrices and visibility before one undoable commit.
The 41 new tests cover exact/fractional endpoints, precision and work budgets,
outside-key record retention, Euler continuity, SDK feedback rejection,
cancellation, concurrent edits, archive readback, and sample-only fidelity.

Local Chromium checks at 1600 × 1000 confirmed:

- **Animation → Bake IK to FK** opens a separate docked panel. Interval zero
  disables the bake and reports a finite-positive-step error without dirtying
  the scene.
- Baking frames 0–120 at interval 0.5 produced 241 samples and 2,169 rotation
  keys. The handle became disabled. **View joint curves** selected Shoulder and
  showed three Graph Editor rotation tracks with 723 keys.
- One undo restored the clean original and enabled handle; redo restored the
  complete bake. Native download/reopen retained nine linear rotation tracks
  with 241 keys each, the disabled handle, and the original three blend keys.
- A 2,401-sample bake reported progress, accepted Cancel, and returned to the
  unchanged clean scene with no undo entry and the original enabled handle.
- Frames 0–0.9 at interval 0.3 produced exactly four planned samples. Baking
  10.25–12 at interval 0.6 with outside-key retention off produced four samples
  and 36 rotation keys; one undo restored the clean original. The IK Handles
  **Bake frame range…** shortcut reopened the dedicated bake panel.
- The saved baked example reopened at frame 30 with its joint curves visible.
  The browser reported zero console errors.

`node scripts/create-ik-bake-example.mjs` generated the 276,193-byte
`examples/baked-ik-motion.msb`. Its two 481-point verification passes include
241 baked samples and 240 quarter-frame intermediate samples, before and after
archive readback. Sampled world-matrix error was at most **1.23e-15** and the
historical sampler matched exactly. Undo and redo each restored the expected
document in one step.

Intermediate accuracy is materially weaker around abrupt changes already in the
mixed-blend source near frames 51 and 71: the largest measured endpoint difference
was **1.63 scene units**. The command deliberately verifies sampled frames;
linear Euler interpolation does not preserve discontinuous subframe motion.
Tests explicitly cover this boundary. Outside-range motion may also change
because the handle is disabled globally and adjacent curve shapes can change.

`node scripts/benchmark-ik-bake.mjs` used Node 22.16.0, two warmups and five
measured commands on fresh stores:

| Sample interval | Samples / rotation keys | Median | Maximum |
| --- | --- | --- | --- |
| 0.5 frames | 241 / 2,169 | 216.844 ms | 234.732 ms |
| 0.05 frames | 2,401 / 21,609 | 2,100.173 ms | 2,201.194 ms |

These local CPU timings include sampling, candidate validation, full-scene sample
verification, timer yields, and one history commit. They exclude browser rendering,
progress DOM updates, editor subscriptions, and archive I/O. The runs yielded 15
and 151 times respectively. Multi-chain/adaptive baking, general constraint
baking, animation layers, and the source rig's discontinuities remain unresolved.

## Animated IK/FK blend checkpoint

The final suite passed **506 tests across 50 files**, TypeScript, and the Vite
production build. The final browser build was `index-Bng-1mD9.js` with zero console
errors. The existing bundle-size warning remains; no dependency was added.

IK handles now use ordinary `animation.tracks` records with channel `ik.blend`.
Validation keeps authored values within 0–1 and separates scalar handle channels
from transform poses and SDK properties. Solver, marker, matching, and historical
particle evaluation use the requested frame. Tests cover interpolation, tangent
overshoot clamping, generic key operations, persistence, deletion, matching,
fractional historical sampling, and preview/history isolation.

Browser checks in the local Chromium preview included:

- **Rigging → IK Handles → Key blend** authored zero at frame 0, then editing the
  animated blend authored one at frame 30. Frame 15 evaluated to 0.5. **Edit blend
  curve** selected, isolated, and framed the named handle track in the Graph Editor.
- **S** on the logical blend selection added the frame-15 blend key without
  transform channels. Timeline key markers showed 0, 15, and 30. The native
  downloaded archive stored those three values and reopened at frame 15.
- Graph numeric editing changed the midpoint to 0.25; undo restored 0.5. Value 2
  was rejected without dirtying the clean scene. Copy/paste added a value-0.5 key
  at frame 45, and undo restored the previous held value of one.
- Timeline key deletion removed only the selected handle's key at frame 15.
  Dope Sheet shifting moved it to frame 20. Each command restored the clean
  original scene with one undo.
- Dragging the blend slider previewed 0.86 while the scene stayed clean. Escape
  restored 0.5. Repeating the drag and releasing committed one edit; undo restored
  the clean scene and 0.5.
- Focusing, tabbing away from, and pressing Enter on an unchanged sampled value
  of 0.233333 at frame 7 created no key or dirty state. This fixes an early blur
  path that inserted a sampled key and could round its value to six decimals.
- A controller's unkeyed world-X preview stayed at -0.0375 through an invalid
  blend edit, a valid edit to 0.6, undo, explicit blend keying, and **S**. Initially,
  unconditional frame seeking and broad rig invalidation dropped this preview.
  Validation now precedes seeking, unchanged frames are not sought, and only
  blend-only edits receive a narrow draft-retention exception. Other animation
  and rig input changes still invalidate drafts; 24 new tests cover that boundary.
- **Match FK to IK and key** inserted blend zero and joint rotation keys at
  frame 45. Deleting the handle removed its curve from the Dope Sheet; undo
  restored both. These actions each returned to the saved scene with one undo.

The 12,136-byte `examples/animated-ik-blend.msb` combines animated FK rotations,
target/pole controls, and a 0 → 1 → 0 blend over frames 0–120 at 24 fps. Its
generator checks 241 half-frame samples before and after archive readback against
independent local quaternion interpolation between FK and a full-IK reference.
Maximum quaternion error was approximately **5.2e-8 radians**; the full-IK
reference endpoint error was below **1.1e-14 world units**. Historical matrices
matched exactly. Intermediate blends intentionally need not reach the target.

`scripts/benchmark-ik-blend.mjs` used Node 22.16.0, 50 warmups and 300 samples.
Full evaluation measured 0.04625 ms median / 0.1226 ms p95 for one chain and
0.28335 ms median / 0.4566 ms p95 for 16 chains. Historical misses for 16 chains
measured 0.30215 ms median / 0.6643 ms p95. These are CPU measurements excluding
browser drawing, GPU work, skinning, and editor refresh.

Blend SDK, solver-setting animation, range-based matching/baking, joint
orientation/limits, and broader animation layers remain incomplete. The browser
was left on the clean example at frame 30, displaying blend 0.5 and its curve.

## Animated IK control checkpoint

The final local check passed **439 tests across 46 files**, TypeScript, and the
Vite production build. The existing bundle-size warning remains. This checkpoint
adds no dependencies. Its browser build was `index-B7anngP4.js`.

Target and pole links use ordinary object transforms with world-space offsets.
Tests cover animated and SDK inputs, constrained controls and FK ancestors,
stable prerequisite phases across disabled/blend-zero handles, feedback rejection,
atomic evaluation failure, matching, deletion, marker positions, and fractional
historical particle sampling. Matching additionally rejects new control keys that
would change the prepared FK chain through a driven relationship, including a
rotation change that does not move the endpoint.

Browser checks used the local Chromium preview at 1600 × 1000:

- Frame 30 in the example showed target `[-1.2, 1.8, 0.5]` and pole
  `[0.2, 0.1, 1.5]`. Focusing and leaving a read-only target field kept the scene
  clean. A blur handler initially wrote ignored fallback values; it now skips
  read-only inputs.
- Dragging a linked target updated its displayed world coordinates while the
  pointer was held, without creating history. Escape restored the original
  target. A committed drag followed by **S** survived scrubbing and save/reopen;
  the downloaded archive retained local X `0.17363740461834387` at frame 30,
  producing world X `-0.6263625953816561` under its constrained parent.
- A linked control rotated from 350° to 392.04595° during the drag and retained
  that value on release. Undo returned to 350°, then to the original clean file.
  The live preview now unwraps Euler angles before replacing the displayed pose.
- Creating target and pole curve controls, unlinking, and both FK matching
  actions each restored the original clean scene with one undo. Matching
  controls placed the target at the FK endpoint `[-0.8, 2.5, 0]`; matching FK to
  IK set the static blend to zero and created joint rotation keys.
- Linking to Control Space with the offset option retained the target position;
  disabling that option snapped it to `[-0.8, 0.1, 0]`. Matching a position-owned
  constrained control was rejected without another history entry.
- Deleting the selected linked target removed its link, kept world X
  `-0.626363`, and made its numeric fields editable. Undo restored the control
  and the clean save state. This exposed an early skeleton subscriber refreshing
  a removed selection; selection access and panel refresh now filter deleted
  IDs. Repeating deletion/undo on the rebuilt app produced **zero console errors**.

`examples/animated-ik-controls.msb` is a 10,617-byte, 24 fps, 0–120-frame example
with keyed target/pole controls and a constrained FK base/control space. Its
generator verified 241 half-frame samples both before and after disk archive
readback, with maximum endpoint error **1.64e-8 world units** and agreement with
the historical particle sampler. The browser was left on this clean example.

The Node 22.16.0 CPU benchmark used 50 warmups and 300 samples. Full time/SDK/rig
evaluation measured 0.0448 ms median / 0.0944 ms p95 for one chain, and 0.2472 ms
median / 0.4230 ms p95 for 16 chains. Historical cache misses for 16 chains measured
0.281 ms median / 0.651 ms p95; cache hits were about 0.0001 ms. These exclude
browser drawing, GPU work, skinning, and editor refresh and are not frame-rate
guarantees. Reproduce with `node scripts/benchmark-ik-controls.mjs`.

Blend and solver settings remain static. Cross-IK input dependencies, animated
blend, joint limits/orientation, and range-based baking remain outside this slice.

## Automated checks

| Checkpoint | Result |
| --- | --- |
| Baseline before animation work | 31 tests passed across 5 files |
| Development checkpoint recorded at 16:56 | 118 tests passed across 15 files |
| Curve-insertion checkpoint at 17:12 | 126 tests passed across 15 files |
| Aim-constraint checkpoint at 17:19 | 137 tests passed across 15 files |
| IK/FK matching checkpoint at 17:28 | 148 tests passed across 15 files |
| Curve-controller checkpoint at 17:51 | 168 tests passed across 18 files |
| Skin-weight checkpoint | 190 tests passed across 21 files |
| Viewport component-selection checkpoint | 202 tests passed across 22 files |
| Skin-paint checkpoint | 224 tests passed across 24 files |
| Analytic two-bone IK checkpoint | 236 tests passed across 26 files |
| Polygon modeling checkpoint | 271 tests passed across 30 files |
| Particle FX checkpoint | 325 tests passed across 36 files |
| Production build | TypeScript checking and Vite build passed |
| Lint | No separate lint script is configured |

Coverage includes animation interpolation and weighted tangents; key command
validation/history; playback ranges and frame rates; driven relationships and
cycles; joint edit continuity; IK; constraints; archive roundtrips and deletion
cleanup; and the existing scene/elasticity regressions. The Vite large-chunk
warning remains. Passing the build does not resolve that bundle-size warning.

## Browser workflow checks

The local production browser was exercised with actual UI interactions. The
latest checked session had no browser console errors.

| Workflow | Observed result |
| --- | --- |
| Manual transform keys | Position values 0 and 4 at frames 0 and 24 evaluated to 2 at frame 12 |
| Graph numeric edits and history | Value 4→6, undo→4, redo→6 |
| Broken tangent editing | After the regression fix, incoming slope changed from approximately 0.167→0.236 while outgoing remained approximately 0.167 |
| Curve clipboard and retiming | Copied frame 24 to 36; Dope Sheet Shift +5 produced 41, with undo/redo restoring 36/41; a key drag moved 41→43 |
| Multi-channel edits and scaling | Two selected channel keys moved 0→2 together; scaling selected times 24/43 by 2 produced 24/62 |
| Graph text-field stability | A value field retained focus and typed text during refresh; Enter committed the value |
| Shape-preserving key insertion | Insert at frame 12 created one key with displayed value 0.938 and Fixed tangents; undo removed it and redo restored it. Dense automated samples verify curve preservation, including adjacent segments |
| Import during animation | Adding a demo object at frame 60 with range starting at 50 retained frame 60 |
| Save shortcut in a rigging field | Ctrl+Shift+S from the Set Driven Key driver-value field opened Save As; cancel returned to editing |
| Set Driven Key | The example mapped driver value 1.5 to 90° rotation; an additional Scale X relationship mapped 0.5→1 |
| IK | Editing a target changed the solved pose; blend 0 restored the FK value 7.5°; target matching was exercised |
| Match FK to IK and key | At frame 24, the shoulder's displayed −0.00064° rotation stayed unchanged while blend changed 1→0 and all XYZ rotation diamonds became keyed. Undo restored blend 1 in one step; redo restored 0; seeking away and back retained the keyed pose |
| IK viewport target selection | Move target in viewport selected the target and attached the translation gizmo; pointer selection was checked |
| IK viewport target drag/history | An actual canvas X-gizmo drag moved target X from −2 to approximately −0.775372 and produced one Edit IK handle entry; undo restored −2 and redo restored the edited value |
| IK viewport target cancellation | After undo, another drag followed by Escape restored −2 without adding history; redo still replayed the prior −0.775372 edit |
| IK panel docking | Opening the IK tab retained viewport height at 730 px; width changed only from 1,300 to 1,290 px in the checked layout |
| Point constraint | Maintain-offset preserved X=3 and Y=1.5 at frame 24 |
| Aim constraint and history | Default +Z/world +Y aimed toward the source with rotation [0, −90, 0]; undo restored [0, 0, 0], redo restored the aim, and frame 24 tracked the moving source |
| Custom aim axes | Local −X/world +Z produced rotation [90, 0, 0] in the checked scene |
| Aim offset and disable | Creation at frame 24 preserved the underlying 90° Z rotation; seeking frame 0 changed it to about 116.565°. Disabling restored the underlying 0° rotation |
| Visibility | Visible at frame 12 and hidden at frame 36 |
| Auto-key | An edited value of 2 survived seeking away and back |
| Frame-rate editing | Changing 24→30 FPS preserved current frame 36 |
| Playback range | With loop disabled, playback stopped at end frame 37 |
| Draft pose history | After seeking, undo preserved the frame's evaluated value 1.5; renaming preserved a draft value of 7 and its undo behavior |
| Portable project | Browser download and reopen preserved animation keys, SDK, IK, and frame 24 |
| Binding and elasticity | One 11,629-splat object was bound to three joints; elasticity remained usable during playback |
| Curve creation and shape history | Created circle/arrow controls beside a splat; CV X changed 2→3, undo→2, redo→3, and Escape canceled a typed 9 back to 3 |
| Curve shape validation and rebuild | Weight 0 was rejected and restored to 1. Insert CV rebuilt knots with 10 CVs; undo restored the original 9 |
| Controller animation and constraint | Controller X keys 4/6 at frames 0/24 evaluated to 5 at frame 12. A point-constrained splat followed X=5/6 at frames 12/24 |
| Controller placement and picking | An arrow matched the selected controller's evaluated X=5 world pose. An actual canvas click selected the curve line |
| Controller project and deletion | Download/reopen retained both shapes, CV X=3, keys, constraint and frame 24. Delete removed the selected controller; undo restored it and the three-object scene |
| Weight range and normalization | Changed Tip from 0.85 to 0.2 over indices 0–511; other influences rescaled to a total of 1. Undo/redo restored both versions |
| Weight validation and resets | Weight 1.2 was rejected without dirtying the scene. Resetting 0–15 reduced authored overrides from 512 to 496; Reset all produced 0. Rigid weight 1 worked; reducing that sole influence to 0.5 was rejected atomically |
| Weight save/reopen and malformed asset | Download/reopen retained 512 overrides and Tip=0.2. A valid archive declaring the wrong component count was rejected before replacing the active scene |
| Weight preview and docking | Color points appeared over Spark splats, followed posed components, and sampled 5,000 of 11,629 indices. The panel joined the side group when Properties was closed; preview cleared on joint selection |
| Weight editing with elasticity | Edited weights remained usable with elasticity and a translated joint: 14,922 rendered splats, 11,629 original editable components, 512 overrides. Unbind/undo restored the authored weights |
| Rigging action history | Fixed duplicate panel event registration. Apply Elasticity now used one history entry; one undo after Unbind restored the binding and weights |
| Viewport component selection | Full-view box selected all 11,629 original components without changing object selection. Click selected 1000; Shift added 7000; Ctrl removed each. Empty selection disabled Apply while keeping picking active |
| Exact selection editing and persistence | Editing 1000/7000 added exactly two overrides (512→514); decoded archive confirmed Tip=0.7 for both and no override at 1001. Reopen retained weights and cleared the temporary selection |
| Selection pose and lifecycle | Frame-24 click selected component 1000 at its deformed position. Undo/redo preserved the pair, playback stopped picking but retained indices, and Escape canceled a box while retaining the prior pair |

The viewport target drag/release/cancel/history checks passed with no browser
console errors. Testing exposed a pointer-capture condition that omitted the
selected IK handle from transform activation; the condition was fixed before
the successful canvas-drag retest. Opening the IK panel also no longer imposes
a height resize on an existing side-panel group.

The Graph Editor/Dope Sheet session also visually checked their light-theme
layout and reported no console errors, with two existing warnings. A broken
auto-tangent regression was found and repaired: changing the incoming slope
previously reset the outgoing slope to zero. A focused automated regression and
the browser retest now cover preservation of the opposite handle.

## Performance measurements and limits

| Local workload | Measurement |
| --- | --- |
| CPU animation evaluation, 1,000 tracks | Approximately 0.56 ms per evaluation |
| CPU IK evaluation, 20 chains | Approximately 2.62 ms per evaluation |
| Node CPU constraint evaluation, 100 parent constraints, 100 evaluations | 43.5 ms total, approximately 0.44 ms per evaluation |
| Node CPU aim evaluation, 100 aim constraints, 100 evaluations after 10 warmups | 27.94 ms total, approximately 0.28 ms per evaluation |
| Browser animation with binding/elasticity, approximately 23,600 scene splats, 90 requestAnimationFrame samples | Median 16.7 ms, p95 16.8 ms |
| Node creation of 100 rational circle renderables, 129 samples each | 17.69 ms total; excludes GPU upload/rendering |
| Browser looping a controller-driven 11,629-splat scene with two curves, 90 requestAnimationFrame samples | Median 16.7 ms, p95 16.8 ms |
| Node weight edit across 11,629 components / rebuild binding / preview 5,000 posed centers | 23.12 ms / 11.51 ms / 3.55 ms; excludes GPU rendering |
| Browser joint animation with 512 authored overrides on 11,629 splats, 90 requestAnimationFrame samples | Median 16.7 ms, p95 16.8 ms; preview hidden during playback |
| Node projection and posed-center scan of 11,629 components at frame 24 | 10.29 ms; no GPU rendering or browser scheduling |
| Node brush index from 11,629 posed centers / 606-component stroke | Median 3.28 ms / 0.48 ms across 20 samples after five warmups; frame 0, no GPU rendering, browser scheduling, commit, or binding rebuild |
| Node IK comparison, 20 three-joint chains, 100 samples after ten warmups | CCD median 2.526 ms / p95 3.064 ms; analytic median 0.180 ms / p95 0.356 ms; excludes animation evaluation, skinning and rendering |

CPU microbenchmarks exclude rendering, editor drawing, asset decoding, Spark
sorting, binding uploads, and elasticity. The browser sample is a small local
scene and measures frame scheduling intervals; it is not isolated GPU time and
does not establish performance for production-size assets. Device, browser,
graphics driver, scene density, and active editor panels can change the result.
The brush measurement is reproducible with `node scripts/benchmark-skin-brush.mjs`.
The IK comparison is reproducible with `node scripts/benchmark-ik.mjs`.

The representative scenes are [animation-study.msb](../examples/animation-study.msb)
and [controller-study.msb](../examples/controller-study.msb), plus
[skin-weights-study.msb](../examples/skin-weights-study.msb).
The analytic IK checkpoint adds [two-bone-study.msb](../examples/two-bone-study.msb),
generated with `node scripts/create-two-bone-example.mjs`.
It uses procedural knots and a short rig, not a large imported capture. Cross-
browser compatibility, large-asset memory/load times, and long-session editing
remain outside this checkpoint's evidence. Imported multi-million-splat scenes
were not benchmarked.

## Commit state at the checkpoint

- `f9fba29` — Add validated animation curves, driven keys and rig solvers.
- `962a2f3` — Integrate animation editors and rigging workspaces with scene playback.
- `1ba021a` — Add viewport IK target manipulation and enforce exact constraint poses.
- `c7f422e` — Preserve animation curve shape when inserting keys.
- `1a15714` — Add aim constraints with configurable local and world-up axes.
- `341d863` — Match solved IK poses to keyed FK with atomic pose validation.
- `ff82b7c` — Add editable NURBS curve controllers to shared scene workflows.
- `f532bf7` — Add normalized skin weight editing and posed component previews.
- `ae5444b` — Add posed viewport component selection for skin weight editing.
- `8797a43` — Add viewport skin weight painting with atomic stroke history.

The curve-insertion commit adds verified shape-preserving key insertion,
preserves the animation frame during import, and restores Save/Open shortcuts
from rigging fields. Eight additional focused animation tests cover insertion,
discrete visibility, neighboring segments, history and atomic rejection of
unrepresentable tangent splits.
The accompanying Aim commit adds signed aim/up axes, maintained orientation
offsets, source-position tracking, and serialization validation. Ten focused
constraint tests and one packed-archive integration test cover it. The browser
checks above passed with no console errors. The build's existing large-chunk
warning remains.
The accompanying IK/FK matching commit adds rotation keys and a static blend
switch in one history entry. Ten new command tests and one packed-archive
integration test cover pose preservation, Euler continuity, partial blends,
ownership conflicts, staged dependency checks, undo/redo and reopening.
The accompanying controller commit adds shared transform-based NURBS controls,
weighted CV editing, mixed-scene persistence and viewport selection. Twenty new
tests cover commands, curve evaluation, renderer lifetime and world placement.
It also fixes server-side example tooling: Zundo now passes through Vite's
existing framework-free Zustand alias, avoiding an unintended React import.
IK/FK matching retains the actual fractional playback frame when capturing a
paused pose instead of rounding a pose sampled at a different time.
The accompanying skin-weight commit adds 22 tests for normalization, sparse
archives (including metadata above the old 4 MiB cap), Spark binding/elasticity
integration and preview lifetime. Numeric editing is limited to 20,000 components
per command and 200,000 stored overrides per shape. Influence locks remain future
work. The preview uses the transparent
render pass so it draws after Spark; paused display is capped at 5,000 points.
The component-selection commit adds 12 projection tests for perspective and
orthographic cameras, transformed parents, clipping, click ties, chunk offsets,
cancellation and atomic overflow. Browser testing caught undo clearing selections
when a historical command label was “Open scene”; scene replacement now resets
selection explicitly. Scans yield on an 8 ms work budget instead of waiting one
animation frame per chunk. X-ray center selection does not test surface occlusion.
The accompanying skin-paint changes add 22 tests for variable-weight commands,
brush indexing/falloff, continuous segments, event-frequency independence, and
browser-adapter cancellation. Review found that hovering after release could
extend a pending stroke, and canvas focus handling could discard numeric drafts.
Both were fixed and covered by regression tests. Brush operations add no package
dependencies; Three.js supplies projection, closest-segment distance and smoothstep.

The browser painted 606 components using Replace, value 0.2, strength 1 and a
32-pixel radius. The file remained clean during the preview; release created one
“Paint skin weights” undo entry. Undo restored the clean baseline and redo restored
the edit. The saved archive contained 1,118 overrides (512 baseline plus 606 new),
all normalized, with unchanged prior rows. Reopening showed component 1,000 at
Tip weight 0.200000. A later Add stroke applied a typed value of 0.4 directly from
the focused field when clicking the canvas, affecting 28 components and bringing
that component to 0.598104 after falloff; undo restored 0.200000. Escape canceled a
757-component preview while retaining painting mode; a second Escape exited it.
Starting playback during another stroke canceled the preview and stopped painting
without dirtying the file. The Rigging menu's Paint weights action opens the new
panel. The checked browser session had no console errors.

Painting currently affects X-ray component centers and previews colors only;
deformation updates on release. Smoothing, influence locks, mirrored brushes,
pressure input and surface occlusion remain unimplemented. Multi-million-component
brush latency and memory have not been measured.

The analytic IK checkpoint adds 12 tests, including 48 varied authored FK hinge
orientations inside the solver sweep. Coverage includes reachable, reversed,
too-close and too-far targets; root/pole coincidences; collinear poles; rotated
parents; arbitrary bone axes; collapsed animated segments; deterministic evaluation;
blending; FK matching; archive rejection; and pole-marker picking/resource lifetime.
Legacy CCD tests still pass. The solver adapts ozz-animation's MIT implementation;
the pinned source and retained notice ship in `public/licenses/ozz-animation.txt`.

Browser checks used an 11,629-splat object bound to a three-joint chain. A pole
X-axis drag preview kept the file clean; release saved X=0.407491 in one edit.
Undo restored X=0 and the clean state; redo restored the edit. Escape during a
second drag restored X=0 without adding history. Numeric pole Z edits also
supported undo. Switching the selected pole's solver to CCD removed the pole
fields/marker, exposed iteration controls, and safely selected the endpoint;
undo restored analytic mode. Match FK to IK created joint rotation keys and
blend=0 in one command; undo restored blend=1. Save/reopen retained the analytic
solver, pole X=0.4 and blend=1. Creating a new analytic handle through the panel
placed its target at the current FK endpoint and generated a perpendicular pole.
The browser reported no console errors.

The numeric-to-gizmo check exposed a focus-order bug: typing a pole value and
dragging immediately could discard the draft once the panel became busy. Canvas
capture now commits IK fields and refreshes the gizmo before TransformControls
begins a drag. The retest preserved the typed X=0.2 as its own edit; undoing the
drag restored 0.2 and a second undo restored the clean X=0 baseline.

Two-bone targets and poles remain static properties; joint limits, stretch,
soft reach, user-authored hinge axes, twist channels and range baking are not
implemented. Degenerate target/pole directions use deterministic fallbacks and
may still flip when crossing a singular configuration. The CPU comparison is
not a production frame-rate guarantee.
Implementation, local verification, commits, remote pushes, and deployment are
separate statuses.

## Polygon modeling checkpoint

The 35 added tests cover shared primitive topology, stable IDs, triangulation,
nonplanar vertex editing, winding/manifold validation, connected region extrusion,
interior-vertex pruning, deletion, atomic history, component picking with clipped
edges and transformed cameras, renderer/overlay resource disposal, and mixed
mesh/splat/curve archive roundtrips with animation, SDK and constraints. Invalid
topology fails before replacing the active document or history.

Browser checks created a cube, selected a visible face, and extruded it by 0.5.
The mesh changed from six to ten faces; undo/redo restored those counts. Vertex
clicks, Shift-add and Control-subtract selected the expected stable IDs. A local
vertex edit and edge offset worked; the offset changed shared vertices once and
created one undo entry. A box selected all ten faces through the object. Extruding
the closed whole mesh was rejected without an edit. Deleting all faces left a
valid empty mesh, and undo restored ten faces. Smooth shading and polygon wire
display survived a real download/reopen; reopening started with empty history.

The representative modeling scene loaded five objects with 365 polygon faces and
11,629 splats, including its curve controller. Scrubbing to frame 24 showed the
mesh's keyed Y rotation of 45 degrees without dirtying the scene. During playback,
90 requestAnimationFrame intervals after ten warmups measured 16.7 ms median and
16.8 ms p95 in this local browser. This is scheduling evidence for this small
scene, not GPU timing or a large-scene guarantee. The browser had no console errors.
Visual inspection found flickering polygon wires; offsetting the filled surface
resolved it. Properties now correctly identifies polygon mesh shapes.
The existing bound-splat analytic IK example also reopened after the mesh scene;
editing a pole value and undoing it restored the original value and clean file.

The CPU benchmark `node scripts/benchmark-mesh-modeling.mjs` uses five samples
after two warmups. One local run measured these median times:

| Grid | Validation | Triangulation | Renderer preparation | Region extrusion command |
| --- | --- | --- | --- | --- |
| 1,024 faces / 1,089 vertices | 10.22 ms | 3.99 ms | 16.24 ms | 17.17 ms |
| 10,000 faces / 10,201 vertices | 57.23 ms | 14.09 ms | 91.14 ms | 149.49 ms |

Renderer preparation includes validation, triangulation, normals and wire buffers;
it excludes GPU upload/rendering. Extrusion includes validation and the immutable
document command, but excludes browser scheduling and editor callbacks. These
independent columns should not be interpreted as frame times. Large topology edits
are synchronous and can interrupt interaction; the 100,000-component document caps
are integrity guards, not a demonstrated interactive-performance target.

Mesh skinning, component gizmos, inset/bevel/subdivision, merge/bridge, edge deletion,
UVs and mesh import/export remain future work. Cross-face geometric intersections
are not detected by the topology validator. No new package dependency was added;
the reused/adapted Earcut ISC notice ships alongside the existing MIT notices.

## Particle FX checkpoint

The 54 added tests cover emitter commands and budgets, historical fractional-frame
poses through animation/SDK/IK/constraints, seeded 120 Hz forward/backward replay,
request-order independence, emission/lifetime boundaries, gravity/drag/noise and
attraction, lifetime appearance, uniform volumes, and world-area-weighted mesh
surface sampling under animated nonuniform scale. Tests also cover cancellation
during surface preparation, bounded output caches, renderer bounds/resources,
stale asynchronous results, constructor-failure recovery, mixed archives/source
bytes, atomic FPS validation, and surface-emitter subtree deletion.

Browser checks created a directional emitter beside the existing knot. At frame 48,
rate 60 produced 120 particles; changing to 120 produced 240. Undo restored 120 and
redo 240. Scrubbing backward to frame 24 produced 120, then forward to 48 restored 240.
Acceleration Y=-1, drag 0.4 and turbulence 0.2 were entered through the panel. A real
download/reopen retained those settings, rate 120, frame 48 and 240 particles, with
empty undo history. The selected emitter's fields also reenable after pausing.

The mixed example opened seven objects: three emitters, 353 polygon faces,
11,629 splats and a curve controller. At frame 48 the moving emitter's keyed X
was -0.8 and its cloud contained 200 particles. Creating a surface emitter from the
selected mesh produced 120 particles; undo/redo restored the three/four-emitter
counts. Playback kept the saved scene clean. Ninety requestAnimationFrame intervals
after ten warmups measured 16.7 ms median and 16.8 ms p95 in the local browser; this is
small-scene scheduling evidence, not GPU timing or a large-scene guarantee. The
browser reported no console errors. Seeking past emission and lifetime emptied
the cloud. Disabling an emitter cleared it; Edit → Undo restored its particles.

`node scripts/benchmark-particles.mjs` includes asynchronous replay yields and
historical pose sampling for an unanimated directional emitter. One local run:

| Live particles at 2 s | Initial 2 s replay | Backward 1 s replay | Forward frame median / p95 |
| --- | --- | --- | --- |
| 1,000 | 83.78 ms | 30.13 ms | 1.29 / 2.35 ms |
| 5,000 | 393.42 ms | 60.28 ms | 13.74 / 18.93 ms |

Forward samples advance five 120 Hz steps per 24 fps frame; thirty samples follow
five warmups. These wall times exclude browser UI, GPU upload/rendering, surface
sampling and animated rig evaluation. Budgets are safety limits, not a promise
that their maximum fits a frame. Long replays yield and can be superseded.

The new package is exactly `three-nebula@13.3.0` (MIT); Three remains 0.180.0. npm
reported one added package and zero audit vulnerabilities at installation. The
published bundle contains utility code, so Nebula, Lodash, potpack and uuid notices
ship in `public/licenses`. The adapter handles upstream fractional-burst scheduling,
the damping reference interval, zero initial size, and renderer resource ownership.
An asynchronous constructor-failure path was fixed and directly regression tested.
Visible emitter markers now take picking priority over the mesh beneath them;
a viewport click selected the surface emitter rather than its source sphere.
The FX workspace preset and panel layout also survived reload together.

Current limitations include 120 Hz quantization, static emitter-property settings,
replay after edits/backward seeks, device-limited point sizes and approximate
transparent sorting. Collisions, trails, animated field objects, cache export,
and splat-particle rendering remain unimplemented. The existing Vite large-bundle
warning remains; the production bundle grew by approximately 88 kB before compression.

## Mesh component gizmos checkpoint

`npm test` passes 345 tests across 38 files; `npm run build` passes with the existing
large-bundle warning. Twenty added tests cover shared vertex resolution, immutable
gesture baselines, world/local conversion through nonuniform and sheared parents,
matrix validation, buffer reuse, normals/wires/bounds, atomic preview rejection,
exact cancellation restore, document updates and disposal.

Real browser drags moved a cube face from X 0.5 to approximately 1, scaled its Y
extent, and rotated it around the common selection center. One undo restored each
starting geometry; redo restored the move. Vertex and edge drags also worked.
Escape cancelled a drag while preserving component mode/selection and the existing
redo history; a second Escape returned to Object mode. Clicking a handle without
moving kept the saved scene clean. A vertex drag that folded a face was rejected
on release, restored X 0.5, and preserved redo history.

A pending numeric X edit to 0.6 now commits before grabbing a component handle.
The following drag produced approximately 0.783; consecutive undo operations
restored 0.6 and then 0.5. This checks the early blur fix that prevents disabling
Mesh Tools during a drag from discarding an unfinished field edit.

A downloaded edited scene contained exactly the two moved edge vertices, with
unchanged face IDs/topology and whole-object transform. Reopening retained their
X value (approximately 0.749638) and started with empty undo/redo history. No
browser console errors were reported.

The mesh benchmark now measures capture and preview separately, selecting every
face and reusing one renderer. One Node 22.16.0 run, five warmups and thirty samples:

| Selected faces / vertices | Capture median / p95 | Preview frame median / p95 |
| --- | --- | --- |
| 1,024 / 1,089 | 0.530 / 1.277 ms | 0.392 / 1.093 ms |
| 10,000 / 10,201 | 5.901 / 7.055 ms | 5.163 / 7.701 ms |

Preview timings include world/local vertex conversion and updating mesh/wire
buffers, normals and bounds. They exclude selection overlays, editor callbacks,
browser scheduling and GPU upload/rendering. Release still runs full validation
and triangulation synchronously. Pivot/axis customization, snapping, soft
selection and component animation remain unimplemented.

## Topology editing checkpoint

`npm test` passes 381 tests across 42 files; `npm run build` passes with the
existing large-bundle warning. Thirty-six added tests cover merge-to-center,
interior-edge deletion, shell-normal reversal, immutable topology replacement,
atomic failure, undo/redo and archive round trips. Tests also verify that valid
existing tessellations remain unchanged, while bent cube n-gons can use the
area-normal projection fallback. Self-crossing planar faces still reject.

Browser verification used the Modeling workspace and actual controls/shortcuts:

- Delete dissolved one cube edge: 8 vertices / 12 edges / 6 faces became
  8 vertices / 11 edges / 5 faces, with a selected six-sided face. Undo/redo
  restored both states. Holding Delete did not delete the resulting faces;
  Ctrl+Delete was consumed without deleting the object.
- Merging diagonal corners of a quad was rejected while retaining the original
  geometry, clean saved state, and redo history. Merging one cube face produced
  a pyramid with 5 vertices / 8 edges / 5 faces and selected the survivor. Undo
  restored the original cube.
- Shell-normal reversal retained the one-face seed selection. Undo/redo worked.
  A downloaded scene retained eight vertex positions, the dissolved n-gon, and
  reversed loops on all unaffected original faces. Reopening restored the five
  faces and started with empty history.
- Deleting a plane's border edge was rejected. Backspace in Face mode removed
  the face while keeping the mesh object, and undo restored it. Delete inside a
  numeric vertex field performed native text editing; Escape restored the field
  without leaving component mode.
- `examples/mesh-topology-study.msb` opened three meshes and sixteen faces, with
  the expected original cube, dissolved cube, and merged pyramid. The browser
  reported no console errors.
- Creation controls fold when meshes arrive, while an explicitly reopened
  section stays open across ordinary selection refreshes. The collapsed local
  offset section still applies edits and undoes back to a clean saved scene.
  Merge to Center is visible without scrolling at the tested 1,600 × 1,000 layout.

Review caught a key-repeat hazard: dissolving an edge switches to Face mode, so
the next repeated Delete event could remove the newly selected faces. The component
shortcut handler now consumes repeats before performing any command; the held-key
browser check above verifies the fix.

A further regression test reproduced dissolving five cube faces into a loop
opposite the sixth face, creating overlapping duplicates. Delete Edge now checks
canonical face cycles before committing. The test covers all six choices of
excluded face and verifies unchanged document/history on rejection.

`node scripts/benchmark-mesh-topology.mjs` ran on Node 22.16.0 with two warmups
and five timed samples per command, each on a fresh store:

| Faces / vertices | Merge median | Delete Edge median | Reverse Normals median |
| --- | --- | --- | --- |
| 1,024 / 1,089 | 6.389 ms | 6.939 ms | 5.684 ms |
| 10,000 / 10,201 | 68.960 ms | 82.538 ms | 63.184 ms |

These timings include shared validation, defensive topology copying and one undo
commit. They exclude store creation, selection lookup outside the command, editor
callbacks, renderer rebuilding and GPU work. Commands remain synchronous. No new
dependencies were added. Merge by distance, bridge, Delete Edge/Vertex cleanup,
custom normals, inset/bevel/subdivision and other remaining modeling work are
documented in the modeling guide.
