# Scene data architecture

Musubi uses a Maya-inspired transform/shape model: named transforms own local
position, rotation, and scale; child splat shapes reference assets and controller
curve shapes store local NURBS data, and mesh shapes store polygon topology. The design
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
    CurveShape: name, parentId, degree, weighted points, knots, closed, color
    MeshShape: name, parentId, vertices[id, position], faces[id, vertex IDs], color, shading, wireframe
    ParticleShape: name, parentId, emission/seed/timing, motion/fields, lifetime appearance, optional mesh source
  assets[id]: procedural generator or original file metadata
  joints?: local position/rotation, preferredAngle, name, ID, parentId
  animation?: fps, start, end, loop, tracks
    track: ID, targetId, channel, keys
  drivenKeys?: driver property, driven property, response curve
  ikHandles?: root/end joint IDs, world target, enabled, iterations, blend,
    optional solver/poleTarget, targetControl/poleControl { objectId, offset }
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
  instancing remain future work. Archive transforms require one shape, either a
  splat shape, controller curve shape, polygon mesh shape, or particle emitter shape.
- Binding records influence joint IDs, rest matrices and optional sparse component
  weight overrides. Shared skin-weight commands validate and normalize authored
  rows; unedited components retain nearest-four distance weights. Spark receives
  the resulting weights before elasticity is initialized. Numeric ranges and
  exact viewport component selections share uniform editing commands; brush
  strokes use the same validation with a separate requested weight per component.
- Binding runtimes cache document binding/elasticity references and joint topology.
  Playback does not serialize the authored weight map. Preview points use only
  requested original components and the same packed skin transforms as selection.
- Component picking projects posed original centers in chunks with Three matrices.
  A click selects the nearest screen-space center; rectangles select through the
  object. Async scans cancel on scene, pose, camera, layout, or binding changes.
  Runtime selections stay outside undo snapshots and archives; explicit scene
  replacement clears them without confusing undo-restored command labels with opens.
- Skin painting reuses that projection scan to build a screen-space grid index.
  Continuous brush segments query nearby centers and retain maximum falloff per
  component for each stroke. A separate interaction adapter previews sampled
  colors without changing geometry or history, then submits one atomic weight
  command on release. Pending scans freeze input on release and cancel on scene,
  camera, layout, or binding changes. Escape discards the stroke. Numeric drafts
  commit before the adapter captures brush settings. Painting and component
  selection are mutually exclusive, with independent panels and shared skin data.
- Elasticity settings belong to bound shapes. Existing elasticity deformation
  and bounded splat allocation run after the rig pose; they are not a second rig.

## Evaluation pipeline

Polygon commands in `mesh-modeling.ts` edit shared vertices and ordered face loops
with stable IDs. Derived edge IDs are sorted vertex-ID pairs. All commands validate
topology before replacing the immutable shape, producing one undo step. Extrusion
duplicates an edge-connected region, builds walls only along its boundary, and
prunes unused vertices. Face deletion also prunes unused vertices. Three.js supplies
primitives and welding; ShapeUtils/Earcut triangulates render buffers while keeping
triangle-to-authored-face mappings. Buffers, computed normals, bounds, and polygon
wire overlays belong to `mesh-renderer.ts`, outside the document/history. Appearance
changes reuse geometry; topology changes dispose replaced geometry.

`setMeshTopology` validates a complete replacement, defensively copies caller-owned
vertex positions and face loops, and preserves the shape's owning transform and
appearance. Merge-to-center rewrites shared corners and rejects pinches/duplicate
faces. Delete Edge traces directed region boundaries and retains unused vertices;
holes and unselected interior edges are rejected. Normal reversal changes full
edge-connected shells to preserve consistent winding. These commands live in
separate modules and share the same undo/persistence path. Existing valid
dominant-axis tessellations are preserved; bent n-gons can fall back to an
orthonormal area-normal projection with the same intersection/triangle checks.

Component gizmos capture the selected components' unique vertices and the mesh's
world matrix once at gesture start. `mesh-component-transform.ts` applies each
complete world-space gizmo delta to that immutable baseline, converting it back
to local coordinates with `inverse(meshWorld) × deltaWorld × meshWorld`. Repeated
pointer events therefore do not accumulate edits or rounding error.
`mesh-renderer.ts` previews those local coordinates in the existing position,
normal and polygon-wire buffers, updating bounds while preserving the committed
tessellation and triangle-to-face mapping. Preview input validation checks IDs
and finite coordinate limits; full topology validation and retessellation happen
on release through the shared mesh command. A valid commit creates one undo step;
cancel restores the exact committed buffers and bounds without changing history.

Mesh vertex/edge clicks use screen distance; face clicks raycast the selected mesh.
Rectangles select component centers through the object. Component selection,
gizmo snapshots, transient geometry previews and overlays are runtime state and
are not saved in `.msb` files. Selection is limited to 20,000 components and is
mutually exclusive with splat skin editing. Document, pose, camera, or layout changes cancel pending
mesh selection gestures. Mesh transforms participate in shared animation, SDK,
and constraints; mesh skinning and animated vertex positions are not implemented.

```text
UI / keyboard → shared commands → immutable SceneDocument → undo history
                                      ↓
                     authored local transform and joint channels
                                      ↓
                    absolute-frame Base and animation layer curves
                                      ↓
                       temporary unkeyed editing overrides
                                      ↓
                   driven-key curves in property dependency order
                                      ↓
                   prerequisite constraints for linked IK inputs
                                      ↓
                          IK solution blended with FK
                                      ↓
                 remaining constraints in hierarchy/dependency order
                                      ↓
             Three.js transforms / joints → Spark binding and elasticity
```

Animation curves are stored independently of renderable assets and apply to
transforms and joints through the same pose representation. Evaluation creates
a pose map without changing the document, so scrubbing and repeated evaluation
of a frame are deterministic and do not fill history. The viewport, Properties,
timeline, Graph Editor, and Dope Sheet refer to the same scene and frame.

Layers retain one flat authoritative track store with optional layer IDs. A
compiled WeakMap plan groups active contributions by target/channel for ordered
scalar mixing. Keying uses the inverse affine stack to produce requested composite
poses; editable-track views scope Graph/Dope/Timeline/Channel Box operations.
Layered pose edits retain authored fallbacks and use temporary overrides before
keying. Layered IK baking writes a new top override and verifies world samples.

`joint-transform.ts` owns orientation composition and rotation-channel extraction
for skeleton, IK and constraints. Joint mirroring reflects right-handed world
frames and derives destination-local channels before whole-rig verification.
Influence palette edits first materialize effective component rows, preserving
automatic weights across palette changes within the existing override budget.

IK handles additionally accept an `ik.blend` track whose `targetId` is the handle
ID. These scalar tracks are evaluated separately from transform poses; no fake
pose is created for a handle. Handle IDs are distinct from node/joint IDs.
`evaluateIKBlend` samples the requested frame and clamps effective output to 0–1,
using the saved literal `blend` when no keys exist. The solver, markers, matching,
and historical pose sampler use the same frame-aware result. Blend slider drafts
preview at runtime; release commits one edit and Escape discards the preview.

`src/animation.ts` owns channels, curve evaluation/validation, and key commands.
It reuses Three.js cubic Bezier primitives, with time-parameter inversion for
weighted handles. Curves hold their endpoint values outside the keyed interval.
Rotation curves retain full turns; numerical inputs preserve intentional spins.
`src/animation-edit.ts` maintains nearby equivalent XYZ angles for gizmo commits
and preserves unaffected evaluated channels during FK edits.

`src/controller-curves.ts` validates and edits rational controller curves, using
the existing Three.js `NURBSCurve` for sampling. A controller's ordinary transform
participates in animation, SDK, and constraints; its shape is local display
geometry rather than a separate pose system. Circle, square, and arrow presets
need no asset bytes. Shape edits are shared document commands with undo.

`src/controller-renderer.ts` owns a Three.js `Line`, geometry, and material per
controller. Local samples provide bounds and selection points; line raycasting
provides viewport picking. Replacing curve geometry disposes the previous buffer
while retaining the line, material, and bounds identities. Runtime shape-record
comparison avoids resampling during playback or transform-only changes. The
adapter reports zero splats, and controller curves bypass binding and elasticity.
Closing a curve joins its sampled endpoints; it does not construct periodic
NURBS data. The renderer disposes its owned resources when the object is removed.

`src/driven-keys.ts` owns attribute connections. Each driven property has one
driver, while one driver may feed many outputs. A property-level topological
order supports chained relationships and rejects cycles. A driven output cannot
also have a time curve. Driven values use the same cubic evaluator as animation;
their horizontal coordinate is the driver value rather than a frame.
SDK still reads authored/time/preview channels and earlier SDK outputs, before
IK or constraints; a solved IK rotation is not a feedback driver.
Its validator and UI use `POSE_ANIMATION_CHANNELS`: handle properties and
`ik.blend` are explicitly excluded from both SDK drivers and outputs.

`src/ik.ts` adapts Three.js's MIT-licensed `CCDIKSolver` to the shared joint pose.
IK affects the pose map before binding, leaving authored FK values intact.
Handles have world-space targets and an FK/IK blend. Overlapping or
ancestor-dependent chains are rejected so array ordering cannot change the result.
An optional `solver` field selects `two-bone` for exactly three joints; an absent
field retains CCD compatibility. Analytic handles require a finite world-space
`poleTarget`. `src/two-bone-ik.ts` adapts ozz-animation's MIT IKTwoBoneJob to Three
quaternions, preserving bone lengths and leaving the endpoint's local rotation
unchanged. It adds deterministic fallback planes for singular inputs. Its license
and pinned source revision ship in `public/licenses/ozz-animation.txt`.
Optional joint `preferredAngle` triples provide an explicit local XYZ starting
pose. Each handle first snapshots its evaluated FK link rotations, then seeds
only root-through-pre-effector joints that have preferences. Both existing
solvers run unchanged and blend their result against the original FK snapshot.
Ancestors, end-joint orientation, blend-zero poses, and joints without preferences
keep their prior behavior. No previous-frame state is used. This stabilizes the
analytic hinge inference when animated FK rotations cross through a straight
pose, provided the stored preferred pose supplies a suitable bend.

`src/joint-preferred.ts` owns atomic metadata capture/edit/clear and explicit
rotation keying; the Joint Settings panel uses prepared FK poses before IK.
Preference-only metadata edits retain temporary FK input drafts, including
through undo/redo. Changes to authored rotations, hierarchy, animation or other
rig inputs retain the normal draft invalidation policy. Preferred angles are
static rig settings, separate from joint orientation and rotation limits.
Optional `targetControl` and `poleControl` records reference an ordinary transform
by `objectId` with an XYZ world-space `offset`. The resolved point is its evaluated
world origin plus that offset. Literal `target`/`poleTarget` values remain saved
fallbacks; old files without links retain static targets and the original
animation → SDK → IK → constraints order. Linked controls use ordinary transform
curves, SDK, and supported constraints; there is no separate target-key schema.

`src/ik-controls.ts` binds/unlinks controls, creates a circle target or arrow pole,
and matches control positions with staged shared commands and one live undo step.
Bind/create refresh the fallback point; unlink freezes the current resolved point.
Deleting a control removes its link while retaining the handle: the viewport
supplies current resolved points, while a pure deletion command without a pose
uses the saved fallback. Undo restores nodes and links together.

Endpoint and pole markers share the viewport adapter; the pole's line connects
to the evaluated middle joint. Linked markers and Move buttons select the ordinary
control object. Its gizmo previews drive the chain live without changing history
until commit. Unlinked markers instead edit literal world points. Linked numeric
target fields display resolved coordinates read-only.

`src/ik-control-plan.ts` computes a cached prerequisite closure from every configured
control link, its hierarchy and constraint sources, and the linked chain root's
ancestors. The plan is structural: disabled handles/constraints, zero blend, and
latent pole links on CCD handles still reserve dependencies. Reaching any IK
chain through hierarchy or constraints rejects the configuration, including
cross-chain feedback. Constraints on chain outputs remain post-IK; unrelated
constraints keep their usual order. `evaluateRigStages` runs prerequisites → IK
→ remaining constraints on a candidate pose map, publishing only after all stages
succeed. A failure leaves the input time/preview/SDK pose intact; no partial IK
or prerequisite result leaks through. Optional snapshots capture prepared FK and
post-IK poses for matching. SDK is not reevaluated after either constraint phase.

`matchFKToIK` captures local rotations after IK and before remaining constraints
for every joint from root through end, unwraps them against the prepared FK pose,
and keys the current frame. An existing `ik.blend` track receives a zero key at
that frame; without a blend track, the literal fallback becomes zero. These
changes form one document command.
It retains existing key settings and leaves position/scale channels untouched.
SDK-owned joint rotations and enabled rotation constraints reject the command
atomically. The target-to-FK command aligns the endpoint target and, for analytic
handles, the pole with the displayed FK bend plane. With linked controls,
`matchIKControlsToFKAndKey` subtracts world offsets and converts desired origins
through evaluated parent inverses before keying local position XYZ. Unlinked
points are updated in the same transaction. Position SDK/Point/Parent ownership,
incompatible target/pole requests on one object, or dependencies that would shift
the keyed result reject the whole edit. Matching does not bake a frame range.
When no blend track exists, the literal blend change still applies at every
frame. Matching keys reuse the existing animation track schema.

`src/ik-bake-plan.ts` validates range settings, rotation ownership, sample/key
limits, and estimated scene work. `src/ik-bake.ts` implements asynchronous
`bakeIKToFK`: sample the immutable original document, build all rotation tracks
as one candidate, and disable the selected handle. A second pass compares every
object/joint world matrix and visibility against fresh original samples. This
also catches SDK dependencies that would change when solved rotations become
authored inputs. Source evaluation uses the same time/SDK/rig stages as playback.
Periodic yields support cancellation; document identity checks prevent stale
results from overwriting newer edits. Only a verified candidate reaches one
store/history commit. The dockable `ik-bake-panel.ts` provides range controls,
progress, cancellation, and access to the resulting joint curves. It has no
renderer dependencies. Between-sample interpolation and outside-range motion
are not verified or preserved by the operation.

Blend keys must lie within 0–1. The Graph Editor shows the authored curve,
including spline/weighted-tangent overshoot, while playback uses clamped output.
Shape-preserving insertion rejects a sample outside the key range atomically;
it cannot preserve that raw curve with an out-of-range key. Handle deletion,
including removal caused by deleting its chain, removes its animation tracks in
the same undoable document edit. Old files with only literal blend retain their
previous behavior; no archive version change is required.

FK rotation capture stages the new keys and handle settings before touching live history,
reevaluates time curves, SDK, and the shared rig stages, and compares every chain joint's world
position and orientation with the captured pose. It repeats that comparison
after constraints. Unkeyed translation previews or rotation-driven feedback
that would move the chain therefore reject the whole operation; benign point
constraints remain supported. Only a verified document enters the live store.

`src/constraints.ts` provides point, orient, aim, scale, and parent constraints across
objects and joints. It computes source world poses in dependency order, converts
results into the driven node's parent space, and overrides the corresponding
output groups in their assigned prerequisite or post-IK phase. Parent constraints affect position and rotation while
retaining target scale; their positional offset follows the source's full
transform, including source scale. Point offsets stay in world space. Rotation
offsets are normalized quaternions. One constraint owns each output group;
hierarchy/constraint cycles, including disabled links, are rejected. IK consumes
its prerequisite results once; remaining constraints do not feed back into IK.
Joint scale constraints are not
supported. Orient/aim/parent/scale reject nonuniform driven-parent transforms.
Orient/parent/scale reject sheared sources; aim reads only the source position.
Point supports arbitrary finite invertible parents. Unsupported
animated poses stop playback with an explicit notice. Evaluation is atomic, so
the whole rig stage falls back to its input time/preview/SDK pose when a check fails.
Disabled constraints remain editable for repair.

Aim owns the target's rotation group and uses Three.js orientation math to
point a signed local axis toward the source's world position. Optional axis
settings default to local +Z and world-up +Y; local up is +Y unless aiming ±Y,
when it is +Z. A maintained quaternion offset preserves initial world orientation.
Coincident source/target positions are rejected atomically. Up-vector collinearity
uses Three.js's deterministic fallback, without a previous-frame orientation
cache; roll continuity near the pole and object-up modes remain future work.

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
Changing only IK blend values or blend curves retains these input pose previews,
including through undo/redo. Changes to other animation or rig inputs still
invalidate them; scrubbing and playback end the preview session.

Undoing an import detaches its runtime object; redo reattaches it. Resources are
released when their IDs leave the current document and both history stacks.
Large imported assets can therefore remain in memory while redo is possible.
The original turntable remains a separate preview group below object transforms.

Zundo imports Zustand's root entry point. Vite aliases that exact entry to
`zustand/vanilla`, avoiding React in this TypeScript application. Tests use the
same alias and inline Zundo.

## Persistence and verification

Particle settings are validated by `particle-emitter.ts`; creation and updates
replace immutable shapes in one history step. Surface emitters are children of
their source mesh's transform, so subtree deletion also removes the emitter.
The scene-wide validator checks source references, parent links, duration at the
current FPS, and particle budgets. Animation settings enforce those budgets too.

`particle-pose-sampler.ts` evaluates authored animation → SDK → prerequisite
constraints → IK → remaining constraints through the same shared rig stage at
historical birth times, excluding viewport drafts and turntable rotation. Its
cache is limited to 256 frames and approximately 32,768 matrices (one frame is
always retained). `particle-simulation.ts` uses pinned Nebula integration and
behaviors with isolated seeded streams, integer birth scheduling, fixed 120 Hz
steps, bounded output caching, and cancellable chunked backward replay. Output
buffers do not enter the document/history. A new document revision rebuilds the
simulation; changing selection or camera does not. There is no resumable exported
solver snapshot: backward replay rebuilds the seeded library state.

`particle-runtime.ts` rejects stale async results across seeks, edits, suspension,
and disposal. `particle-renderer.ts` renders world-space buffers under a local
emitter marker, compensating for the current emitter hierarchy transform. This
keeps old particles stationary when the emitter moves; the separate turntable
presentation can rotate the cloud. Bounds include the current cloud, while
viewport clicking and marquee selection use the emitter marker. Shader points
respect opaque geometry depth; transparent cross-object sorting is approximate.

Portable `.msb` ZIP packages store the scene and original asset bytes. Camera
and current time in seconds are stored separately from scene animation settings.
The current scene format is version 2, including independent layer-owned weight
curves. The MSB container remains version 1. Older scene versions are rejected
explicitly; optional animation, driven-key, IK and constraint fields may be absent. Loading validates references and limits before
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
