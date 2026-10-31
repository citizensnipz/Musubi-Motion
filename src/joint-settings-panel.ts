import type { AnimationPose } from "./animation.ts";
import { preferredJointIds, setJointPreferredAngle, setPreferredAngles, clearPreferredAngles, keyPreferredAngles } from "./joint-preferred.ts";
import type { Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  available: () => boolean;
  getSelection: () => string[];
  getFKPoses: () => ReadonlyMap<string, AnimationPose>;
  getFrame: () => number;
  canKey: () => boolean;
  onSelect?: (id: string) => void;
  onStatus?: (message: string) => void;
};

/** Preferred-angle metadata is separate from authored FK and its animation. */
export function createJointSettingsPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "joint-settings-panel";
  element.setAttribute("aria-label", "Joint Settings");
  const style = document.createElement("style");
  style.textContent = `.joint-settings-panel{height:100%;overflow:auto;box-sizing:border-box;padding:12px;background:var(--panel);color:var(--text);font-size:12px}
    .joint-settings-panel p{margin:8px 0;line-height:1.5;color:var(--muted)}.joint-settings-panel label{display:grid;gap:5px;margin:8px 0}
    .joint-settings-panel input,.joint-settings-panel select,.joint-settings-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}
    .joint-settings-panel select,.joint-settings-panel input:not([type=checkbox]){width:100%}.joint-settings-panel button{cursor:pointer}.joint-settings-panel button:hover:enabled{background:var(--hover)}
    .joint-settings-panel :disabled{opacity:.45;cursor:default}.joint-settings-panel :focus-visible{outline:1px solid var(--strong);outline-offset:2px}
    .joint-settings-panel fieldset{min-width:0;border:1px solid var(--line);padding:10px;margin:12px 0}.joint-settings-panel legend{padding:0 5px}
    .joint-settings-panel .joint-angle-fields{display:grid;grid-template-columns:repeat(3,minmax(45px,1fr));gap:7px}.joint-settings-panel .joint-angle-fields label{margin:0}
    .joint-settings-panel .joint-settings-check{display:flex;align-items:center;gap:7px}.joint-settings-panel .joint-settings-check input{width:auto;margin:0}
    .joint-settings-panel .joint-settings-actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.joint-settings-panel output{display:block;line-height:1.5;color:var(--muted);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .joint-settings-panel .joint-settings-status{min-height:20px;overflow-wrap:anywhere}.joint-settings-panel [data-error=true]{color:#ce756a}`;
  function label(text: string, control: HTMLElement) {
    const wrapper = document.createElement("label"); wrapper.append(document.createTextNode(text), control); return wrapper;
  }
  function button(text: string, action: () => void) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = action; return node;
  }
  const intro = document.createElement("p"); intro.textContent = "Choose the local joint angles that IK should use as its starting pose.";
  const joints = document.createElement("select"); joints.setAttribute("aria-label", "Joint settings joint");
  const useSelected = button("Use selected joint", () => {
    const valid = new Set((store.getState().document.joints ?? []).map(joint => joint.id));
    const id = options.getSelection().filter(id => valid.has(id)).at(-1);
    if (!options.available()) return;
    if (!id) { report("Select a joint in the viewport or Outliner first.", true); return; }
    selectedJointId = id; clearStatus(); refresh();
  });
  const empty = document.createElement("p"); empty.textContent = "Create joints in the Rigging panel, then choose one here to store a preferred pose.";
  const angles = document.createElement("fieldset"), angleLegend = document.createElement("legend"); angleLegend.textContent = "Selected joint · local degrees";
  const stored = document.createElement("p"); stored.setAttribute("aria-live", "polite");
  const fields = ["X", "Y", "Z"].map(axis => {
    const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.setAttribute("aria-label", `Preferred angle ${axis}`); return input;
  });
  const axisRow = document.createElement("div"); axisRow.className = "joint-angle-fields";
  fields.forEach((input, index) => axisRow.append(label("XYZ"[index], input)));
  const currentFK = document.createElement("output"); currentFK.setAttribute("aria-label", "Prepared FK rotations");
  const manualHelp = document.createElement("p"); manualHelp.textContent = "XYZ edits apply to this joint only. Unset fields show zero; IK then starts from the current FK pose.";
  angles.append(angleLegend, stored, axisRow, currentFK, manualHelp);
  const descendants = document.createElement("input"); descendants.type = "checkbox"; descendants.checked = true;
  const descendantsLabel = label("Include descendants", descendants); descendantsLabel.className = "joint-settings-check";
  const scope = document.createElement("p"), keyHelp = document.createElement("p");
  const capture = button("Capture FK angles", () => run(() => {
    const ids = scopeIds(); setPreferredAngles(store, ids, options.getFKPoses());
    return `Captured prepared FK angles for ${ids.length} joint${ids.length === 1 ? "" : "s"}.`;
  }));
  const clear = button("Clear preferred angles", () => run(() => {
    const ids = scopeIds(); clearPreferredAngles(store, ids);
    return `Cleared preferred angles for ${ids.length} joint${ids.length === 1 ? "" : "s"}.`;
  }));
  const key = button("Key preferred FK angles", () => run(() => {
    if (!options.canKey()) throw Error("Switch the timeline to Animation mode before keying preferred angles.");
    const ids = scopeIds(), frame = options.getFrame(); keyPreferredAngles(store, ids, frame);
    return `Preferred FK angles keyed for ${ids.length} joint${ids.length === 1 ? "" : "s"} at frame ${frame}. Set IK blend to 0 to inspect FK.`;
  }));
  const actions = document.createElement("div"); actions.className = "joint-settings-actions"; actions.append(capture, clear, key);
  const captureHelp = document.createElement("p"); captureHelp.textContent = "Capture uses FK before IK. The descendant setting applies to all three actions. Keying leaves IK enabled; set blend to 0 to inspect keyed FK.";
  const status = document.createElement("p"); status.className = "joint-settings-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  element.append(style, intro, label("Joint", joints), useSelected, empty, angles, descendantsLabel, scope, actions, keyHelp, captureHelp, status);

  let selectedJointId = "", displayedJointId = "", jointSignature = "", selectionSignature = "", disposed = false, editEpoch = 0;
  let scopeJoints: unknown, scopeRoot = "", scopeDescendants = true, cachedScope: string[] = [], scopeFailure: Error | undefined;
  function report(message: string, error = false) { status.textContent = message; status.dataset.error = String(error); options.onStatus?.(message); }
  function clearStatus() { status.textContent = ""; status.dataset.error = "false"; }
  function scopeIds() {
    const doc = store.getState().document;
    if (scopeJoints !== doc.joints || scopeRoot !== selectedJointId || scopeDescendants !== descendants.checked) {
      scopeJoints = doc.joints; scopeRoot = selectedJointId; scopeDescendants = descendants.checked; scopeFailure = undefined;
      try { cachedScope = preferredJointIds(doc, selectedJointId, descendants.checked); }
      catch (error) { cachedScope = []; scopeFailure = error instanceof Error ? error : Error(String(error)); }
    }
    if (scopeFailure) throw scopeFailure;
    return cachedScope;
  }
  function run(action: () => string) {
    if (disposed) return;
    if (!options.available()) { report("Pause playback and finish the current operation before editing joint settings.", true); refresh(); return; }
    try { report(action()); }
    catch (error) { report(error instanceof Error ? error.message : String(error), true); }
    refresh();
  }
  function refresh() {
    if (disposed) return;
    const doc = store.getState().document, records = doc.joints ?? [], byId = new Map(records.map(joint => [joint.id, joint]));
    const selection = options.getSelection(), nextSelection = JSON.stringify(selection);
    if (selectionSignature !== nextSelection) {
      selectionSignature = nextSelection;
      const selectedJoints = selection.filter(id => byId.has(id));
      if (selectedJoints.length === 1) selectedJointId = selectedJoints[0];
    }
    if (!byId.has(selectedJointId)) selectedJointId = records[0]?.id ?? "";
    const signature = JSON.stringify(records.map(joint => [joint.id, joint.name]));
    if (jointSignature !== signature) {
      jointSignature = signature; joints.replaceChildren(...records.map(joint => new Option(joint.name, joint.id)));
      if (!records.length) joints.add(new Option("No joints", ""));
    }
    joints.value = selectedJointId;
    const selected = byId.get(selectedJointId), changedJoint = displayedJointId !== selectedJointId, available = options.available();
    displayedJointId = selectedJointId;
    if (changedJoint) {
      editEpoch++;
      // A draft belongs to its original joint. End focus before replacing its
      // displayed values so subsequent edits begin against the new joint.
      fields.find(input => input === document.activeElement)?.blur();
    }
    empty.hidden = !!selected; angles.hidden = descendantsLabel.hidden = scope.hidden = actions.hidden = keyHelp.hidden = captureHelp.hidden = !selected;
    joints.disabled = !available || !records.length; useSelected.disabled = !available || !selection.some(id => byId.has(id));
    angles.disabled = !available || !selected; descendants.disabled = !available || !selected;
    const preferred = selected?.preferredAngle;
    stored.textContent = preferred ? "Preferred angles stored" : "Preferred angles unset";
    fields.forEach((input, index) => { if (changedJoint || document.activeElement !== input) input.value = String(preferred?.[index] ?? 0); });
    let ids: string[] = [], scopeError = "", fkError = "", poses: ReadonlyMap<string, AnimationPose> | undefined;
    if (selected) {
      try { ids = scopeIds(); } catch (error) { scopeError = error instanceof Error ? error.message : String(error); }
      try { poses = options.getFKPoses(); } catch (error) { fkError = error instanceof Error ? error.message : String(error); }
    }
    const fk = poses?.get(selectedJointId)?.rotation;
    currentFK.textContent = fk ? `Prepared FK · ${fk.map((value, index) => `${"XYZ"[index]} ${Number(value.toFixed(3))}°`).join(" · ")}` : "Prepared FK pose unavailable";
    const saved = ids.filter(id => byId.get(id)?.preferredAngle !== undefined).length;
    scope.textContent = scopeError || `${ids.length} joint${ids.length === 1 ? "" : "s"} in scope · ${saved} of ${ids.length} have preferred angles`;
    scope.dataset.error = String(!!scopeError);
    const completeFK = ids.length > 0 && ids.every(id => poses?.has(id));
    capture.disabled = !available || !completeFK || !!scopeError;
    capture.title = fkError || (!completeFK ? "Every joint in scope needs a prepared FK pose before capture." : "Capture local rotations before IK for every joint in scope.");
    clear.disabled = !available || !saved || !!scopeError;
    key.disabled = !available || !options.canKey() || !ids.length || saved !== ids.length || !!scopeError;
    keyHelp.textContent = !options.canKey() ? "Switch the timeline to Animation mode to key preferred FK angles."
      : saved !== ids.length ? "Every joint in scope needs a stored preference before keying. Capture the scope first, or turn off Include descendants."
      : "Key writes XYZ rotations at the current frame.";
  }
  fields.forEach(input => {
    let dirty = false, original = "", editingJointId = "", focusEpoch = 0;
    input.addEventListener("focus", () => { dirty = false; original = input.value; editingJointId = selectedJointId; focusEpoch = editEpoch; });
    input.addEventListener("input", () => { dirty = true; });
    input.addEventListener("blur", () => {
      const shouldCommit = dirty && focusEpoch === editEpoch && selectedJointId === editingJointId && options.available(); dirty = false;
      if (shouldCommit) run(() => {
        const values = fields.map(field => {
          if (!field.value.trim() || !Number.isFinite(field.valueAsNumber)) throw Error("Preferred angles must be finite local XYZ degrees.");
          return field.valueAsNumber;
        }) as Vec3;
        setJointPreferredAngle(store, editingJointId, values); return "Preferred angles stored for the selected joint.";
      });
      else refresh();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dirty = false; input.value = original; input.blur(); refresh(); }
    });
  });
  joints.onchange = () => { selectedJointId = joints.value; clearStatus(); options.onSelect?.(selectedJointId); refresh(); };
  descendants.onchange = () => { clearStatus(); refresh(); };
  function resetScene() {
    editEpoch++;
    selectedJointId = displayedJointId = jointSignature = selectionSignature = ""; descendants.checked = true; clearStatus(); refresh();
  }
  const unsubscribe = store.subscribe(refresh); refresh();
  return {
    element, refresh, resetScene,
    select(id: string) {
      if (disposed || !store.getState().document.joints?.some(joint => joint.id === id)) return;
      selectedJointId = id; selectionSignature = JSON.stringify(options.getSelection()); clearStatus(); refresh();
    },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); },
  };
}
