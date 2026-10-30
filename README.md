# Musubi Motion

Musubi Motion is a Gaussian-splat-native 3D animation engine for the browser, built on Three.js and Spark. It aims to make Gaussian splats first-class, animatable scene assets, with tools for composing scenes, sequencing motion, and applying procedural deformation and visual effects in real time.

**Status:** Initial browser prototype. The current runtime uses WebGL2 through Three.js's WebGLRenderer and Spark 2.4.0. WebGPU is not implemented.

## Run locally

Requires Node.js 22.12+ (tested with 22.16).

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. `npm run build` type-checks and builds the application; `npm run preview` serves the production build. `npm test` checks scene data and undo history.

## Available now

- A thin, responsive monochrome interface with light/dark themes, remembered locally.
- A built-in grayscale knot rendered as actual Gaussian splats, with no remote demo asset required.
- Local PLY, SPZ, SPLAT, KSPLAT, and SOG file selection through Spark. Files are decoded in the browser, not uploaded to a server. File variants remain subject to Spark's decoder support.
- Orbit, zoom, and reset-to-fit camera controls.
- A 12-second turntable with play/pause, rewind, looping, and scrubbing. This rotates the entire asset; it is not skeletal animation or per-splat deformation.
- Loading and error messages, plus a WebGL2 availability check.
- Multiple named objects, a scene outliner, and editable local position, rotation, and scale in the right properties panel.
- Undo/redo for imports, renaming, numeric edits, and completed gizmo drags. History keeps up to 100 edits without copying splat buffers.

The interface and demo use grayscale; gizmos and the X/Z grid origin lines retain their axis colors. Imported assets retain their source colors. Import splat and Add demo add independent objects to the scene. Scenes can be saved and reopened as portable `.msb` files containing their splat assets. Autosave is not implemented.

## Project direction (future work)

- Compose scenes from multiple Gaussian splat assets with independent transforms and animation tracks.
- Provide deterministic timeline playback, seeking, looping, and interpolation for objects, cameras, and effect parameters.
- Support procedural animation of splat position, orientation, scale, color, and opacity.
- Explore skeletal or other structured deformation after validating the basic animation pipeline.
- Save reusable scene and animation descriptions and play them directly in the browser.

Here, "native" means that splats are first-class animation data throughout the engine. It does not require writing a new rasterizer. Capture reconstruction and model training are outside the initial runtime scope; the first prototype will use existing assets. Recorded 4D splat sequences are a separate future capability from animating a static splat asset.

## Foundation

**Three.js + Spark is the selected foundation.** Three.js handles the scene, camera, and browser rendering integration; Spark handles Gaussian splats. The UI uses plain TypeScript and CSS with Vite, without a UI framework.

Spark provides extension points for per-splat editing, procedural effects, and skeletal animation. These are upstream capabilities, not features implemented in this prototype. Any future WebGPU backend will require a compatible splat rendering path; replacing WebGLRenderer alone is not sufficient.

## Next milestones

Build on the current Three.js/Spark prototype:

1. Extend the current multi-object scene model with grouping and validated parenting.
2. Add a timeline with play, pause, seek, and loop. Animate an object and a camera from absolute timeline time so seeking produces repeatable results.
3. Add one visible per-splat deformation, such as a masked bend or wave. Validate changing orientation and scale as well as position where the deformation requires it.
4. Inspect overlap sorting, culling bounds, and visual stability while both assets and the camera move. A visually plausible static viewer is insufficient evidence for animated splats.
5. Measure load-to-visible time, frame-time distribution, and memory where measurable. Record asset size, splat count, resolution, device, browser, and active graphics backend.
6. Add recovery snapshots and efficient project-folder saves for large scenes.

The first milestone is a small, repeatable animated scene with correct overlap and reliable scrubbing. A full editor, custom file format, renderer fork, and training pipeline can wait until that foundation works.

## Architecture boundary

Musubi should own scene identifiers, animation clips, tracks, interpolation, playback state, and serialization. The underlying engine should own device creation, rendering, asset upload, and sorting. Use a small adapter around the chosen engine; avoid building multiple complete backends before a concrete need emerges.

## Technical references

Reviewed October 30, 2026. These document upstream capabilities, not benchmarks performed by this project.

- [Three.js](https://threejs.org/docs/)
- [Spark capabilities and source](https://github.com/sparkjsdev/spark)
- [Spark browser integration](https://sparkjs.dev/docs/)

## License

[Apache License 2.0](LICENSE).

## Viewport controls

W: translate. E: rotate. R: scale individual axes, planes, or uniformly with the center handle. Q: hide gizmo.
Alt + left drag: orbit. Alt + middle drag: pan. Alt + right drag: dolly. Scroll: zoom.
The grid lies on world Y=0, with red X and blue Z origin lines. Transform edits remain separate from turntable playback. Transforms are included in saved `.msb` scenes.

Selection: click a splat surface or an outliner row to select an object. Drag a rectangle to select objects with splat centers inside; hold Shift to toggle selection. Click empty space or press Escape to clear. Alt-drag navigates without selecting. Properties and gizmos edit one selected object at a time.

Ctrl+Z: undo. Ctrl+Y or Ctrl+Shift+Z: redo. Maya-style Z / Shift+Z also work outside text fields. Enter or leaving a property field commits its value; typing retains native text undo. Escape cancels an active gizmo drag.

The scene document follows Maya's transform/shape organization with stable IDs and separate asset references. See [SCENE-ARCHITECTURE.md](SCENE-ARCHITECTURE.md) for the implemented subset and the save/load plan.

Non-uniform scaling uses Spark covariance rendering with extended-precision splats. Procedural buffers are finalized through Spark's public initialization API. Scales stay positive (minimum 0.001). See SCALING-EXPERIMENT.md for validation and limits.

## Scene files

Use **File > New scene / Open scene / Save / Save as**. Ctrl+S saves; Ctrl+Shift+S saves as; Ctrl+O opens (Cmd on macOS). The scene name shows an asterisk for unsaved edits. Save includes object names, IDs, hierarchy, transforms, shape offsets, original splat files, and the viewport camera and timeline position.

Native file pickers allow saving back to the selected file. Other browsers download an `.msb` copy. Opening prepares the complete scene before replacing your work; New/Open prompt before discarding unsaved edits. Undo history starts fresh after opening. Current packages are capped at 512 MiB and are built in memory. See [MSB-FORMAT.md](MSB-FORMAT.md).
