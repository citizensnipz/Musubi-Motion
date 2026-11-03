import { meshToSplatData } from "./mesh-to-splats";
import { createMeshSplatColors } from "./mesh-splat-colors";
import { cubeToSplatBytes, cubeSplatFaces } from "./cube-to-splats";
import { createCubeSplatDialog } from "./cube-splat-dialog";
import { findMeshShape as conversionMeshShape } from "./mesh-modeling";
import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { addSplat, emptyScene, transformNodes, deleteSceneItems, normalizedChannels, uniqueName } from "./scene-document.ts";
import type {
  SceneDocument,
  AssetRecord,
  SplatShapeNode,
  CurveShapeNode,
  MeshShapeNode,
  ParticleShapeNode,
  TransformChannels,
  Vec3,
} from "./scene-document.ts";
import {
  createSceneStore,
  setObjectVisibility,
  renameObject,
} from "./scene-store.ts";
import { mountViewportFileDrop } from "./viewport-file-drop.ts";
import { importFBX } from "./fbx-import.ts";
import { transformSpace, type TransformOrientation } from "./transform-space.ts";
import { objectGeometryPosition, relocateObjectPivot, objectLocalMatrix, globalObjectTransform } from "./object-pivot.ts";
import type { TransformNode } from "./scene-document.ts";
import { createMorphPanel } from "./morph-panel.ts";
import { createPropertiesPanel } from "./properties-panel.ts";
import { makeDemo, prepareSplat } from "./splat-assets.ts";
import {
  encodeProjectBlob,
  decodeProjectBlob,
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
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import packageInfo from "../package.json";
import "./style.css";
import { defaultAnimation, editingTracks, evaluateChannels, evaluateSceneAnimation, keyChannels, setKeys, type AnimationPose } from "./animation.ts";
import { evaluateDrivenKeys } from "./driven-keys.ts";
import { mountTimeline } from "./timeline-panel.ts";
import { advanceFrame } from "./animation-playback.ts";
import { mountAnimationEditors } from "./graph-editor.ts";
import { createDrivenKeyPanel } from "./driven-key-panel.ts";
import { prepareJointAnimationEdit, prepareTransformAnimationEdit, unwrapEuler } from "./animation-edit.ts";
import { evaluateRigStages, getIKTargetPoints, validateIKHandles, updateIKHandle, deleteIKHandle } from "./ik.ts";
import { ikInputConstraintTargets } from "./ik-control-plan.ts";
import { createIKPanel } from "./ik-panel.ts";
import { createIKBakePanel } from "./ik-bake-panel.ts";
import { createJointSettingsPanel } from "./joint-settings-panel.ts";
import { createRotationPanel } from "./rotation-panel.ts";
import { jointRotationFromQuaternion } from "./joint-transform.ts";
import { createAnimationLayersPanel } from "./animation-layers-panel.ts";
import { bindJointMirrorControls, createJointMirrorPanel } from "./joint-mirror-panel.ts";
import { validateConstraints } from "./constraints.ts";
import { createConstraintsPanel } from "./constraints-panel.ts";
import { mountChannelKeyControls } from "./channel-animation-controls.ts";
import { applyTransformPoseDraft, PoseDrafts } from "./pose-drafts.ts";
import { createIKTargets, type IKControlKind } from "./ik-targets.ts";
import { createControllerRenderable } from "./controller-renderer.ts";
import { createControllerPanel } from "./controller-panel.ts";
import { controllerPlacement } from "./controller-placement.ts";
import { mountSkeleton } from "./skeleton.ts";
import { createBinding } from "./splat-binding.ts";
import { validateSkinWeightCount, editSkinWeightValues } from "./skin-weights.ts";
import { createSkinWeightsPanel } from "./skin-weights-panel.ts";
import { createSkinWeightPreview } from "./skin-weight-preview.ts";
import { pickProjectedComponents } from "./component-picking.ts";
import { createSkinWeightPaintPanel, type SkinWeightBrushSettings } from "./skin-weight-paint-panel.ts";
import { createSkinWeightPaintTool } from "./skin-weight-paint-tool.ts";
import { createMeshRenderable } from "./mesh-renderer.ts";
import { createMeshComponentPreview, type MeshComponentMode } from "./mesh-component-preview.ts";
import { createModelingPanel } from "./modeling-panel.ts";
import { pickMeshComponents } from "./mesh-component-selection.ts";
import { captureMeshComponentTransform } from "./mesh-component-transform.ts";
import { setMeshVertexPositions } from "./mesh-modeling.ts";
import { createParticleRuntime } from "./particle-runtime.ts";
import { createParticlePoseSampler } from "./particle-pose-sampler.ts";
import { createParticlePanel } from "./particle-panel.ts";
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
terminal.watchNotices(element("file-status"));
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

type RuntimeBase = {
  root: THREE.Group;
  preview: THREE.Group;
  bounds: THREE.Box3;
  centers: Float32Array;
  count: number;
  box: THREE.Box3Helper;
};
type RuntimeObject = RuntimeBase & (
  | { kind: "splat"; mesh: SplatMesh; assetId: string }
  | { kind: "curve"; mesh: ReturnType<typeof createControllerRenderable>["mesh"]; controller: ReturnType<typeof createControllerRenderable>; shape: CurveShapeNode }
  | { kind: "mesh"; mesh: ReturnType<typeof createMeshRenderable>["mesh"]; polygon: ReturnType<typeof createMeshRenderable>; shape: MeshShapeNode }
  | { kind: "particle"; mesh: ReturnType<typeof createParticleRuntime>["mesh"]; particles: ReturnType<typeof createParticleRuntime>; shape: ParticleShapeNode }
);

function particleObjectRuntime(shape: ParticleShapeNode): RuntimeObject {
  const particles = createParticleRuntime(shape), root = new THREE.Group(), preview = new THREE.Group();
  preview.add(particles.mesh); root.add(preview);
  const box = new THREE.Box3Helper(new THREE.Box3(), 0x999999); box.visible = false;
  return { kind: "particle", root, preview, mesh: particles.mesh, particles, shape, box, bounds: particles.bounds, centers: particles.centers, count: 0 };
}

function meshRuntime(shape: MeshShapeNode): RuntimeObject {
  const polygon = createMeshRenderable(shape), root = new THREE.Group(), preview = new THREE.Group();
  preview.add(polygon.mesh); root.add(preview);
  const box = new THREE.Box3Helper(new THREE.Box3(), 0x999999); box.visible = false;
  return { kind: "mesh", root, preview, mesh: polygon.mesh, polygon, shape, box, bounds: polygon.bounds, centers: polygon.centers, count: 0 };
}

function controllerRuntime(shape: CurveShapeNode): RuntimeObject {
  const controller = createControllerRenderable(shape);
  const root = new THREE.Group(), preview = new THREE.Group();
  preview.add(controller.mesh); root.add(preview);
  const box = new THREE.Box3Helper(new THREE.Box3(), 0x999999); box.visible = false;
  return { kind: "curve", root, preview, mesh: controller.mesh, controller, shape, box,
    bounds: controller.bounds, centers: controller.centers, count: 0 };
}

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
  const maximumParticlePointSize = Number(webgl.getContext().getParameter(webgl.getContext().ALIASED_POINT_SIZE_RANGE)[1]);
  webgl.setPixelRatio(Math.min(devicePixelRatio, 2));
  webgl.domElement.setAttribute(
    "aria-label",
    "Interactive 3D scene",
  );
  viewport.prepend(webgl.domElement);
  scene = new THREE.Scene();
  const world = scene;
  world.add(new THREE.HemisphereLight(0xffffff, 0x606878, 2));
  const meshLight = new THREE.DirectionalLight(0xffffff, 2); meshLight.position.set(4, 6, 5); world.add(meshLight);
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
  let selectedIKBlendId = "";
  let blendPreview: { id: string; value: number } | undefined;
  let selectedIKKind: IKControlKind = "target";
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
  let dragControlPose: { id: string; pose: AnimationPose; node?: TransformNode } | undefined;
  const poseOverrides = new Map<string, AnimationPose>();
  const poseDrafts = new PoseDrafts();
  let evaluated = new Map<string, AnimationPose>();
  let drivenPoses = new Map<string, AnimationPose>();
  let fkPoses = new Map<string, AnimationPose>();
  let solvedPoses = new Map<string, AnimationPose>();
  let timelinePanel: ReturnType<typeof mountTimeline> | undefined;
  let animationEditors: ReturnType<typeof mountAnimationEditors> | undefined;
  let drivenPanel: ReturnType<typeof createDrivenKeyPanel> | undefined;
  let ikPanel: ReturnType<typeof createIKPanel> | undefined;
  let ikBakePanel: ReturnType<typeof createIKBakePanel> | undefined;
  let jointSettingsPanel: ReturnType<typeof createJointSettingsPanel> | undefined;
  let rotationPanel: ReturnType<typeof createRotationPanel> | undefined;
  let animationLayersPanel: ReturnType<typeof createAnimationLayersPanel> | undefined;
  let jointMirrorPanel: ReturnType<typeof createJointMirrorPanel> | undefined;
  let constraintsPanel: ReturnType<typeof createConstraintsPanel> | undefined;
  let controllerPanel: ReturnType<typeof createControllerPanel> | undefined;
  let skinWeightsPanel: ReturnType<typeof createSkinWeightsPanel> | undefined;
  let skinPaintPanel: ReturnType<typeof createSkinWeightPaintPanel> | undefined;
  let skinPaintTool: ReturnType<typeof createSkinWeightPaintTool> | undefined;
  let paintSettings: SkinWeightBrushSettings | undefined;
  let modelingPanel: ReturnType<typeof createModelingPanel> | undefined;
  let particlePanel: ReturnType<typeof createParticlePanel> | undefined;
  let particlePoseDoc: SceneDocument | undefined, particlePoseSampler: ReturnType<typeof createParticlePoseSampler> | undefined;
  let meshComponentRequest: { shapeId: string; mode: MeshComponentMode } | undefined;
  let meshComponentIds: string[] = [];
  const meshComponentProxy = new THREE.Object3D(); world.add(meshComponentProxy);
  let meshDrag: { document: SceneDocument; shape: MeshShapeNode; object: Extract<RuntimeObject, { kind: "mesh" }>;
    snapshot: ReturnType<typeof captureMeshComponentTransform>; startInverse: THREE.Matrix4; previewShape?: MeshShapeNode } | undefined;
  const meshComponentPreview = createMeshComponentPreview();
  function updateMeshComponentPreview() {
    const shape = meshComponentRequest && store.getState().document.nodes[meshComponentRequest.shapeId];
    const object = shape?.type === "meshShape" ? runtime.get(shape.parentId) : undefined;
    if (!meshComponentRequest || shape?.type !== "meshShape" || object?.kind !== "mesh") { meshComponentPreview.clear(); return; }
    meshComponentPreview.update(meshDrag?.previewShape ?? shape, object.mesh, object.polygon.triangleFaceIds, meshComponentRequest.mode, meshComponentIds);
    meshComponentPreview.setVisible(gizmosVisible && !playing && !loading);
  }
  let weightPreview: { shapeId: string; indices: number[]; jointId: string } | undefined;
  const weightOverlay = createSkinWeightPreview();
  let componentPickShape: string | undefined, componentPickEpoch = 0, pendingComponentPick: number | undefined;
  let skinPoseVersion = 0;
  function cancelComponentScan(message = "Component selection canceled.") {
    componentPickEpoch++;
    if (pendingComponentPick !== undefined) { pendingComponentPick = undefined; notice.textContent = message; }
  }
  let channelKeys: ReturnType<typeof mountChannelKeyControls> | undefined;
  let evaluationError = "";
  const animationSettings = () => store.getState().document.animation ?? defaultAnimation();
  const getFrame = () => time * animationSettings().fps;
  const allSelection = (): string[] => {
    const doc = store.getState().document, joints = new Set(doc.joints?.map(joint => joint.id));
    // Earlier store subscribers can refresh panels before syncScene prunes selection.
    return [...selected, ...skeleton.selectedIds].filter(id => doc.nodes[id]?.type === "transform" || joints.has(id));
  };
  const currentPose = (id: string): AnimationPose => evaluated.get(id) ?? poseOverrides.get(id) ?? evaluateChannels(store.getState().document, id, getFrame());
  const animationSelection = () => {
    const id = selectedIKBlendId || selectedIKId;
    return id && store.getState().document.ikHandles?.some(handle => handle.id === id) ? [id] : allSelection();
  };
  function prepareJointEdit(next: import("./skeleton.ts").Joint[], label: string): SceneDocument {
    const result = prepareJointAnimationEdit(store.getState().document, next, label, Math.round(getFrame()), timelinePanel?.autoKey ?? false, currentPose);
    if (result.document.ikHandles) validateIKHandles(result.document.ikHandles, result.document);
    if (result.document.constraints) validateConstraints(result.document.constraints, result.document);
    for (const [id, pose] of result.overrides) poseOverrides.set(id, pose);
    if (result.overrides.size) poseDrafts.capture(result.document, poseOverrides);
    return result.document;
  }
  const skeleton = mountSkeleton(store, world, riggingPanel, () => !loading && !dragId, prepareJointEdit);
  function editPose(id: string, channels: TransformChannels, label: string, transformedNode?: TransformNode) {
    setPlaying(false);
    let doc = store.getState().document;
    const node = doc.nodes[id];
    if (node?.type !== "transform") return;
    const pose = { ...normalizedChannels(channels), visibility: currentPose(id).visibility, morphWeights: currentPose(id).morphWeights };
    if (transformedNode) {
      const patched = { ...node }; if (transformedNode.affine) patched.affine = [...transformedNode.affine]; else delete patched.affine;
      doc = { ...doc, nodes: { ...doc.nodes, [id]: patched } };
    }
    try {
      doc = prepareTransformAnimationEdit(doc, id, pose, getFrame(), timelinePanel?.autoKey ?? false);
      if (doc.constraints) validateConstraints(doc.constraints, doc);
    } catch (error) {
      syncScene(); notice.textContent = (error as Error).message; return;
    }
    poseOverrides.set(id, pose);
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
    const ids = animationSelection();
    if (!ids.length) { notice.textContent = "Select objects, joints, or an IK blend channel to set keys."; return; }
    setKeys(store, ids, Math.round(getFrame()), new Map(allSelection().map(id => [id, currentPose(id)])));
    if (allSelection().length) clearPoseDraft();
    updateTime();
    notice.textContent = `Set keys for ${ids.length} selected item(s) at frame ${Math.round(getFrame())}.`;
  }
  function clearPoseDraft() {
    blendPreview = undefined;
    poseOverrides.clear();
    poseDrafts.clear();
  }
  function preserveUnconsumedDrafts(consumedIds: string[], action: () => void) {
    const retained = poseDrafts.preserveAcrossEdit(store.getState().document, poseOverrides, consumedIds, () => {
      action(); return store.getState().document;
    });
    poseOverrides.clear();
    for (const [id, pose] of retained) poseOverrides.set(id, pose);
    updateTime();
  }
  const bindings = new Map<string, { binding: SplatShapeNode["binding"]; elasticity: SplatShapeNode["elasticity"]; structure: string; mesh: SplatMesh; skin: ReturnType<typeof createBinding> }>();
  let cachedJoints: SceneDocument["joints"], jointStructure = "";
  function updateWeightPreview() {
    if (!weightPreview || playing || loading || dragId || !gizmosVisible || paintSettings) { weightOverlay.setVisible(false); return; }
    const entry = bindings.get(weightPreview.shapeId);
    const shape = store.getState().document.nodes[weightPreview.shapeId];
    if (!entry || shape?.type !== "splatShape" || !shape.binding?.jointIds.includes(weightPreview.jointId)
      || weightPreview.indices.some(index => index < 0 || index >= entry.skin.componentCount)) { weightOverlay.clear(); return; }
    const weights = weightPreview.indices.map(index => entry.skin.getWeights(index).find(influence => influence.jointId === weightPreview!.jointId)?.weight ?? 0);
    weightOverlay.update(entry.mesh, entry.skin.getComponentPositions(weightPreview.indices), weights);
  }
  function boundSelection(object:RuntimeObject) {
    if (object.kind !== "splat") return undefined;
    return [...bindings.values()].find(b=>b.mesh===object.mesh)?.skin.selection();
  }
  function updateBindings() {
    skinPoseVersion++;
    const doc = store.getState().document;
    if (cachedJoints !== doc.joints) {
      cachedJoints = doc.joints;
      jointStructure = JSON.stringify(doc.joints?.map(joint => [joint.id, joint.parentId]));
    }
    const shapes = Object.values(doc.nodes).filter((n): n is SplatShapeNode => n.type === "splatShape");
    for (const [id, entry] of bindings) {
      const shape = doc.nodes[id];
      if (shape?.type !== "splatShape" || !shape.binding || shape.binding !== entry.binding || shape.elasticity !== entry.elasticity
        || jointStructure !== entry.structure || runtime.get(shape.parentId)?.mesh !== entry.mesh) {
        entry.skin.dispose(); bindings.delete(id);
      }
    }
    for (const shape of shapes) if (shape.binding) {
      const object = runtime.get(shape.parentId);
      if (!object || object.kind !== "splat") continue;
      if (!bindings.has(shape.id)) bindings.set(shape.id, {binding:shape.binding,elasticity:shape.elasticity,structure:jointStructure,mesh:object.mesh,skin:createBinding(object.mesh,shape.binding,shape.elasticity,doc.joints)});
      bindings.get(shape.id)!.skin.update(id => skeleton.boneMatrix(id));
    }
    updateWeightPreview();
    skinPaintTool?.refresh();
    updateMeshComponentPreview();
  }
  for (const control of new Set([...Array.from(document.querySelectorAll<WaButton>("[data-rig-action]")), ...Array.from(riggingPanel.querySelectorAll<WaButton>("[data-rig-action]"))])) {
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
        const object = runtime.get(shape.parentId);
        if (!object || object.kind !== "splat") continue;
        const mesh = object.mesh;
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
      // TransformControls suppresses native focus changes. Commit field drafts before a drag makes their panel busy.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(".ik-panel, .modeling-panel")) {
        focused.blur();
        transform.getHelper().updateMatrixWorld(true);
      }
      if (componentPickShape && !skinWeightsPanel?.element.checkVisibility()) skinWeightsPanel?.stopPicking();
      if (paintSettings && !skinPaintPanel?.element.checkVisibility()) skinPaintPanel?.stopPainting();
      if (meshComponentRequest && !modelingPanel?.element.checkVisibility()) modelingPanel?.stopEditing();
      controls.enabled = event.pointerType === "touch" || event.altKey;
      transform.enabled =
        !componentPickShape && !paintSettings && (!meshComponentRequest || transform.object === meshComponentProxy) &&
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
  const objectPivotProxy = new THREE.Group(); world.add(objectPivotProxy);
  let pivotHeld = false;
  let objectOrientation: TransformOrientation = "world";
  let objectDrag: { id: string; document: SceneDocument; node: TransformNode; pose: AnimationPose; editingPivot: boolean; inverseWorld: THREE.Matrix4; beforeWorld: THREE.Matrix4; parentWorld: THREE.Matrix4; initialOrientation: THREE.Quaternion } | undefined;
  const pivotCanvas = document.createElement("canvas"); pivotCanvas.width = pivotCanvas.height = 128;
  const pivotContext = pivotCanvas.getContext("2d")!;
  pivotContext.strokeStyle = "#ffffff"; pivotContext.lineWidth = 10; pivotContext.beginPath(); pivotContext.arc(64, 64, 48, 0, Math.PI * 2); pivotContext.stroke();
  const pivotCircle = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(pivotCanvas), depthTest: false, depthWrite: false }));
  pivotCircle.scale.set(.27, .27, 1); pivotCircle.renderOrder = 1000001; pivotCircle.visible = false;
  // Keep Three's screen-plane center picker; replace only its visible center while editing.
  const translateCenter = (transform as unknown as { _gizmo: { gizmo: { translate: THREE.Group } } })._gizmo.gizmo.translate.children.find(child => child.name === "XYZ") as THREE.Mesh;
  translateCenter.add(pivotCircle);
  function updatePivotMarker() {
    const editing = (objectDrag?.editingPivot ?? pivotHeld) && transform.object === objectPivotProxy && currentMode === "translate";
    pivotCircle.visible = editing;
    (translateCenter.material as THREE.Material).visible = !editing;
  }
  function applyObjectPose(object: RuntimeObject, node: TransformNode, pose: TransformChannels) {
    object.root.position.copy(objectGeometryPosition(node, pose));
    object.root.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as Vec3);
    object.root.scale.fromArray(pose.scale);
    object.root.matrixAutoUpdate = !node.affine;
    if (node.affine) { object.root.matrix.copy(objectLocalMatrix(node, pose)); object.root.matrixWorldNeedsUpdate = true; }
    else object.root.updateMatrix();
  }
  function dragTransform(session: NonNullable<typeof objectDrag>) {
    return globalObjectTransform(session.node, session.pose, session.beforeWorld, session.parentWorld, objectPivotProxy, currentMode, session.initialOrientation);
  }

  const toolbar = element<HTMLDivElement>("transform-tools");
  toolbar.className = "transform-tools";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Transform tools");
  const orientationControl = document.createElement("select");
  orientationControl.id = "transform-orientation";
  orientationControl.setAttribute("aria-label", "Object gizmo axis orientation");
  orientationControl.title = "World: global axes · Object: selected object's axes";
  orientationControl.add(new Option("World", "world")); orientationControl.add(new Option("Object", "object"));
  orientationControl.value = objectOrientation;
  orientationControl.addEventListener("change", () => {
    if (dragId || loading || playing) { orientationControl.value = objectOrientation; return; }
    objectOrientation = orientationControl.value === "object" ? "object" : "world";
    refreshGizmo();
  });

  function singleId() {
    return selected.size === 1 ? selected.values().next().value : undefined;
  }
  function refreshGizmo() {
    orientationControl.disabled = !!dragId || loading || playing || !!meshComponentRequest || !!skeleton.selectedIds.size || !!selectedIKId || !singleId();
    if (meshDrag || objectDrag) return;
    if (componentPickShape || paintSettings) { transform.detach(); transform.enabled = false; return; }
    if(!gizmosVisible || (skeleton.selectedId&&!jointsVisible)) {transform.detach();transform.enabled=false;return;}
    transform.setSpace("world");
    if (meshComponentRequest) {
      const shape = store.getState().document.nodes[meshComponentRequest.shapeId];
      const object = shape?.type === "meshShape" ? runtime.get(shape.parentId) : undefined;
      if (currentMode !== "select" && !loading && !playing && meshComponentIds.length && shape?.type === "meshShape" && object?.kind === "mesh") {
        try {
          object.mesh.updateWorldMatrix(true, false);
          const snapshot = captureMeshComponentTransform(shape, meshComponentRequest.mode, meshComponentIds, object.mesh.matrixWorld);
          meshComponentProxy.position.copy(snapshot.pivot); meshComponentProxy.quaternion.identity(); meshComponentProxy.scale.setScalar(1);
          meshComponentProxy.updateMatrixWorld(true);
          if (transform.object !== meshComponentProxy) transform.attach(meshComponentProxy);
          transform.setMode(currentMode); transform.enabled = true; transform.getHelper().visible = true;
          return;
        } catch (error) { notice.textContent = (error as Error).message; }
      }
      transform.detach(); transform.enabled = false; return;
    }
    if (selectedIKId) {
      const target = ikTargets.getObject(selectedIKId, selectedIKKind);
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
      transform.setSpace(transformSpace(currentMode, false, objectOrientation));
      const node = store.getState().document.nodes[id!] as TransformNode;
      const pose = currentPose(id!);
      object.root.updateWorldMatrix(true, false);
      if (objectPivotProxy.parent !== world) world.add(objectPivotProxy);
      objectPivotProxy.position.set(...node.pivot ?? [0, 0, 0]).applyMatrix4(object.root.matrixWorld);
      if (objectOrientation === "object") object.root.getWorldQuaternion(objectPivotProxy.quaternion).normalize();
      else objectPivotProxy.quaternion.identity();
      objectPivotProxy.scale.setScalar(1); objectPivotProxy.updateMatrixWorld(true);
      if (transform.object !== objectPivotProxy) transform.attach(objectPivotProxy);
      updatePivotMarker();
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
    if ((componentPickShape || paintSettings) && mode !== "select") { notice.textContent = "Return to Object mode before transforming an object."; return; }
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
        ? "Scale along the selected World/Object axes, or uniformly with the center handle"
        : mode === "rotate" ? "Rotate around the selected World/Object axes" : mode;
    button.addEventListener("click", () => choose(mode));
    toolbar.append(button);
    const tooltip = document.createElement("wa-tooltip");
    tooltip.setAttribute("for", button.id);
    tooltip.textContent = `${mode[0].toUpperCase() + mode.slice(1)} · ${key.toUpperCase()}${mode === "translate" ? " · Hold D to edit pivot" : ""}`;
    toolbar.append(tooltip);
  }
  toolbar.append(orientationControl);
  const selectionLabel = document.createElement("span");
  selectionLabel.className = "selection-label";
  selectionLabel.setAttribute("role", "status");
  viewport.append(selectionLabel);
  riggingPanel.addEventListener("joint-selection-change", () => {
    const doc = store.getState().document;
    selected = new Set([...selected].filter(id => doc.nodes[id]?.type === "transform"));
    if (skeleton.selectedIds.size) { selectedIKId = ""; selectedIKBlendId = ""; ikTargets.setSelected(); }
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
    skinWeightsPanel?.refresh();
    skinPaintPanel?.refresh();
    modelingPanel?.refresh();
    refreshGizmo();
    particlePanel?.refresh();
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
  let morphPanel: ReturnType<typeof createMorphPanel> | undefined;
  const panelHost = element<HTMLElement>("properties");
  const panel = createPropertiesPanel(panelHost, element("outliner-panel"), {
    visibility(id, visible) { if (!loading && !dragId) setObjectVisibility(store, id, visible); },
    previewChannel(id, channel, axis) {
      if (loading || dragId) return;
      const doc = store.getState().document;
      if (doc.drivenKeys?.some(r => r.driven.targetId === id && r.driven.channel === `${channel}.${"xyz"[axis]}`)) return;
      if (channel === "scale" && doc.joints?.some(j => j.id === id)) return;
      setPlaying(false);
      const original = poseOverrides.get(id);
      const pose = structuredClone(currentPose(id));
      return {
        update(value) {
          if (store.getState().document !== doc) return;
          const next = structuredClone(pose);
          next[channel][axis] = value;
          poseOverrides.set(id, { ...normalizedChannels(next), visibility: next.visibility, ...(next.morphWeights ? { morphWeights: [...next.morphWeights] } : {}) });
          updateTime();
        },
        end() {
          if (store.getState().document !== doc) return;
          if (original) poseOverrides.set(id, original);
          else poseOverrides.delete(id);
          updateTime();
        },
      };
    },
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
  morphPanel = createMorphPanel(panelHost, store, { getFrame, available: () => !loading && !playing && !dragId, canKey: () => !timelinePanel?.turntable, onStatus: message => { notice.textContent = message; } });
  function updatePanel(preview?: TransformChannels) {
    const doc = store.getState().document,
      id = singleId();
    const shape = Object.values(doc.nodes).find(
      (node) => node.type !== "transform" && node.parentId === id,
    );
    const jointNodes = (doc.joints ?? []).map(j => ({...j, type: "transform" as const, joint: true,
      rotationOrder: "XYZ" as const, rotation: j.rotation ?? [0,0,0] as Vec3, scale: [1,1,1] as Vec3 }));
    const ids = allSelection();
    const curves = new Set(Object.values(doc.nodes).filter(node => node.type === "curveShape").map(node => node.parentId));
    const meshes = new Set(Object.values(doc.nodes).filter(node => node.type === "meshShape").map(node => node.parentId));
    const emitters = new Set(Object.values(doc.nodes).filter(node => node.type === "particleShape").map(node => node.parentId));
    panel.update([...transformNodes(doc).map(node => ({ ...node, curve: curves.has(node.id), mesh: meshes.has(node.id), particle: emitters.has(node.id) })), ...jointNodes], new Set(ids), shape?.name, preview ?? (ids.length === 1 ? currentPose(ids[0]) : undefined));
    elasticityPanel.update(shape?.type === "splatShape" ? shape : undefined, new Map((doc.joints??[]).map(j=>[j.id,j.name])));
    morphPanel?.update(shape?.type === "meshShape" ? shape : undefined);
    channelKeys?.refresh();
  }
  function selectObjects(ids: string[], additive = false) {
    if (dragId) return;
    selectedIKId = ""; selectedIKBlendId = ""; ikTargets.setSelected();
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
    if (!doc.ikHandles?.some(h => h.id === selectedIKBlendId)) selectedIKBlendId = "";
    if (selectedIKKind === "pole" && doc.ikHandles?.find(h => h.id === selectedIKId)?.solver !== "two-bone") selectedIKKind = "target";
    ikTargets.setSelected(selectedIKId || undefined, selectedIKKind);
    selected = new Set(
      [...selected].filter((id) => doc.nodes[id]?.type === "transform"),
    );
    for (const [id, object] of runtime) object.box.visible = gizmosVisible && selected.has(id);
    selectionLabel.textContent = selectedIKBlendId ? `IK blend: ${doc.ikHandles?.find(h => h.id === selectedIKBlendId)?.name}` : selectedIKId ? `IK ${selectedIKKind === "pole" ? "pole" : "target"}: ${doc.ikHandles?.find(h => h.id === selectedIKId)?.name}` : selected.size && skeleton.selectedIds.size ? `${selected.size} objects · ${skeleton.selectedIds.size} joints selected` : skeleton.selectedBone ? `Joint: ${skeleton.selectedBone.name}` : skeleton.selectedIds.size ? `${skeleton.selectedIds.size} joints selected` : selected.size
      ? `${selected.size} object${selected.size === 1 ? "" : "s"} selected`
      : "Nothing selected";
    refreshGizmo();
    updatePanel();
    timelinePanel?.refresh();
    animationEditors?.refresh();
    controllerPanel?.refresh();
    jointSettingsPanel?.refresh();
    rotationPanel?.refresh();
    animationLayersPanel?.refresh();
    jointMirrorPanel?.refresh();
    skinWeightsPanel?.refresh();
    skinPaintPanel?.refresh();
    modelingPanel?.refresh();
    particlePanel?.refresh();
  }
  function syncScene() {
    const doc = store.getState().document;
    for (const shape of Object.values(doc.nodes)) if (shape.type === "particleShape") {
      let object = runtime.get(shape.parentId);
      if (!object) { object = particleObjectRuntime(shape); runtime.set(shape.parentId, object); world.add(object.box); }
      if (object.kind === "particle") object.shape = shape;
    }
    for (const shape of Object.values(doc.nodes)) if (shape.type === "meshShape") {
      let object = runtime.get(shape.parentId);
      if (!object) { object = meshRuntime(shape); runtime.set(shape.parentId, object); world.add(object.box); }
      if (object.kind === "mesh" && object.shape !== shape) {
        object.polygon.update(shape); object.centers = object.polygon.centers; object.shape = shape;
      }
    }
    for (const shape of Object.values(doc.nodes)) if (shape.type === "curveShape") {
      let object = runtime.get(shape.parentId);
      if (!object) {
        object = controllerRuntime(shape); runtime.set(shape.parentId, object); world.add(object.box);
      }
      if (object.kind === "curve" && object.shape !== shape) {
        object.controller.update(shape); object.centers = object.controller.centers; object.shape = shape;
      }
    }
    for (const [id, object] of runtime) {
      const node = doc.nodes[id];
      if (node?.type !== "transform") {
        if (object.kind === "particle") object.particles.suspend();
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
      if (shape && object.kind === "splat") {
        object.mesh.name = shape.name;
        object.mesh.position.fromArray(shape.offset);
      }
    }
    const nodes = transformNodes(doc);
    applyAnimationPose();
    updateBindings();
    updateFileState();
    const count = nodes.reduce(
      (sum, node) => {
        const object = runtime.get(node.id);
        return sum + (object?.kind === "splat" ? object.mesh.extSplats?.numSplats ?? object.count : 0);
      },
      0,
    );
    const meshes = Object.values(doc.nodes).filter(node => node.type === "meshShape");
    const emitters = Object.values(doc.nodes).filter(node => node.type === "particleShape");
    element("asset-detail").textContent =
      `${nodes.length} object${nodes.length === 1 ? "" : "s"} · ${count.toLocaleString()} splats`
      + (meshes.length ? ` · ${meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0).toLocaleString()} polygon faces` : "")
      + (emitters.length ? ` · ${emitters.length} emitter${emitters.length === 1 ? "" : "s"}` : "");
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
    ikBakePanel?.refresh();
    jointSettingsPanel?.refresh();
    rotationPanel?.refresh();
    animationLayersPanel?.refresh();
    jointMirrorPanel?.refresh();
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
        disposeObject(object);
        runtime.delete(id);
      }
    const retainedAssets = new Set(
      docs.flatMap((doc) => (doc ? Object.keys(doc.assets) : [])),
    );
    for (const id of assetFiles.keys())
      if (!retainedAssets.has(id)) assetFiles.delete(id);
  }
  timelinePanel = mountTimeline(store, { getFrame, setFrame, setKey: keySelection, getSelection: animationSelection,
    available: () => !loading && !dragId,
    onModeChange() { setPlaying(false); clearPoseDraft(); time = timelinePanel?.turntable ? 0 : animationSettings().start / animationSettings().fps; updateTime(); },
  });
  animationEditors = mountAnimationEditors(store, { getFrame, setFrame, getSelection: animationSelection, getDrivenPoses: () => drivenPoses, onSelectTarget: selectAnimationTarget, available: () => !loading && !dragId && !playing });
  drivenPanel = createDrivenKeyPanel(store, { getFrame, getSelection: allSelection, getPoses: () => drivenPoses,
    onEditCurve: id => { animationEditors?.focusDrivenRelationship(id); element("view-graph").click(); },
    available: () => !loading && !dragId && !playing });
  ikPanel = createIKPanel(store, { getFrame, setFrame, previewBlend(id, value) {
    blendPreview = value === undefined ? undefined : { id, value }; applyAnimationPose(); updateBindings();
  }, canKey: () => !timelinePanel?.turntable, getPoses: () => evaluated, getFKPoses: () => fkPoses, getSolvedPoses: () => solvedPoses, getSelection: allSelection, available: () => !loading && !dragId && !playing });
  constraintsPanel = createConstraintsPanel(store, { getPoses: () => evaluated, getSelection: allSelection, available: () => !loading && !dragId && !playing });
  controllerPanel = createControllerPanel(store, {
    available: () => !loading && !dragId && !playing,
    getSelection: allSelection,
    getPlacement: () => {
      const ids = allSelection();
      if (!ids.length) return undefined;
      if (ids.length !== 1) throw Error("Select one object or joint to place the controller.");
      return controllerPlacement(store.getState().document, evaluated, ids[0]);
    },
    onSelect: id => selectObjects([id]),
  });
  channelKeys = mountChannelKeyControls(panelHost, store, { getFrame, getPose: currentPose, getSelection: allSelection, available: () => !loading && !dragId && !playing && !timelinePanel?.turntable });
  workspace.registerPanel("graph", "Graph Editor", animationEditors.graph);
  workspace.registerPanel("dope-sheet", "Dope Sheet", animationEditors.dopeSheet);
  workspace.registerPanel("driven-keys", "Set Driven Key", drivenPanel.element);
  workspace.registerPanel("ik-handles", "IK Handles", ikPanel.element);
  ikBakePanel = createIKBakePanel(store, {
    available: () => !loading && !dragId && !playing,
    onBusyChange: value => busy(value, value ? "Baking IK animation…" : ""),
    onStatus: message => { notice.textContent = message; },
    onViewCurves: id => {
      const doc = store.getState().document, handle = doc.ikHandles?.find(handle => handle.id === id);
      if (!handle || loading || dragId || playing) return;
      selectAnimationTarget(handle.rootId);
      const track = editingTracks(doc).find(track => track.targetId === handle.rootId && track.channel.startsWith("rotation."));
      if (track) animationEditors?.focusTrack(track.id);
      element("view-graph").click();
    },
  });
  workspace.registerPanel("ik-bake", "Bake IK to FK", ikBakePanel.element);
  jointSettingsPanel = createJointSettingsPanel(store, {
    available: () => !loading && !dragId && !playing,
    getSelection: allSelection, getFKPoses: () => fkPoses, getFrame,
    preserveDrafts: preserveUnconsumedDrafts,
    canKey: () => !timelinePanel?.turntable,
    onSelect: selectAnimationTarget,
    onStatus: message => { notice.textContent = message; },
  });
  workspace.registerPanel("joint-settings", "Joint Settings", jointSettingsPanel.element);
  rotationPanel = createRotationPanel(store, {
    available: () => !loading && !dragId && !playing,
    getSelection: allSelection,
    onStatus: message => { notice.textContent = message; },
  });
  workspace.registerPanel("rotation-curves", "Rotation Curves", rotationPanel.element);
  animationLayersPanel = createAnimationLayersPanel(store, {
    available: () => !loading && !dragId && !playing,
    onActiveChange: () => { clearPoseDraft(); updateTime(); },
    onStatus: message => { notice.textContent = message; },
  });
  workspace.registerPanel("animation-layers", "Animation Layers", animationLayersPanel.element);
  jointMirrorPanel = createJointMirrorPanel(store, {
    available: () => !loading && !dragId && !playing,
    getSelection: allSelection, getFKPoses: () => fkPoses, getFrame,
    canKey: () => !timelinePanel?.turntable,
    onSelect: selectAnimationTarget,
    preserveDrafts: preserveUnconsumedDrafts,
  });
  workspace.registerPanel("joint-mirror", "Mirror Joints / Pose", jointMirrorPanel.element);
  bindJointMirrorControls([
    ...Array.from(document.querySelectorAll<WaButton>("[data-rig-action='Mirror joints']")),
    ...Array.from(riggingPanel.querySelectorAll<WaButton>("[data-rig-action='Mirror joints']")),
  ], () => {
    jointMirrorPanel?.useSelection();
    element("view-joint-mirror").click();
  });
  ikPanel.element.addEventListener("ik-range-bake", event => {
    ikBakePanel?.selectHandle((event as CustomEvent<string>).detail);
    element("view-ik-bake").click();
  });
  function selectIKTarget(id: string, kind: IKControlKind = "target") {
    if (loading || dragId || !ikTargets.getObject(id, kind)) return;
    selectedIKBlendId = "";
    setPlaying(false);
    skinWeightsPanel?.stopPicking(); skinPaintPanel?.stopPainting();
    modelingPanel?.stopEditing();
    const handle = store.getState().document.ikHandles?.find(handle => handle.id === id);
    const control = kind === "pole" ? handle?.poleControl : handle?.targetControl;
    if (control) {
      selectObjects([control.objectId]); ikPanel?.select(id); choose("translate");
      element("view-ik-handles").click(); return;
    }
    selected.clear(); skeleton.select("");
    selectedIKId = id; selectedIKKind = kind; ikTargets.setSelected(id, kind); ikPanel?.select(id);
    choose("translate"); refreshSelection();
    element("view-ik-handles").click();
  }
  ikPanel.element.addEventListener("ik-target-select", event => selectIKTarget((event as CustomEvent<string>).detail));
  ikPanel.element.addEventListener("ik-pole-select", event => selectIKTarget((event as CustomEvent<string>).detail, "pole"));
  function selectAnimationTarget(id: string) {
    if (loading || dragId) return;
    const doc = store.getState().document;
    if (doc.ikHandles?.some(handle => handle.id === id)) {
      setPlaying(false); modelingPanel?.stopEditing(); selected.clear(); skeleton.select("");
      selectedIKId = ""; selectedIKBlendId = id; ikPanel?.select(id); choose("select"); refreshSelection();
    } else if (doc.joints?.some(joint => joint.id === id)) {
      selected.clear(); skeleton.select(id);
    } else selectObjects([id]);
  }
  ikPanel.element.addEventListener("ik-blend-select", event => selectAnimationTarget((event as CustomEvent<string>).detail));
  ikPanel.element.addEventListener("ik-blend-curve", event => {
    const id = (event as CustomEvent<string>).detail;
    const track = editingTracks(store.getState().document).find(track => track.targetId === id && track.channel === "ik.blend");
    if (!track) return;
    selectAnimationTarget(id); animationEditors?.focusTrack(track.id); element("view-graph").click();
  });
  ikPanel.element.addEventListener("ik-control-created", event => {
    modelingPanel?.stopEditing(); selectObjects([(event as CustomEvent<string>).detail]); choose("translate");
  });
  workspace.registerPanel("constraints", "Constraints", constraintsPanel.element);
  workspace.registerPanel("controllers", "Curve Controls", controllerPanel.element);
  for (const control of Array.from(document.querySelectorAll<WaButton>("[data-rig-action]"))) {
    if (control.dataset.rigAction === "Pole target") {
      control.disabled = false; control.title = "Open two-bone pole target controls";
      control.addEventListener("click", () => {
        if (selectedIKId && ikTargets.getObject(selectedIKId, "pole")) selectIKTarget(selectedIKId, "pole");
        else element("view-ik-handles").click();
      });
    }
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
  skinWeightsPanel = createSkinWeightsPanel(store, {
    getInfluenceRestMatrix: (shapeId, jointId) => {
      const shape = store.getState().document.nodes[shapeId];
      const object = shape?.parentId ? runtime.get(shape.parentId) : undefined;
      const bone = skeleton.boneMatrix(jointId);
      if (!object || object.kind !== "splat" || !bone) throw Error("Load the splat and joint before adding an influence.");
      object.mesh.updateWorldMatrix(true, false);
      if (Math.abs(object.mesh.matrixWorld.determinant()) < 1e-12) throw Error("The splat transform is singular.");
      return object.mesh.matrixWorld.clone().invert().multiply(bone).toArray();
    },
    available: () => !loading && !dragId && !playing,
    getSelection: allSelection,
    getComponents: shapeId => {
      const entry = bindings.get(shapeId);
      return entry ? { count: entry.skin.componentCount, getWeights: entry.skin.getWeights } : undefined;
    },
    onPreview: preview => { weightPreview = preview; if (!preview) weightOverlay.clear(); else updateWeightPreview(); },
    onPickMode: shapeId => {
      if (componentPickShape === shapeId) return;
      if (shapeId) skinPaintPanel?.stopPainting();
      if (shapeId) modelingPanel?.stopEditing();
      cancelComponentScan(); componentPickShape = shapeId;
      webgl.domElement.style.cursor = shapeId ? "crosshair" : "";
      if (shapeId) choose("select"); else refreshGizmo();
    },
  });
  workspace.registerPanel("skin-weights", "Skin Weights", skinWeightsPanel.element);
  skinPaintPanel = createSkinWeightPaintPanel(store, {
    available: () => !loading && !dragId && !playing && !skinPaintTool?.busy,
    getSelection: allSelection,
    getComponents: shapeId => {
      const entry = bindings.get(shapeId);
      return entry ? { count: entry.skin.componentCount, getWeights: entry.skin.getWeights } : undefined;
    },
    onBrushMode: settings => {
      paintSettings = settings;
      if (settings) skinWeightsPanel?.stopPicking();
      if (settings) modelingPanel?.stopEditing();
      skinPaintTool?.setBrush(settings);
      if (settings) choose("select"); else refreshGizmo();
      updateWeightPreview();
    },
  });
  workspace.registerPanel("paint-skin-weights", "Paint Skin Weights", skinPaintPanel.element);
  modelingPanel = createModelingPanel(store, {
    available: () => !loading && !dragId && !playing,
    keepComponentMode: () => !!meshDrag,
    getSelection: allSelection,
    onSelectObject: id => selectObjects([id]),
    onComponentMode: request => {
      if (request) { skinWeightsPanel?.stopPicking(); skinPaintPanel?.stopPainting(); selectedIKId = ""; selectedIKBlendId = ""; ikTargets.setSelected(); }
      meshComponentRequest = request;
      webgl.domElement.style.cursor = request ? "crosshair" : "";
      if (request) choose("select"); else refreshGizmo();
      updateMeshComponentPreview();
    },
    onComponentSelection: (shapeId, mode, ids) => {
      if (meshComponentRequest?.shapeId !== shapeId || meshComponentRequest.mode !== mode) return;
      meshComponentIds = [...ids]; updateMeshComponentPreview(); refreshGizmo();
    },
  });
  workspace.registerPanel("modeling", "Mesh Tools", modelingPanel.element);
  particlePanel = createParticlePanel(store, {
    available: () => !loading && !dragId && !playing,
    getSelection: allSelection,
    onSelectObject: id => selectObjects([id]),
    getRuntimeStatus: shapeId => {
      const shape = store.getState().document.nodes[shapeId], object = shape && runtime.get(shape.parentId!);
      return object?.kind === "particle" ? object.particles.status : undefined;
    },
  });
  workspace.registerPanel("particles", "Particle Emitters", particlePanel.element);
  for (const control of new Set([...Array.from(document.querySelectorAll<WaButton>("[data-rig-action='Paint weights']")),
    ...Array.from(riggingPanel.querySelectorAll<WaButton>("[data-rig-action='Paint weights']"))])) {
    control.disabled = false; control.title = "Open Paint Skin Weights";
    control.addEventListener("click", () => element("view-paint-skin-weights").click());
  }
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
      orientationControl.disabled = true;
      if (meshComponentRequest && transform.object === meshComponentProxy) {
        try {
          const document = store.getState().document, shape = document.nodes[meshComponentRequest.shapeId];
          const object = shape?.type === "meshShape" ? runtime.get(shape.parentId) : undefined;
          if (shape?.type !== "meshShape" || object?.kind !== "mesh") throw Error("The selected mesh no longer exists.");
          object.mesh.updateWorldMatrix(true, false); meshComponentProxy.updateMatrixWorld(true);
          meshDrag = { document, shape, object,
            snapshot: captureMeshComponentTransform(shape, meshComponentRequest.mode, meshComponentIds, object.mesh.matrixWorld),
            startInverse: meshComponentProxy.matrixWorld.clone().invert() };
          dragId = `mesh:${shape.id}`;
        } catch (error) { notice.textContent = (error as Error).message; transform.pointerUp(null); refreshGizmo(); return; }
      } else dragId = selectedIKId ? `ik:${selectedIKId}` : skeleton.selectedId || singleId();
      if (dragId && transform.object === objectPivotProxy) {
        const node = store.getState().document.nodes[dragId]; const object = runtime.get(dragId);
        if (node?.type === "transform" && object) {
          object.root.updateWorldMatrix(true, false);
          objectDrag = { id: dragId, document: store.getState().document, node, pose: currentPose(dragId), editingPivot: pivotHeld && currentMode === "translate", inverseWorld: object.root.matrixWorld.clone().invert(), beforeWorld: object.root.matrixWorld.clone(), parentWorld: object.root.parent?.matrixWorld.clone() ?? new THREE.Matrix4(), initialOrientation: objectPivotProxy.quaternion.clone() };
        }
      }
      if(skeleton.selectedId&&currentMode==="rotate")skeleton.beginRotation();
      cancelDrag = false;
      setPlaying(false);
    } else if (dragId) {
      const id = dragId;
      if (objectDrag) {
        const session = objectDrag; objectDrag = undefined; dragId = undefined; dragControlPose = undefined;
        try {
          if (!cancelDrag) {
            if (store.getState().document !== session.document) throw Error("The scene changed during the drag. Try again.");
            if (session.editingPivot) {
              objectPivotProxy.updateWorldMatrix(true, false);
              const pivot = objectPivotProxy.getWorldPosition(new THREE.Vector3()).applyMatrix4(session.inverseWorld).toArray() as Vec3;
              const next = relocateObjectPivot(session.node, session.pose, pivot);
              preserveUnconsumedDrafts([], () => store.setState({ document: { ...session.document, nodes: { ...session.document.nodes, [id]: next } }, editLabel: "Move object pivot" }));
            } else {
              const result = dragTransform(session), channels = result.channels;
              channels.rotation = currentMode === "rotate" ? unwrapEuler(channels.rotation, session.pose.rotation) : session.pose.rotation;
              editPose(id, channels, `${currentMode[0].toUpperCase() + currentMode.slice(1)} object`, result.node);
            }
          }
        } catch (error) { notice.textContent = error instanceof Error ? error.message : String(error); }
        syncScene(); updatePivotMarker(); refreshGizmo(); updateHistoryButtons(); return;
      }
      if (meshDrag) {
        const session = meshDrag;
        meshComponentProxy.updateMatrixWorld(true);
        const delta = meshComponentProxy.matrixWorld.clone().multiply(session.startInverse);
        session.object.polygon.clearPreview(); meshDrag = undefined; dragId = undefined;
        try {
          if (!cancelDrag) {
            if (store.getState().document !== session.document) throw Error("The scene changed during the component drag. Try again.");
            setMeshVertexPositions(store, session.shape.id, session.snapshot.changes(delta),
              currentMode === "rotate" ? "Rotate mesh vertices" : currentMode === "scale" ? "Scale mesh vertices" : "Move mesh vertices");
          }
        } catch (error) { notice.textContent = (error as Error).message; }
        syncScene(); updateMeshComponentPreview(); updateHistoryButtons(); return;
      }
      if (selectedIKId && id === `ik:${selectedIKId}`) {
        const target = ikTargets.getObject(selectedIKId, selectedIKKind)?.position.toArray() as Vec3 | undefined;
        dragId = undefined;
        if (!cancelDrag && target) {
          try { updateIKHandle(store, selectedIKId, selectedIKKind === "pole" ? { poleTarget: target } : { target }); }
          catch (error) { notice.textContent = (error as Error).message; }
        }
        syncScene(); updateHistoryButtons(); return;
      }
      const joint = skeleton.selectedId === id ? skeleton.selectedBone : undefined;
      const jointPosition = joint?.position.toArray() as Vec3 | undefined;
      dragId = undefined;
      dragControlPose = undefined;
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
    if (objectDrag) {
      if (!cancelDrag && !objectDrag.editingPivot) {
        for (let i = 0; i < 3; i++) objectPivotProxy.scale.setComponent(i, Math.max(.001 / objectDrag.pose.scale[i], objectPivotProxy.scale.getComponent(i)));
        const object = runtime.get(objectDrag.id)!, result = dragTransform(objectDrag), channels = result.channels;
        applyObjectPose(object, result.node, channels);
        if (ikInputConstraintTargets(store.getState().document).has(objectDrag.id)) {
          dragControlPose = { id: objectDrag.id, pose: { ...objectDrag.pose, ...channels }, node: result.node };
          applyAnimationPose();
        }
        updateBindings(); updatePanel(channels);
      }
      return;
    }
    if (meshDrag) {
      if (cancelDrag) return;
      try {
        if (store.getState().document !== meshDrag.document) throw Error("The scene changed during the component drag. Try again.");
        meshComponentProxy.updateMatrixWorld(true);
        const changes = meshDrag.snapshot.changes(meshComponentProxy.matrixWorld.clone().multiply(meshDrag.startInverse));
        meshDrag.previewShape = meshDrag.object.polygon.previewVertices(changes);
        updateMeshComponentPreview();
      } catch (error) { notice.textContent = (error as Error).message; }
      return;
    }
    if (selectedIKId) { applyAnimationPose(); updateBindings(); return; }
    if (skeleton.selectedId) {
      if(dragId&&currentMode==="rotate")skeleton.previewRotation();
      skeleton.preview(); updateBindings();
      const bone = skeleton.selectedBone!, channels = readChannels(bone);
      const joint = store.getState().document.joints?.find(joint => joint.id === skeleton.selectedId);
      if (joint) channels.rotation = jointRotationFromQuaternion(joint, bone.quaternion, currentPose(joint.id).rotation);
      updatePanel(channels); return;
    }
    const id = singleId(),
      object = id ? runtime.get(id) : undefined;
    if (!object) return;
    object.root.scale.clampScalar(0.001, Number.MAX_VALUE);
    if (dragId === id && ikInputConstraintTargets(store.getState().document).has(id!)) {
      const previous = currentPose(id!), channels = readChannels(object.root);
      channels.rotation = currentMode === "rotate" ? unwrapEuler(channels.rotation, previous.rotation) : previous.rotation;
      dragControlPose = { id: id!, pose: { ...previous, ...channels } };
      applyAnimationPose(); updateBindings(); ikPanel?.refresh();
    }
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
    controls.maxDistance=Infinity; controls.minZoom=1e-12; controls.maxZoom=1e12;
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
    if(kind==="gizmos"){gizmosVisible=visible;for(const [id,object]of runtime)object.box.visible=visible&&selected.has(id);updateWeightPreview();skinPaintTool?.refresh();updateMeshComponentPreview();}
    refreshGizmo();
  },switchView,()=>{switchView("perspective");fitView();});
  viewportTools.setView(activeView);
  element("reset").parentElement!.hidden=true;
  function fitView() {
    world.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    const document = store.getState().document;
    const ids = new Set(selected.size ? selected : skeleton.selectedIds.size ? [] : document.rootIds);
    let expanded = true;
    while (expanded) { expanded = false; for (const node of transformNodes(document)) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); expanded = true; } }
    for (const id of skeleton.selectedIds) {
      const matrix = skeleton.boneMatrix(id); if (matrix) bounds.expandByPoint(new THREE.Vector3().setFromMatrixPosition(matrix));
    }
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
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-20) direction.copy(viewDirections[activeView]);
    const damping = controls.enableDamping; controls.enableDamping = false; controls.update();
    camera.position
      .copy(direction)
      .normalize()
      .multiplyScalar(distance)
      .add(sphere.center);
    camera.near = Math.max(radius / 1000, 0.0001);
    camera.far = Math.max(distance * 50, 100);
    if(camera===orthographic){orthographic.zoom=1;orthographic.top=radius*1.15/Math.min(1,perspective.aspect);orthographic.bottom=-orthographic.top;resizeProjection();}
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.minDistance = radius * 0.15;
    controls.maxDistance = Infinity;
    controls.update(); controls.enableDamping = damping;
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
    { x: number; y: number; id: number; additive: boolean; subtract: boolean; component?: string;
      mesh?: { request: NonNullable<typeof meshComponentRequest>; document: SceneDocument; poseVersion: number;
        camera: THREE.Camera; world: THREE.Matrix4; projection: THREE.Matrix4; rect: DOMRect } } | undefined;
  function cancelSelection() {
    gesture = undefined;
    marquee.hidden = true;
    controls.enabled = !transform.dragging;
  }
  function pickPolygonComponents(start: NonNullable<typeof gesture>, event: PointerEvent) {
    const snapshot = start.mesh!;
    world.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const rect = webgl.domElement.getBoundingClientRect();
    if (snapshot.request !== meshComponentRequest || snapshot.document !== store.getState().document
      || snapshot.poseVersion !== skinPoseVersion || playing || loading || dragId || snapshot.camera !== camera
      || !snapshot.world.equals(camera.matrixWorld) || !snapshot.projection.equals(camera.projectionMatrix)
      || ["x", "y", "width", "height"].some(key => rect[key as keyof DOMRect] !== snapshot.rect[key as keyof DOMRect])) {
      notice.textContent = "Component selection canceled because the scene or view changed."; return;
    }
    const { shapeId, mode } = snapshot.request, shape = store.getState().document.nodes[shapeId];
    const object = shape?.type === "meshShape" ? runtime.get(shape.parentId) : undefined;
    if (shape?.type !== "meshShape" || object?.kind !== "mesh") return;
    for (let parent: THREE.Object3D | null = object.mesh; parent; parent = parent.parent) if (!parent.visible) return;
    try {
      const hit = pickMeshComponents({ shape, mesh: object.mesh, triangleFaceIds: object.polygon.triangleFaceIds,
        camera, width: rect.width, height: rect.height, mode,
        start: { x: start.x - rect.left, y: start.y - rect.top }, end: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
      const hits = new Set(hit);
      const ids = start.subtract ? meshComponentIds.filter(id => !hits.has(id))
        : start.additive ? [...new Set([...meshComponentIds, ...hit])] : hit;
      if (ids.length > 20_000) throw Error("Select at most 20,000 mesh components.");
      modelingPanel?.setComponentSelection(shapeId, mode, ids);
      notice.textContent = `${ids.length.toLocaleString()} ${mode} components selected. Edit them in Mesh Tools.`;
    } catch (error) { notice.textContent = error instanceof Error ? error.message : String(error); }
  }
  async function pickSkinComponents(start: NonNullable<typeof gesture>, event: PointerEvent) {
    const shapeId = start.component!, entry = bindings.get(shapeId);
    if (!entry || componentPickShape !== shapeId || playing || loading || dragId) return;
    for (let parent: THREE.Object3D | null = entry.mesh; parent; parent = parent.parent) {
      if (!parent.visible) { notice.textContent = "The component object is hidden."; return; }
    }
    world.updateMatrixWorld(true); camera.updateWorldMatrix(true, false);
    const rect = webgl.domElement.getBoundingClientRect(), cameraRef = camera;
    const cameraWorld = camera.matrixWorld.clone(), projection = camera.projectionMatrix.clone(), meshWorld = entry.mesh.matrixWorld.clone();
    const documentRef = store.getState().document, poseVersion = skinPoseVersion;
    const epoch = ++componentPickEpoch; pendingComponentPick = epoch;
    const cancelled = () => {
      const current = webgl.domElement.getBoundingClientRect();
      return epoch !== componentPickEpoch || componentPickShape !== shapeId || playing || loading || !!dragId
        || documentRef !== store.getState().document || poseVersion !== skinPoseVersion || bindings.get(shapeId)?.skin !== entry.skin
        || camera !== cameraRef || !camera.matrixWorld.equals(cameraWorld) || !camera.projectionMatrix.equals(projection)
        || !entry.mesh.matrixWorld.equals(meshWorld) || current.width !== rect.width || current.height !== rect.height
        || current.left !== rect.left || current.top !== rect.top;
    };
    notice.textContent = "Selecting components… Esc cancels.";
    let lastYield = performance.now();
    try {
      const indices = await pickProjectedComponents({
        componentCount: entry.skin.componentCount,
        readPositions: (offset, count) => entry.skin.getComponentPositions(Array.from({ length: count }, (_, index) => offset + index)),
        matrixWorld: meshWorld, camera: cameraRef, width: rect.width, height: rect.height,
        start: { x: start.x - rect.left, y: start.y - rect.top },
        end: { x: event.clientX - rect.left, y: event.clientY - rect.top }, cancelled,
        yieldTask: async () => {
          if (performance.now() - lastYield < 8) return;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          lastYield = performance.now();
        },
      });
      if (cancelled()) throw new DOMException("Component selection canceled.", "AbortError");
      skinWeightsPanel?.setComponentSelection(shapeId, indices, start.subtract ? "subtract" : start.additive ? "add" : "replace");
      notice.textContent = `${skinWeightsPanel?.getComponentSelection().length.toLocaleString() ?? 0} skin components selected. Edit their weights in Skin Weights.`;
    } catch (error) {
      if (epoch === componentPickEpoch) notice.textContent = (error as Error).name === "AbortError"
        ? "Component selection canceled because the scene or view changed." : (error as Error).message;
    } finally { if (pendingComponentPick === epoch) pendingComponentPick = undefined; }
  }
  webgl.domElement.addEventListener(
    "wheel",
    () => {
      cancelComponentScan(); cancelSelection();
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
    cancelComponentScan();
    camera.updateMatrixWorld(true);
    gesture = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      additive: event.shiftKey,
      subtract: event.ctrlKey || event.metaKey,
      component: componentPickShape,
      mesh: meshComponentRequest ? { request: meshComponentRequest, document: store.getState().document,
        poseVersion: skinPoseVersion, camera, world: camera.matrixWorld.clone(), projection: camera.projectionMatrix.clone(),
        rect: webgl.domElement.getBoundingClientRect() } : undefined,
    };
    webgl.domElement.setPointerCapture(event.pointerId);
  });
  webgl.domElement.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (event.altKey) {
      cancelComponentScan();
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
    if (start.mesh) { pickPolygonComponents(start, event); return; }
    if (start.component) { void pickSkinComponents(start, event); return; }
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
      const height = camera === orthographic ? (orthographic.top - orthographic.bottom) / orthographic.zoom
        : 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2));
      raycaster.params.Line.threshold = Math.max(0.001, height * 6 / Math.max(1, rect.height));
      const targetHit = ikTargets.pickControl(raycaster);
      if (targetHit) { selectIKTarget(targetHit.id, targetHit.kind); return; }
      const jointHit = skeleton.pick(raycaster);
      if (jointHit) { if (!start.additive) selected.clear(); skeleton.selectMany([jointHit], start.additive); return; }
      // Emitter markers draw above surfaces, so pick them with the same priority.
      const emitterHit = gizmosVisible ? objects.filter(({ object }) => object.kind === "particle")
        .map(({ id, object }) => ({ id, distance: raycaster.intersectObject(object.mesh, false)[0]?.distance ?? Infinity }))
        .filter(hit => Number.isFinite(hit.distance)).sort((a, b) => a.distance - b.distance)[0] : undefined;
      if (emitterHit) { selectObjects([emitterHit.id], start.additive); return; }
      const hits=objects.filter(({object})=>object.kind!=="particle").map(({id,object})=>({id,distance:boundSelection(object)?.pick(raycaster)??raycaster.intersectObject(object.mesh,false)[0]?.distance??Infinity})).filter(h=>Number.isFinite(h.distance)).sort((a,b)=>a.distance-b.distance);
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
    cancelComponentScan();
    abortDrag();
    cancelSelection();
  });
  webgl.domElement.addEventListener("lostpointercapture", () => { if (gesture?.component) cancelComponentScan(); cancelSelection(); });
  window.addEventListener("blur", () => {
    pivotHeld = false;
    ikPanel?.cancelPreview();
    cancelComponentScan();
    abortDrag();
    cancelSelection();
  });
  window.addEventListener("keyup", (event) => {
    if (event.key.toLowerCase() === "d") { pivotHeld = false; if (!dragId) { refreshGizmo(); updatePivotMarker(); } }
    if (event.key === "Alt" && !dragId) refreshGizmo();
  });
  // A long scan must remain cancellable even if focus moves into an editor field.
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || pendingComponentPick === undefined) return;
    cancelComponentScan(); cancelSelection(); skinWeightsPanel?.stopPicking();
  }, true);
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
    const key = event.key.toLowerCase();
    if (key === "escape" && meshDrag) { event.preventDefault(); abortDrag(); return; }
    if (key === "escape" && meshComponentRequest) { event.preventDefault(); cancelSelection(); modelingPanel?.stopEditing(); return; }
    if (key === "escape" && paintSettings) { event.preventDefault(); skinPaintPanel?.stopPainting(); return; }
    if (key === "escape" && (componentPickShape || pendingComponentPick !== undefined || gesture?.component)) {
      event.preventDefault(); cancelComponentScan(); cancelSelection(); skinWeightsPanel?.stopPicking(); return;
    }
    if (key === "escape" && objectDrag) { event.preventDefault(); abortDrag(); return; }
    const editing = isEditing(event);
    if (editing) return; // Preserve native text editing undo inside fields.
    if (meshComponentRequest && ["delete", "backspace"].includes(key)) {
      event.preventDefault();
      if (event.repeat || event.altKey || loading || dragId || playing) return;
      if (event.ctrlKey || event.metaKey) notice.textContent = "Use Delete to dissolve edges. Deleting associated vertices is not supported yet.";
      else if (!modelingPanel?.deleteSelectedComponents()) notice.textContent = "Switch to Edge or Face mode to delete components.";
      return;
    }
    if ((componentPickShape || paintSettings || meshComponentRequest) && ["delete", "s"].includes(key) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); notice.textContent = "Exit component editing before deleting or keying an object."; return;
    }
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
    if (key === "d" && currentMode === "translate" && singleId() && !skeleton.selectedIds.size && !loading && !playing && !dragId && !meshComponentRequest && !componentPickShape && !paintSettings) { event.preventDefault(); pivotHeld = true; refreshGizmo(); updatePivotMarker(); return; }
    if (key === "f" && !loading && !dragId) { event.preventDefault(); fitView(); return; }
    if (key === "s") { event.preventDefault(); keySelection(); return; }
    if (key === " ") { event.preventDefault(); if (!loading && !dragId) setPlaying(!playing); return; }
    if (key === "," || key === ".") { event.preventDefault(); setFrame(getFrame() + (key === "," ? -1 : 1)); return; }
    if (key === "delete") {
      if (loading || dragId) return;
      event.preventDefault();
      if (selectedIKId || selectedIKBlendId) { deleteIKHandle(store, selectedIKId || selectedIKBlendId); return; }
      const ids = new Set([...selected, ...skeleton.selectedIds]);
      if (!ids.size) return;
      setPlaying(false);
      const doc = store.getState().document;
      let targets: ReturnType<typeof getIKTargetPoints> | undefined;
      try { targets = getIKTargetPoints(doc, evaluated); } catch { /* Invalid previews fall back to stored targets. */ }
      store.setState({ document: deleteSceneItems(doc, ids, targets), editLabel: "Delete selection" });
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
      skinPaintPanel?.stopPainting();
      modelingPanel?.stopEditing();
      clearPoseDraft();
      const settings = animationSettings();
      if (!timelinePanel?.turntable && getFrame() >= settings.end) time = settings.start / settings.fps;
    }
    playing = value;
    buttonContent(play, value ? "pause" : "play");
    play.setAttribute(
      "aria-label",
      value ? "Pause animation" : "Play animation",
    );
    animationEditors?.refresh();
    drivenPanel?.refresh();
    ikPanel?.refresh();
    constraintsPanel?.refresh();
    controllerPanel?.refresh();
    ikBakePanel?.refresh();
    skinWeightsPanel?.refresh();
    jointSettingsPanel?.refresh();
    rotationPanel?.refresh();
    animationLayersPanel?.refresh();
    jointMirrorPanel?.refresh();
    skinPaintPanel?.refresh();
    modelingPanel?.refresh();
    updateWeightPreview();
    particlePanel?.refresh();
    channelKeys?.refresh();
  }
  function applyAnimationPose() {
    const draggingTarget = !!selectedIKId && dragId === `ik:${selectedIKId}`;
    if (dragId && !draggingTarget && !dragControlPose) return;
    let doc = store.getState().document;
    if (dragControlPose?.node) doc = { ...doc, nodes: { ...doc.nodes, [dragControlPose.id]: dragControlPose.node } };
    if (blendPreview && doc.ikHandles?.some(handle => handle.id === blendPreview!.id))
      doc = keyChannels(doc, blendPreview.id, blendPreview.value, getFrame(), false);
    if (draggingTarget) {
      const target = ikTargets.getObject(selectedIKId, selectedIKKind)!.position.toArray() as Vec3;
      const patch = selectedIKKind === "pole" ? { poleTarget: target } : { target };
      doc = { ...doc, ikHandles: doc.ikHandles?.map(handle => handle.id === selectedIKId ? { ...handle, ...patch } : handle) };
    }
    evaluated = evaluateSceneAnimation(doc, getFrame());
    for (const [id, pose] of poseOverrides) if (evaluated.has(id)) evaluated.set(id, applyTransformPoseDraft(evaluated.get(id)!, pose));
    if (dragControlPose) evaluated.set(dragControlPose.id, dragControlPose.pose);
    evaluateDrivenKeys(doc, evaluated);
    drivenPoses = new Map(evaluated);
    fkPoses = new Map(evaluated);
    solvedPoses = new Map(evaluated);
    try {
      const stages = evaluateRigStages(doc, evaluated, true, getFrame());
      fkPoses = stages.fkPoses!; solvedPoses = stages.solvedPoses!;
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
      const node = doc.nodes[id];
      if (node?.type === "transform") applyObjectPose(object, node, pose);
      object.root.visible = !(node?.type === "transform" && node.hidden) && pose.visibility >= .5;
      object.preview.rotation.y = timelinePanel?.turntable ? (time / duration) * Math.PI * 2 : 0;
    }
    skeleton.applyPose(evaluated);
    for (const object of runtime.values()) if (object.kind === "mesh") object.polygon.applySkin(id => skeleton.boneMatrix(id), evaluated.get(object.shape.parentId)?.morphWeights);
    ikTargets.sync(doc, evaluated, getFrame());
    if (!objectDrag && !meshDrag) refreshGizmo();
  }
  function updateTime(apply = true) {
    if (apply) { applyAnimationPose(); updateBindings(); }
    if (meshComponentRequest) refreshGizmo();
    updateParticles();
    timelinePanel?.refresh();
    const turntable = timelinePanel?.turntable;
    timeline.value = turntable ? time : getFrame();
    element<HTMLOutputElement>("time").value = turntable ? `${time.toFixed(2)} / 12.00s` : `${Math.round(getFrame())} / ${animationSettings().end}`;
    updatePanel();
    animationEditors?.refresh();
    if (!playing) drivenPanel?.refresh();
    ikPanel?.refresh();
    constraintsPanel?.refresh();
    particlePanel?.refresh();
    jointSettingsPanel?.refresh();
    rotationPanel?.refresh();
    animationLayersPanel?.refresh();
    jointMirrorPanel?.refresh();
  }
  function updateParticles() {
    if (loading) return;
    const doc = store.getState().document;
    if (particlePoseDoc !== doc) { particlePoseDoc = doc; particlePoseSampler = createParticlePoseSampler(doc); }
    for (const object of runtime.values()) if (object.kind === "particle" && doc.nodes[object.shape.id]?.type === "particleShape") {
      object.particles.request(doc, object.shape, getFrame(), particlePoseSampler!, () => {
        const error = object.particles.status.error;
        if (error) { setPlaying(false); notice.textContent = `Particle simulation: ${error}`; }
        particlePanel?.refresh();
      });
    }
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
    if (value) ikPanel?.cancelPreview();
    loading = value;
    if (value) {
      skinPaintPanel?.stopPainting();
      modelingPanel?.stopEditing();
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
    if (object.kind === "curve") object.controller.dispose();
    else if (object.kind === "mesh") object.polygon.dispose();
    else if (object.kind === "particle") object.particles.dispose();
    else object.mesh.dispose();
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
    selectedIKBlendId = "";
    skinWeightsPanel?.resetScene();
    skinPaintPanel?.resetScene();
    modelingPanel?.resetScene(); meshComponentPreview.clear(); meshComponentIds = [];
    particlePanel?.resetScene(); particlePoseDoc = undefined; particlePoseSampler = undefined;
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
    ikBakePanel?.resetScene();
    jointSettingsPanel?.resetScene();
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
      const bytes = await encodeProjectBlob(doc, assetFiles, editorSnapshot());
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
      const project = await decodeProjectBlob(file);
      for (const node of transformNodes(project.scene)) {
        const emitter = Object.values(project.scene.nodes).find((shape): shape is ParticleShapeNode => shape.type === "particleShape" && shape.parentId === node.id);
        if (emitter) { staged.set(node.id, particleObjectRuntime(emitter)); continue; }
        const polygon = Object.values(project.scene.nodes).find((shape): shape is MeshShapeNode => shape.type === "meshShape" && shape.parentId === node.id);
        if (polygon) { staged.set(node.id, meshRuntime(polygon)); continue; }
        const curve = Object.values(project.scene.nodes).find((shape): shape is CurveShapeNode => shape.type === "curveShape" && shape.parentId === node.id);
        if (curve) { staged.set(node.id, controllerRuntime(curve)); continue; }
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
          if (shape.binding) validateSkinWeightCount(shape.binding, mesh.numSplats);
          const root = new THREE.Group(),
            preview = new THREE.Group(),
            box = new THREE.Box3Helper(new THREE.Box3(), 0x999999);
          preview.add(mesh);
          root.add(preview);
          box.visible = false;
          staged.set(node.id, {
            kind: "splat",
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
      case "about":
        closeFileMenu();
        element<WaDialog>("about-dialog").open = true;
        break;
      case "scene-new":
        void newProject();
        break;
      case "scene-open":
        void openProject();
        break;
      case "open":
        closeFileMenu();
        if (!loading && !dragId) fileInput.click();
        break;
      case "scene-save":
        void saveProject();
        break;
      case "scene-save-as":
        void saveProject(true);
        break;
    }
  });
  element("about-version").textContent = `Version ${packageInfo.version}`;
  element("about-close").addEventListener("click", () => { element<WaDialog>("about-dialog").open = false; });
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
        kind: "splat",
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
  const cubeSplatDialog = createCubeSplatDialog(async (settings, moveAside, budget) => {
    if (loading || dragId || playing) throw Error("Stop playback and finish the current edit before converting.");
    if (selected.size !== 1) throw Error("Select one mesh part in the viewport or Outliner.");
    const doc = store.getState().document, source = conversionMeshShape(doc, [...selected][0]);
    if (!source) throw Error("Select one mesh part in the viewport or Outliner.");
    const sourceNode = doc.nodes[source.parentId];
    if (sourceNode.type !== "transform") throw Error("Cube transform is missing.");
    const pose = currentPose(sourceNode.id);
    let cubeFaces: ReturnType<typeof cubeSplatFaces> | undefined;
    try { cubeFaces = cubeSplatFaces(source); } catch { /* General meshes use triangle sampling. */ }
    busy(true, "Converting mesh to splats...");
    let generated: ReturnType<typeof meshToSplatData>;
    let warnings: string[] = [];
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cubeFaces) generated = { bytes: cubeToSplatBytes(source, settings), binding: undefined };
      else {
        const colors = await createMeshSplatColors(source); warnings = colors.warnings;
        generated = meshToSplatData(source, settings, budget, sample => colors.sampleSurface(sample.vertices, sample.bary, sample.materialIndex));
      }
    } catch (error) { busy(false); throw error; }
    const { bytes, binding } = generated;
    const file = new File([bytes], "mesh.splat"), asset: AssetRecord = { id: crypto.randomUUID(), kind: "file", fileName: file.name, byteLength: file.size };
    let candidate: SplatMesh | undefined;

    try {
      candidate = new SplatMesh({ extSplats: true, covSplats: true, fileBytes: bytes, fileName: file.name });
      const data = await prepareSplat(candidate);
      const added = addSplat(doc, asset, `${sourceNode.name}_splats`, [0, 0, 0]);
      const node = added.document.nodes[added.id] as TransformNode;
      Object.assign(node, { ...sourceNode, ...normalizedChannels(pose), id: added.id, hidden: false, name: uniqueName(doc, `${sourceNode.name}_splats`, sourceNode.parentId) });
      if (moveAside && !binding) {
        const width = new THREE.Box3().setFromPoints(source.vertices.map(v => new THREE.Vector3(...v.position))).getSize(new THREE.Vector3()).x;
        const displacement = new THREE.Vector3(width * 1.5, 0, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(objectLocalMatrix(sourceNode, pose)));
        node.position = pose.position.map((v, axis) => v + displacement.getComponent(axis)) as Vec3;
      }
      const shape = Object.values(added.document.nodes).find((n): n is SplatShapeNode => n.type === "splatShape" && n.parentId === node.id)!;
      shape.binding = binding;
      if (doc.animation) added.document.animation = { ...doc.animation, tracks: [...doc.animation.tracks, ...doc.animation.tracks.filter(t => t.targetId === sourceNode.id && t.channel !== "visibility" && !t.channel.startsWith("morph.")).map(t => ({ ...t, id: crypto.randomUUID(), targetId: node.id, keys: t.keys.map(k => ({ ...k, id: crypto.randomUUID() })) }))] };
      if (node.parentId) added.document.rootIds = added.document.rootIds.filter(id => id !== node.id);
      const root = new THREE.Group(), preview = new THREE.Group(), box = new THREE.Box3Helper(new THREE.Box3(), 0x999999);
      preview.add(candidate); root.add(preview); box.visible = false;
      runtime.set(node.id, { kind: "splat", root, preview, mesh: candidate, box, assetId: asset.id, ...data });
      world.add(box); assetFiles.set(asset.id, file);
      store.setState({ document: added.document, editLabel: "Convert mesh to splats" });
      selectObjects([node.id]); fitView();
      return `Created ${data.count.toLocaleString()} splats. Hide the source in the Outliner to compare. Undo removes the copy. ${binding ? "Skin weights transferred; shares the original skeleton." : ""} ${warnings.join(" ")}`;
    } catch (error) { candidate?.dispose(); throw error; }
    finally { busy(false); }
  });
  element("modeling-menu").addEventListener("wa-select", (event) => {
    if ((event as WaSelectEvent).detail.item.id === "convert-to-splats") cubeSplatDialog.open();
  });
  async function importFBXFile(file: File, sidecars: File[] = []) {
    if (loading || dragId) return;
    busy(true, "Importing FBX meshes, skeletons, and animation…");
    let message = "";
    try {
      // Let the loading message paint before parsing and sampling animation.
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = await importFBX(file, store.getState().document, sidecars);
      clearPoseDraft();
      store.setState({ document: result.document, editLabel: "Import FBX" });
      if (result.objectIds.length) selectObjects(result.objectIds);
      else if (result.jointIds.length) selectAnimationTarget(result.jointIds[0]);
      if (result.clips.length) {
        const mode = document.querySelector<HTMLSelectElement>("select[aria-label='Playback mode']")!;
        mode.value = "animation"; mode.dispatchEvent(new Event("change"));
        time = result.clips[0].start / animationSettings().fps;
      }
      updateTime(); fitView();
      message = `Imported ${file.name}: ${result.objectIds.length} meshes, ${result.jointIds.length} joints, ${result.clips.length} animation clip${result.clips.length === 1 ? "" : "s"}.`;
      for (const clip of result.clips) terminal.log(`${clip.name}: frames ${clip.start}–${clip.end}`);
      if (result.warnings.length) message += ` ${result.warnings.join(" ")}`;
      element("file-status").textContent = message;
      message = "";
    } catch (error) {
      message = `Could not import FBX. ${error instanceof Error ? error.message : String(error)}`;
    } finally { busy(false, message); }
  }
  function importFiles(files: File[]) {
    if (loading || dragId || dialogOpen()) return;
    const projects = files.filter(f => /\.msb$/i.test(f.name));
    const models = files.filter(f => /\.fbx$/i.test(f.name));
    if (projects.length) {
      if (projects.length !== 1 || files.length !== 1) { notice.textContent = "Drop one MSB project at a time. FBX files and their textures can be dropped together."; return; }
      void loadProject(projects[0]); return;
    }
    const splats = files.filter(f => /\.(ply|spz|splat|ksplat|sog)$/i.test(f.name));
    if (models.length + splats.length > 1) { notice.textContent = "Import one model at a time. Select texture images together with their FBX."; return; }
    const file = files.find(f => /\.fbx$/i.test(f.name)) ?? files[0];
    if (!file || loading) return;
    if (!/\.(fbx|ply|spz|splat|ksplat|sog)$/i.test(file.name)) { notice.textContent = "Import an FBX, MSB, or supported splat file. Select texture images together with their FBX."; return; }
    if (/\.fbx$/i.test(file.name)) { void importFBXFile(file, files.filter(f => f !== file)); return; }
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
  }
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []); fileInput.value = ""; importFiles(files);
  });
  mountViewportFileDrop(viewport, importFiles);
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
  skinPaintTool = createSkinWeightPaintTool(webgl.domElement, viewport, {
    available: () => !loading && !playing && !dragId,
    showPreview: () => gizmosVisible,
    getCamera: () => camera,
    getRevision: () => skinPoseVersion,
    getContext: shapeId => {
      const entry = bindings.get(shapeId);
      return entry ? { identity: entry.skin, mesh: entry.mesh, count: entry.skin.componentCount,
        getWeights: entry.skin.getWeights, getPositions: entry.skin.getComponentPositions } : undefined;
    },
    commit: (settings, values, context) => editSkinWeightValues(store, settings.shapeId, values, settings.jointId,
      { count: context.count, getWeights: context.getWeights }),
    onBusyChange: () => skinPaintPanel?.refresh(),
    onMessage: message => { notice.textContent = message; },
  });
  webgl.domElement.addEventListener("webglcontextlost", (event) => {
    skinPaintPanel?.stopPainting();
    modelingPanel?.stopEditing();
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
    updatePivotMarker();
    const cameraDistance = camera.position.distanceTo(controls.target);
    const far = Math.max(1000, cameraDistance * 100);
    if (Math.abs(camera.far - far) > far * .1) { camera.far = far; camera.updateProjectionMatrix(); }
    const drawingHeight = webgl.domElement.height;
    for (const object of runtime.values()) if (object.kind === "particle" && object.root.parent) {
      object.root.updateWorldMatrix(true, false);
      object.particles.setWorldTransform(object.root.matrixWorld);
      object.particles.setViewport(drawingHeight, maximumParticlePointSize);
      object.particles.setMarkerVisible(gizmosVisible);
    }
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
