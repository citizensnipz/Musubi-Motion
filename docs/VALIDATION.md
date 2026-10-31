# Validation record — 2026-10-31

This records the local development checkpoint, not a production rollout or a
cross-browser certification. No deployment, push, new package dependency, or paid
service was introduced by this work.

## Automated checks

| Checkpoint | Result |
| --- | --- |
| Baseline before animation work | 31 tests passed across 5 files |
| Development checkpoint recorded at 16:56 | 118 tests passed across 15 files |
| Curve-insertion checkpoint at 17:12 | 126 tests passed across 15 files |
| Aim-constraint checkpoint at 17:19 | 137 tests passed across 15 files |
| IK/FK matching checkpoint at 17:28 | 148 tests passed across 15 files |
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

CPU microbenchmarks exclude rendering, editor drawing, asset decoding, Spark
sorting, binding uploads, and elasticity. The browser sample is a small local
scene and measures frame scheduling intervals; it is not isolated GPU time and
does not establish performance for production-size assets. Device, browser,
graphics driver, scene density, and active editor panels can change the result.

The representative scene is [animation-study.msb](../examples/animation-study.msb).
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
Implementation, local verification, commits, remote pushes, and deployment are
separate statuses.
