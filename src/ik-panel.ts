import { Vector3 } from "three";
import type { AnimationPose } from "./animation.ts";
import { createIKHandle, deleteIKHandle, ikChain, jointWorldMatrices, matchIKToFK, matchFKToIK, updateIKHandle, type IKHandle } from "./ik.ts";
import type { Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  available: () => boolean;
  getPoses: () => Map<string, AnimationPose>;
  getFrame: () => number;
  canKey?: () => boolean;
  /** Solved joint poses after IK and before the constraint pass. */
  getSolvedPoses: () => Map<string, AnimationPose>;
  getSelection: () => string[];
  /** Time/driven/preview poses before the IK pass; optional for older hosts. */
  getFKPoses?: () => Map<string, AnimationPose>;
};

export function createIKPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section");
  element.className = "ik-panel"; element.setAttribute("aria-label", "IK Handles");
  const style = document.createElement("style");
  style.textContent = `.ik-panel{height:100%;overflow:auto;padding:12px;background:var(--panel);color:var(--text);font-size:12px}
    .ik-panel h3{font-size:12px;margin:0 0 8px}.ik-panel p{color:var(--muted);line-height:1.5}
    .ik-panel fieldset{min-width:0;border:1px solid var(--line);padding:10px;margin:0 0 12px}.ik-panel legend{padding:0 5px}
    .ik-panel label{display:grid;gap:5px;margin:8px 0}.ik-panel input,.ik-panel select,.ik-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
    .ik-panel input,.ik-panel select{width:100%}.ik-panel button{cursor:pointer}.ik-panel button:hover{background:var(--hover)}
    .ik-panel :disabled{opacity:.45;cursor:default}.ik-panel .ik-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
    .ik-panel .ik-target{display:grid;grid-template-columns:repeat(3,minmax(50px,1fr));gap:7px}
    .ik-panel .ik-enabled{display:flex;align-items:center;gap:8px}.ik-panel .ik-enabled input{width:auto}
    .ik-panel .ik-blend{display:grid;grid-template-columns:minmax(70px,1fr) 70px;gap:8px;align-items:center}
    .ik-panel input[type=range]{padding:0;accent-color:var(--text)}.ik-panel .ik-status{min-height:20px;white-space:normal}
    .ik-panel .ik-chain{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.ik-panel .ik-empty{padding:12px 0}`;
  element.append(style);
  const intro = document.createElement("p"); intro.textContent = "Create an IK handle from a root joint to a descendant end joint. Move its world-space target to pose the chain."; element.append(intro);
  const status = document.createElement("p"); status.className = "ik-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  function run(action: () => void, message = "") {
    if (!options.available()) { status.textContent = "Pause playback and finish the current operation before editing IK."; return; }
    try { action(); status.textContent = message; refresh(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  }
  function label(text: string, control: HTMLElement) {
    const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node;
  }
  function button(text: string, action: () => void) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = action; return node;
  }
  function select(name: string) { const node = document.createElement("select"); node.setAttribute("aria-label", name); return node; }
  function number(name: string, step = "any") {
    const node = document.createElement("input"); node.type = "number"; node.step = step; node.setAttribute("aria-label", name); return node;
  }
  function commitField(input: HTMLInputElement, action: () => void) {
    let cancel = false;
    input.addEventListener("blur", () => { if (!cancel) run(action); cancel = false; });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { event.preventDefault(); cancel = true; input.blur(); status.textContent = ""; refresh(); }
    });
  }
  function finiteInput(input: HTMLInputElement) {
    if (!input.value.trim() || !Number.isFinite(input.valueAsNumber)) throw Error(`${input.getAttribute("aria-label")} must be a finite number.`);
    return input.valueAsNumber;
  }
  const creation = document.createElement("fieldset"), createLegend = document.createElement("legend"); createLegend.textContent = "Create handle";
  const root = select("IK root joint"), end = select("IK end joint");
  const useSelection = button("Use selected joints", () => {
    const doc = store.getState().document, selected = options.getSelection().filter(id => doc.joints?.some(joint => joint.id === id));
    if (selected.length !== 2) { status.textContent = "Select exactly two joints: the root and a descendant end joint."; return; }
    for (const [a, b] of [selected, [...selected].reverse()]) {
      try { ikChain(doc, a, b); root.value = a; updateEnds(b); status.textContent = ""; return; }
      catch { /* Try the other selection order. */ }
    }
    status.textContent = "The selected end joint must be a descendant of the root joint.";
  });
  const create = button("Create IK handle", () => run(() => {
    const doc = store.getState().document;
    ikChain(doc, root.value, end.value);
    const matrix = jointWorldMatrices(doc, options.getPoses()).get(end.value);
    if (!matrix) throw Error("Choose an end joint.");
    selectedHandleId = createIKHandle(store, root.value, end.value, new Vector3().setFromMatrixPosition(matrix).toArray() as Vec3);
    refresh();
  }, "IK handle created at the displayed end joint."));
  const createActions = document.createElement("div"); createActions.className = "ik-actions"; createActions.append(useSelection, create);
  creation.append(createLegend, label("Root joint", root), label("End joint", end), createActions); element.append(creation);

  const handles = select("Selected IK handle"); element.append(label("IK handles", handles));
  let selectedHandleId = "";
  const details = document.createElement("fieldset"), detailsLegend = document.createElement("legend"); detailsLegend.textContent = "Handle properties";
  const name = document.createElement("input"); name.type = "text"; name.maxLength = 100; name.setAttribute("aria-label", "IK handle name");
  const chainDescription = document.createElement("p"); chainDescription.className = "ik-chain";
  const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.setAttribute("aria-label", "Enable IK handle");
  const enabledLabel = label("Enabled", enabled); enabledLabel.className = "ik-enabled";
  const targets = ["X", "Y", "Z"].map(axis => number(`IK target ${axis}`, "0.1"));
  const targetRow = document.createElement("div"); targetRow.className = "ik-target";
  targets.forEach((input, index) => targetRow.append(label(`Target ${"XYZ"[index]}`, input)));
  const targetHeading = document.createElement("p"); targetHeading.textContent = "World-space target";
  const blendRow = document.createElement("div"); blendRow.className = "ik-blend";
  const blendSlider = document.createElement("input"); blendSlider.type = "range"; blendSlider.min = "0"; blendSlider.max = "1"; blendSlider.step = "0.01"; blendSlider.setAttribute("aria-label", "IK FK blend slider");
  const blend = number("IK FK blend", "0.01"); blend.min = "0"; blend.max = "1"; blendRow.append(blendSlider, blend);
  const blendLabel = document.createElement("div"); blendLabel.textContent = "FK / IK blend · 0 = FK, 1 = IK";
  const iterations = number("IK solver iterations", "1"); iterations.min = "1"; iterations.max = "128";
  const match = button(options.getFKPoses ? "Match target to FK" : "Match target to authored FK", () => run(() => {
    if (!selectedHandleId) return;
    matchIKToFK(store, selectedHandleId, options.getFKPoses?.());
  }, "Target matched to the FK end joint."));
  const matchFK = button("Match FK to IK and key", () => run(() => {
    if (options.canKey && !options.canKey()) throw Error("Switch the timeline to Animation mode before matching and keying FK.");
    const handle = current();
    if(!handle?.enabled || handle.blend <= 0)throw Error("Enable the selected IK handle and set its blend above zero before matching FK to IK.");
    matchFKToIK(store, handle.id, options.getFrame(), options.getSolvedPoses(), options.getFKPoses?.());
  }, `Joint rotation keys set at frame ${Number(options.getFrame().toFixed(3))}; the handle now uses FK.`));
  matchFK.title = "Key the selected chain's solved rotations at the current frame and switch its static blend to 0 (FK), in one undo step.";
  const matchHelp = document.createElement("p");
  matchHelp.textContent = "Match FK to IK and key writes rotation keys for every joint in this handle's chain at the current frame, then sets its static blend to 0 (FK). Remove Set Driven Key relationships on chain rotations; disable or delete constraints that drive those rotations.";
  const remove = button("Delete IK handle", () => run(() => {
    if (!selectedHandleId) return;
    deleteIKHandle(store, selectedHandleId);
  }, "IK handle deleted. The chain uses its authored FK pose."));
  const move = button("Move target in viewport", () => {
    if (selectedHandleId && options.available()) element.dispatchEvent(new CustomEvent("ik-target-select", { detail: selectedHandleId }));
  });
  const actions = document.createElement("div"); actions.className = "ik-actions"; actions.append(move, match, matchFK, remove);
  details.append(detailsLegend, chainDescription, label("Name", name), enabledLabel, targetHeading, targetRow, blendLabel, blendRow, label("Solver iterations", iterations), actions, matchHelp);
  const empty = document.createElement("p"); empty.className = "ik-empty"; empty.textContent = "No IK handles. Create a joint chain, then choose its root and end above.";
  const note = document.createElement("p"); note.textContent = "CCD solves position with fixed bone lengths. Unreachable targets extend toward the target. This version has no pole vectors or joint limits; overlapping chains are rejected. Targets are saved but are not yet keyframe channels.";
  element.append(details, empty, status, note);

  function current(): IKHandle | undefined { return store.getState().document.ikHandles?.find(handle => handle.id === selectedHandleId); }
  function patch(changes: Partial<Omit<IKHandle, "id">>) {
    if (!current()) throw Error("Select an IK handle first.");
    updateIKHandle(store, selectedHandleId, changes);
  }
  commitField(name, () => patch({ name: name.value.trim() }));
  targets.forEach(input => commitField(input, () => patch({ target: targets.map(finiteInput) as Vec3 })));
  commitField(blend, () => patch({ blend: finiteInput(blend) }));
  commitField(iterations, () => patch({ iterations: finiteInput(iterations) }));
  enabled.onchange = () => run(() => patch({ enabled: enabled.checked }));
  blendSlider.oninput = () => { blend.value = blendSlider.value; };
  blendSlider.onchange = () => run(() => patch({ blend: blendSlider.valueAsNumber }));
  handles.onchange = () => { selectedHandleId = handles.value; status.textContent = ""; refresh(); };
  root.onchange = () => { updateEnds(); status.textContent = ""; refresh(); };
  end.onchange = () => { status.textContent = ""; refresh(); };

  function updateEnds(preferred = end.value) {
    const doc = store.getState().document;
    const descendants = (doc.joints ?? []).filter(joint => {
      try { ikChain(doc, root.value, joint.id); return true; } catch { return false; }
    });
    end.replaceChildren(...descendants.map(joint => new Option(joint.name, joint.id)));
    if (descendants.some(joint => joint.id === preferred)) end.value = preferred;
    if (!descendants.length) end.add(new Option("No descendant joints", ""));
  }
  let jointSignature = "", handleSignature = "", displayedHandleId = "";
  function setValue(input: HTMLInputElement, value: string, force: boolean) {
    if (force || document.activeElement !== input) input.value = value;
  }
  function refresh() {
    const doc = store.getState().document, available = options.available();
    const nextJointSignature = JSON.stringify((doc.joints ?? []).map(joint => [joint.id, joint.name, joint.parentId]));
    if (nextJointSignature !== jointSignature) {
      jointSignature = nextJointSignature;
      const previous = root.value;
      root.replaceChildren(...(doc.joints ?? []).map(joint => new Option(joint.name, joint.id)));
      if (doc.joints?.some(joint => joint.id === previous)) root.value = previous;
      if (!doc.joints?.length) root.add(new Option("No joints in scene", ""));
      updateEnds();
    }
    if (!doc.ikHandles?.some(handle => handle.id === selectedHandleId)) selectedHandleId = doc.ikHandles?.[0]?.id ?? "";
    const nextHandleSignature = JSON.stringify((doc.ikHandles ?? []).map(handle => [handle.id, handle.name]));
    if (nextHandleSignature !== handleSignature) {
      handleSignature = nextHandleSignature;
      handles.replaceChildren(...(doc.ikHandles ?? []).map(handle => new Option(handle.name, handle.id)));
      if (!doc.ikHandles?.length) handles.add(new Option("No IK handles", ""));
    }
    handles.value = selectedHandleId;
    const selected = current(), force = displayedHandleId !== selectedHandleId;
    displayedHandleId = selectedHandleId; details.hidden = !selected; empty.hidden = !!selected;
    for (const control of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) control.disabled = !available;
    create.disabled = !available || !root.value || !end.value;
    handles.disabled = !available || !doc.ikHandles?.length;
    matchFK.disabled = !available || !selected?.enabled || selected.blend <= 0 || (options.canKey !== undefined && !options.canKey());
    matchFK.title = options.canKey && !options.canKey()
      ? "Switch the timeline to Animation mode to match and key FK."
      : "Key the selected chain's solved rotations at the current frame and switch its static blend to 0 (FK), in one undo step.";
    if (!selected) return;
    setValue(name, selected.name, force);
    targets.forEach((input, index) => setValue(input, String(Number(selected.target[index].toFixed(6))), force));
    if (force || (document.activeElement !== blend && document.activeElement !== blendSlider)) { blend.value = String(selected.blend); blendSlider.value = String(selected.blend); }
    setValue(iterations, String(selected.iterations), force); enabled.checked = selected.enabled;
    const names = new Map((doc.joints ?? []).map(joint => [joint.id, joint.name]));
    const chain = ikChain(doc, selected.rootId, selected.endId);
    chainDescription.textContent = `${names.get(selected.rootId)} → ${names.get(selected.endId)} · ${chain.length - 1} bones`;
  }
  store.subscribe(refresh); refresh();
  return { element, refresh, select(id: string) { selectedHandleId = id; refresh(); } };
}
