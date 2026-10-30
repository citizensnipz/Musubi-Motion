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

**Current status: working editor prototype.** Scene composition, transform editing, portable scene files, and a turntable preview are implemented. Keyframe tracks, curve editing, skeletal animation, and per-splat deformation remain future work. The renderer uses WebGL2; WebGPU is not implemented.

**Topics:** `gaussian-splatting` · `3d-animation` · `3d-editor` · `threejs` · `sparkjs` · `webgl2` · `typescript` · `dockview`

## Features

- **Splat scenes:** import local PLY, SPZ, SPLAT, KSPLAT, and SOG files; add multiple named objects; start with the included grayscale knot. Format variants depend on Spark's decoder support.
- **Selection and transforms:** click or marquee selection, an Outliner, editable position/rotation/scale properties, and full X/Y/Z transform gizmos, including non-uniform scaling.
- **Customizable workspace:** drag Dockview panel tabs to dock beside other panels or combine them as tabs. Resize panels with their dividers. Properties starts beside Outliner on desktop.
- **Floating tools:** icon-only selection and transform controls sit inside the viewport. Unlock the panel to move it by its grip, then lock it in place.
- **Monochrome UI:** light/dark themes, Web Awesome menus and fields, and Lucide icons. The theme is remembered locally; custom panel arrangements currently last for the session.
- **Undo/redo:** the Edit menu and keyboard shortcuts cover imports, names, numeric properties, and completed gizmo drags. History retains up to 100 edits without copying splat buffers.
- **Turntable preview:** play/pause, rewind, loop, and scrub a 12-second rotation preview. Authored transforms remain separate from playback.
- **Portable scenes:** save and reopen `.msb` packages with scene data and source splat assets.

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
| Select object | Click a splat surface or Outliner row |
| Marquee select | Drag a rectangle in the viewport |
| Toggle selection | Shift + click / marquee |
| Clear selection / cancel gizmo drag | Escape |
| Undo | Ctrl+Z; Maya-style Z outside text fields |
| Redo | Ctrl+Y or Ctrl+Shift+Z; Maya-style Shift+Z outside text fields |
| Save / Save as | Ctrl+S / Ctrl+Shift+S |
| Open scene | Ctrl+O |

Command can replace Ctrl for the application shortcuts on macOS. Text fields retain native text undo. Enter or leaving a property field commits its value. Gizmos and properties edit one selected object at a time. Marquee selection includes objects with splat centers inside the rectangle.

Drag a **panel title tab** toward another panel's edge to split the space, or toward its center to combine them as tabs. The floating tool panel is separate: click its lock icon to unlock it, then drag the grip. An unlocked grip also supports arrow-key nudging, with Shift for larger steps.

## Scene files

Use **File → New scene / Open scene / Save / Save as**. An asterisk beside the scene name indicates unsaved edits.

An `.msb` file includes object names and IDs, hierarchy, transforms, shape offsets, original splat assets, the viewport camera, and the timeline position. It does not store undo history or the UI panel arrangement.

Supported browsers can save back to a selected file through native file pickers. Other browsers download an `.msb` copy. New/Open asks before discarding unsaved edits; opening stages the scene before replacing the current one. Undo history starts fresh after opening.

Packages are built in memory and currently capped at **512 MiB**. Autosave and recovery snapshots are not implemented. See [MSB-FORMAT.md](MSB-FORMAT.md) for the format and validation rules.

## Technology

| Layer | Foundation |
| --- | --- |
| Scene, camera, and rendering integration | Three.js |
| Gaussian splat rendering and decoding | Spark 2.4, using WebGL2 |
| Docking and resizable panels | Dockview |
| Menus, dialogs, and property controls | Web Awesome web components |
| Icons | Lucide |
| Scene state and undo history | Zustand and Zundo |
| Scene archive compression | fflate |
| Application and tooling | Vanilla TypeScript, CSS, Vite, and Vitest |

The document model follows Maya's transform/shape organization with stable IDs and separate asset references. UI components call scene commands; scene data, undo history, and serialization remain independent of the UI libraries. GPU resources and splat buffers stay outside undo snapshots.

Non-uniform scaling uses Spark covariance rendering with extended-precision splats. Scale values must remain positive, with a minimum of 0.001. See [SCALING-EXPERIMENT.md](SCALING-EXPERIMENT.md) for validation and limitations, and [SCENE-ARCHITECTURE.md](SCENE-ARCHITECTURE.md) for the document model.

## Roadmap

- Expose grouping and parenting tools for scene organization.
- Add editable keyframe tracks and deterministic playback for objects and cameras.
- Add per-splat deformation and validate covariance, bounds, and overlap sorting during animation.
- Explore skeletal or structured deformation after validating the basic animation workflow.
- Measure load time, frame time, and memory across representative scenes and devices.
- Add recovery snapshots and more efficient saving for large projects.

Capture reconstruction, model training, and recorded 4D splat playback are outside the current scope. A future WebGPU backend needs a compatible splat rendering path; switching the Three.js renderer alone is insufficient.

## License

[Apache License 2.0](LICENSE).
