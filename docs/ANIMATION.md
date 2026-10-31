# Animation and rigging guide

Musubi implements a practical subset of Maya-style animation workflows. The
current editor has a frame timeline, editable transform/joint curves, driven
keys, FK/CCD IK, and point/orient/aim/scale/parent constraints. Animation layers,
pole vectors, full skin-weight
editing, polygon modeling, and particle FX remain future work.

## Start with the example

Choose **File → Open scene** and open
[examples/animation-study.msb](../examples/animation-study.msb). This small portable
scene uses procedural assets, so it needs no external splat file. It contains:

- An **Animated study** knot with a keyed bounce and a 720-degree spin.
- A **Driven study** knot whose Z rotation responds to the first knot's Y position.
- A **Shoulder → Elbow → Wrist** joint hierarchy with keyed shoulder FK motion.

Play or scrub frames 0–96. Choose the **Animation** workspace preset to inspect
the curves, then open **Animation → Set Driven Key** to inspect the response.
The example has no binding or IK handle preset. In the IK controls, choose
Shoulder as root and Wrist as end to try a three-joint chain.

Regenerate this example from the repository root with:

```sh
node scripts/create-animation-example.mjs
```

The script uses the application's own document/archive modules and the existing
Vite dependency. It does not download assets or introduce a service dependency.

## Workspaces and panels

The workspace selector offers **General**, **Animation**, and **Rigging**. A
preset rearranges existing panels; it does not create a separate scene. Animation
opens the Graph Editor, while Rigging opens the rigging tools. Dockview tabs can
be dragged, combined, closed, and resized. The layout is saved in local browser
storage, outside the `.msb` project.

Open **Graph Editor**, **Dope Sheet**, and **Set Driven Key** from the **Animation**
menu. Outliner and Properties remain the selection and local-channel controls.
Use **View** to reopen the standard panels. Modeling and FX presets are not yet
provided because their toolsets are not implemented.

## Keyframe an object or joint

1. Select an object or joint in the Outliner or viewport.
2. Leave Timeline **Mode** set to **Animation** and choose the current frame.
3. Edit Position, Rotation, or Scale in Properties, or use the viewport gizmo.
   Joint scale is not supported.
4. Press **S** outside text fields, or click **Set key · S**. This keys the
   selected transforms/joints at the current frame.
5. Move to another frame, change the pose, and set another key. Scrub or play to
   inspect the result.

The initial range is 0–288 at 24 FPS. Timeline **Start**, **End**, **FPS**, and
**Loop** are saved with the scene and support undo. Frame navigation snaps to
whole frames; playback evaluates subframes. Keys outside the playback range are
retained. The slider's markers show keyed frames for the current selection.
Click a marker to seek to it. **Delete keys at frame** removes the selected
objects' keys at the current rounded frame.

**Auto key** modifies existing animated channels when their displayed values
change. Set the first keys with **S**; enabling auto-key does not create tracks
for an entirely unkeyed object. Driven output channels are excluded from manual
transform keying and auto-key. The auto-key toggle is an editing preference for
the session, rather than a scene animation layer.

Properties has a diamond beside each transform channel. Click it to key just
that channel's displayed value. An empty diamond means no curve, a filled
diamond means an animated channel, and a gold diamond means a key at the current
frame. Joint scale and SDK-driven outputs cannot be keyed there. The **Visible
(key at current frame)** checkbox directly authors a stepped visibility key;
its diamond keys the existing visible/hidden value without toggling it.

An edit to an already animated channel without auto-key is a temporary pose
override until it is keyed. Scrubbing or starting playback resumes the curve.
Authored base channels still participate in ordinary document edits, but saving
does not turn that temporary pose into animation keys. Set the key before leaving
the frame when you intend to keep the animation change.

**Space** toggles playback; **,** and **.** step one frame backward/forward.
Rewind seeks to the playback start. The separate **Turntable preview** mode
retains the original 12-second presentation rotation. Turntable playback is not
a keyframe curve and is not saved as animation.

## Graph Editor

Select a channel in the list to make its curve active. **Selected objects**
filters the list to the scene selection. Curves use local transform units or
degrees, with labelled frame and value axes.

| Action | Control |
| --- | --- |
| Select a key | Click its diamond |
| Add/remove keys from selection | Shift-click |
| Select keys in a rectangle | Drag blank graph space; Shift adds to selection |
| Move selected keys | Drag a key; frame coordinates snap to whole frames |
| Edit one key precisely | Frame and Value fields |
| Insert without changing curve shape | Insert key or focused-editor S, at the current frame |
| Author a key at a chosen time/value | Double-click the graph |
| Delete selected keys | Delete button, Delete, or Backspace |
| Copy/paste | Toolbar or Ctrl/Cmd+C and Ctrl/Cmd+V |
| Zoom around the pointer | Mouse wheel |
| Pan | Alt-drag or middle drag; Shift-wheel pans time |
| Frame keys | Frame all / Frame selected; F uses the current key selection |
| Nudge key times | Left/right arrow; Shift changes the step to 10 frames |
| Select all visible keys | Ctrl/Cmd+A |
| Cancel a graph drag / clear key selection | Escape |

Paste offsets copied keys so the earliest copied time lands on the current
frame. It preserves their original object/channel destinations; this is not
animation retargeting. Moves and time scaling that create conflicting key times
are rejected atomically. A completed key or tangent drag is one undoable edit.

**Insert key** samples the active curve at the current frame and preserves its
shape. Linear and stepped intervals retain their existing interpolation; Bezier
intervals are subdivided with De Casteljau interpolation, including ordinary
weighted handles. Affected neighboring tangents become Fixed so their adjacent
segments retain the same shape. The insertion and tangent changes form one
undoable edit. Double-clicking an explicit time/value instead performs ordinary
key authoring and may change the curve.

Some extreme weighted splits would require infinite tangent slopes or handle
weights greater than one, which the saved curve schema cannot represent. Those
insertions are rejected atomically with an instruction to adjust tangent weights;
the editor does not substitute an approximate curve.

Choose **Bezier**, **Linear**, or **Stepped** interpolation. Bezier keys expose
incoming/outgoing handles on the active curve. Drag a handle or edit **In slope**
and **Out slope**. **Break tangents** permits independent directions; linked
handles share a slope. **In weight** and **Out weight** set handle lengths as
fractions of adjacent key intervals; **Unweight** resets each to one third.

Tangent presets are **Auto**, **Clamped**, **Spline**, **Flat**, and **Fixed**.
Auto limits slopes and flattens extrema; Clamped flattens plateau transitions;
Spline uses the neighboring-key slope; Flat uses zero slope. Fixed retains
explicit slopes for hand editing. These implement documented DCC concepts, not
bit-for-bit Maya tangent algorithms. Weighted time coordinates are solved before
evaluating the cubic, so the displayed curve and scene use the same evaluator.

Rotation is XYZ Euler degrees. A 0→720 curve performs two turns, rather than
taking a quaternion shortest path. Gizmo commits choose the nearest equivalent
XYZ representation to the displayed pose; typed values retain intentional full
turns. There is no full Euler filter, alternate rotation-order selection, or
quaternion-curve editing yet. Interpolation holds endpoint values outside keys;
pre/post-infinity cycle modes are not implemented.

Visibility channels use stepped playback and are authored through the Properties
visibility controls or SDK. The standard transform **S** command creates
position/rotation/scale tracks; the visibility checkbox/diamond handles visibility.

## Dope Sheet

The Dope Sheet lists object/joint channels as rows and shares key selection with
the Graph Editor. Shift-click or box-select keys across multiple objects, then
drag to retime them together. **Shift frames** and **Shift** apply a numeric
offset. **Time scale** and **Scale time** scale selected times around the earliest
selected key, snapping results to whole frames. Copy, paste, deletion, framing,
zooming, and history use the same commands as the Graph Editor.

The current sheet edits channel rows. It does not provide animation clips,
layer compositing, range ripple editing, or a nonlinear animation editor.

## Set Driven Key

1. Open **Animation → Set Driven Key**.
2. Choose the driver object and attribute, or select it in the scene and click
   **Load selected as driver**.
3. Choose the driven object and attribute. They may be different attributes on
   the same object.
4. Enter a **Driver value** and **Driven value**, then click **Set driven key**.
5. Enter another pair and set another key. Change the driver in Properties, or
   animate it with ordinary time keys, to see the response.

**Load current values** samples the current displayed pose, including unkeyed
editing previews. Values typed into this panel are draft mapping values until
**Set driven key** is pressed; they do not directly move the objects.

The **Relationships** list exposes each mapping. Its response curve plots driver
value horizontally and driven value vertically. Edit either value, interpolation,
or tangent preset in the key table. **Load relationship** restores its property
selectors for adding another pair. Delete individual keys or remove a complete
relationship; removing the last key also removes that dependency.

One driver may control many outputs. An output has one driver, and may not also
have a time curve. Cycles are rejected at the property level, including indirect
cycles. Chained mappings evaluate in dependency order and hold endpoint values
outside the driver range. Visibility defaults to stepped response; interpolated
scale remains positive. These records and edits support project saving and undo.

SDK uses the same curve representation/evaluator as time animation, but its
curves currently have their own table and preview. They are not selectable in
the time Graph Editor. Multiple-driver blending and driving from post-IK solved
values are not implemented; SDK evaluates before IK and constraints.

## FK, IK, binding, and elasticity

The Rigging panel already supports joint creation, parenting, FK rotation,
binding, unbinding, and elasticity. Select a splat and Shift-select joints before
**Bind splats**. Automatic distance weights use up to four influences per splat.
The **Elasticity** tool applies to bound parent–child connections; its properties
control deformation and the bounded allocation of fill splats. These existing
systems consume the final animated joint pose.

IK controls select a **Root joint** and descendant **End joint**, then click
**Create IK handle**. **Use selected joints** loads a root/end pair from the scene.
Its target is a world-space XYZ position. Change the target to solve the chain;
use the FK/IK blend to retain FK at zero or apply the solution at one. The
**Match target to FK** places the IK target at the current FK endpoint. It only
moves the target; it does not key joints or change the blend.
Enable/disable, target, blend, solver iteration count, and handle removal are
document edits with undo and serialization.

To keep the current solved pose as FK, select an enabled handle with blend above
zero and click **Match FK to IK and key**. The command captures XYZ local rotation
keys for every joint from root through end at the current frame, then sets the
handle's blend to zero. Both changes form one undo command. It samples the IK
result before constraints and chooses equivalent Euler angles near the current
FK values to preserve rotation continuity. Existing keys at that frame retain
their interpolation and tangent settings; new keys use auto Bezier tangents.
Position and scale keys are unchanged.

Matching rejects chains with SDK-owned rotation channels or enabled Orient,
Aim, or Parent constraints on their joints. Disable or remove those competing
rotation controls before matching. A disabled handle or zero blend has no active
IK pose to capture. This command matches one frame: the blend setting is not
animated, so it changes how the handle evaluates at every frame. It neither
bakes a frame range nor guarantees a seamless switch elsewhere in the animation.

Before committing, matching checks that the chain keeps its world positions and
orientations, both before and after constraints. Unkeyed position previews or
rotation-driven dependencies can make a rotation-only match change the pose;
the command then rejects the entire edit. Key those position previews or resolve
the dependencies first. Point constraints are allowed when the resulting pose
remains unchanged.

Click **Move target in viewport** to select the handle's target marker and attach
the translation gizmo. Target markers can also be selected by clicking them in
the viewport. Drag to preview the solution; release records one target edit in
history. **Escape** cancels the drag, and **Delete** removes the selected handle.
The marker is a viewport control for the handle's stored world-space target,
not a separate scene transform node or animation channel.

The solver reuses Three.js `CCDIKSolver`. It supports two-bone and longer chains,
with deterministic handling around straight-chain singularities. Unreachable
targets produce a bounded iterative approximation. Chains may not overlap or
control ancestors of another chain. This prevents order-dependent results.

Current IK limitations are significant: no pole vector, joint orientation/axis
editing, angular limits, analytic two-bone solution, target transform node,
target/blend keyframing, or range-based IK-to-FK pose baking. Matching a target position
does not reproduce every possible elbow/knee bend. There is no animation layer
for blending competing rigs. Use the FK and animation controls for authored poses.

## Constraints

Open **Rigging → Constraints**. Choose **Source · follow this**, **Driven ·
constrain this**, and a constraint **Type**. The selection-loading buttons fill
the source/driven selectors from scene selection. Leave **Maintain offset**
checked to retain the current relationship, or clear it to align the affected
attributes, then click the corresponding **Create … constraint** button.

| Type | Result |
| --- | --- |
| Point | Follows world position; a maintained positional offset stays in world space |
| Orient | Follows world rotation using a stored quaternion offset |
| Aim | Rotates a selected local axis toward the source's world position, using a selected world-up direction |
| Scale | Follows world size with an optional multiplicative scale offset; object targets only |
| Parent | Follows position and rotation; target scale remains its underlying value |

Parent positional offsets are expressed relative to the source. Rotating or
scaling the source therefore also rotates or scales the offset's translation,
even though the constraint does not copy scale onto the driven object. Point
constraints instead add their positional offset in world space. The evaluation
converts world results back into the driven object's parent space.

The **Scene constraints** list provides Enabled and Delete controls. Disabling
a constraint reveals its underlying animation/SDK/IK pose; it does not bake the
constrained pose into keys. Creation, enable/disable, and deletion support undo
and archive persistence. Recreate a relationship to change its source, type, or
captured offset.

For **Aim**, choose **Look-at source · aim toward this** and **Driven · rotate
this**, then select a signed **Local aim axis** and **World up axis** from ±X,
±Y, or ±Z. Click **Create aim constraint**. Defaults are local **+Z** and world
**+Y**. The local up axis
is +Y, except that aiming ±Y uses local +Z as up. Clear **Maintain offset** for
the selected axis to point directly toward the source. When offset is maintained,
the initial world orientation is preserved relative to the initial aim solution;
the chosen axis therefore need not point directly at the source.

Aim changes rotation only. Its source and driven object must occupy distinct
world positions (separation greater than 0.00000001 scene units). Coincident
points are rejected; if animation reaches them, playback stops with an explanation
and the entire constraint stage falls back to its underlying pose. When the aim
direction is parallel to world up, Three.js supplies a deterministic fallback
basis. This avoids undefined orientation but can produce a roll change near the
pole; it is not a continuity-preserving roll solver. There is no object-up mode,
animated up object, or multi-source aim weighting. Recreate the constraint to
change its captured offset or axis settings.

Constraints evaluate after animation, SDK, and IK, overriding their assigned
channel groups. They do not feed values back into those earlier stages. Each
position, rotation, or scale group has one constraint source; Parent owns both
position and rotation, and Aim owns rotation. Cycles involving constraints and the hierarchy are
rejected, including disabled constraints, so enabling a record cannot introduce
a hidden cycle.

This subset has no multi-source weighting or constraint animation. Joint scale
constraints are disabled. Orient, Aim, Parent, and Scale reject nonuniformly
scaled driven-parent transforms. Orient, Parent and Scale also reject sheared
sources. Aim uses only the source position, so source shear is allowed. Point
supports arbitrary finite, invertible parent transforms. Non-finite values and
singular driven-parent transforms are rejected.

If animation reaches an unsupported constraint pose, playback stops and a notice
identifies the limitation. Constraint evaluation falls back atomically to the
underlying animation/SDK/IK pose rather than leaving some constraints applied.
Disabled constraints remain editable, so the offending relationship can be
disabled or deleted before repairing the hierarchy or animation.

## Performance and verification

Development CPU measurements were approximately **0.56 ms for 1,000 animation
tracks**, **2.62 ms for 20 IK chains**, and **0.44 ms for 100 parent constraints**
on the local development machine. The constraint measurement used 100 Node CPU
evaluations taking 43.5 ms in total.
These are narrow CPU microbenchmarks, not end-to-end frame times. They exclude
WebGL/Spark rendering, skinning/binding uploads, elasticity, UI rendering,
source-asset loading, and device/browser variation. Large weighted curves and
large splat scenes still require representative profiling.

Run `npm test` for focused model, command, archive, and regression tests. Run
`npm run build` for TypeScript checking and the production bundle. No separate
lint script is configured. Tests cover weighted curves, full-turn rotations,
key edits/history, SDK cycles/order, animated FK edit continuity, IK solving,
and existing scene/elasticity behavior. The example scene supports repeatable
manual browser checks; it does not substitute for imported production assets.
See [VALIDATION.md](VALIDATION.md) for the dated verification record and measured
small-scene playback results.

## Remaining work, in priority order

1. Pole vectors, analytic two-bone IK, local joint axes/orientation, rotation
   limits, target/blend animation, and range-based IK/FK baking.
2. Aim object-up/roll controls, multi-source constraint weighting, constraint
   animation, and curve-based controller shapes.
3. Editable normalized skin weights, influence management, weight painting,
   joint/pose mirroring, and conventional deformers.
4. Animation layers, camera/custom-property animation, Euler filtering, richer
   clipboard/retargeting, and SDK Graph Editor integration.
5. Polygon primitives and editable topology, component selection, modeling
   operations, materials/UVs, and mesh import/export.
6. Deterministic particle emitters and fields, lifetime controls/caches, and a
   dedicated FX workspace.

## References and licenses

Functional references are Autodesk's [Graph Editor tangents documentation](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Animation/files/GUID-43A4FE2C-4863-4EA6-B6AE-6D2B6757F6C7.htm)
and [Set Driven Key workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Animation/files/GUID-F5429279-8EDB-449C-9E8D-4B5C0210757D.htm).
The aim workflow follows Autodesk's [Aim constraint options](https://help.autodesk.com/cloudhelp/2024/ENU/Maya-CharacterAnimation/files/GUID-D4769D95-EC0E-4C94-AF60-8EB3FC4305E4.htm):
the local aim direction points toward a target, and a world-up direction controls
roll. Musubi uses +Z as its default aim axis, while Maya documents +X, and exposes
only signed-axis vector-up settings rather than Maya's full set of up modes.
Autodesk's [IK/FK Keys menu](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-Animation/files/GUID-C5ACDDBC-9E30-443C-8419-F07FC41E9A86.htm)
distinguishes moving an IK target to an FK endpoint from keying the handle and
joint chain. Its [IK/FK blending workflow](https://help.autodesk.com/cloudhelp/2022/ENU/Maya-CharacterAnimation/files/GUID-8B0B343A-B00A-427C-8C79-E2B9008C4A88.htm)
also animates blend values across frames. Musubi's matching commands cover target
alignment and a current-frame rotation capture; animated blend transitions remain
future work.
The interface adapts these concepts without using Autodesk code, branding,
proprietary artwork, or file formats.

Curve primitives and CCD solving reuse the existing Three.js dependency. Its
[MIT license](https://github.com/mrdoob/three.js/blob/r180/LICENSE) is compatible
with this Apache-2.0 project. No new package dependencies or paid services were
introduced for these animation/rigging additions. Other dependencies retain
their existing licenses.
