import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { addSplat, transformNodes } from "./scene-document.ts";
import type {
  AssetRecord,
  SplatShapeNode,
  TransformChannels,
  Vec3,
} from "./scene-document.ts";
import {
  createSceneStore,
  commitChannels,
  renameObject,
} from "./scene-store.ts";
import { createPropertiesPanel } from "./properties-panel.ts";
import { makeDemo, prepareSplat } from "./splat-assets.ts";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const viewport = element<HTMLDivElement>("viewport");
const notice = element<HTMLDivElement>("notice");
const play = element<HTMLButtonElement>("play");
const rewind = element<HTMLButtonElement>("rewind");
const timeline = element<HTMLInputElement>("timeline");
const theme = element<HTMLButtonElement>("theme");
const fileInput = element<HTMLInputElement>("file");
const undoButton = element<HTMLButtonElement>("undo");
const redoButton = element<HTMLButtonElement>("redo");
const duration = 12;
let scene: THREE.Scene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let grid: THREE.GridHelper | undefined;

function applyTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  theme.setAttribute(
    "aria-label",
    `Switch to ${dark ? "light" : "dark"} theme`,
  );
  theme.title = theme.getAttribute("aria-label")!;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#171717" : "#f2f2f2");
  if (scene) scene.background = new THREE.Color(dark ? "#171717" : "#f2f2f2");
  if (grid) {
    const materials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    materials.forEach((material) => {
      material.opacity = dark ? 0.16 : 0.1;
    });
  }
}
theme.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("musubi-theme", next);
  } catch {
    /* Restricted storage. */
  }
  applyTheme();
});
applyTheme();

type RuntimeObject = {
  root: THREE.Group;
  preview: THREE.Group;
  mesh: SplatMesh;
  bounds: THREE.Box3;
  centers: Float32Array;
  count: number;
  box: THREE.Box3Helper;
  assetId: string;
};

async function start() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false });
  } catch {
    notice.textContent =
      "WebGL2 is unavailable. Try a browser with hardware acceleration enabled.";
    element("asset-detail").textContent = "Renderer unavailable";
    for (const id of ["open", "demo", "reset"])
      element<HTMLButtonElement>(id).disabled = true;
    return;
  }
  const webgl = renderer;
  webgl.setPixelRatio(Math.min(devicePixelRatio, 2));
  webgl.domElement.setAttribute(
    "aria-label",
    "Interactive Gaussian splat scene",
  );
  viewport.prepend(webgl.domElement);
  scene = new THREE.Scene();
  const world = scene;
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  const store = createSceneStore();
  // GPU objects and asset bytes are excluded from the document and undo snapshots.
  const runtime = new Map<string, RuntimeObject>();
  const assetFiles = new Map<string, File>();
  let selected = new Set<string>();
  let loading = false,
    playing = false,
    time = 0,
    previous = 0;
  let dragId: string | undefined;
  let cancelDrag = false;
  const modes = {
    q: "select",
    w: "translate",
    e: "rotate",
    r: "scale",
  } as const;
  type Mode = (typeof modes)[keyof typeof modes];
  let currentMode: Mode = "select";

  // Capture runs before OrbitControls and TransformControls pointer listeners.
  webgl.domElement.addEventListener(
    "pointerdown",
    (event) => {
      controls.enabled = event.pointerType === "touch" || event.altKey;
      transform.enabled =
        !event.altKey &&
        selected.size === 1 &&
        currentMode !== "select" &&
        !loading;
    },
    true,
  );
  const controls = new OrbitControls(camera, webgl.domElement);
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.DOLLY,
  };
  controls.enableDamping = true;
  world.add(
    new SparkRenderer({
      renderer: webgl,
      accumExtSplats: true,
      covSplats: true,
    }),
  );
  const transform = new TransformControls(camera, webgl.domElement);
  transform.getHelper().traverse((child) => {
    child.renderOrder = 1000000;
  });
  world.add(transform.getHelper());
  const toolbar = document.createElement("div");
  toolbar.className = "transform-tools";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Transform tools");
  viewport.append(toolbar);
  function singleId() {
    return selected.size === 1 ? selected.values().next().value : undefined;
  }
  function refreshGizmo() {
    const id = singleId(),
      object = id ? runtime.get(id) : undefined;
    if (object && currentMode !== "select" && !loading) {
      if (transform.object !== object.root) transform.attach(object.root);
      transform.setMode(currentMode);
      transform.enabled = true;
      transform.getHelper().visible = true;
    } else {
      transform.detach();
      transform.enabled = false;
    }
  }
  function choose(mode: Mode) {
    if (dragId) return;
    currentMode = mode;
    refreshGizmo();
    toolbar
      .querySelectorAll("button")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.mode === mode),
        ),
      );
  }
  for (const [key, mode] of Object.entries(modes)) {
    const button = document.createElement("button");
    button.textContent = `${mode[0].toUpperCase() + mode.slice(1)} · ${key.toUpperCase()}`;
    button.dataset.mode = mode;
    button.title =
      mode === "scale"
        ? "Scale axes, planes, or uniformly with the center handle"
        : mode;
    button.addEventListener("click", () => choose(mode));
    toolbar.append(button);
  }
  const selectionLabel = document.createElement("span");
  selectionLabel.className = "selection-label";
  selectionLabel.setAttribute("role", "status");
  viewport.append(selectionLabel);
  function readChannels(object: THREE.Object3D): TransformChannels {
    return {
      position: object.position.toArray() as Vec3,
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z].map(
        THREE.MathUtils.radToDeg,
      ) as Vec3,
      scale: object.scale.toArray() as Vec3,
    };
  }
  const panelHost = element<HTMLElement>("properties");
  const panel = createPropertiesPanel(panelHost, {
    select(id, additive) {
      if (!dragId && !loading) selectObjects([id], additive);
    },
    rename(id, name) {
      if (!loading && !dragId) renameObject(store, id, name);
    },
    channel(id, channel, axis, value) {
      if (loading || dragId) return;
      const node = store.getState().document.nodes[id];
      if (node?.type !== "transform") return;
      setPlaying(false);
      const channels: TransformChannels = {
        position: [...node.position],
        rotation: [...node.rotation],
        scale: [...node.scale],
      };
      channels[channel][axis] = value;
      commitChannels(store, id, channels, `Edit ${channel}`);
    },
  });
  panelHost.addEventListener("focusout", () =>
    queueMicrotask(() => updatePanel()),
  );
  function updatePanel(preview?: TransformChannels) {
    const doc = store.getState().document,
      id = singleId();
    const shape = Object.values(doc.nodes).find(
      (node) => node.type === "splatShape" && node.parentId === id,
    );
    panel.update(transformNodes(doc), selected, shape?.name, preview);
  }
  function selectObjects(ids: string[], additive = false) {
    if (dragId) return;
    const doc = store.getState().document;
    const next = additive ? new Set(selected) : new Set<string>();
    for (const id of ids)
      if (doc.nodes[id]?.type === "transform") {
        if (additive && next.has(id)) next.delete(id);
        else next.add(id);
      }
    selected = next;
    refreshSelection();
  }
  function refreshSelection() {
    const doc = store.getState().document;
    selected = new Set(
      [...selected].filter((id) => doc.nodes[id]?.type === "transform"),
    );
    for (const [id, object] of runtime) object.box.visible = selected.has(id);
    selectionLabel.textContent = selected.size
      ? `${selected.size} object${selected.size === 1 ? "" : "s"} selected`
      : "Nothing selected";
    refreshGizmo();
    updatePanel();
  }
  function syncScene() {
    const doc = store.getState().document;
    for (const [id, object] of runtime) {
      const node = doc.nodes[id];
      if (node?.type !== "transform") {
        object.root.removeFromParent();
        object.box.visible = false;
        continue;
      }
      const parent = node.parentId ? runtime.get(node.parentId)?.root : world;
      if (parent && object.root.parent !== parent) parent.add(object.root);
      object.root.name = node.name;
      object.root.position.fromArray(node.position);
      const angles = node.rotation.map(THREE.MathUtils.degToRad);
      object.root.rotation.set(
        angles[0],
        angles[1],
        angles[2],
        node.rotationOrder,
      );
      object.root.scale.fromArray(node.scale);
      const shape = Object.values(doc.nodes).find(
        (n): n is SplatShapeNode =>
          n.type === "splatShape" && n.parentId === id,
      );
      if (shape) {
        object.mesh.name = shape.name;
        object.mesh.position.fromArray(shape.offset);
      }
    }
    const nodes = transformNodes(doc);
    element("asset-name").textContent = "Scene";
    const count = nodes.reduce(
      (sum, node) => sum + (runtime.get(node.id)?.count ?? 0),
      0,
    );
    element("asset-detail").textContent =
      `${nodes.length} object${nodes.length === 1 ? "" : "s"} · ${count.toLocaleString()} splats`;
    play.disabled =
      rewind.disabled =
      timeline.disabled =
        loading || nodes.length === 0;
    refreshSelection();
  }
  function updateHistoryButtons() {
    const history = store.temporal.getState();
    undoButton.disabled =
      loading || !!dragId || history.pastStates.length === 0;
    redoButton.disabled =
      loading || !!dragId || history.futureStates.length === 0;
    undoButton.title = `Undo${history.pastStates.length ? ` ${store.getState().editLabel}` : ""} (Ctrl+Z)`;
    redoButton.title = "Redo (Ctrl+Y or Ctrl+Shift+Z)";
  }
  // Retain GPU resources for redo; release them when they leave the bounded history.
  function collectUnusedResources() {
    const history = store.temporal.getState();
    const docs = [
      store.getState(),
      ...history.pastStates,
      ...history.futureStates,
    ].map((state) => state.document);
    const retainedIds = new Set(
      docs.flatMap((doc) => (doc ? Object.keys(doc.nodes) : [])),
    );
    for (const [id, object] of runtime)
      if (!retainedIds.has(id)) {
        object.root.removeFromParent();
        world.remove(object.box);
        object.box.geometry.dispose();
        (object.box.material as THREE.Material).dispose();
        object.mesh.dispose();
        assetFiles.delete(object.assetId);
        runtime.delete(id);
      }
  }
  store.subscribe(() => {
    syncScene();
    queueMicrotask(collectUnusedResources);
  });
  store.temporal.subscribe(() => {
    updateHistoryButtons();
    queueMicrotask(collectUnusedResources);
  });
  function historyAction(redo: boolean) {
    if (loading || dragId) return;
    setPlaying(false);
    const history = store.temporal.getState();
    if (redo) history.redo();
    else history.undo();
    updateHistoryButtons();
  }
  undoButton.addEventListener("click", () => historyAction(false));
  redoButton.addEventListener("click", () => historyAction(true));
  transform.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value;
    if (event.value) {
      dragId = singleId();
      cancelDrag = false;
      setPlaying(false);
    } else if (dragId) {
      const id = dragId;
      dragId = undefined;
      const object = runtime.get(id);
      if (!cancelDrag && object)
        commitChannels(
          store,
          id,
          readChannels(object.root),
          `${currentMode[0].toUpperCase() + currentMode.slice(1)} object`,
        );
      else syncScene();
      updatePanel();
    }
    updateHistoryButtons();
  });
  transform.addEventListener("objectChange", () => {
    const id = singleId(),
      object = id ? runtime.get(id) : undefined;
    if (!object) return;
    object.root.scale.clampScalar(0.001, Number.MAX_VALUE);
    updatePanel(readChannels(object.root));
  });
  function abortDrag() {
    if (!dragId) return;
    cancelDrag = true;
    transform.reset();
    transform.pointerUp(null);
    syncScene();
  }

  grid = new THREE.GridHelper(20, 40, 0x888888, 0x888888);
  const materials = Array.isArray(grid.material)
    ? grid.material
    : [grid.material];
  materials.forEach((material) => {
    material.transparent = true;
    material.depthWrite = false;
  });
  world.add(grid);
  for (const [points, color] of [
    [[-10, 0.002, 0, 10, 0.002, 0], 0xcc4444],
    [[0, 0.002, -10, 0, 0.002, 10], 0x4477dd],
  ] as const) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([...points], 3),
    );
    grid.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })));
  }
  applyTheme();
  function fitView() {
    world.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    const ids = selected.size
      ? [...selected]
      : store.getState().document.rootIds;
    for (const id of ids) {
      const object = runtime.get(id);
      if (object)
        bounds.union(
          object.bounds.clone().applyMatrix4(object.mesh.matrixWorld),
        );
    }
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere()),
      radius = Math.max(sphere.radius, 0.01);
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const limitingFov = Math.min(
      halfFov,
      Math.atan(Math.tan(halfFov) * camera.aspect),
    );
    const distance = (radius / Math.sin(limitingFov)) * 1.15;
    camera.position
      .set(0.35, 0.2, 1)
      .normalize()
      .multiplyScalar(distance)
      .add(sphere.center);
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = Math.max(distance * 50, 100);
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.minDistance = radius * 0.15;
    controls.maxDistance = distance * 10;
    controls.update();
  }
  new ResizeObserver(() => {
    const { width, height } = viewport.getBoundingClientRect();
    webgl.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }).observe(viewport);
  camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);

  const marquee = document.createElement("div");
  marquee.className = "selection-marquee";
  marquee.hidden = true;
  viewport.append(marquee);
  const raycaster = new THREE.Raycaster(),
    projected = new THREE.Vector3();
  let gesture:
    { x: number; y: number; id: number; additive: boolean } | undefined;
  function cancelSelection() {
    gesture = undefined;
    marquee.hidden = true;
    controls.enabled = !transform.dragging;
  }
  webgl.domElement.addEventListener(
    "wheel",
    () => {
      controls.enabled = !transform.dragging;
    },
    { capture: true },
  );
  webgl.domElement.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      event.altKey ||
      event.pointerType === "touch" ||
      loading ||
      transform.dragging
    )
      return;
    gesture = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      additive: event.shiftKey,
    };
    webgl.domElement.setPointerCapture(event.pointerId);
  });
  webgl.domElement.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (event.altKey) {
      cancelSelection();
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const width = Math.abs(event.clientX - gesture.x),
      height = Math.abs(event.clientY - gesture.y);
    marquee.hidden = Math.max(width, height) < 4;
    Object.assign(marquee.style, {
      left: Math.min(event.clientX, gesture.x) - rect.left + "px",
      top: Math.min(event.clientY, gesture.y) - rect.top + "px",
      width: width + "px",
      height: height + "px",
    });
  });
  webgl.domElement.addEventListener("pointerup", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const start = gesture;
    cancelSelection();
    if (event.altKey) return;
    world.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const rect = webgl.domElement.getBoundingClientRect();
    const ndc = (x: number, y: number) =>
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        1 - ((y - rect.top) / rect.height) * 2,
      );
    const end = ndc(event.clientX, event.clientY);
    const objects = transformNodes(store.getState().document).map((node) => ({
      id: node.id,
      object: runtime.get(node.id)!,
    }));
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) {
      raycaster.setFromCamera(end, camera);
      const hits = raycaster.intersectObjects(
        objects.map(({ object }) => object.mesh),
        false,
      );
      const hit = hits.length
        ? objects.find(({ object }) => object.mesh === hits[0].object)
        : undefined;
      selectObjects(hit ? [hit.id] : [], start.additive);
    } else {
      const begin = ndc(start.x, start.y),
        hits: string[] = [];
      for (const { id, object } of objects)
        for (let i = 0; i < object.centers.length; i += 3) {
          projected
            .fromArray(object.centers, i)
            .applyMatrix4(object.mesh.matrixWorld)
            .project(camera);
          if (
            projected.z >= -1 &&
            projected.z <= 1 &&
            projected.x >= Math.min(begin.x, end.x) &&
            projected.x <= Math.max(begin.x, end.x) &&
            projected.y >= Math.min(begin.y, end.y) &&
            projected.y <= Math.max(begin.y, end.y)
          ) {
            hits.push(id);
            break;
          }
        }
      selectObjects(hits, start.additive);
    }
  });
  webgl.domElement.addEventListener("pointercancel", () => {
    abortDrag();
    cancelSelection();
  });
  webgl.domElement.addEventListener("lostpointercapture", cancelSelection);
  window.addEventListener("blur", () => {
    abortDrag();
    cancelSelection();
  });
  window.addEventListener("keyup", (event) => {
    if (event.key === "Alt" && !dragId) refreshGizmo();
  });
  window.addEventListener("keydown", (event) => {
    const editing =
      event.target instanceof HTMLElement &&
      (event.target.matches("input,textarea,select") ||
        event.target.isContentEditable);
    if (editing) return; // Preserve native text editing undo inside fields.
    const key = event.key.toLowerCase();
    if (
      !event.altKey &&
      (event.ctrlKey || event.metaKey) &&
      (key === "z" || key === "y")
    ) {
      event.preventDefault();
      historyAction(key === "y" || event.shiftKey);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    if (key === "z") {
      event.preventDefault();
      historyAction(event.shiftKey);
      return;
    }
    if (key === "escape") {
      abortDrag();
      cancelSelection();
      selectObjects([]);
      return;
    }
    if (!event.shiftKey && key in modes) {
      event.preventDefault();
      choose(modes[key as keyof typeof modes]);
    }
  });
  function setPlaying(value: boolean) {
    playing = value;
    play.textContent = value ? "Ⅱ" : "▶";
    play.setAttribute(
      "aria-label",
      value ? "Pause animation" : "Play animation",
    );
  }
  function updateTime() {
    // Temporary turntable preview is below authored transforms and excluded from history.
    for (const object of runtime.values())
      object.preview.rotation.y = (time / duration) * Math.PI * 2;
    timeline.value = String(time);
    element<HTMLOutputElement>("time").value =
      `${time.toFixed(2).padStart(5, "0")} / 12.00`;
  }
  async function importObject(
    create: () => SplatMesh | Promise<SplatMesh>,
    name: string,
    asset: AssetRecord,
    source?: File,
    initial = false,
  ) {
    if (loading || dragId) return;
    loading = true;
    setPlaying(false);
    updateHistoryButtons();
    refreshGizmo();
    for (const id of ["open", "demo"])
      element<HTMLButtonElement>(id).disabled = true;
    play.disabled = rewind.disabled = timeline.disabled = true;
    notice.textContent = "Loading splats…";
    let candidate: SplatMesh | undefined,
      registered = false;
    try {
      candidate = await create();
      const { bounds, centers, count } = await prepareSplat(candidate);
      const offset = bounds
        .getCenter(new THREE.Vector3())
        .negate()
        .toArray() as Vec3;
      const added = addSplat(store.getState().document, asset, name, offset);
      const root = new THREE.Group(),
        preview = new THREE.Group();
      preview.add(candidate);
      root.add(preview);
      const box = new THREE.Box3Helper(new THREE.Box3(), 0x999999);
      box.visible = false;
      world.add(box);
      runtime.set(added.id, {
        root,
        preview,
        mesh: candidate,
        bounds,
        centers,
        count,
        box,
        assetId: asset.id,
      });
      if (source) assetFiles.set(asset.id, source);
      registered = true;
      store.setState({ document: added.document, editLabel: "Import object" });
      if (initial) store.temporal.getState().clear();
      selectObjects([added.id]);
      time = 0;
      updateTime();
      fitView();
      notice.textContent = "";
    } catch (error) {
      if (!registered) candidate?.dispose();
      notice.textContent = `Could not load this scene. ${error instanceof Error ? error.message : "Try another splat file."}`;
    } finally {
      loading = false;
      for (const id of ["open", "demo"])
        element<HTMLButtonElement>(id).disabled = false;
      syncScene();
      updateHistoryButtons();
    }
  }
  element("open").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file || loading) return;
    void importObject(
      async () =>
        new SplatMesh({
          extSplats: true,
          covSplats: true,
          fileBytes: await file.arrayBuffer(),
          fileName: file.name,
        }),
      file.name.replace(/\.[^.]+$/, ""),
      {
        id: crypto.randomUUID(),
        kind: "file",
        fileName: file.name,
        byteLength: file.size,
      },
      file,
    );
  });
  element("demo").addEventListener(
    "click",
    () =>
      void importObject(makeDemo, "splatStudy", {
        id: crypto.randomUUID(),
        kind: "procedural",
        generator: "knot-v1",
      }),
  );
  element("reset").addEventListener("click", fitView);
  play.addEventListener("click", () => {
    if (!dragId) setPlaying(!playing);
  });
  rewind.addEventListener("click", () => {
    setPlaying(false);
    time = 0;
    updateTime();
  });
  timeline.addEventListener("input", () => {
    setPlaying(false);
    time = Number(timeline.value);
    updateTime();
  });
  webgl.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    abortDrag();
    setPlaying(false);
    webgl.setAnimationLoop(null);
    notice.textContent =
      "The graphics context was lost. Reload the page to restore the workspace.";
    loading = true;
    syncScene();
    updateHistoryButtons();
    for (const id of ["open", "demo"])
      element<HTMLButtonElement>(id).disabled = true;
  });
  webgl.setAnimationLoop((now) => {
    const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 0;
    previous = now;
    if (playing) {
      time = (time + delta) % duration;
      updateTime();
    }
    controls.update();
    for (const id of selected) {
      const object = runtime.get(id);
      if (object) {
        object.mesh.updateWorldMatrix(true, false);
        object.box.box
          .copy(object.bounds)
          .applyMatrix4(object.mesh.matrixWorld);
      }
    }
    webgl.render(world, camera);
  });
  choose("select");
  syncScene();
  updateHistoryButtons();
  await importObject(
    makeDemo,
    "splatStudy",
    { id: crypto.randomUUID(), kind: "procedural", generator: "knot-v1" },
    undefined,
    true,
  );
}
void start().catch((error) => {
  renderer?.setAnimationLoop(null);
  notice.textContent = `The viewer could not start. ${error instanceof Error ? error.message : "Please reload."}`;
});
