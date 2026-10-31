import { Vector3 } from "three";
import { evaluateIKBlend, setIKBlendKey, type AnimationPose } from "./animation.ts";
import { createIKHandle, defaultPoleTarget, deleteIKHandle, getIKTargetPoints, ikChain, jointWorldMatrices, matchIKToFK, matchFKToIK, updateIKHandle, type IKHandle } from "./ik.ts";
import { createIKControl, matchIKControlsToFKAndKey, setIKControl } from "./ik-controls.ts";
import { transformNodes, type Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  available: () => boolean;
  getPoses: () => Map<string, AnimationPose>;
  getFrame: () => number;
  setFrame?: (frame: number) => void;
  previewBlend?: (id: string, value?: number) => void;
  canKey?: () => boolean;
  /** Solved joint poses after IK and before remaining output constraints. */
  getSolvedPoses: () => Map<string, AnimationPose>;
  getSelection: () => string[];
  /** Time/driven/preview poses plus prerequisite constraints, before IK. */
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
  function commitField(input: HTMLInputElement, action: () => void, onlyChanged = false) {
    let cancel = false, original = input.value;
    input.addEventListener("focus", () => { original = input.value; });
    input.addEventListener("blur", () => {
      const changed = input.value !== original && input.valueAsNumber !== Number(original);
      if (!cancel && !input.readOnly && (!onlyChanged || changed)) run(action);
      cancel = false;
    });
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
  function solverSelect(name: string) {
    const node = select(name); node.add(new Option("CCD", "ccd")); node.add(new Option("Analytic two-bone", "two-bone")); return node;
  }
  const creationSolver = solverSelect("New IK handle solver");
  const creationHelp = document.createElement("p");
  const useSelection = button("Use selected joints", () => {
    const doc = store.getState().document, selected = options.getSelection().filter(id => doc.joints?.some(joint => joint.id === id));
    if (selected.length !== 2) { status.textContent = "Select exactly two joints: the root and a descendant end joint."; return; }
    for (const [a, b] of [selected, [...selected].reverse()]) {
      try { ikChain(doc, a, b); root.value = a; updateEnds(b); status.textContent = ""; refresh(); return; }
      catch { /* Try the other selection order. */ }
    }
    status.textContent = "The selected end joint must be a descendant of the root joint.";
  });
  const create = button("Create IK handle", () => run(() => {
    const doc = store.getState().document;
    const chain = ikChain(doc, root.value, end.value);
    const solver = creationSolver.value as "ccd" | "two-bone";
    if (solver === "two-bone" && chain.length !== 3) throw Error("Analytic two-bone IK requires exactly three joints: root, middle, and end.");
    const matrix = jointWorldMatrices(doc, options.getPoses()).get(end.value);
    if (!matrix) throw Error("Choose an end joint.");
    selectedHandleId = createIKHandle(store, root.value, end.value, new Vector3().setFromMatrixPosition(matrix).toArray() as Vec3,
      { solver, ...(solver === "two-bone" ? { poleTarget: defaultPoleTarget(doc, root.value, end.value, options.getFKPoses?.() ?? options.getPoses()) } : {}) });
    refresh();
  }, "IK handle created at the displayed end joint."));
  const createActions = document.createElement("div"); createActions.className = "ik-actions"; createActions.append(useSelection, create);
  creation.append(createLegend, label("Root joint", root), label("End joint", end), label("Solver", creationSolver), creationHelp, createActions); element.append(creation);

  const handles = select("Selected IK handle"); element.append(label("IK handles", handles));
  let selectedHandleId = "";
  const details = document.createElement("fieldset"), detailsLegend = document.createElement("legend"); detailsLegend.textContent = "Handle properties";
  const name = document.createElement("input"); name.type = "text"; name.maxLength = 100; name.setAttribute("aria-label", "IK handle name");
  const chainDescription = document.createElement("p"); chainDescription.className = "ik-chain";
  const solver = solverSelect("IK handle solver");
  const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.setAttribute("aria-label", "Enable IK handle");
  const enabledLabel = label("Enabled", enabled); enabledLabel.className = "ik-enabled";
  const targets = ["X", "Y", "Z"].map(axis => number(`IK target ${axis}`, "0.1"));
  const targetRow = document.createElement("div"); targetRow.className = "ik-target";
  targets.forEach((input, index) => targetRow.append(label(`Target ${"XYZ"[index]}`, input)));
  const targetHeading = document.createElement("p"); targetHeading.textContent = "World-space target";
  const targetControl = select("IK target control"), poleControl = select("IK pole control");
  const maintainOffset = document.createElement("input"); maintainOffset.type = "checkbox"; maintainOffset.checked = true;
  const offsetLabel = label("Keep target position when linking", maintainOffset); offsetLabel.className = "ik-enabled";
  function linkControl(kind: "target" | "pole", picker: HTMLSelectElement) {
    run(() => setIKControl(store, selectedHandleId, kind, picker.value || undefined, maintainOffset.checked, options.getPoses()),
      picker.value ? "Control linked. Animate its transform with the timeline or Graph Editor." : "Control unlinked; its current target position is retained.");
    refresh();
  }
  targetControl.onchange = () => linkControl("target", targetControl);
  poleControl.onchange = () => linkControl("pole", poleControl);
  function createControl(kind: "target" | "pole") {
    run(() => {
      const id = createIKControl(store, selectedHandleId, kind, options.getPoses());
      element.dispatchEvent(new CustomEvent<string>("ik-control-created", { detail: id }));
    }, "Curve control created. Move it in the viewport and key its transform with S.");
  }
  const createTarget = button("Create target control", () => createControl("target"));
  const createPole = button("Create pole control", () => createControl("pole"));
  const poleControls = document.createElement("div");
  const poleHeading = document.createElement("p"); poleHeading.textContent = "World-space pole target";
  const poleRow = document.createElement("div"); poleRow.className = "ik-target";
  const poles = ["X", "Y", "Z"].map(axis => number(`IK pole target ${axis}`, "0.1"));
  poles.forEach((input, index) => poleRow.append(label(`Pole ${"XYZ"[index]}`, input)));
  const selectPole = button("Select pole target", () => {
    if (selectedHandleId && current()?.solver === "two-bone" && options.available())
      element.dispatchEvent(new CustomEvent<string>("ik-pole-select", { detail: selectedHandleId }));
  });
  const poleHelp = document.createElement("p"); poleHelp.textContent = "The pole chooses the elbow or knee direction. Link a control to animate it; the linked world coordinates are read-only here.";
  poleControls.append(poleHeading, label("Pole control", poleControl), createPole, poleRow, selectPole, poleHelp);
  const blendRow = document.createElement("div"); blendRow.className = "ik-blend";
  const blendSlider = document.createElement("input"); blendSlider.type = "range"; blendSlider.min = "0"; blendSlider.max = "1"; blendSlider.step = "0.01"; blendSlider.setAttribute("aria-label", "IK FK blend slider");
  const blend = number("IK FK blend", "0.01"); blend.min = "0"; blend.max = "1"; blendRow.append(blendSlider, blend);
  const blendLabel = document.createElement("div"); blendLabel.textContent = "FK / IK blend · 0 = FK, 1 = IK";
  const blendHelp = document.createElement("p");
  const blendActions = document.createElement("div"); blendActions.className = "ik-actions";
  function keyFrame() {
    if (options.canKey && !options.canKey()) throw Error("Switch the timeline to Animation mode before keying IK blend.");
    const currentFrame = options.getFrame(), frame = Math.round(currentFrame);
    if (Math.abs(frame - currentFrame) > 1e-9) options.setFrame?.(frame);
    return frame;
  }
  const keyBlend = button("Key blend", () => run(() => {
    const frame = keyFrame();
    setIKBlendKey(store, selectedHandleId, frame, evaluateIKBlend(store.getState().document, selectedHandleId, frame));
    element.dispatchEvent(new CustomEvent<string>("ik-blend-select", { detail: selectedHandleId }));
  }, "IK blend keyed at the current frame."));
  const editBlendCurve = button("Edit blend curve", () => {
    if (options.available()) element.dispatchEvent(new CustomEvent<string>("ik-blend-curve", { detail: selectedHandleId }));
  });
  blendActions.append(keyBlend, editBlendCurve);
  const iterations = number("IK solver iterations", "1"); iterations.min = "1"; iterations.max = "128";
  const iterationsLabel = label("Solver iterations", iterations);
  const match = button(options.getFKPoses ? "Match target to FK" : "Match target to authored FK", () => run(() => {
    if (!selectedHandleId) return;
    if (current()?.targetControl || current()?.poleControl) {
      if (options.canKey && !options.canKey()) throw Error("Switch the timeline to Animation mode before matching and keying controls.");
      matchIKControlsToFKAndKey(store, selectedHandleId, options.getFrame(), options.getFKPoses?.());
    } else matchIKToFK(store, selectedHandleId, options.getFKPoses?.());
  }, "Targets matched to FK. Linked controls receive position keys at the current frame."));
  const matchFK = button("Match FK to IK and key", () => run(() => {
    if (options.canKey && !options.canKey()) throw Error("Switch the timeline to Animation mode before matching and keying FK.");
    const handle = current();
    if(!handle?.enabled || evaluateIKBlend(store.getState().document, handle.id, options.getFrame()) <= 0)throw Error("Enable the selected IK handle and set its blend above zero before matching FK to IK.");
    matchFKToIK(store, handle.id, options.getFrame(), options.getSolvedPoses(), options.getFKPoses?.());
  }, `Joint rotation keys set at frame ${Number(options.getFrame().toFixed(3))}; the handle now uses FK.`));
  matchFK.title = "Key the selected chain's solved rotations at the current frame and switch its static blend to 0 (FK), in one undo step.";
  const matchHelp = document.createElement("p");
  matchHelp.textContent = "Match FK to IK and key captures joint rotations and switches to FK. An animated blend receives a zero key at this frame; an unanimated blend becomes a static zero. Remove Set Driven Key or rotation constraints on the chain before matching.";
  const remove = button("Delete IK handle", () => run(() => {
    if (!selectedHandleId) return;
    deleteIKHandle(store, selectedHandleId);
  }, "IK handle deleted. The chain uses its authored FK pose."));
  const move = button("Move target in viewport", () => {
    if (selectedHandleId && options.available()) element.dispatchEvent(new CustomEvent("ik-target-select", { detail: selectedHandleId }));
  });
  const rangeBake = button("Bake frame range…", () => {
    if (selectedHandleId && options.available()) element.dispatchEvent(new CustomEvent("ik-range-bake", { detail: selectedHandleId }));
  });
  rangeBake.title = "Sample saved animation into joint rotation keys and disable this handle, in one undo step.";
  const actions = document.createElement("div"); actions.className = "ik-actions"; actions.append(move, match, matchFK, rangeBake, remove);
  details.append(detailsLegend, chainDescription, label("Name", name), enabledLabel, label("Solver", solver), offsetLabel, targetHeading, label("Target control", targetControl), createTarget, targetRow, poleControls, blendLabel, blendRow, blendActions, blendHelp, iterationsLabel, actions, matchHelp);
  const empty = document.createElement("p"); empty.className = "ik-empty"; empty.textContent = "No IK handles. Create a joint chain, then choose its root and end above.";
  const note = document.createElement("p"); note.textContent = "Animate targets and poles through linked controls, and blend through its IK blend curve. Solver settings remain static. Both solvers preserve bone lengths; unreachable targets stop at the chain's reach. Joint limits are not supported.";
  element.append(details, empty, status, note);

  function current(): IKHandle | undefined { return store.getState().document.ikHandles?.find(handle => handle.id === selectedHandleId); }
  function patch(changes: Partial<Omit<IKHandle, "id">>) {
    if (!current()) throw Error("Select an IK handle first.");
    updateIKHandle(store, selectedHandleId, changes);
  }
  commitField(name, () => patch({ name: name.value.trim() }));
  targets.forEach(input => commitField(input, () => patch({ target: targets.map(finiteInput) as Vec3 })));
  poles.forEach(input => commitField(input, () => {
    if (current()?.solver !== "two-bone") throw Error("Choose Analytic two-bone before editing a pole target.");
    patch({ poleTarget: poles.map(finiteInput) as Vec3 });
  }));
  const hasBlendKeys = () => store.getState().document.animation?.tracks.some(track => track.targetId === selectedHandleId && track.channel === "ik.blend" && track.keys.length) ?? false;
  function editBlend(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw Error("IK blend must be between zero and one.");
    options.previewBlend?.(selectedHandleId);
    if (hasBlendKeys()) setIKBlendKey(store, selectedHandleId, keyFrame(), value);
    else patch({ blend: value });
  }
  commitField(blend, () => editBlend(finiteInput(blend)), true);
  commitField(iterations, () => patch({ iterations: finiteInput(iterations) }));
  enabled.onchange = () => run(() => patch({ enabled: enabled.checked }));
  let cancelBlend = false, previewingBlend = false;
  const cancelBlendPreview = () => {
    previewingBlend = false; options.previewBlend?.(selectedHandleId);
    const value = current() ? String(evaluateIKBlend(store.getState().document, selectedHandleId, options.getFrame())) : "0";
    blend.value = value; blendSlider.value = value;
  };
  function cancelPreview() { if (previewingBlend) { cancelBlend = true; cancelBlendPreview(); } }
  blendSlider.onpointerdown = () => { cancelBlend = false; };
  blendSlider.oninput = () => {
    if (cancelBlend || !options.available()) return;
    previewingBlend = true; blend.value = blendSlider.value; options.previewBlend?.(selectedHandleId, blendSlider.valueAsNumber);
  };
  blendSlider.onchange = () => {
    previewingBlend = false;
    if (cancelBlend) { cancelBlend = false; cancelBlendPreview(); return; }
    run(() => editBlend(blendSlider.valueAsNumber));
  };
  blendSlider.onkeydown = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelBlend = true; cancelBlendPreview(); blendSlider.blur(); }
    else cancelBlend = false;
  };
  blendSlider.onblur = cancelPreview;
  handles.onchange = () => { selectedHandleId = handles.value; status.textContent = ""; refresh(); };
  root.onchange = () => { updateEnds(); status.textContent = ""; refresh(); };
  end.onchange = () => { status.textContent = ""; refresh(); };
  creationSolver.onchange = () => { status.textContent = ""; refresh(); };
  solver.onchange = () => {
    const requested = solver.value as "ccd" | "two-bone";
    solver.value = current()?.solver ?? "ccd";
    run(() => {
      const handle = current(); if (!handle) throw Error("Select an IK handle first.");
      if (requested === "two-bone") {
        const doc = store.getState().document;
        if (ikChain(doc, handle.rootId, handle.endId).length !== 3) throw Error("Analytic two-bone IK requires exactly three joints: root, middle, and end.");
        patch({ solver: requested, poleTarget: handle.poleTarget ?? defaultPoleTarget(doc, handle.rootId, handle.endId, options.getFKPoses?.() ?? options.getPoses()) });
      } else patch({ solver: requested });
    });
  };

  function updateEnds(preferred = end.value) {
    const doc = store.getState().document;
    const descendants = (doc.joints ?? []).filter(joint => {
      try { ikChain(doc, root.value, joint.id); return true; } catch { return false; }
    });
    end.replaceChildren(...descendants.map(joint => new Option(joint.name, joint.id)));
    if (descendants.some(joint => joint.id === preferred)) end.value = preferred;
    if (!descendants.length) end.add(new Option("No descendant joints", ""));
  }
  let jointSignature = "", handleSignature = "", controlSignature = "", displayedHandleId = "";
  function setValue(input: HTMLInputElement, value: string, force: boolean) {
    if (force || input.readOnly || document.activeElement !== input) input.value = value;
  }
  function refresh() {
    const doc = store.getState().document, available = options.available();
    const objects = transformNodes(doc), nextControlSignature = JSON.stringify(objects.map(node => [node.id, node.name]));
    if (nextControlSignature !== controlSignature) {
      controlSignature = nextControlSignature;
      for (const picker of [targetControl, poleControl]) picker.replaceChildren(new Option("None · static target", ""), ...objects.map(node => new Option(node.name, node.id)));
    }
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
    let creationChainLength = 0;
    try { creationChainLength = ikChain(doc, root.value, end.value).length; } catch { /* No eligible chain chosen. */ }
    const analyticCreation = creationSolver.value === "two-bone";
    creationHelp.textContent = analyticCreation
      ? "Requires exactly three joints: root, middle, and end. The initial pole is derived from the FK pose; edit its world-space position after creation."
      : "CCD supports a root and descendant end joint with iterative position solving.";
    create.disabled = !available || !root.value || !end.value || (analyticCreation && creationChainLength !== 3);
    create.title = analyticCreation && creationChainLength !== 3 ? "Choose a chain containing exactly three joints for analytic two-bone IK." : "Create an IK handle at the displayed end joint.";
    handles.disabled = !available || !doc.ikHandles?.length;
    const effectiveBlend = selected ? evaluateIKBlend(doc, selected.id, options.getFrame()) : 0;
    matchFK.disabled = !available || !selected?.enabled || effectiveBlend <= 0 || (options.canKey !== undefined && !options.canKey());
    matchFK.title = options.canKey && !options.canKey()
      ? "Switch the timeline to Animation mode to match and key FK."
      : "Key the solved joint rotations and switch to FK at this frame in one undo step.";
    if (!selected) return;
    keyBlend.disabled = !available || (options.canKey !== undefined && !options.canKey());
    editBlendCurve.disabled = !available || !hasBlendKeys();
    blend.disabled = blendSlider.disabled = !available || (hasBlendKeys() && options.canKey !== undefined && !options.canKey());
    blendHelp.textContent = hasBlendKeys()
      ? "Animated blend: edits set a key at the current frame. Use the Graph Editor or Dope Sheet to edit or delete keys. Playback clamps blend to 0–1."
      : "Static blend. Set the first blend key to animate a switch or gradual transition between FK and IK.";
    targetControl.value = selected.targetControl?.objectId ?? ""; poleControl.value = selected.poleControl?.objectId ?? "";
    const linked = !!(selected.targetControl || selected.poleControl);
    match.textContent = linked ? "Match controls to FK and key" : options.getFKPoses ? "Match target to FK" : "Match target to authored FK";
    match.disabled = !available || (linked && options.canKey !== undefined && !options.canKey());
    move.textContent = selected.targetControl ? "Move target control" : "Move target in viewport";
    selectPole.textContent = selected.poleControl ? "Move pole control" : "Select pole target";
    const analytic = selected.solver === "two-bone";
    solver.value = selected.solver ?? "ccd";
    poleControls.hidden = !analytic; iterationsLabel.hidden = analytic; iterations.disabled = !available || analytic;
    for (const input of poles) input.disabled = !available || !analytic;
    selectPole.disabled = !available || !analytic;
    setValue(name, selected.name, force);
    let points: { target: Vec3; poleTarget?: Vec3 } = { target: selected.target, poleTarget: selected.poleTarget };
    try { points = getIKTargetPoints(doc, options.getPoses()).get(selected.id)!; } catch { /* The viewport reports evaluation errors. */ }
    targets.forEach((input, index) => { input.readOnly = !!selected.targetControl; setValue(input, String(Number(points.target[index].toFixed(6))), force); });
    poles.forEach((input, index) => { input.readOnly = !!selected.poleControl; setValue(input, points.poleTarget ? String(Number(points.poleTarget[index].toFixed(6))) : "", force); });
    if (force || (document.activeElement !== blend && document.activeElement !== blendSlider)) { blend.value = String(Number(effectiveBlend.toFixed(6))); blendSlider.value = String(effectiveBlend); }
    setValue(iterations, String(selected.iterations), force); enabled.checked = selected.enabled;
    const names = new Map((doc.joints ?? []).map(joint => [joint.id, joint.name]));
    const chain = ikChain(doc, selected.rootId, selected.endId);
    chainDescription.textContent = `${names.get(selected.rootId)} → ${names.get(selected.endId)} · ${chain.length - 1} bones`;
  }
  store.subscribe(refresh); refresh();
  return { element, refresh, cancelPreview, select(id: string) { selectedHandleId = id; refresh(); } };
}
