# Musubi scene files (.msb), version 1

An `.msb` file is a standard ZIP archive, written using fflate. File > Save uses
the current file handle where supported. Save As requests a new destination.
Browsers without the native file picker download a named `.msb` copy instead;
the status says "Scene download started" because the app cannot confirm that
the browser finished writing a download. Open falls back to a file input.

Shortcuts: Ctrl/Cmd+S saves, Ctrl/Cmd+Shift+S saves as, Ctrl/Cmd+O opens.
New and Open ask before discarding unsaved document edits. The title's asterisk
tracks scene-document changes, including undo back to the saved state. Camera
navigation, selection, and playback do not mark the scene dirty. Camera and
timeline position are nevertheless captured whenever a scene is explicitly saved.
Failed/canceled saves retain the previous destination and unsaved state.

```text
scene.json
assets/<asset-id>
assets/<another-asset-id>
```

`scene.json` is UTF-8 JSON with this envelope:

```json
{
  "format": "musubi-project",
  "version": 1,
  "scene": { "format": "musubi-scene", "version": 1 },
  "editor": {
    "camera": { "position": [3, 2, 8], "target": [0, 0, 0], "fov": 42, "near": 0.01, "far": 1000 },
    "time": 0
  },
  "files": {
    "asset-id": { "path": "assets/asset-id", "sha256": "<64 lowercase hex characters>" }
  }
}
```

The shortened `scene` above stands for the full `SceneDocument` defined in
`src/scene-document.ts`: units, axis, ordered roots, node records, and asset
records. IDs, names, parent relationships, local transforms, and shape offsets
are preserved, along with optional joints, binding, elasticity, animation,
driven-key relationships, IK handles, and constraints. File assets retain their original names and byte lengths in
that document. Each file asset ID has exactly one ZIP entry and SHA-256 digest;
multiple shapes can refer to that same asset. A procedural `knot-v1` asset is
regenerated deterministically and needs no embedded file. Undo history, GPU
resources, UI theme/layout, selection, curve clipboard, auto-key toggle, playback
mode, and unkeyed pose overrides are not saved. Opening pauses playback.

## Animation and rigging extensions

These optional fields are additive to `musubi-scene` version 1. Older archives
without them retain their authored transforms and have no animation or IK.
The current loader accepts both old scenes and these extended scenes. Older
application builds are not guaranteed to preserve extensions when resaving.

| Field | Stored data |
| --- | --- |
| `joints` | Joint IDs/names, parent IDs, local position, optional XYZ Euler rotation in degrees |
| `SplatShape.binding` | Influence joint IDs, matching rest matrices, optional sparse `weights` |
| `SplatShape.elasticity` | Stretch/spacing/expansion, allocation budget, optional density/distribution, selected connection scope |
| `CurveShape` | `type: "curveShape"`, ID/name/parent ID, `degree`, weighted `points`, `knots`, `closed`, `color` |
| `MeshShape` | `type: "meshShape"`, ID/name/parent ID, `vertices` with stable IDs/local positions, `faces` with stable IDs/ordered vertex IDs, `color`, `shading`, `wireframe` |
| `ParticleShape` | `type: "particleShape"`, identity/parent, emission type/source, seed/timing, rate/lifetime, motion and fields, size/color/opacity endpoints |
| `animation` | `fps`, `start`, `end`, `loop`, `tracks` |
| Animation track | `id`, `targetId`, `channel`, ordered `keys` |
| Curve key | `id`, `time`, `value`, `interpolation`, `tangentMode`, optional `inSlope`, `outSlope`, `inWeight`, `outWeight`, `broken` |
| `drivenKeys` | Relationship `id`, `driver` and `driven` property references, and curve `keys` |
| `ikHandles` | `id`, `name`, `rootId`, `endId`, world-space `target`, `enabled`, `iterations`, `blend` |
| `constraints` | `id`, `name`, `type`, `sourceId`, `targetId`, `enabled`, `maintainOffset`, stored `offset`, optional `aimAxis`/`worldUpAxis` |

Each transform owns exactly one splat, controller curve, polygon mesh, or particle emitter shape. Curve shapes
need no asset record or binary entry; their parent transforms use the existing
animation and constraint channels. Curve degree is 1, 2, or 3. Each control point
is `[x, y, z, weight]`; there must be at least degree + 1 and at most 128 points.
Coordinates and knot values are finite within ±1,000,000; weights are positive
from 0.000001 through 1,000,000. The knot vector has point count + degree + 1
entries, is nondecreasing, has a nonempty active interval, allows multiplicity
up to degree + 1 at endpoints and degree in the interior, and separates distinct
values by at least 0.000000001. Interior continuity prevents false display bridges.
`closed` is a boolean and joins rendered endpoints without periodic conversion;
`color` is a six-digit `#rrggbb` string. Samples, line buffers, and selection
bounds are rebuilt at load time rather than saved. Existing splat-only archives
remain supported; older applications may reject the new shape type.

Polygon mesh shapes need no asset entry. They support up to 100,000 vertices and
100,000 faces, with 3–64 distinct existing vertex IDs per face. Positions are finite
within ±1,000,000. Component IDs are unique within the shape. Validation rejects
inconsistent winding, nonmanifold edges/vertex fans, zero-area faces, and polygons
that cannot be triangulated without self-intersection or degenerate triangles.
Validation first uses the dominant-axis projection, with an orthonormal frame
around the area-weighted face normal as a fallback for bent n-gons. Open
surfaces and empty meshes are valid. Intersections between separate faces are not
checked. `shading` is `flat` or `smooth`, `wireframe` is boolean, and `color` is a
six-digit hex string. Derived edges, triangulation, normals, selections, and GPU
buffers are rebuilt rather than stored. Older applications may reject mesh shapes.

Particle shapes store authored settings only, without live particles, GPU buffers,
solver state or replay caches. Surface emitters reference a mesh shape and must
be parented under its transform. Validation checks all references, finite field
settings, uint32 seeds, emission timing, and scene-wide particle budgets. Changes
to FPS must retain the maximum 300-second emission duration. See the exact bounds
in [the particle guide](docs/PARTICLES.md#limits). Reopening deterministically
replays to the saved timeline time. Older builds may reject the new shape type.

Optional `binding.weights` stores `{ count, overrides }`. `count` is the
nonnegative safe-integer count of original splat components, excluding generated
elasticity fill. `overrides` maps canonical decimal indices such as `"0"` and
`"12"` to arrays of `{ jointId, weight }`. Each row has one through four unique
bound joint IDs, strictly positive finite weights no greater than one, and a
total within 0.00000001 of one. Indices must be less than `count`; leading-zero,
fractional, negative, and unsafe-integer keys are rejected. Each shape supports
at most 200,000 stored overrides; a single editing command accepts at most
20,000 component indices.

Missing rows retain the existing automatic nearest-four inverse-squared-distance
weights. Authored weights retain floating-point precision in JSON; Spark packs
them to 8-bit values for rendering. Loading checks the stored count against the
decoded source before attaching skinning. A mismatch rejects the load rather
than applying weights to different components. Resetting overrides restores
automatic weighting. Original asset bytes are unchanged, and generated fill
inherits weights through the existing elasticity pipeline.

Property references contain `targetId` and `channel`. Channels are
`position.x/y/z`, `rotation.x/y/z`, `scale.x/y/z`, and `visibility`; joints do not
support scale channels. Key interpolation is `step`, `linear`, or `bezier`.
Tangent modes are `auto`, `clamped`, `flat`, `spline`, or `fixed`. Slopes use
value units per horizontal unit. Weights are fractions of the adjacent key
interval; absent weights default to one third.

Animation key `time` values are frame coordinates. Driven-key `time` values are
driver attribute values and can be fractional or negative. Neither curve type
uses the editor's saved time as its key coordinate. `editor.time` continues to
mean **seconds**, preserving the older archive convention. It now accepts signed
finite values up to an absolute 1,000,000 seconds instead of being restricted to
the old 12-second turntable. The UI restores the saved time within the scene's
playback range. Camera view/orthographic height remain optional extensions.

Animation validation requires valid targets/channels, finite bounded numbers,
ordered unique key coordinates, unique track/key IDs, and one track per target
channel. Frame rate is 1–240; start/end are within ±1,000,000 frames and end must
be greater than start. Curve values and slopes are bounded by an absolute
1,000,000,000,000; weights are within 0–1. There may be at most 100,000 animation
keys in total and at most 100,000 driven keys in total.

Driven graphs permit one driver per output, reject property cycles, and reject
outputs that also have time curves. Relationship count is capped at 10,000.
Stored driven scale keys must be positive (at least 0.001), and visibility keys
must be within 0–1. The runtime also clamps interpolated scale/visibility outputs.

IK validation requires a root-to-descendant joint chain with nonzero authored
segment lengths, finite targets, blend within 0–1, and 1–128 iterations. It caps
handle count at 128 and rejects oversized chains, overlapping chains, and chains
controlled by another handle's ancestor. Deleting targets removes affected
animation/driven relationships; deleting relevant joints also removes affected
IK handles. History restores those records together on undo.

Constraint types are `point`, `orient`, `aim`, `scale`, and `parent`. Offsets contain
position and scale XYZ tuples plus a normalized XYZW rotation quaternion.
Offsets and endpoints are captured at creation; enabled/name may be changed
later. There may be at most 10,000 constraints. Validation rejects missing
targets, self/hierarchy/dependency cycles, invalid offsets, joint scale outputs,
and multiple owners of the same position/rotation/scale group. Disabled records
still participate in cycle/ownership validation. Parent owns position and
rotation; it does not own scale. Removing a source or target removes its
constraints, and undo restores them with the scene.

Aim records may specify `aimAxis` and `worldUpAxis` as `+X`, `-X`, `+Y`, `-Y`,
`+Z`, or `-Z`; omitted values default to `+Z` and `+Y` respectively. The local
up direction is derived: +Y except for a ±Y aim axis, which uses +Z. Aim owns
rotation and stores a maintained orientation offset in the existing quaternion
field. It does not add a target node or alter local translation/scale. Enabled
aim constraints reject coincident world positions within 0.00000001 scene units.

Creation checks the supplied current pose; archive validation checks axes,
references and affine restrictions in the authored pose. Aim coincidence is
checked during creation and evaluation, since animation can separate coincident
authored origins. Runtime affine checks are also necessary because valid data
can animate into unsupported transforms. Orient/aim/parent/scale require
uniformly scaled driven parents; orient/parent/scale require nonsheared sources.
Aim reads only the source position. Point permits arbitrary finite invertible
parents. Non-finite values and singular driven parents are rejected. A runtime
failure stops playback with a notice and leaves the underlying pre-constraint
pose intact. This check does not remove the saved constraint; it can be disabled
or deleted to repair the scene.

The loader validates format versions, IDs, references, unique sibling names,
hierarchy cycles, roots, transform values, shape counts, camera values, asset
inventory, byte lengths, SHA-256 digests, and the optional animation/rigging
records above. Unsupported generators and node
types are rejected. Version 1 matches the current editor's one renderable shape per
transform; group-only nodes and instancing of DAG nodes are not implemented.

All meshes are prepared in a staging collection. The old scene and history stay
active until preparation succeeds. A malformed archive or a splat decoding
failure leaves the current scene intact. Successful Open/New clears old history
and releases old runtime objects. No network asset downloads occur during Open.

## Limits and future work

- Packaging is in memory. Files and total unpacked data are capped at 512 MiB;
  JSON metadata is capped at 128 MiB and scene nodes at 10,000. These are guardrails,
  not a performance guarantee: actual memory includes staging and GPU data too.
- Saves use ZIP STORE entries because splat files often have their own
  compression. Each save rewrites the portable package. Streaming/project-folder
  saving should precede support for very large assets.
- The filename extension is `.msb`; it does not imply Maya binary compatibility.
- Autosave, incremental backups, reusable scene references, and schema migration
  are future work. Unknown versions fail explicitly instead of loading partially.

## Verification

`npm test` covers archive round trips, original asset bytes, IDs and transforms,
empty scenes, missing/corrupt assets, invalid hierarchy, unsupported versions,
file-handle reuse, failed writes, and cancel behavior. Browser checks exercised a
real `.msb` download and reopening it after New, with both procedural and imported
splats, plus restored non-uniform transforms and dirty-state undo. Native handle
protocols are tested with mocks; the OS save dialog is not automated.

The animation and driven-key suites additionally cover extended metadata
roundtrips, malformed keys/dependencies, and deletion cleanup. A representative
portable scene is included at [examples/animation-study.msb](examples/animation-study.msb);
its source is [scripts/create-animation-example.mjs](scripts/create-animation-example.mjs).
