import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { addSplat, emptyScene, transformNodes, deleteSceneItems, normalizedChannels } from "./scene-document.ts";
import type {
  SceneDocument,
  AssetRecord,
  SplatShapeNode,
  TransformChannels,
  Vec3,
} from "./scene-document.ts";
import {
  createSceneStore,
  renameObject,
} from "./scene-store.ts";
import { createPropertiesPanel } from "./properties-panel.ts";
import { makeDemo, prepareSplat } from "./splat-assets.ts";
import {
  encodeProject,
  decodeProject,
  MAX_PROJECT_BYTES,
} from "./project-archive.ts";
import type { EditorSnapshot } from "./project-archive.ts";
import { pickScene, saveDestination, writeScene } from "./scene-files.ts";
import type { SceneFileHandle } from "./scene-files.ts";

import { mountToolPalette } from "./tool-palette.ts";
import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import { mountWorkspace } from "./workspace.ts";
import {
  hydrateIcons,
  buttonContent,
  askDiscard,
  askFilename,
  isEditing,
  blurEditor,
  dialogOpen,
} from "./ui.ts";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "./style.css";
import { defaultAnimation, evaluateChannels, evaluateSceneAnimation, keyChannels, setKeys, type AnimationPose } from "./animation.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { mountTimeline } from "./timeline-panel.ts";
import { advanceFrame } from "./animation-playback.ts";
import { mountAnimationEditors } from "./graph-editor.ts";
import { createDrivenKeyPanel } from "./driven-key-panel.ts";
import { prepareJointAnimationEdit, unwrapEuler } from "./animation-edit.ts";
import { evaluateIK, validateIKHandles, updateIKHandle, deleteIKHandle } from "./ik.ts";
import { createIKPanel } from "./ik-panel.ts";
import { evaluateConstraints, validateConstraints } from "./constraints.ts";
import { createConstraintsPanel } from "./constraints-panel.ts";
import { mountChannelKeyControls } from "./channel-animation-controls.ts";
import { PoseDrafts } from "./pose-drafts.ts";
import { createIKTargets } from "./ik-targets.ts";
import { mountSkeleton } from "./skeleton.ts";
import { createBinding } from "./splat-binding.ts";
import { createTerminal } from "./terminal-panel.ts";
import { elasticityDefaults, elasticEdges, validateElasticity } from "./elasticity";
import { createElasticityPanel } from "./elasticity-panel";
import { mountViewportTools, type ViewName } from "./viewport-tools";
import { createRiggingPanel, mountRiggingPanel } from "./rigging-panel.ts";
const riggingPanel = createRiggingPanel();
const terminal = createTerminal();
const workspace = mountWorkspace(riggingPanel, terminal.element);
mountRiggingPanel(riggingPanel, workspace);
hydrateIcons();
mountToolPalette();
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const viewport = element<HTMLDivElement>("viewport");
const notice = element<HTMLDivElement>("notice");
terminal.watchNotices(notice);
const play = element<WaButton>("play");
const rewind = element<WaButton>("rewind");
const timeline = element<WaSlider>("timeline");
const theme = element<WaButton>("theme");
const fileInput = element<HTMLInputElement>("file");
const undoButton = element<WaDropdownItem>("undo");
const redoButton = element<WaDropdownItem>("redo");
const duration = 12;
let scene: THREE.Scene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let grid: THREE.GridHelper | undefined;

function applyTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  document.documentElement.classList.toggle("wa-dark", dark);
  document.documentElement.classList.toggle("wa-light", !dark);
  buttonContent(theme, dark ? "sun" : "moon");
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
      element<WaButton>(id).disabled = true;
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
  const perspective = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
  const orthographic = new THREE.OrthographicCamera(-4,4,4,-4,.01,1000);
  let camera:THREE.PerspectiveCamera|THREE.OrthographicCamera=perspective;
  let activeView:ViewName="perspective", gizmosVisible=true, jointsVisible=true;
  const store = createSceneStore();
  // GPU objects and asset bytes are excluded from the document and undo snapshots.
  const runtime = new Map<string, RuntimeObject>();
  const assetFiles = new Map<string, File>();
  let selected = new Set<string>();
  let selectedIKId = "";
  const ikTargets = createIKTargets(world);
  let sceneName = "Untitled.msb";
  let sceneHandle: SceneFileHandle | undefined;
  let savedDocument = JSON.stringify(store.getState().document);
  const isDirty = () =>
    JSON.stringify(store.getState().document) !== savedDocument;
  function updateFileState() {
    const dirty = isDirty();
    element("asset-name").textContent = `${sceneName}${dirty ? " *" : ""}`;
    element("scene-state").textContent = dirty
      ? "Unsaved changes"
      : "No unsaved changes";
    document.title = `${dirty ? "* " : ""}${sceneName} — Musubi Motion`;
  }
  window.addEventListener("beforeunload", (event) => {
    if (isDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  let loading = false,
    playing = false,
    time = 0,
    previous = 0;
  let dragId: string | undefined;
  const poseOverrides = new Map<string, AnimationPose>();
  const poseDrafts = new PoseDrafts();
  let evaluated = new Map<string, AnimationPose>();
  let fkPoses = new Map<string, AnimationPose>();
  let solvedPoses = new Map<string, AnimationPose>();
  let timelinePanel: ReturnType<typeof mountTimeline> | undefined;
  let animationEditors: ReturnType<typeof mountAnimationEditors> | undefined;
  let drivenPanel: ReturnType<typeof createDrivenKeyPanel> | undefined;
  let ikPanel: ReturnType<typeof createIKPanel> | undefined;
  let constraintsPanel: ReturnType<typeof createConstraintsPanel> | undefined;
  let channelKeys: ReturnType<typeof mountChannelKeyControls> | undefined;
  let evaluationError = "";
  const animationSettings = () => store.getState().document.animation ?? defaultAnimation();
  const getFrame = () => time * animationSettings().fps;
  const allSelection = (): string[] => [...selected, ...skeleton.selectedIds];
  const currentPose = (id: string): AnimationPose => evaluated.get(id) ?? poseOverrides.get(id) ?? evaluateChannels(store.getState().document, id, getFrame());
  function prepareJointEdit(next: import("./skeleton.ts").Joint[], label: string): SceneDocument {
    const result = prepareJointAnimationEdit(store.getState().document, next, label, Math.round(getFrame()), timelinePanel?.autoKey ?? false, currentPose);
    if (result.document.ikHandles) validateIKHandles(result.document.ikHandles, result.document);
    if (result.document.constraints) validateConstraints(result.document.constraints, result.document);
    for (const [id, pose] of result.overrides) poseOverrides.set(id, pose);
    if (result.overrides.size) poseDrafts.capture(result.document, poseOverrides);
    return result.document;
  }
  const skeleton = mountSkeleton(store, world, riggingPanel, () => !loading && !dragId, prepareJointEdit);
  function editPose(id: string, channels: TransformChannels, label: string) {
    setPlaying(false);
    let doc = store.getState().document;
    const node = doc.nodes[id];
    if (node?.type !== "transform") return;
    const pose = { ...normalizedChannels(channels), visibility: currentPose(id).visibility };
    doc = { ...doc, nodes: { ...doc.nodes, [id]: { ...node, position: pose.position, rotation: pose.rotation, scale: pose.scale } } };
    try {
      if (doc.constraints) validateConstraints(doc.constraints, doc);
    } catch (error) {
      syncScene(); notice.textContent = (error as Error).message; return;
    }
    poseOverrides.set(id, pose);
    if (timelinePanel?.autoKey) doc = keyChannels(doc, id, pose, Math.round(getFrame()));
    poseDrafts.capture(doc, poseOverrides);
    store.setState({ document: doc, editLabel: label });
  }
  function setFrame(frame: number) {
    if (!Number.isFinite(frame) || loading || dragId) return;
    setPlaying(false); clearPoseDraft();
    const settings = animationSettings();
    time = Math.max(settings.start, Math.min(settings.end, Math.round(frame))) / settings.fps;
    updateTime();
  }
  function keySelection() {
    if (loading || dragId || timelinePanel?.turntable) return;
    setPlaying(false);
    const ids = allSelection();
    if (!ids.length) { notice.textContent = "Select objects or joints to set keys."; return; }
    setKeys(store, ids, Math.round(getFrame()), new Map(ids.map(id => [id, currentPose(id)])));
    clearPoseDraft(); updateTime();
    notice.textContent = `Set keys for ${ids.length} selected item(s) at frame ${Math.round(getFrame())}.`;
  }
  function clearPoseDraft() {
    poseOverrides.clear();
    poseDrafts.clear();
  }
  const bindings = new Map<string, { signature: string; mesh: SplatMesh; skin: ReturnType<typeof createBinding> }>();
  function boundSelection(object:RuntimeObject) {
    return [...bindings.values()].find(b=>b.mesh===object.mesh)?.skin.selection();
  }
  function updateBindings() {
    const doc = store.getState().document;
    const shapes = Object.values(doc.nodes).filter((n): n is SplatShapeNode => n.type === "splatShape");
    for (const [id, entry] of bindings) {
      const shape = shapes.find(s => s.id === id);
      if (!shape?.binding || JSON.stringify([shape.binding, shape.elasticity, doc.joints?.map(j => [j.id, j.parentId])]) !== entry.signature || runtime.get(shape.parentId)?.mesh !== entry.mesh) {
        entry.skin.dispose(); bindings.delete(id);
      }
    }
    for (const shape of shapes) if (shape.binding) {
      const object = runtime.get(shape.parentId);
      if (!object) continue;
      if (!bindings.has(shape.id)) bindings.set(shape.id, {signature:JSON.stringify([shape.binding, shape.elasticity, doc.joints?.map(j => [j.id, j.parentId])]),mesh:object.mesh,skin:createBinding(object.mesh,shape.binding,shape.elasticity,doc.joints)});
      bindings.get(shape.id)!.skin.update(id => skeleton.boneMatrix(id));
    }
  }
  for (const control of [...Array.from(document.querySelectorAll<WaButton>("[data-rig-action]")), ...Array.from(riggingPanel.querySelectorAll<WaButton>("[data-rig-action]"))]) {
    const action = control.dataset.rigAction;
    if (action === "Elasticity") {
      control.disabled = false; control.title = "Apply Elasticity to selected bound objects";
      control.addEventListener("click", () => {
        if (loading || dragId) return;
        const doc = store.getState().document;
        const shapes = Object.values(doc.nodes).filter((n): n is SplatShapeNode => n.type === "splatShape" && selected.has(n.parentId));
        if (!shapes.length || shapes.some(s=>!s.binding)) { notice.textContent="Select an object already bound to joints."; return; }
        const scope = skeleton.selectedIds.size ? [...skeleton.selectedIds] : null;
        if (shapes.some(s=>!elasticEdges(s.binding!.jointIds,doc.joints??[],scope).length)) { notice.textContent="Elasticity requires a bound parent–child connection. Select both endpoints, or no joints for all connections."; return; }
        const nodes = {...doc.nodes};
        for (const shape of shapes) nodes[shape.id]={...shape,elasticity:{...elasticityDefaults,...shape.elasticity,joints:scope}};
        store.setState({document:{...doc,nodes},editLabel:"Apply Elasticity"});
        terminal.log(`Elasticity applied to ${shapes.length} objects; ${scope ? scope.length + " selected joints" : "all bound connections"}.`);
      });
      continue;
    }
    if (action !== "Bind splats" && action !== "Unbind splats") continue;
    control.disabled = false; control.title = action;
    control.addEventListener("click", () => {
      if (loading || dragId) return;
      const doc = store.getState().document;
      const shapes = Object.values(doc.nodes).filter((n): n is SplatShapeNode => n.type === "splatShape" && selected.has(n.parentId));
      const joints = (doc.joints ?? []).filter(j => skeleton.selectedIds.has(j.id));
      if (action === "Bind splats" && !joints.length) return;
      if (!shapes.length) { notice.textContent = "Select a splat object in the Outliner first."; return; }
      if (action === "Bind splats" && joints.length > 256) { notice.textContent = "Select at most 256 joints for binding."; return; }
      setPlaying(false); time = 0; updateTime(); world.updateMatrixWorld(true);
      terminal.log(`${action}: ${shapes.length} object(s); ${joints.length} selected joint(s).`);
      if (action === "Bind splats") terminal.log(`Joint influences: ${joints.map(j => j.name).join(", ")}. Up to four nearest joints per splat; inverse-distance weights.`);
      const nodes = {...doc.nodes};
      for (const shape of shapes) {
        const mesh = runtime.get(shape.parentId)!.mesh;
        terminal.log(`${action}: ${doc.nodes[shape.parentId].name}; ${runtime.get(shape.parentId)!.count.toLocaleString()} splats.`);
        mesh.updateWorldMatrix(true,false);
        const inverse = mesh.matrixWorld.clone().invert();
        nodes[shape.id] = {...shape, elasticity: undefined, binding: action === "Unbind splats" ? undefined : {
          jointIds: joints.map(j=>j.id), restMatrices: joints.map(j=>inverse.clone().multiply(skeleton.boneMatrix(j.id)!).toArray())
        }};
      }
      store.setState({document:{...doc,nodes},editLabel:action});
      notice.textContent = action === "Bind splats" ? `Bound to ${joints.length} selected joints using automatic distance weights.` : "Splats unbound.";
    });
  }
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
        gizmosVisible && (!skeleton.selectedId || jointsVisible) &&
        !event.altKey &&
        (selectedIKId ? jointsVisible && currentMode === "translate" : (selected.size === 1 || !!skeleton.selectedId) && currentMode !== "select") &&
        !loading;
    },
    true,
  );
  let controls = new OrbitControls(camera, webgl.domElement);
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
  const toolbar = element<HTMLDivElement>("transform-tools");
  toolbar.className = "transform-tools";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Transform tools");

  function singleId() {
    return selected.size === 1 ? selected.values().next().value : undefined;
  }
  function refreshGizmo() {
    if(!gizmosVisible || (skeleton.selectedId&&!jointsVisible)) {transform.detach();transform.enabled=false;return;}
    if (selectedIKId) {
      const target = ikTargets.getObject(selectedIKId);
      if (target && currentMode === "translate" && !loading && jointsVisible) {
        transform.attach(target); transform.setMode("translate"); transform.enabled = true; transform.getHelper().visible = true;
      } else { transform.detach(); transform.enabled = false; }
      return;
    }
    if (selected.size && skeleton.selectedIds.size) { transform.detach(); transform.enabled = false; return; }
    if (skeleton.selectedBone) {
      if ((currentMode === "translate" || currentMode === "rotate") && !loading) {
        transform.attach(skeleton.selectedBone);
        transform.setMode(currentMode);
        transform.enabled = true;
        transform.getHelper().visible = true;
      } else { transform.detach(); transform.enabled = false; }
      return;
    }
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
      .querySelectorAll("wa-button")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.mode === mode),
        ),
      );
  }
  for (const [key, mode] of Object.entries(modes)) {
    const button = document.createElement("wa-button");
    button.size = "s";
    button.variant = "neutral";
    button.appearance = "plain";
    buttonContent(button, mode);
    button.setAttribute("aria-label", mode[0].toUpperCase() + mode.slice(1));
    button.setAttribute("aria-keyshortcuts", key.toUpperCase());
    button.id = "tool-" + mode;
    button.dataset.mode = mode;
    button.title =
      mode === "scale"
        ? "Scale axes, planes, or uniformly with the center handle"
        : mode;
    button.addEventListener("click", () => choose(mode));
    toolbar.append(button);
    const tooltip = document.createElement("wa-tooltip");
    tooltip.setAttribute("for", button.id);
    tooltip.textContent = `${mode[0].toUpperCase() + mode.slice(1)} · ${key.toUpperCase()}`;
    toolbar.append(tooltip);
  }
  const selectionLabel = document.createElement("span");
  selectionLabel.className = "selection-label";
  selectionLabel.setAttribute("role", "status");
  viewport.append(selectionLabel);
  riggingPanel.addEventListener("joint-selection-change", () => {
    if (skeleton.selectedIds.size) { selectedIKId = ""; ikTargets.setSelected(); }
    if (!dragId) { applyAnimationPose(); updateBindings(); }
    if (skeleton.selectedIds.size) {
      for (const [id, object] of runtime) object.box.visible = gizmosVisible && selected.has(id);
      selectionLabel.textContent = skeleton.selectedBone ? `Joint: ${skeleton.selectedBone.name}` : `${skeleton.selectedIds.size} joints selected`;
      updatePanel();
    }
    if (!skeleton.selectedIds.size) {
      selectionLabel.textContent = selected.size ? `${selected.size} objects selected` : "Nothing selected";
      updatePanel();
    }
    if (selected.size && skeleton.selectedIds.size) selectionLabel.textContent = `${selected.size} objects · ${skeleton.selectedIds.size} joints selected`;
    refreshGizmo();
  });
  riggingPanel.addEventListener("rigging-error", event => { notice.textContent = (event as CustomEvent<string>).detail; });
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
  const panel = createPropertiesPanel(panelHost, element("outliner-panel"), {
    reparent(id, parentId) {
      if (loading || dragId) return;
      try { skeleton.reparent(id, parentId); }
      catch { notice.textContent = "Cannot parent a joint to itself or its descendants."; }
    },
    select(id, additive) {
      if (dragId || loading) return;
      if (store.getState().document.joints?.some(j => j.id === id)) {
        if (!additive) selected.clear();
        skeleton.selectMany([id], additive);
      }
      else selectObjects([id], additive);
    },
    rename(id, name) {
      const doc = store.getState().document;
      if (!loading && !dragId && doc.joints?.some(j => j.id === id)) {
        if (name.trim()) store.setState({ document: { ...doc, joints: doc.joints.map(j => j.id === id ? {...j, name: name.trim()} : j) }, editLabel: "Rename joint" });
        return;
      }
      if (!loading && !dragId) renameObject(store, id, name);
    },
    channel(id, channel, axis, value) {
      if (loading || dragId) return;
      if (store.getState().document.drivenKeys?.some(r => r.driven.targetId === id && r.driven.channel === `${channel}.${"xyz"[axis]}`)) {
        notice.textContent = "This channel is driven. Edit its relationship in Animation → Set Driven Key."; return;
      }
      setPlaying(false);
      const pose = structuredClone(currentPose(id));
      pose[channel][axis] = value;
      const joint = store.getState().document.joints?.find(j => j.id === id);
      if (joint) {
        if (channel !== "scale") skeleton.commitMove(id, pose.position, pose.rotation);
        return;
      }
      editPose(id, pose, `Edit ${channel}`);
    },
  });
  panelHost.addEventListener("focusout", () =>
    queueMicrotask(() => updatePanel()),
  );
  const elasticityPanel = createElasticityPanel(panelHost, (id,value) => {
    if (loading || dragId) return;
    const doc=store.getState().document, shape=doc.nodes[id];
    if(shape?.type!=="splatShape" || !shape.binding)return;
    if(value)validateElasticity(value);
    store.setState({document:{...doc,nodes:{...doc.nodes,[id]:{...shape,elasticity:value}}},editLabel:value?"Edit Elasticity":"Remove Elasticity"});
  });
  function updatePanel(preview?: TransformChannels) {
    const doc = store.getState().document,
      id = singleId();
    const shape = Object.values(doc.nodes).find(
      (node) => node.type === "splatShape" && node.parentId === id,
    );
    const jointNodes = (doc.joints ?? []).map(j => ({...j, type: "transform" as const, joint: true,
      rotationOrder: "XYZ" as const, rotation: j.rotation ?? [0,0,0] as Vec3, scale: [1,1,1] as Vec3 }));
    const ids = [...selected, ...skeleton.selectedIds];
    panel.update([...transformNodes(doc), ...jointNodes], new Set(ids), shape?.name, preview ?? (ids.length === 1 ? currentPose(ids[0]) : undefined));
    elasticityPanel.update(shape?.type === "splatShape" ? shape : undefined, new Map((doc.joints??[]).map(j=>[j.id,j.name])));
    channelKeys?.refresh();
  }
  function selectObjects(ids: string[], additive = false) {
    if (dragId) return;
    selectedIKId = ""; ikTargets.setSelected();
    if (!additive && skeleton.selectedIds.size) skeleton.select("");
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
    if (!doc.ikHandles?.some(h => h.id === selectedIKId)) selectedIKId = "";
    ikTargets.setSelected(selectedIKId || undefined);
    selected = new Set(
      [...selected].filter((id) => doc.nodes[id]?.type === "transform"),
    );
    for (const [id, object] of runtime) object.box.visible = gizmosVisible && selected.has(id);
    selectionLabel.textContent = selectedIKId ? `IK target: ${doc.ikHandles?.find(h => h.id === selectedIKId)?.name}` : selected.size && skeleton.selectedIds.size ? `${selected.size} objects · ${skeleton.selectedIds.size} joints selected` : skeleton.selectedBone ? `Joint: ${skeleton.selectedBone.name}` : skeleton.selectedIds.size ? `${skeleton.selectedIds.size} joints selected` : selected.size
      ? `${selected.size} object${selected.size === 1 ? "" : "s"} selected`
      : "Nothing selected";
    refreshGizmo();
    updatePanel();
    timelinePanel?.refresh();
    animationEditors?.refresh();
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
    applyAnimationPose();
    updateBindings();
    updateFileState();
    const count = nodes.reduce(
      (sum, node) => sum + (runtime.get(node.id)?.mesh.extSplats?.numSplats ?? runtime.get(node.id)?.count ?? 0),
      0,
    );
    element("asset-detail").textContent =
      `${nodes.length} object${nodes.length === 1 ? "" : "s"} · ${count.toLocaleString()} splats`;
    play.disabled =
      rewind.disabled =
      timeline.disabled =
        loading || (nodes.length === 0 && !doc.joints?.length);
    refreshSelection();
    updateTime(false);
  }
  function updateHistoryButtons() {
    for (const id of ["scene-new", "scene-open", "scene-save", "scene-save-as"])
      element<WaButton>(id).disabled = loading || !!dragId;
    panelHost.inert = loading;
    element("outliner-panel").inert = loading;
    timelinePanel?.refresh();
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
        runtime.delete(id);
      }
    const retainedAssets = new Set(
      docs.flatMap((doc) => (doc ? Object.keys(doc.assets) : [])),
    );
    for (const id of assetFiles.keys())
      if (!retainedAssets.has(id)) assetFiles.delete(id);
  }
  timelinePanel = mountTimeline(store, { getFrame, setFrame, setKey: keySelection, getSelection: allSelection,
    available: () => !loading && !dragId,
    onModeChange() { setPlaying(false); clearPoseDraft(); time = timelinePanel?.turntable ? 0 : animationSettings().start / animationSettings().fps; updateTime(); },
  });
  animationEditors = mountAnimationEditors(store, { getFrame, setFrame, getSelection: allSelection, available: () => !loading && !dragId && !playing });
  drivenPanel = createDrivenKeyPanel(store, { getFrame, getSelection: allSelection, getPoses: () => evaluated, available: () => !loading && !dragId && !playing });
  ikPanel = createIKPanel(store, { getFrame, canKey: () => !timelinePanel?.turntable, getPoses: () => evaluated, getFKPoses: () => fkPoses, getSolvedPoses: () => solvedPoses, getSelection: allSelection, available: () => !loading && !dragId && !playing });
  constraintsPanel = createConstraintsPanel(store, { getPoses: () => evaluated, getSelection: allSelection, available: () => !loading && !dragId && !playing });
  channelKeys = mountChannelKeyControls(panelHost, store, { getFrame, getPose: currentPose, getSelection: allSelection, available: () => !loading && !dragId && !playing && !timelinePanel?.turntable });
  workspace.registerPanel("graph", "Graph Editor", animationEditors.graph);
  workspace.registerPanel("dope-sheet", "Dope Sheet", animationEditors.dopeSheet);
  workspace.registerPanel("driven-keys", "Set Driven Key", drivenPanel.element);
  workspace.registerPanel("ik-handles", "IK Handles", ikPanel.element);
  function selectIKTarget(id: string) {
    if (loading || dragId || !ikTargets.getObject(id)) return;
    setPlaying(false);
    selected.clear(); skeleton.select("");
    selectedIKId = id; ikTargets.setSelected(id); ikPanel?.select(id);
    choose("translate"); refreshSelection();
    element("view-ik-handles").click();
  }
  ikPanel.element.addEventListener("ik-target-select", event => selectIKTarget((event as CustomEvent<string>).detail));
  workspace.registerPanel("constraints", "Constraints", constraintsPanel.element);
  for (const control of Array.from(document.querySelectorAll<WaButton>("[data-rig-action]"))) {
    if (["Create IK chain", "Move IK target", "IK / FK blend"].includes(control.dataset.rigAction!)) {
      control.disabled = false; control.title = "Open IK Handles";
      control.addEventListener("click", () => element("view-ik-handles").click());
    }
  }
  for (const control of Array.from(document.querySelectorAll<WaButton>("[data-rig-action='Keyframe pose']"))) {
    control.disabled = false; control.title = "Set keys on selected joints at the current frame";
    control.addEventListener("click", keySelection);
  }
  element("animation-set-key").addEventListener("click", keySelection);
  store.subscribe((state, previous) => {
    poseOverrides.clear();
    for (const [id, pose] of poseDrafts.restore(state.document, previous.document, state.editLabel)) poseOverrides.set(id, pose);
    const beforeFPS = previous.document.animation?.fps ?? 24;
    const after = state.document.animation ?? defaultAnimation();
    if (beforeFPS !== after.fps) time = time * beforeFPS / after.fps;
    if (!timelinePanel?.turntable) time = Math.max(after.start / after.fps, Math.min(after.end / after.fps, time));
    if (state.document !== previous.document) terminal.log(`${state.editLabel} · ${transformNodes(state.document).length} objects · ${state.document.joints?.length ?? 0} joints`);
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
    terminal.log(redo ? "Redo requested." : "Undo requested.");
    updateHistoryButtons();
  }
  element("edit-menu").addEventListener("wa-select", (event) => {
    const id = (event as WaSelectEvent).detail.item.id;
    if (id === "undo" || id === "redo") historyAction(id === "redo");
  });
  transform.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value;
    if (event.value) {
      dragId = selectedIKId ? `ik:${selectedIKId}` : skeleton.selectedId || singleId();
      if(skeleton.selectedId&&currentMode==="rotate")skeleton.beginRotation();
      cancelDrag = false;
      setPlaying(false);
    } else if (dragId) {
      const id = dragId;
      if (selectedIKId && id === `ik:${selectedIKId}`) {
        const target = ikTargets.getObject(selectedIKId)?.position.toArray() as Vec3 | undefined;
        dragId = undefined;
        if (!cancelDrag && target) {
          try { updateIKHandle(store, selectedIKId, { target }); }
          catch (error) { notice.textContent = (error as Error).message; }
        }
        syncScene(); updateHistoryButtons(); return;
      }
      const joint = skeleton.selectedId === id ? skeleton.selectedBone : undefined;
      const jointPosition = joint?.position.toArray() as Vec3 | undefined;
      dragId = undefined;
      if (jointPosition) {
        if (!cancelDrag && currentMode==="rotate") skeleton.commitRotation();
        else if (!cancelDrag) skeleton.commitMove(id, jointPosition, currentPose(id).rotation);
        else skeleton.reset();
        updateHistoryButtons();
        return;
      }
      const object = runtime.get(id);
      if (!cancelDrag && object) {
        const channels = readChannels(object.root);
        channels.rotation = currentMode === "rotate" ? unwrapEuler(channels.rotation, currentPose(id).rotation) : currentPose(id).rotation;
        editPose(
          id,
          channels,
          `${currentMode[0].toUpperCase() + currentMode.slice(1)} object`,
        );
      }
      else syncScene();
      updatePanel();
    }
    updateHistoryButtons();
  });
  transform.addEventListener("objectChange", () => {
    if (selectedIKId) { applyAnimationPose(); updateBindings(); return; }
    if (skeleton.selectedId) { if(dragId&&currentMode==="rotate")skeleton.previewRotation(); skeleton.preview(); updateBindings(); updatePanel(readChannels(skeleton.selectedBone!)); return; }
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
  const viewDirections:Record<ViewName,THREE.Vector3>={
    perspective:new THREE.Vector3(.35,.2,1).normalize(),front:new THREE.Vector3(0,0,1),back:new THREE.Vector3(0,0,-1),
    left:new THREE.Vector3(-1,0,0),right:new THREE.Vector3(1,0,0),top:new THREE.Vector3(0,1,0),bottom:new THREE.Vector3(0,-1,0),
  };
  function reconnectControls(target:THREE.Vector3) {
    controls.dispose();controls=new OrbitControls(camera,webgl.domElement);
    controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.DOLLY};
    controls.enableDamping=true;controls.enableRotate=camera===perspective;
    controls.target.copy(target);controls.update();transform.camera=camera;
  }
  function resizeProjection() {
    perspective.aspect=viewport.clientWidth/Math.max(1,viewport.clientHeight);
    const half=(orthographic.top-orthographic.bottom)/2;
    orthographic.left=-half*perspective.aspect;orthographic.right=half*perspective.aspect;
    perspective.updateProjectionMatrix();orthographic.updateProjectionMatrix();
  }
  function switchView(name:ViewName) {
    if(dragId)return;
    const target=controls.target.clone(),distance=Math.max(camera.position.distanceTo(target),.01);
    const visibleHeight=camera===perspective ? 2*distance*Math.tan(THREE.MathUtils.degToRad(perspective.fov/2)) : (orthographic.top-orthographic.bottom)/orthographic.zoom;
    const near=camera.near,far=camera.far;
    activeView=name;camera=name==="perspective"?perspective:orthographic;
    camera.near=near;camera.far=far;
    camera.up.set(0,1,0);
    if(name==="top")camera.up.set(0,0,-1);
    if(name==="bottom")camera.up.set(0,0,1);
    const newDistance=name==="perspective"?visibleHeight/(2*Math.tan(THREE.MathUtils.degToRad(perspective.fov/2))):distance;
    camera.position.copy(target).addScaledVector(viewDirections[name],newDistance);
    orthographic.top=visibleHeight/2;orthographic.bottom=-visibleHeight/2;orthographic.zoom=1;
    resizeProjection();reconnectControls(target);viewportTools.setView(name);
  }
  const viewportTools=mountViewportTools(viewport,(kind,visible)=>{
    if(kind==="grid")grid!.visible=visible;
    if(kind==="joints"){jointsVisible=visible;skeleton.setVisible(visible);ikTargets.setVisible(visible);}
    if(kind==="gizmos"){gizmosVisible=visible;for(const [id,object]of runtime)object.box.visible=visible&&selected.has(id);}
    refreshGizmo();
  },switchView,()=>{switchView("perspective");fitView();});
  viewportTools.setView(activeView);
  element("reset").parentElement!.hidden=true;
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
          (boundSelection(object)?.bounds??object.bounds).clone().applyMatrix4(object.mesh.matrixWorld),
        );
    }
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere()),
      radius = Math.max(sphere.radius, 0.01);
    const halfFov = THREE.MathUtils.degToRad(perspective.fov / 2);
    const limitingFov = Math.min(
      halfFov,
      Math.atan(Math.tan(halfFov) * perspective.aspect),
    );
    const distance = (radius / Math.sin(limitingFov)) * 1.15;
    camera.position
      .copy(viewDirections[activeView])
      .normalize()
      .multiplyScalar(distance)
      .add(sphere.center);
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = Math.max(distance * 50, 100);
    if(camera===orthographic){orthographic.zoom=1;orthographic.top=radius*1.15/Math.min(1,perspective.aspect);orthographic.bottom=-orthographic.top;resizeProjection();}
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.minDistance = radius * 0.15;
    controls.maxDistance = distance * 10;
    controls.update();
  }
  new ResizeObserver(() => {
    const { width, height } = viewport.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    webgl.setSize(width, height);
    resizeProjection();
  }).observe(viewport);
  resizeProjection();
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
    })).filter(({object}) => {
      let current: THREE.Object3D | null = object?.root;
      while (current) { if (!current.visible) return false; current = current.parent; }
      return !!object;
    });
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) {
      raycaster.setFromCamera(end, camera);
      const targetHit = ikTargets.pick(raycaster);
      if (targetHit) { selectIKTarget(targetHit); return; }
      const jointHit = skeleton.pick(raycaster);
      if (jointHit) { if (!start.additive) selected.clear(); skeleton.selectMany([jointHit], start.additive); return; }
      const hits=objects.map(({id,object})=>({id,distance:boundSelection(object)?.pick(raycaster)??raycaster.intersectObject(object.mesh,false)[0]?.distance??Infinity})).filter(h=>Number.isFinite(h.distance)).sort((a,b)=>a.distance-b.distance);
      const hit=hits[0];
      selectObjects(hit ? [hit.id] : [], start.additive);
    } else {
      const begin = ndc(start.x, start.y),
        hits: string[] = [];
      const jointHits = skeleton.marquee(begin, end, camera);
      for (const { id, object } of objects) {
        const centers=boundSelection(object)?.centers??object.centers;
        for (let i = 0; i < centers.length; i += 3) {
          projected
            .fromArray(centers, i)
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
      }
      if (!start.additive) { selected.clear(); skeleton.select(""); }
      selectObjects(hits, true);
      skeleton.selectMany(jointHits, true);
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
    if (event.defaultPrevented || dialogOpen()) return;
    if (
      !event.altKey &&
      (event.ctrlKey || event.metaKey) &&
      ["s", "o"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      if (event.repeat) return;
      blurEditor();
      if (event.key.toLowerCase() === "s") void saveProject(event.shiftKey);
      else void openProject();
      return;
    }
    if (
      element<WaDropdown>("file-menu").open ||
      element<WaDropdown>("edit-menu").open
    )
      return;
    const editing = isEditing(event);
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
    if (key === "s") { event.preventDefault(); keySelection(); return; }
    if (key === " ") { event.preventDefault(); if (!loading && !dragId) setPlaying(!playing); return; }
    if (key === "," || key === ".") { event.preventDefault(); setFrame(getFrame() + (key === "," ? -1 : 1)); return; }
    if (key === "delete") {
      if (loading || dragId) return;
      event.preventDefault();
      if (selectedIKId) { deleteIKHandle(store, selectedIKId); return; }
      const ids = new Set([...selected, ...skeleton.selectedIds]);
      if (!ids.size) return;
      setPlaying(false);
      store.setState({ document: deleteSceneItems(store.getState().document, ids), editLabel: "Delete selection" });
      return;
    }
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
    if (value) {
      clearPoseDraft();
      const settings = animationSettings();
      if (!timelinePanel?.turntable && getFrame() >= settings.end) time = settings.start / settings.fps;
    }
    playing = value;
    buttonContent(play, value ? "pause" : "play", value ? "Pause" : "Play");
    play.setAttribute(
      "aria-label",
      value ? "Pause animation" : "Play animation",
    );
    animationEditors?.refresh();
    drivenPanel?.refresh();
    ikPanel?.refresh();
    constraintsPanel?.refresh();
    channelKeys?.refresh();
  }
  function applyAnimationPose() {
    const draggingTarget = !!selectedIKId && dragId === `ik:${selectedIKId}`;
    if (dragId && !draggingTarget) return;
    let doc = store.getState().document;
    if (draggingTarget) {
      const target = ikTargets.getObject(selectedIKId)!.position.toArray() as Vec3;
      doc = { ...doc, ikHandles: doc.ikHandles?.map(handle => handle.id === selectedIKId ? { ...handle, target } : handle) };
    }
    evaluated = evaluateSceneAnimation(doc, getFrame());
    for (const [id, pose] of poseOverrides) if (evaluated.has(id)) evaluated.set(id, pose);
    evaluateDrivenKeys(doc, evaluated);
    fkPoses = new Map(evaluated);
    evaluateIK(doc, evaluated);
    solvedPoses = new Map(evaluated);
    try {
      evaluateConstraints(doc, evaluated);
      evaluationError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (playing) setPlaying(false);
      if (message !== evaluationError) notice.textContent = message;
      evaluationError = message;
    }
    for (const [id, object] of runtime) {
      const pose = evaluated.get(id);
      if (!pose) continue;
      object.root.position.fromArray(pose.position);
      object.root.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as Vec3);
      object.root.scale.fromArray(pose.scale);
      object.root.visible = pose.visibility >= .5;
      object.preview.rotation.y = timelinePanel?.turntable ? (time / duration) * Math.PI * 2 : 0;
    }
    skeleton.applyPose(evaluated);
    ikTargets.sync(doc, evaluated);
  }
  function updateTime(apply = true) {
    if (apply) { applyAnimationPose(); updateBindings(); }
    timelinePanel?.refresh();
    const turntable = timelinePanel?.turntable;
    timeline.value = turntable ? time : getFrame();
    element<HTMLOutputElement>("time").value = turntable ? `${time.toFixed(2)} / 12.00s` : `${Math.round(getFrame())} / ${animationSettings().end}`;
    updatePanel();
    animationEditors?.refresh();
    if (!playing) drivenPanel?.refresh();
    ikPanel?.refresh();
    constraintsPanel?.refresh();
  }
  const sceneInput = element<HTMLInputElement>("scene-file");
  function closeFileMenu() {
    element<WaDropdown>("file-menu").open = false;
  }
  async function discardChanges() {
    closeFileMenu();
    return !isDirty() || (await askDiscard());
  }
  function busy(value: boolean, message = "") {
    loading = value;
    if (value) {
      setPlaying(false);
      cancelSelection();
    }
    for (const id of ["open", "demo"]) element<WaButton>(id).disabled = value;
    notice.textContent = message;
    syncScene();
    updateHistoryButtons();
  }
  function disposeObject(object: RuntimeObject) {
    object.root.removeFromParent();
    object.box.removeFromParent();
    object.box.geometry.dispose();
    (object.box.material as THREE.Material).dispose();
    object.mesh.dispose();
  }
  function replaceScene(
    doc: SceneDocument,
    objects: Map<string, RuntimeObject>,
    files: Map<string, File>,
    name: string,
    handle?: SceneFileHandle,
  ) {
    transform.detach();
    clearPoseDraft();
    selectedIKId = "";
    selected.clear();
    const previousObjects = [...runtime.values()];
    runtime.clear();
    assetFiles.clear();
    for (const [id, object] of objects) {
      runtime.set(id, object);
      world.add(object.box);
    }
    for (const [id, file] of files) assetFiles.set(id, file);
    sceneName = name;
    sceneHandle = handle;
    savedDocument = JSON.stringify(doc);
    store.temporal.getState().pause();
    store.setState({ document: doc, editLabel: "Open scene" });
    store.temporal.getState().resume();
    store.temporal.getState().clear();
    previousObjects.forEach(disposeObject);
    time = 0;
    updateTime();
  }
  function editorSnapshot(): EditorSnapshot {
    return {
      camera: {
        position: camera.position.toArray() as Vec3,
        target: controls.target.toArray() as Vec3,
        fov: perspective.fov,
        view:activeView,
        height:(orthographic.top-orthographic.bottom)/orthographic.zoom,
        near: camera.near,
        far: camera.far,
      },
      time,
    };
  }
  function restoreEditor(editor: EditorSnapshot) {
    activeView=editor.camera.view??"perspective";
    camera=activeView==="perspective"?perspective:orthographic;
    camera.up.set(0,1,0);
    if(activeView==="top")camera.up.set(0,0,-1);
    if(activeView==="bottom")camera.up.set(0,0,1);
    // Flush residual orbit damping before applying the saved view.
    controls.enableDamping = false;
    controls.update();
    camera.position.fromArray(editor.camera.position);
    controls.target.fromArray(editor.camera.target);
    perspective.fov = editor.camera.fov;
    orthographic.top=(editor.camera.height??8)/2;orthographic.bottom=-orthographic.top;orthographic.zoom=1;
    camera.near = editor.camera.near;
    camera.far = editor.camera.far;
    controls.minDistance = 0.00001;
    controls.maxDistance = Infinity;
    resizeProjection();reconnectControls(new THREE.Vector3(...editor.camera.target));viewportTools.setView(activeView);
    controls.enableDamping = true;
    time = Math.max(animationSettings().start / animationSettings().fps, Math.min(animationSettings().end / animationSettings().fps, editor.time));
    updateTime();
  }
  async function saveProject(saveAs = false) {
    if (loading || dragId) return;
    closeFileMenu();
    busy(true);
    try {
      // Request the destination before asynchronous packing so browser user activation is retained.
      const destination = await saveDestination(
        sceneName,
        saveAs ? undefined : sceneHandle,
        askFilename,
      );
      if (!destination) return;
      notice.textContent = "Saving scene…";
      const doc = store.getState().document;
      const bytes = await encodeProject(doc, assetFiles, editorSnapshot());
      await writeScene(bytes, destination);
      sceneName = destination.name;
      sceneHandle = destination.handle;
      savedDocument = JSON.stringify(doc);
      element("file-status").textContent = destination.handle
        ? "Scene saved"
        : "Scene download started";
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        element("file-status").textContent =
          `Save failed: ${error instanceof Error ? error.message : "Could not write file."}`;
      }
    } finally {
      busy(false);
    }
  }
  async function loadProject(file: File, handle?: SceneFileHandle) {
    if (loading || dragId || dialogOpen() || !(await discardChanges())) return;
    busy(true, "Opening scene…");
    const staged = new Map<string, RuntimeObject>();
    let committed = false;
    try {
      if (file.size > MAX_PROJECT_BYTES)
        throw new Error("This version supports projects up to 512 MiB.");
      const project = await decodeProject(
        new Uint8Array(await file.arrayBuffer()),
      );
      for (const node of transformNodes(project.scene)) {
        const shape = Object.values(project.scene.nodes).find(
          (n): n is SplatShapeNode =>
            n.type === "splatShape" && n.parentId === node.id,
        )!;
        const asset = project.scene.assets[shape.assetId];
        const mesh =
          asset.kind === "procedural"
            ? makeDemo()
            : new SplatMesh({
                extSplats: true,
                covSplats: true,
                fileBytes: await project.files.get(asset.id)!.arrayBuffer(),
                fileName: asset.fileName,
              });
        try {
          const data = await prepareSplat(mesh);
          const root = new THREE.Group(),
            preview = new THREE.Group(),
            box = new THREE.Box3Helper(new THREE.Box3(), 0x999999);
          preview.add(mesh);
          root.add(preview);
          box.visible = false;
          staged.set(node.id, {
            ...data,
            root,
            preview,
            mesh,
            box,
            assetId: asset.id,
          });
        } catch (error) {
          mesh.dispose();
          throw error;
        }
      }
      replaceScene(project.scene, staged, project.files, file.name, handle);
      committed = true;
      restoreEditor(project.editor);
      element("file-status").textContent = "Scene opened";
    } catch (error) {
      element("file-status").textContent =
        `Open failed: ${error instanceof Error ? error.message : "Invalid scene."}`;
    } finally {
      if (!committed) staged.forEach(disposeObject);
      busy(false);
    }
  }
  async function openProject() {
    if (loading || dragId) return;
    closeFileMenu();
    try {
      const picked = await pickScene();
      if (picked) await loadProject(picked.file, picked.handle);
      else sceneInput.click();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        element("file-status").textContent =
          `Open failed: ${error instanceof Error ? error.message : "Could not read file."}`;
    }
  }
  async function newProject() {
    if (loading || dragId || dialogOpen() || !(await discardChanges())) return;
    closeFileMenu();
    setPlaying(false);
    cancelSelection();
    replaceScene(emptyScene(), new Map(), new Map(), "Untitled.msb");
    restoreEditor({
      camera: {
        position: [3, 2, 8],
        target: [0, 0, 0],
        fov: 42,
        near: 0.01,
        far: 1000,
      },
      time: 0,
    });
    syncScene();
    updateHistoryButtons();
    element("file-status").textContent = "New scene";
  }
  element("file-menu").addEventListener("wa-select", (event) => {
    switch ((event as WaSelectEvent).detail.item.id) {
      case "scene-new":
        void newProject();
        break;
      case "scene-open":
        void openProject();
        break;
      case "scene-save":
        void saveProject();
        break;
      case "scene-save-as":
        void saveProject(true);
        break;
    }
  });
  sceneInput.addEventListener("change", () => {
    const file = sceneInput.files?.[0];
    sceneInput.value = "";
    if (file) void loadProject(file);
  });
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
    for (const id of ["open", "demo"]) element<WaButton>(id).disabled = true;
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
      if (timelinePanel?.turntable) time = 0;
      updateTime();
      fitView();
      notice.textContent = "";
    } catch (error) {
      if (!registered) candidate?.dispose();
      notice.textContent = `Could not load this scene. ${error instanceof Error ? error.message : "Try another splat file."}`;
    } finally {
      loading = false;
      for (const id of ["open", "demo"]) element<WaButton>(id).disabled = false;
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
    clearPoseDraft();
    time = timelinePanel?.turntable ? 0 : animationSettings().start / animationSettings().fps;
    updateTime();
  });
  timeline.addEventListener("input", () => {
    setPlaying(false);
    if (dragId || loading) return;
    clearPoseDraft();
    time = timelinePanel?.turntable ? Number(timeline.value) : Math.round(Number(timeline.value)) / animationSettings().fps;
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
    for (const id of ["open", "demo"]) element<WaButton>(id).disabled = true;
  });
  webgl.setAnimationLoop((now) => {
    const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 0;
    previous = now;
    if (playing) {
      if (timelinePanel?.turntable) time = (time + delta) % duration;
      else {
        const next = advanceFrame(getFrame(), delta, animationSettings());
        time = next.frame / animationSettings().fps;
        if (next.stopped) setPlaying(false);
      }
      updateTime();
    }
    controls.update();
    for (const id of selected) {
      const object = runtime.get(id);
      if (object) {
        object.mesh.updateWorldMatrix(true, false);
        const skin = playing ? [...bindings.values()].find(b => b.mesh === object.mesh)?.skin : undefined;
        object.box.box
          .copy(skin ? skin.conservativeBounds(object.bounds) : boundSelection(object)?.bounds ?? object.bounds)
          .applyMatrix4(object.mesh.matrixWorld);
        object.box.visible = gizmosVisible && object.root.visible;
      }
    }
    viewportTools.updateOrientation(camera.quaternion);
    webgl.render(world, camera);
  });
  choose("select");
  setPlaying(false);
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
