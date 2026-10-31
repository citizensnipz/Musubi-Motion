# Scene data architecture

Musubi uses a Maya-inspired transform/shape model: named transforms own local
position, rotation, and scale; child splat shapes reference assets. The design
follows the principles of Maya's documented [DAG hierarchy](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-5029CF89-D420-4236-A7CF-884610828B70.htm)
and [parent-relative transforms](https://help.autodesk.com/cloudhelp/ENU/MayaCRE-Tech-Docs/Nodes/dagNode.html).
It does not implement Maya's complete dependency graph or construction history.

## Authoritative document

```text
SceneDocument v1
  rootIds: ordered root transform IDs
  nodes[id]
    Transform: name, parentId, position, rotation, scale, rotationOrder
    SplatShape: name, parentId, assetId, offset, optional binding/elasticity
  assets[id]: procedural generator or original file metadata
  joints?: local position/rotation, name, ID, parentId
  animation?: fps, start, end, loop, tracks
    track: ID, targetId, channel, keys
  drivenKeys?: driver property, driven property, response curve
  ikHandles?: root/end joint IDs, world target, enabled, iterations, blend
  constraints?: source/target IDs, type, enabled, maintain-offset, stored offsets
```

- IDs remain stable when objects are renamed. Transform names are unique among
  siblings; collisions receive a numeric suffix.
- Positions and scales use XYZ tuples. Rotation channels are local Euler degrees
  in XYZ order; the runtime converts to radians. The scene is unitless and Y-up.
- Shape offsets retain the import-centering adjustment independently of object
  transforms. Original source assets are separate from editable metadata.
- Joint hierarchy parenting preserves the authored world pose and rejects
  cycles. General transform grouping, interactive object parenting, and DAG
  instancing remain future work. Archive transforms still require one splat shape.
- Binding records influence joint IDs and rest matrices. The runtime creates
  normalized distance-based weights and passes bone transforms to Spark skinning.
  Editable weights and weight painting are not implemented.
- Elasticity settings belong to bound shapes. Existing elasticity deformation
  and bounded splat allocation run after the rig pose; they are not a second rig.

## Evaluation pipeline

```text
UI / keyboard → shared commands → immutable SceneDocument → undo history
                                      ↓
                     authored local transform and joint channels
                                      ↓
                           absolute-frame animation curves
                                      ↓
                       temporary unkeyed editing overrides
                                      ↓
                   driven-key curves in property dependency order
                                      ↓
                          IK solution blended with FK
                                      ↓
                    constraints in hierarchy/dependency order
                                      ↓
             Three.js transforms / joints → Spark binding and elasticity
```

Animation curves are stored independently of renderable assets and apply to
transforms and joints through the same pose representation. Evaluation creates
a pose map without changing the document, so scrubbing and repeated evaluation
of a frame are deterministic and do not fill history. The viewport, Properties,
timeline, Graph Editor, and Dope Sheet refer to the same scene and frame.

`src/animation.ts` owns channels, curve evaluation/validation, and key commands.
It reuses Three.js cubic Bezier primitives, with time-parameter inversion for
weighted handles. Curves hold their endpoint values outside the keyed interval.
Rotation curves retain full turns; numerical inputs preserve intentional spins.
`src/animation-edit.ts` maintains nearby equivalent XYZ angles for gizmo commits
and preserves unaffected evaluated channels during FK edits.

`src/driven-keys.ts` owns attribute connections. Each driven property has one
driver, while one driver may feed many outputs. A property-level topological
order supports chained relationships and rejects cycles. A driven output cannot
also have a time curve. Driven values use the same cubic evaluator as animation;
their horizontal coordinate is the driver value rather than a frame.

`src/ik.ts` adapts Three.js's MIT-licensed `CCDIKSolver` to the shared joint pose.
IK affects the pose map before binding, leaving authored FK values intact.
Handles have independent world-space targets and an FK/IK blend. Overlapping or
ancestor-dependent chains are rejected so array ordering cannot change the result.
Two-bone chains use the same CCD solver; there is no analytic solver or pole vector.

`src/constraints.ts` provides point, orient, scale, and parent constraints across
objects and joints. It computes source world poses in dependency order, converts
results into the driven node's parent space, and overrides the corresponding
output groups after IK. Parent constraints affect position and rotation while
retaining target scale; their positional offset follows the source's full
transform, including source scale. Point offsets stay in world space. Rotation
offsets are normalized quaternions. One constraint owns each output group;
hierarchy/constraint cycles, including disabled links, are rejected. SDK and IK
are not reevaluated from constrained results. Shear and joint scale constraints
are not supported; rotation/scale under nonuniform scaled hierarchies are limited.

The document and its commands do not depend on a viewport widget. This is the
integration boundary for future automation/MCP access; no MCP endpoint is
implemented. Automated callers should use these validated commands rather than
writing arbitrary store state.

## Undo, previews, and resources

Zustand vanilla and Zundo retain up to 100 immutable document snapshots, sharing
unchanged metadata. Imports, property edits, completed gizmo drags, curve edits,
driven relationships, IK settings, and constraints are document edits. Key drags preview in
the editor and commit once. FK edits and their auto keys are prepared together
for a single history entry. A new edit after undo discards the redo branch.

Selection, camera, theme, playback position, temporary animation overrides,
source `File` objects, splat buffers, and GPU resources stay outside history.
Editing an animated pose without setting keys previews that pose at the current
frame; scrubbing or playback resumes evaluation from the saved curve. Authored
base-channel edits are still document changes. The animation preview itself is
not an animation key and is not stored as one in an archive.

Undoing an import detaches its runtime object; redo reattaches it. Resources are
released when their IDs leave the current document and both history stacks.
Large imported assets can therefore remain in memory while redo is possible.
The original turntable remains a separate preview group below object transforms.

Zundo imports Zustand's root entry point. Vite aliases that exact entry to
`zustand/vanilla`, avoiding React in this TypeScript application. Tests use the
same alias and inline Zundo.

## Persistence and verification

Portable `.msb` ZIP packages store the scene and original asset bytes. Camera
and current time in seconds are stored separately from scene animation settings.
The optional animation, driven-key, IK, and constraint fields extend scene version 1 without
requiring them in older archives. Loading validates references and limits before
staging splat resources and replacing the active scene. Successful Open/New
starts a fresh history. See [MSB-FORMAT.md](MSB-FORMAT.md).

Focused tests cover curve interpolation and tangents, key operations/history,
driven cycles and evaluation order, animated joint edit preparation, IK behavior,
archive roundtrips, deletion cleanup, and the existing scene and elasticity
regressions. The production build includes TypeScript checking. There is no
separate lint script. Live UI checks complement the pure-model tests; they do
not establish large-scene or cross-browser performance.

See [docs/ANIMATION.md](docs/ANIMATION.md) for workflows, limitations, reference
documentation, and the prioritized next steps.
