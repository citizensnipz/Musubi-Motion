import type { AnimationPose } from "./animation.ts";
import { createConstraint, deleteConstraint, updateConstraint, type Constraint, type ConstraintType, type SignedAxis } from "./constraints.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = { getPoses: () => Map<string, AnimationPose>; getSelection: () => string[]; available: () => boolean };

export function createConstraintsPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "constraints-panel"; element.setAttribute("aria-label", "Constraints");
  const style = document.createElement("style");
  style.textContent = `.constraints-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .constraints-panel p{line-height:1.5;color:var(--muted)}.constraints-panel label{display:grid;gap:5px;margin:8px 0}
    .constraints-panel select,.constraints-panel button,.constraints-panel input{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
    .constraints-panel select{width:100%}.constraints-panel button{cursor:pointer}.constraints-panel button:hover{background:var(--hover)}.constraints-panel :disabled{opacity:.45;cursor:default}
    .constraints-panel fieldset{min-width:0;border:1px solid var(--line);padding:10px;margin:0 0 12px}.constraints-panel legend{padding:0 5px}
    .constraints-panel .constraint-check{display:flex;align-items:center;gap:7px}.constraints-panel .constraint-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
    .constraints-panel .constraint-status{min-height:20px;white-space:normal}.constraints-panel .constraint-list{display:grid;gap:8px}
    .constraints-panel article{padding:10px;border:1px solid var(--line);border-radius:3px}.constraints-panel article p{margin:6px 0;overflow-wrap:anywhere}
    .constraints-panel h3{font-size:12px;margin:0 0 8px}.constraints-panel .constraint-row{display:flex;gap:8px;align-items:center;justify-content:space-between}.constraints-panel .constraint-row label{margin:0}`;
  element.append(style);
  const intro = document.createElement("p"); intro.textContent = "Make an object or joint follow another. Point follows position, Orient follows rotation, Scale follows size, Parent follows position and rotation, and Aim turns a local axis toward the source.";
  element.append(intro);
  const fieldset = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = "Create constraint";
  function select(name: string) { const control = document.createElement("select"); control.setAttribute("aria-label", name); return control; }
  function label(text: string, control: HTMLElement) { const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node; }
  function button(text: string, action: () => void) { const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = action; return node; }
  const source = select("Constraint source"), target = select("Constrained object"), type = select("Constraint type");
  for (const value of ["point", "orient", "scale", "parent", "aim"] as const) type.add(new Option(value[0].toUpperCase() + value.slice(1), value));
  const aimAxis = select("Local aim axis"), worldUpAxis = select("World up axis");
  for (const axis of ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]) {
    aimAxis.add(new Option(axis, axis)); worldUpAxis.add(new Option(axis, axis));
  }
  aimAxis.value = "+Z"; worldUpAxis.value = "+Y";
  const aimFields = document.createElement("div"); aimFields.hidden = true;
  const aimHelp = document.createElement("p"); aimHelp.textContent = "The driven object's local aim axis points toward the source position. World up guides roll using a fixed world axis; object-up controls are not supported. Maintain offset keeps the current orientation at creation.";
  const aimConvention = document.createElement("p"); aimConvention.textContent = "Local up: +Y, or +Z when aiming along ±Y. Roll can flip when the aim direction crosses the world-up axis. To change axes after creation, delete and recreate the constraint.";
  aimFields.append(label("Local aim axis · driven object's forward direction", aimAxis), label("World up axis · world-space roll reference", worldUpAxis), aimHelp, aimConvention);
  const maintainOffset = document.createElement("input"); maintainOffset.type = "checkbox"; maintainOffset.checked = true; maintainOffset.setAttribute("aria-label", "Maintain constraint offset");
  const offsetLabel = label("Maintain offset · keep the current pose", maintainOffset); offsetLabel.className = "constraint-check";
  const status = document.createElement("p"); status.className = "constraint-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  function run(action: () => void, message = "") {
    if (!options.available()) { status.textContent = "Pause playback and finish the current operation before editing constraints."; return; }
    try { action(); status.textContent = message; refresh(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  }
  function loadSelected(select: HTMLSelectElement, last = false) {
    const ids = options.getSelection().filter(id => Array.from(select.options).some(option => option.value === id));
    if (!ids.length) { status.textContent = "Select an object or joint in the Outliner or viewport first."; return; }
    select.value = last ? ids.at(-1)! : ids[0]; status.textContent = ""; refresh();
  }
  const loadActions = document.createElement("div"); loadActions.className = "constraint-actions";
  loadActions.append(button("Load selected source", () => loadSelected(source)), button("Load selected driven", () => loadSelected(target, true)));
  const create = button("Create point constraint", () => run(() => {
    createConstraint(store, type.value as ConstraintType, source.value, target.value, maintainOffset.checked, options.getPoses(),
      type.value === "aim" ? { aimAxis: aimAxis.value as SignedAxis, worldUpAxis: worldUpAxis.value as SignedAxis } : undefined);
  }, "Constraint created. Undo restores the previous pose."));
  const createActions = document.createElement("div"); createActions.className = "constraint-actions"; createActions.append(create);
  const sourceLabel = label("Source · follow this", source), targetLabel = label("Driven · constrain this", target);
  fieldset.append(legend, sourceLabel, targetLabel, loadActions, label("Type", type), aimFields, offsetLabel, createActions);
  const heading = document.createElement("h3"); heading.textContent = "Scene constraints";
  const list = document.createElement("div"); list.className = "constraint-list"; list.setAttribute("aria-label", "Scene constraints");
  const note = document.createElement("p"); note.textContent = "Constraints override their position, rotation or scale channels after animation, driven keys and IK. Disable a constraint to return to that underlying pose. Cycles and duplicate outputs are rejected. Parent does not constrain size.";
  const limits = document.createElement("p"); limits.textContent = "Orient, Parent, Scale and Aim require uniform driven-parent scales. Orient, Parent and Scale also require a source without shear. Aim uses only the source position and requires distinct source/driven positions. Unsupported animated poses stop playback with an explanation. Point accepts any invertible parent. Joint scaling and multiple sources are not supported yet.";
  element.append(fieldset, status, heading, list, note, limits);
  for (const select of [source, target, type, aimAxis, worldUpAxis]) select.onchange = () => { status.textContent = ""; refresh(); };
  let targetSignature = "", listSignature = "", previousConstraints: Constraint[] | undefined;
  function name(id: string) {
    const doc = store.getState().document; return doc.nodes[id]?.name ?? doc.joints?.find(joint => joint.id === id)?.name ?? id;
  }
  function renderList() {
    list.replaceChildren();
    const constraints = store.getState().document.constraints ?? [];
    if (!constraints.length) { const empty = document.createElement("p"); empty.textContent = "No constraints. Choose a source and driven object above to create one."; list.append(empty); return; }
    for (const constraint of constraints) {
      const row = document.createElement("article"), title = document.createElement("strong"); title.textContent = constraint.name;
      const relation = document.createElement("p"); relation.textContent = `${name(constraint.sourceId)} → ${name(constraint.targetId)}`;
      const description = document.createElement("p"); description.textContent = `${constraint.type[0].toUpperCase() + constraint.type.slice(1)} · ${constraint.maintainOffset ? "Offset maintained" : "No offset"}`;
      if(constraint.type === "aim") description.textContent += ` · Local aim ${constraint.aimAxis ?? "+Z"} · World up ${constraint.worldUpAxis ?? "+Y"}`;
      const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = constraint.enabled; enabled.setAttribute("aria-label", `Enable ${constraint.name}`);
      enabled.onchange = () => run(() => updateConstraint(store, constraint.id, { enabled: enabled.checked }));
      const enableLabel = label("Enabled", enabled); enableLabel.className = "constraint-check";
      const controls = document.createElement("div"); controls.className = "constraint-row";
      const remove = button("Delete", () => run(() => deleteConstraint(store, constraint.id), "Constraint deleted. Undo restores it.")); remove.setAttribute("aria-label", `Delete ${constraint.name}`);
      controls.append(enableLabel, remove); row.append(title, relation, description, controls); list.append(row);
    }
  }
  function refresh() {
    const doc = store.getState().document;
    const objects = [...Object.values(doc.nodes).filter(node => node.type === "transform"), ...(doc.joints ?? [])];
    const signature = JSON.stringify(objects.map(object => [object.id, object.name]));
    if (signature !== targetSignature) {
      const sourceValue = source.value, targetValue = target.value;
      targetSignature = signature;
      for (const select of [source, target]) {
        select.replaceChildren(...objects.map(object => new Option(object.name, object.id)));
        if (!objects.length) select.add(new Option("No objects or joints", ""));
      }
      if (objects.some(object => object.id === sourceValue)) source.value = sourceValue;
      if (objects.some(object => object.id === targetValue)) target.value = targetValue;
      else if (objects.length > 1) target.value = objects[1].id;
    }
    if (previousConstraints !== doc.constraints || listSignature !== signature) {
      previousConstraints = doc.constraints; listSignature = signature; renderList();
    }
    for (const control of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) control.disabled = !options.available();
    const aiming = type.value === "aim";
    aimFields.hidden = !aiming;
    sourceLabel.firstChild!.textContent = aiming ? "Look-at source · aim toward this" : "Source · follow this";
    targetLabel.firstChild!.textContent = aiming ? "Driven · rotate this" : "Driven · constrain this";
    create.textContent = `Create ${type.value} constraint`;
    create.disabled = !options.available() || !source.value || !target.value || source.value === target.value
      || (type.value === "scale" && !!doc.joints?.some(joint => joint.id === target.value));
  }
  store.subscribe(refresh); refresh();
  return { element, refresh };
}
