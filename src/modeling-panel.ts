import { createMeshPrimitive, findMeshShape, meshEdges, setMeshVertexPositions, updateMeshAppearance, extrudeMeshFaces, deleteMeshFaces } from "./mesh-modeling.ts";
import type { MeshShapeNode, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

export type MeshComponentMode = "vertex" | "edge" | "face";
type Options = {
  available: () => boolean;
  getSelection: () => string[];
  onSelectObject: (id: string) => void;
  onComponentMode: (request: { shapeId: string; mode: MeshComponentMode } | undefined) => void;
  onComponentSelection: (shapeId: string, mode: MeshComponentMode, ids: string[]) => void;
};

/** Modeling UI uses the same validated commands as viewport tools. Selection is runtime state. */
export function createModelingPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "modeling-panel"; element.setAttribute("aria-label", "Polygon Modeling");
  const style = document.createElement("style");
  style.textContent = `.modeling-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .modeling-panel p{line-height:1.5;color:var(--muted)}.modeling-panel fieldset{margin:0 0 12px;padding:10px;min-width:0;border:1px solid var(--line)}.modeling-panel legend{padding:0 5px}
    .modeling-panel label{display:grid;gap:5px;margin:8px 0}.modeling-panel input,.modeling-panel select,.modeling-panel textarea,.modeling-panel button{font:inherit;padding:6px;min-width:0;border:1px solid var(--line);border-radius:3px;background:var(--bg);color:var(--text);box-sizing:border-box}
    .modeling-panel input:not([type=checkbox]),.modeling-panel select,.modeling-panel textarea{width:100%}.modeling-panel textarea{font:11px monospace;resize:vertical}.modeling-panel button{cursor:pointer}.modeling-panel button:hover:not(:disabled){background:var(--hover)}.modeling-panel :disabled{opacity:.45;cursor:default}
    .modeling-panel :focus-visible{outline:1px solid var(--strong)}.modeling-panel .modeling-xyz{display:grid;grid-template-columns:repeat(3,minmax(40px,1fr));gap:6px}.modeling-panel .modeling-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
    .modeling-panel .modeling-check{display:flex;gap:7px;align-items:center}.modeling-panel .modeling-status{min-height:20px;overflow-wrap:anywhere}.modeling-panel .modeling-status[data-error=true]{color:#ce756a}`;
  function label(text: string, control: HTMLElement) { const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node; }
  function group(text: string) { const node = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = text; node.append(legend); return node; }
  function select(name: string) { const node = document.createElement("select"); node.setAttribute("aria-label", name); return node; }
  function number(name: string, value = "0") { const node = document.createElement("input"); node.type = "number"; node.step = "any"; node.value = value; node.setAttribute("aria-label", name); return node; }
  function button(text: string, action: () => void) { const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = action; return node; }
  function axes(title: string) {
    const row = document.createElement("div"); row.className = "modeling-xyz";
    const inputs = ["X", "Y", "Z"].map(axis => number(`${title} ${axis}`)); inputs.forEach((input, index) => row.append(label("XYZ"[index], input))); return { row, inputs };
  }
  const status = document.createElement("p"); status.className = "modeling-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  let shapeId = "", selectedIds: string[] = [], selectionSignature = "", objectSignature = "", componentSignature = "", modeSignature = "", emittedSelection = "", displayedVertex = "";
  let primitiveSize = 1, primitiveName = "", offset: Vec3 = [0, 0, 0], extrudeDistance = 0.25;
  let cachedShape: MeshShapeNode | undefined;
  let cachedEdges: ReturnType<typeof meshEdges> = [];
  let cachedRows: Record<MeshComponentMode, { id: string; text: string }[]> = { vertex: [], edge: [], face: [] };
  const creation = group("Create Primitive"), primitive = select("Mesh primitive");
  for (const value of ["cube", "plane", "sphere", "cylinder"]) primitive.add(new Option(value[0].toUpperCase() + value.slice(1), value));
  const name = document.createElement("input"); name.type = "text"; name.maxLength = 100; name.value = primitiveName; name.placeholder = "Use primitive name"; name.setAttribute("aria-label", "New mesh name");
  const size = number("Mesh primitive size", "1"); size.min = "0.000001"; size.max = "1000000";
  const create = button("Create mesh primitive", () => run(() => {
    const id = createMeshPrimitive(store, primitive.value as "cube" | "plane" | "sphere" | "cylinder", { name: primitiveName || undefined, size: primitiveSize });
    const shape = findMeshShape(store.getState().document, id); stopEditing(); shapeId = shape?.id ?? ""; options.onSelectObject(id);
  }, "Mesh created at the origin."));
  creation.append(label("Primitive", primitive), label("Name", name), label("Size", size), create);
  const objects = select("Editable mesh object"), empty = document.createElement("p"); empty.textContent = "Create a polygon mesh or select one in the Outliner.";
  const components = group("Components"), mode = select("Mesh selection mode");
  for (const value of ["object", "vertex", "edge", "face"]) mode.add(new Option(value[0].toUpperCase() + value.slice(1), value));
  const summary = document.createElement("p"), picker = select("Mesh component");
  const replace = button("Select component", () => choose(false)), add = button("Add component", () => choose(true));
  const clear = button("Clear component selection", () => run(() => { selectedIds = []; }));
  const selectionActions = document.createElement("div"); selectionActions.className = "modeling-actions"; selectionActions.append(replace, add, clear);
  const ids = document.createElement("textarea"); ids.rows = 3; ids.readOnly = true; ids.setAttribute("aria-label", "Selected mesh component IDs");
  const idDetails = document.createElement("details"), idSummary = document.createElement("summary"); idSummary.textContent = "Component IDs"; idDetails.append(idSummary, ids);
  const cap = document.createElement("p");
  const absolute = axes("Vertex local position"), absoluteGroup = document.createElement("div"), absoluteTitle = document.createElement("p"); absoluteTitle.textContent = "Single vertex · absolute local position"; absoluteGroup.append(absoluteTitle, absolute.row);
  const delta = axes("Component local offset"), deltaTitle = document.createElement("p"); deltaTitle.textContent = "Selected components · local offset";
  const applyOffset = button("Apply offset", () => run(() => {
    const shape = requiredShape(), affected = selectedVertices(shape);
    if (!affected.size) throw Error("Select vertices, edges, or faces before applying an offset.");
    setMeshVertexPositions(store, shape.id, shape.vertices.filter(vertex => affected.has(vertex.id)).map(vertex => ({ id: vertex.id, position: vertex.position.map((value, axis) => value + offset[axis]) as Vec3 })));
  }, "Offset applied to each selected vertex once."));
  const distance = number("Face extrusion distance", "0.25"), faceActions = document.createElement("div"); distance.min = "-1000000"; distance.max = "1000000";
  const extrude = button("Extrude selected faces", () => run(() => {
    const shape = requiredShape(); requireFaces(); const next = extrudeMeshFaces(store, shape.id, [...selectedIds], extrudeDistance); selectedIds = [...next];
  }, "Faces extruded. New top faces selected."));
  const remove = button("Delete selected faces", () => run(() => { const shape = requiredShape(); requireFaces(); deleteMeshFaces(store, shape.id, [...selectedIds]); selectedIds = []; }, "Selected faces deleted."));
  const faceButtons = document.createElement("div"); faceButtons.className = "modeling-actions"; faceButtons.append(extrude, remove);
  const extrusionHelp = document.createElement("p"); extrusionHelp.textContent = "Extrude one edge-connected face region along its average local normal. Use a nonzero distance within ±1,000,000. A closed whole-mesh selection has no boundary and cannot be extruded. Invalid topology is rejected without a partial edit.";
  faceActions.append(label("Extrude distance · local units", distance), faceButtons, extrusionHelp);
  const componentHelp = document.createElement("p"); componentHelp.textContent = "Choose a component mode to edit in the viewport or select IDs here. Offsets move the unique vertices belonging to the selected components in mesh-local coordinates. Topology and position edits use undo and save with the scene; component selection is temporary.";
  components.append(label("Mode", mode), summary, label("Component", picker), selectionActions, cap, idDetails, absoluteGroup, deltaTitle, delta.row, applyOffset, faceActions, componentHelp);
  const appearance = group("Appearance"), color = document.createElement("input"); color.type = "color"; color.setAttribute("aria-label", "Mesh color");
  const shading = select("Mesh shading"); shading.add(new Option("Flat", "flat")); shading.add(new Option("Smooth", "smooth"));
  const wireframe = document.createElement("input"); wireframe.type = "checkbox"; const wireframeLabel = label("Wireframe", wireframe); wireframeLabel.className = "modeling-check";
  appearance.append(label("Color", color), label("Shading", shading), wireframeLabel);
  element.append(style, creation, label("Mesh object", objects), empty, components, appearance, status);

  function requiredShape(): MeshShapeNode {
    const shape = findMeshShape(store.getState().document, shapeId); if (!shape) throw Error("Choose an editable mesh first."); return shape;
  }
  function componentMode(): MeshComponentMode | undefined { return mode.value === "object" ? undefined : mode.value as MeshComponentMode; }
  function componentRows(shape: MeshShapeNode, kind: MeshComponentMode) {
    if (cachedShape !== shape) {
      cachedShape = shape; cachedEdges = meshEdges(shape);
      const vertexNumbers = new Map(shape.vertices.map((vertex, index) => [vertex.id, index + 1]));
      cachedRows = {
        vertex: shape.vertices.map((vertex, index) => ({ id: vertex.id, text: `Vertex ${index + 1}` })),
        face: shape.faces.map((face, index) => ({ id: face.id, text: `Face ${index + 1} (${face.vertices.length} vertices)` })),
        edge: cachedEdges.map((edge, index) => ({ id: edge.id, text: `Edge ${index + 1} (Vertex ${vertexNumbers.get(edge.vertices[0])}–Vertex ${vertexNumbers.get(edge.vertices[1])})` })),
      };
    }
    return cachedRows[kind];
  }
  function selectedVertices(shape: MeshShapeNode) {
    const selected = new Set(selectedIds), kind = componentMode();
    if (kind === "vertex") return selected;
    if (kind === "edge") return new Set(meshEdges(shape).filter(edge => selected.has(edge.id)).flatMap(edge => edge.vertices));
    if (kind === "face") return new Set(shape.faces.filter(face => selected.has(face.id)).flatMap(face => face.vertices));
    return new Set<string>();
  }
  function requireFaces() { if (componentMode() !== "face" || !selectedIds.length) throw Error("Select faces before using this operation."); }
  function run(action: () => void, message = "") {
    if (!options.available()) { status.textContent = "Pause playback and finish the current operation before editing meshes."; status.dataset.error = "true"; return; }
    try { action(); status.textContent = message; status.dataset.error = "false"; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); status.dataset.error = "true"; }
    refresh();
  }
  function finite(input: HTMLInputElement) { const value = input.valueAsNumber; if (!input.value.trim() || !Number.isFinite(value)) throw Error(`${input.getAttribute("aria-label")} must be a finite number.`); return value; }
  function commit(input: HTMLInputElement, action: () => void) {
    let cancel = false;
    input.addEventListener("blur", () => { if (!cancel) run(action); cancel = false; refresh(); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel = true; input.blur(); }
    });
  }
  commit(size, () => { const next = finite(size); if (next < 0.000001 || next > 1000000) throw Error("Primitive size must be between 0.000001 and 1000000."); primitiveSize = next; });
  commit(name, () => { primitiveName = name.value.trim(); });
  delta.inputs.forEach((input, axis) => commit(input, () => { offset[axis] = finite(input); }));
  commit(distance, () => { extrudeDistance = finite(distance); });
  absolute.inputs.forEach(input => commit(input, () => {
    const shape = requiredShape(); if (componentMode() !== "vertex" || selectedIds.length !== 1) throw Error("Select exactly one vertex to edit its absolute position.");
    setMeshVertexPositions(store, shape.id, [{ id: selectedIds[0], position: absolute.inputs.map(finite) as Vec3 }]);
  }));
  color.onchange = () => run(() => updateMeshAppearance(store, requiredShape().id, { color: color.value }));
  shading.onchange = () => run(() => updateMeshAppearance(store, requiredShape().id, { shading: shading.value as "flat" | "smooth" }));
  wireframe.onchange = () => run(() => updateMeshAppearance(store, requiredShape().id, { wireframe: wireframe.checked }));
  objects.onchange = () => { const next = objects.value; run(() => { stopEditing(); shapeId = next; if (shapeId) options.onSelectObject(requiredShape().parentId); }); };
  mode.onchange = () => run(() => { selectedIds = []; });
  function choose(append: boolean) { run(() => {
    const kind = componentMode(); if (!picker.value || !kind) throw Error("Choose a component first.");
    setComponentSelection(shapeId, kind, append ? [...selectedIds, picker.value] : [picker.value]);
  }); }
  function stopEditing() {
    const oldMode = componentMode(), oldShape = shapeId; mode.value = "object"; selectedIds = [];
    if (modeSignature) { modeSignature = ""; options.onComponentMode(undefined); }
    if (oldMode && oldShape) { emittedSelection = JSON.stringify([oldShape, oldMode, []]); options.onComponentSelection(oldShape, oldMode, []); }
    refresh();
  }
  function resetScene() {
    stopEditing(); shapeId = ""; selectionSignature = JSON.stringify(options.getSelection()); selectedIds = []; componentSignature = ""; displayedVertex = ""; emittedSelection = "";
    offset = [0, 0, 0]; status.textContent = ""; status.dataset.error = "false"; refresh();
  }
  function setComponentSelection(targetShapeId: string, kind: MeshComponentMode, nextIds: string[]) {
    if (!["vertex", "edge", "face"].includes(kind)) throw Error("Unknown mesh component mode.");
    const shape = findMeshShape(store.getState().document, targetShapeId); if (!shape) throw Error("The editable mesh no longer exists.");
    const validIds = new Set(componentRows(shape, kind).map(row => row.id));
    const unique = [...new Set(nextIds)];
    if (unique.length > 20_000) throw Error("Select at most 20,000 mesh components. The previous selection was kept.");
    if (unique.some(id => !validIds.has(id))) throw Error("The component selection is stale. Select components again.");
    shapeId = shape.id; mode.value = kind; selectedIds = unique; refresh();
  }
  function setValue(input: HTMLInputElement, value: string, force = false) { if (force || document.activeElement !== input) input.value = value; }
  function refresh() {
    const doc = store.getState().document, available = options.available(), selection = options.getSelection(), selectionKey = JSON.stringify(selection);
    const shapes = Object.values(doc.nodes).filter((node): node is MeshShapeNode => node.type === "meshShape");
    if (selectionKey !== selectionSignature) {
      selectionSignature = selectionKey; const selected = selection.length === 1 ? findMeshShape(doc, selection[0]) : undefined;
      if (shapeId !== (selected?.id ?? "")) { shapeId = selected?.id ?? ""; selectedIds = []; mode.value = "object"; }
    }
    const objectKey = JSON.stringify(shapes.map(shape => [shape.id, doc.nodes[shape.parentId]?.name ?? shape.name]));
    if (objectKey !== objectSignature) { objectSignature = objectKey; objects.replaceChildren(new Option("Choose an editable mesh", ""), ...shapes.map(shape => new Option(doc.nodes[shape.parentId]?.name ?? shape.name, shape.id))); }
    const shape = shapes.find(candidate => candidate.id === shapeId);
    if (!shape) { shapeId = ""; selectedIds = []; mode.value = "object"; }
    objects.value = shapeId; empty.hidden = !!shape; components.hidden = appearance.hidden = !shape;
    for (const control of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) control.disabled = !available;
    objects.disabled = !available || !shapes.length;
    setValue(name, primitiveName); setValue(size, String(primitiveSize)); setValue(distance, String(extrudeDistance)); delta.inputs.forEach((input, axis) => setValue(input, String(offset[axis])));
    const kind = componentMode(), rows = shape && kind ? componentRows(shape, kind) : [], validIds = new Set(rows.map(row => row.id));
    selectedIds = selectedIds.filter(id => validIds.has(id));
    const nextComponents = JSON.stringify([shapeId, kind, rows]);
    if (nextComponents !== componentSignature) { componentSignature = nextComponents; const previous = picker.value; picker.replaceChildren(...rows.slice(0, 5000).map(row => new Option(row.text, row.id))); if (rows.slice(0, 5000).some(row => row.id === previous)) picker.value = previous; }
    picker.disabled = replace.disabled = add.disabled = !available || !rows.length;
    clear.disabled = !available || !selectedIds.length; ids.value = selectedIds.join("\n");
    cap.textContent = rows.length > 5000 ? "The component menu lists the first 5,000 components. Viewport selection can select other IDs." : "";
    summary.textContent = shape ? `${shape.vertices.length} vertices · ${componentRows(shape, "edge").length} edges · ${shape.faces.length} faces · ${selectedIds.length} selected` : "";
    const singleVertex = shape && kind === "vertex" && selectedIds.length === 1 ? shape.vertices.find(vertex => vertex.id === selectedIds[0]) : undefined;
    absoluteGroup.hidden = !singleVertex;
    const vertexKey = singleVertex ? `${shapeId}/${singleVertex.id}` : "", force = vertexKey !== displayedVertex; displayedVertex = vertexKey;
    absolute.inputs.forEach((input, axis) => { input.disabled = !available || !singleVertex; if (singleVertex) setValue(input, String(singleVertex.position[axis]), force); });
    for (const input of delta.inputs) input.disabled = !available || !kind || !selectedIds.length;
    applyOffset.disabled = !available || !kind || !selectedIds.length;
    faceActions.hidden = kind !== "face"; extrude.disabled = remove.disabled = !available || kind !== "face" || !selectedIds.length;
    if (shape) { setValue(color, shape.color); shading.value = shape.shading; wireframe.checked = shape.wireframe; }
    const nextMode = shape && kind && available ? JSON.stringify([shape.id, kind]) : "";
    if (nextMode !== modeSignature) { modeSignature = nextMode; options.onComponentMode(nextMode ? { shapeId: shape!.id, mode: kind! } : undefined); }
    const nextSelection = shape && kind ? JSON.stringify([shape.id, kind, selectedIds]) : "";
    if (nextSelection !== emittedSelection) { emittedSelection = nextSelection; if (shape && kind) options.onComponentSelection(shape.id, kind, [...selectedIds]); }
  }
  store.subscribe(() => refresh()); refresh();
  return { element, refresh, resetScene, stopEditing, setComponentSelection };
}
