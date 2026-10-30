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
are preserved. File assets retain their original names and byte lengths in
that document. Each file asset ID has exactly one ZIP entry and SHA-256 digest;
multiple shapes can refer to that same asset. A procedural `knot-v1` asset is
regenerated deterministically and needs no embedded file. Undo history, GPU
resources, UI theme, and selection are not saved. Opening pauses playback.

The loader validates format versions, IDs, references, unique sibling names,
hierarchy cycles, roots, transform values, shape counts, camera values, asset
inventory, byte lengths, and SHA-256 digests. Unsupported generators and node
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
