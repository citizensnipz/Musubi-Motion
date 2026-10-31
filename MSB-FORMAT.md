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
| `SplatShape.binding` | Influence joint IDs and matching rest matrices |
| `SplatShape.elasticity` | Stretch/spacing/expansion, allocation budget, optional density/distribution, selected connection scope |
| `animation` | `fps`, `start`, `end`, `loop`, `tracks` |
| Animation track | `id`, `targetId`, `channel`, ordered `keys` |
| Curve key | `id`, `time`, `value`, `interpolation`, `tangentMode`, optional `inSlope`, `outSlope`, `inWeight`, `outWeight`, `broken` |
| `drivenKeys` | Relationship `id`, `driver` and `driven` property references, and curve `keys` |
| `ikHandles` | `id`, `name`, `rootId`, `endId`, world-space `target`, `enabled`, `iterations`, `blend` |
| `constraints` | `id`, `name`, `type`, `sourceId`, `targetId`, `enabled`, `maintainOffset`, stored `offset` |

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

Constraint types are `point`, `orient`, `scale`, and `parent`. Offsets contain
position and scale XYZ tuples plus a normalized XYZW rotation quaternion.
Offsets and endpoints are captured at creation; enabled/name may be changed
later. There may be at most 10,000 constraints. Validation rejects missing
targets, self/hierarchy/dependency cycles, invalid offsets, joint scale outputs,
and multiple owners of the same position/rotation/scale group. Disabled records
still participate in cycle/ownership validation. Parent owns position and
rotation; it does not own scale. Removing a source or target removes its
constraints, and undo restores them with the scene.

The loader validates format versions, IDs, references, unique sibling names,
hierarchy cycles, roots, transform values, shape counts, camera values, asset
inventory, byte lengths, SHA-256 digests, and the optional animation/rigging
records above. Unsupported generators and node
types are rejected. Version 1 matches the current editor's one splat shape per
transform; group-only nodes and instancing of DAG nodes are not implemented.

All meshes are prepared in a staging collection. The old scene and history stay
active until preparation succeeds. A malformed archive or a splat decoding
failure leaves the current scene intact. Successful Open/New clears old history
and releases old runtime objects. No network asset downloads occur during Open.

## Limits and future work

- Packaging is in memory. Files and total unpacked data are capped at 512 MiB;
  JSON metadata is capped at 4 MiB and scene nodes at 10,000. These are guardrails,
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
