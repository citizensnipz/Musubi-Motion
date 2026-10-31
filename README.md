# Musubi Motion

[![Status: Prototype](https://img.shields.io/badge/status-prototype-555555?style=flat-square)](#about)
[![Three.js](https://img.shields.io/badge/Three.js-0.180-555555?style=flat-square)](https://threejs.org/)
[![Spark](https://img.shields.io/badge/Spark-2.4-555555?style=flat-square)](https://sparkjs.dev/)
[![WebGL2](https://img.shields.io/badge/renderer-WebGL2-555555?style=flat-square)](#technology)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-555555?style=flat-square)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-555555?style=flat-square)](LICENSE)

A browser-based Gaussian splat animation engine and editor, built on **Three.js and Spark**.

## About

Musubi Motion treats Gaussian splats as named, selectable scene objects with their own transforms and asset references. The goal is a focused browser workspace for composing and animating splat scenes, with familiar Maya-style controls and a minimal monochrome interface.

**Current status: working editor prototype.** The editor supports transform and joint animation, a Graph Editor and Dope Sheet, Set Driven Keys, FK joints, CCD and analytic two-bone inverse kinematics, constraints, splat binding, elasticity, polygon mesh editing, and deterministic particle FX. These are useful subsets of established DCC workflows, not full Maya parity. The renderer uses WebGL2; WebGPU is not implemented.

**Topics:** `gaussian-splatting` · `3d-animation` · `3d-editor` · `threejs` · `sparkjs` · `webgl2` · `typescript` · `dockview`

## Features

- **Splat scenes:** import local PLY, SPZ, SPLAT, KSPLAT, and SOG files; add multiple named objects; start with the included grayscale knot. Format variants depend on Spark's decoder support.
- **Selection and transforms:** click or marquee selection, an Outliner, editable position/rotation/scale properties, and full X/Y/Z transform gizmos, including non-uniform scaling.
- **Customizable workspace:** General, Animation, Rigging, Modeling, and FX presets arrange relevant panels. Drag Dockview tabs to split or combine panels, resize with dividers, and reopen editors from their menus. Layouts and the selected preset are remembered in local browser storage.
- **Floating tools:** icon-only selection and transform controls sit inside the viewport. Unlock the panel to move it by its grip, then lock it in place.
- **Monochrome UI:** light/dark themes, Web Awesome menus and fields, and Lucide icons. Theme and panel layouts are remembered locally.
- **Animation:** frame-based timeline, configurable frame rate and playback range, looping, manual keys with **S**, and auto-key for channels that already have keys. Transform and joint curves evaluate from the requested frame without writing playback into scene history.
- **Channel key controls:** key individual Properties channels with their diamonds and author stepped visibility with the Visible checkbox. Indicators distinguish unanimated channels, animated channels, and keys at the current frame.
- **Graph Editor and Dope Sheet:** dockable curve/channel editing, key multiselection and box selection, Bezier tangent handles, linear/stepped interpolation, tangent presets, shape-preserving key insertion, copy/paste, retiming, and time scaling.
- **Set Driven Key:** connect a driver attribute to multiple driven attributes through individual response curves. Cycles and competing time keys are rejected.
- **Rigging:** create and parent joints, edit FK rotations, bind selected splats to selected influences, unbind, and apply configurable elasticity. CCD IK handles support root/end chains, draggable viewport targets, FK/IK blend, target-to-FK alignment, and **Match FK to IK and key** to capture the current solved joint rotations and switch to FK in one undoable edit. Blend is not animated; matching captures one frame.
- **Two-bone IK:** select the analytic solver for a root/middle/end chain and move its pole target to control the bend plane. Target and pole markers support viewport dragging, numeric editing, undo, and saving. Unreachable targets preserve bone lengths; existing handles keep their CCD behavior.
- **Constraints:** dedicated **Rigging → Constraints** controls create point, orient, aim, scale, and parent relationships with optional maintain-offset. Aim selects a signed local axis and world-up axis. Each output group has one source; dependency cycles are rejected.
- **Curve controllers:** Circle, Square, and Arrow controls with editable local CVs, rational weights, degree, closure, and color. Their ordinary transforms support animation, SDK, and constraints; curve data saves directly in the scene without asset files.
- **Skin Weights:** a dedicated Rigging panel edits normalized influences over component ranges or exact viewport selections. Click or box-select posed components, add/subtract selections, inspect weights, restore automatic weights, and view sampled colors. Edits support undo and persistence; the elasticity pipeline inherits them.
- **Paint Skin Weights:** a separate Rigging panel provides Replace, Add, and Subtract brushes with adjustable radius, strength, and smooth falloff. Color previews remain outside the scene until release; each stroke applies deformation with one undo step. Escape cancels a stroke.
- **Polygon modeling:** create cubes, planes, spheres, and cylinders alongside splats. **Modeling → Mesh Tools** provides vertex/edge/face selection, local vertex edits and component offsets, connected face-region extrusion, face deletion, color, flat/smooth shading, and polygon wire display. Shared vertices and stable component IDs persist through undo and saving. See [the modeling guide](docs/MODELING.md).
- **Particle FX:** **FX → Particle Emitters** creates omni, directional, box/sphere volume, and polygon-surface emitters. Edit rate, lifetime, seeded variation, gravity/acceleration, drag, curl noise, attraction/repulsion, and lifetime size/color/opacity. Fixed-step replay supports backward scrubbing; particles retain their historical birth positions when emitters animate. Settings support undo and saving. See [the particle guide](docs/PARTICLES.md).
- **Undo/redo:** editing operations use shared document commands. History retains up to 100 edits without copying splat buffers; playback and scrubbing create no history entries.
- **Turntable preview:** the Timeline's separate playback mode retains the original 12-second rotation preview.
- **Portable scenes:** save and reopen `.msb` packages with source assets, meshes, controllers, particle settings, joints, binding/elasticity settings, animation curves, driven relationships, IK handles, and constraints.

Splat files are decoded in the browser, not uploaded to a server. The interface and included demo are grayscale; transform gizmos and the red X / blue Z grid origin lines retain axis colors. Imported splats retain their source colors.

## Run locally

Use Node.js **22.12 or newer** and a browser with WebGL2 hardware acceleration.

```sh
npm install
npm run dev
```

Open the URL printed by Vite.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run build` | Type-check and create the production build |
| `npm run preview` | Serve the production build locally |
| `npm test` | Test scene data, history, archive validation, and file-saving behavior |

## Controls

| Action | Control |
| --- | --- |
| Select / hide gizmo | Q |
| Translate | W |
| Rotate | E |
| Scale | R |
| Orbit | Alt + left drag |
| Pan | Alt + middle drag |
| Dolly | Alt + right drag |
| Zoom | Scroll wheel |
| Select object | Click a splat surface, controller line, or Outliner row |
| Marquee select | Drag a rectangle in the viewport |
| Toggle selection | Shift + click / marquee |
| Clear selection / cancel gizmo drag | Escape |
| Undo | Ctrl+Z; Maya-style Z outside text fields |
| Redo | Ctrl+Y or Ctrl+Shift+Z; Maya-style Shift+Z outside text fields |
| Save / Save as | Ctrl+S / Ctrl+Shift+S |
| Open scene | Ctrl+O |
| Set keys on selected objects/joints | S, outside text fields and curve-editor focus |
| Play / pause | Space |
| Previous / next frame | , / . |

Command can replace Ctrl for the application shortcuts on macOS. Text fields retain native text undo. Enter or leaving a property field commits its value. Gizmos and properties edit one selected object at a time. Marquee selection includes objects with splat centers inside the rectangle.

Use **Animation → Graph Editor / Dope Sheet / Set Driven Key** for dedicated animation tools. The Graph Editor has its own shortcuts when focused: **S** inserts a key on its active curve, **F** frames keys, and arrow keys retime selected keys. See [the animation guide](docs/ANIMATION.md) for workflows, tangent behavior, and current limitations.

Open [examples/animation-study.msb](examples/animation-study.msb) for a procedural bounce/spin animation, a driven rotation, and a keyed three-joint FK chain. Rebuild it with `node scripts/create-animation-example.mjs`.

Drag a **panel title tab** toward another panel's edge to split the space, or toward its center to combine them as tabs. The floating tool panel is separate: click its lock icon to unlock it, then drag the grip. An unlocked grip also supports arrow-key nudging, with Shift for larger steps.

## Scene files

Use **File → New scene / Open scene / Save / Save as**. An asterisk beside the scene name indicates unsaved edits.

An `.msb` file includes object names and IDs, hierarchy, transforms, shape offsets, original splat assets, polygon topology and appearance, controller curves, particle settings, joints and binding, elasticity, animation/SDK/IK data, constraints, the viewport camera, and the timeline position. It does not store undo history, unkeyed animation previews, live particle buffers, or the UI panel arrangement.

Supported browsers can save back to a selected file through native file pickers. Other browsers download an `.msb` copy. New/Open asks before discarding unsaved edits; opening stages the scene before replacing the current one. Undo history starts fresh after opening.

Packages are built in memory and currently capped at **512 MiB**. Autosave and recovery snapshots are not implemented. See [MSB-FORMAT.md](MSB-FORMAT.md) for the format and validation rules.

## Technology

| Layer | Foundation |
| --- | --- |
| Scene, camera, and rendering integration | Three.js |
| Cubic curve primitives and CCD IK solver | Existing Three.js dependency, MIT licensed |
| Analytic two-bone IK | Scalar Three.js adaptation of ozz-animation's MIT-licensed IKTwoBoneJob; attribution in `public/licenses/ozz-animation.txt` |
| Polygon primitives and triangulation | Existing Three.js geometry/welding utilities (MIT) and bundled Earcut (ISC); retained notice in `public/licenses/earcut.txt` |
| Particle simulation | Pinned three-nebula 13.3.0 (MIT), with validated timeline scheduling and a Three.js rendering adapter |
| Gaussian splat rendering and decoding | Spark 2.4, using WebGL2 |
| Docking and resizable panels | Dockview |
| Menus, dialogs, and property controls | Web Awesome web components |
| Icons | Lucide |
| Scene state and undo history | Zustand and Zundo |
| Scene archive compression | fflate |
| Application and tooling | Vanilla TypeScript, CSS, Vite, and Vitest |

The document model follows Maya's transform/shape organization with stable IDs and separate asset references. UI components call scene commands; scene data, undo history, and serialization remain independent of the UI libraries. GPU resources and splat buffers stay outside undo snapshots.

Non-uniform scaling uses Spark covariance rendering with extended-precision splats. Scale values must remain positive, with a minimum of 0.001. See [SCALING-EXPERIMENT.md](SCALING-EXPERIMENT.md) for validation and limitations, and [SCENE-ARCHITECTURE.md](SCENE-ARCHITECTURE.md) for the document model.

## Remaining priorities

1. Joint orientation/limits, target/pole/blend animation, twist controls, and range-based IK/FK baking.
2. Object-up and roll controls for aim constraints, multi-source constraint weights, and richer controller/component editing.
3. Influence management, weight smoothing and locks, surface-only component selection, and joint/pose mirroring.
4. Animation layers, camera/property channels, Euler filtering, richer curve clipboard/retargeting, and SDK curves inside the Graph Editor.
5. Component gizmos, inset/bevel/subdivision, merge/bridge and edge deletion, materials/UVs, mesh skinning, and mesh import/export.
6. Particle collisions, trails, animated emitter properties/field objects, cache export, and splat-particle rendering.
7. Object grouping/reparenting tools, recovery snapshots, and saving strategies for large projects.

General, Animation, Rigging, Modeling, and FX workspace presets are available. Existing disabled rigging entries describe work still to come; they are not implemented commands.

Local CPU measurements were approximately **0.56 ms for 1,000 animation tracks**, **2.62 ms for 20 IK chains**, and **0.44 ms for 100 parent constraints**. These development measurements exclude WebGL/Spark rendering, binding, elasticity, editor drawing, and large asset loads; they are not a browser frame-rate or production performance guarantee. See [the animation guide](docs/ANIMATION.md#performance-and-verification).

The dated [validation record](docs/VALIDATION.md) separates model tests, browser workflows, small-scene playback measurements, and remaining verification limits.

Capture reconstruction, model training, and recorded 4D splat playback are outside the current scope. A future WebGPU backend needs a compatible splat rendering path; switching the Three.js renderer alone is insufficient.

## License

[Apache License 2.0](LICENSE).

The adapted two-bone solver retains [ozz-animation's MIT notice](public/licenses/ozz-animation.txt), also included in production builds.
Polygon validation and triangulation retain [Earcut's ISC notice](public/licenses/earcut.txt), also included in production builds.
Particle simulation retains [Nebula's MIT notice](public/licenses/three-nebula.txt) and notices for its bundled [Lodash](public/licenses/nebula-lodash.txt), [potpack](public/licenses/nebula-potpack.txt), and [uuid](public/licenses/nebula-uuid.txt) utilities in production builds.
