# Scene data architecture

Musubi uses a small Maya-inspired scene model: named transform nodes own local
position, rotation, and scale; child shape nodes reference Gaussian splat assets.
This follows Maya's documented [DAG hierarchy](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-Basics/files/GUID-5029CF89-D420-4236-A7CF-884610828B70.htm)
and [parent-relative transforms and sibling naming](https://help.autodesk.com/cloudhelp/ENU/MayaCRE-Tech-Docs/Nodes/dagNode.html).

## Implemented model

```text
SceneDocument v1
  rootIds: ordered root transform IDs
  nodes[id]
    Transform: name, parentId, position, rotation, scale, rotationOrder
      SplatShape: name, parentId, assetId, offset
  assets[id]
    Procedural: generator identifier
    File: original filename, byte length
```

- UUIDs identify nodes and assets. Renaming never changes identity or references.
- Transform names are unique among siblings; collisions receive a numeric suffix.
- Position and scale are XYZ tuples. Rotation is local Euler degrees in XYZ order.
  The renderer converts degrees to radians. Units are currently unitless, Y-up.
- Shape offsets preserve the import-centering adjustment independently of the
  object's editable transform. Source splat data stays unchanged.
- The model uses a single-parent tree. Current UI imports root transforms with
  one splat shape each. Group creation, reparenting, and instancing are future work.
- The outliner lists objects. Click and rectangle selection operate on whole
  objects. Shift-selection toggles membership. Multiple objects can be selected;
  property editing and the gizmo currently require one selected object.

`src/scene-document.ts` defines renderer-independent data.
`src/scene-store.ts` owns document changes and history through Zustand vanilla and
Zundo. `src/main.ts` maps node IDs to Three.js groups, Spark meshes, and selection
bounds. `src/splat-assets.ts` prepares assets, including the Spark 2.4 procedural
texture-finalization workaround for covariance rendering.

## Undo and runtime state

History holds up to 100 immutable document snapshots, sharing unchanged nodes
and asset metadata. Rename, a numeric field commit, a completed gizmo drag, and
an import each form one edit. Drag previews stay in the runtime until pointer-up;
Escape or window blur cancels an unfinished drag. No-op edits add no history.
A new edit after undo discards the redo branch.

Selection, camera, theme, playback position, source File objects, splat buffers,
and GPU resources stay outside document history. Undoing an import detaches its
runtime object; redo reattaches it. Resources are released once their IDs are
absent from the current document and both history stacks. Large imported assets
can therefore remain in memory while redo remains available.

The turntable is a temporary preview group below the authored transform. It does
not alter the saved rotation channels or create undo entries. Real animation
tracks will need an explicit time-evaluation layer.

Zundo currently imports Zustand's root entry point. Vite aliases that exact
entry to `zustand/vanilla`, avoiding React in this plain TypeScript application.
Tests use the same alias and inline Zundo so the dependency follows it.

## Saving and next steps

The document is versioned and JSON-serializable, with a round-trip test. This is
the metadata foundation, **not a complete saved project**: original imported
files are retained only in memory, and refresh loses the scene. Save/open and
autosave are not implemented yet. Maya `.ma` / `.mb` files are unsupported.

Recommended next steps:

1. Add validated group/reparent commands, rejecting cycles and updating sibling
   ordering, names, and local/world transform conversions atomically.
2. Save a project containing the versioned document plus asset bytes keyed by
   stable asset ID (for example, a ZIP with `scene.json` and `assets/`). Load must
   validate IDs, references, topology, finite values, supported generators and
   schema versions before swapping the active scene. Filenames alone cannot
   identify assets or restore browser file access.
3. Add animation curves keyed by node ID and channel; evaluate from absolute time
   for reliable seeking. Keep authored channels, animation evaluation, and
   rendering separate. Camera data can then use the same scene identity model.
4. Introduce explicit dependency connections when constraints/deformers need
   them. Maya's full dependency graph and construction history are beyond this
   initial transform/shape subset.

## Verification

`npm test` covers relationships, serializable metadata, unique names, stable
identity, immutable transforms, atomic undo/redo, no-op edits, redo branching,
imports, finite values, scale clamping, and bounded history. Browser verification
also exercises the live properties panel, keyboard shortcuts, a physical gizmo
drag as one undo step, click/box selection, and additive objects.
