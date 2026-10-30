# Musubi Motion

Musubi Motion is a Gaussian-splat-native 3D animation engine for the browser, built on Three.js and Spark. It aims to make Gaussian splats first-class, animatable scene assets, with tools for composing scenes, sequencing motion, and applying procedural deformation and visual effects in real time.

**Status:** Initial browser prototype. The current runtime uses WebGL2 through Three.js's WebGLRenderer and Spark 2.4.0. WebGPU is not implemented.

## Run locally

Requires Node.js 22.12+ (tested with 22.16).

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. `npm run build` type-checks and builds the application; `npm run preview` serves the production build.

## Available now

- A thin, responsive monochrome interface with light/dark themes, remembered locally.
- A built-in grayscale knot rendered as actual Gaussian splats, with no remote demo asset required.
- Local PLY, SPZ, SPLAT, KSPLAT, and SOG file selection through Spark. Files are decoded in the browser, not uploaded to a server. File variants remain subject to Spark's decoder support.
- Orbit, zoom, and reset-to-fit camera controls.
- A 12-second turntable with play/pause, rewind, looping, and scrubbing. This rotates the entire asset; it is not skeletal animation or per-splat deformation.
- Loading and error messages, plus a WebGL2 availability check.

The interface and demo use only grayscale. Imported assets retain their source colors. Loading a file replaces the current asset; multi-asset editing and scene saving are future work.

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

1. Load two splat assets into the same scene, with orbit controls and independent transforms.
2. Add a timeline with play, pause, seek, and loop. Animate an object and a camera from absolute timeline time so seeking produces repeatable results.
3. Add one visible per-splat deformation, such as a masked bend or wave. Validate changing orientation and scale as well as position where the deformation requires it.
4. Inspect overlap sorting, culling bounds, and visual stability while both assets and the camera move. A visually plausible static viewer is insufficient evidence for animated splats.
5. Measure load-to-visible time, frame-time distribution, and memory where measurable. Record asset size, splat count, resolution, device, browser, and active graphics backend.
6. Save and reload the scene and timeline.

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
