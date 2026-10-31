import { defaultAnimation } from "./animation.ts";
import { bakeIKToFK } from "./ik-bake.ts";
import { planIKBake, type IKBakeSettings } from "./ik-bake-plan.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = {
  available: () => boolean;
  onBusyChange?: (busy: boolean) => void;
  onStatus?: (text: string) => void;
  onViewCurves?: (handleId: string) => void;
};

/** Range settings and progress only; the shared bake command owns validation,
 * cancellation, stale-document protection, and the single history commit. */
export function createIKBakePanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "ik-bake-panel";
  element.setAttribute("aria-label", "Bake IK to FK");
  const style = document.createElement("style");
  style.textContent = `.ik-bake-panel{height:100%;overflow:auto;padding:12px;box-sizing:border-box;background:var(--panel);color:var(--text);font-size:12px}
    .ik-bake-panel p{margin:8px 0;line-height:1.5;color:var(--muted)}.ik-bake-panel label{display:grid;gap:5px;margin:8px 0}
    .ik-bake-panel input,.ik-bake-panel select,.ik-bake-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0;box-sizing:border-box}
    .ik-bake-panel select,.ik-bake-panel input:not([type=checkbox]){width:100%}.ik-bake-panel button{cursor:pointer}.ik-bake-panel button:hover:enabled{background:var(--hover)}
    .ik-bake-panel :disabled{opacity:.45;cursor:default}.ik-bake-panel :focus-visible{outline:1px solid var(--strong);outline-offset:2px}
    .ik-bake-panel fieldset{min-width:0;border:1px solid var(--line);padding:10px;margin:12px 0}.ik-bake-panel legend{padding:0 5px}
    .ik-bake-panel .bake-range{display:grid;grid-template-columns:repeat(2,minmax(70px,1fr));gap:8px}.ik-bake-panel .bake-range label{margin:0}
    .ik-bake-panel .bake-check{display:flex;align-items:center;gap:7px}.ik-bake-panel .bake-check input{width:auto;margin:0}
    .ik-bake-panel .bake-actions{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.ik-bake-panel .bake-estimate{font-variant-numeric:tabular-nums;white-space:pre-line;overflow-wrap:anywhere}
    .ik-bake-panel [data-error=true]{color:#ce756a}.ik-bake-panel .bake-status{min-height:20px;overflow-wrap:anywhere}
    .ik-bake-panel progress{display:block;width:100%;height:7px;accent-color:var(--text);margin:10px 0}.ik-bake-panel progress[hidden]{display:none}`;
  function label(text: string, control: HTMLElement) {
    const wrapper = document.createElement("label"); wrapper.append(document.createTextNode(text), control); return wrapper;
  }
  function button(text: string, action: () => void) {
    const control = document.createElement("button"); control.type = "button"; control.textContent = text; control.onclick = action; return control;
  }
  function number(name: string) {
    const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.setAttribute("aria-label", name); return input;
  }
  const intro = document.createElement("p"); intro.textContent = "Sample saved animation into FK rotation keys. Temporary viewport pose edits are not included.";
  const handles = document.createElement("select"); handles.setAttribute("aria-label", "Bake IK handle");
  const settingsGroup = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = "Sample range";
  const start = number("Bake start frame"), end = number("Bake end frame"), step = number("Bake sample interval");
  start.min = end.min = "-1000000"; start.max = end.max = "1000000"; step.min = "0";
  const range = document.createElement("div"); range.className = "bake-range"; range.append(label("Start frame", start), label("End frame", end));
  const useRange = button("Use playback range", () => { if (!running && options.available()) { initializeRange(); clearStatus(); refresh(); } });
  const rangeHelp = document.createElement("p"); rangeHelp.textContent = "Includes both ends of the range. The exact end frame is sampled even when the interval does not land on it.";
  const preserve = document.createElement("input"); preserve.type = "checkbox"; preserve.checked = true;
  const preserveLabel = label("Keep keys outside range", preserve); preserveLabel.className = "bake-check";
  const minimize = document.createElement("input"); minimize.type = "checkbox"; minimize.checked = true;
  const minimizeLabel = label("Minimize rotation", minimize); minimizeLabel.className = "bake-check";
  minimize.title = "Choose nearby equivalent Euler angles between samples to reduce unnecessary full turns.";
  settingsGroup.append(legend, range, label("Sample interval · frames", step), useRange, rangeHelp, preserveLabel, minimizeLabel);
  const estimate = document.createElement("p"); estimate.className = "bake-estimate"; estimate.setAttribute("aria-live", "polite");
  const limitation = document.createElement("p"); limitation.textContent = "Writes linear rotation keys and disables this handle globally after baking. Keeping outside keys preserves their records; neighboring interpolation and motion outside the range may still change. With the option off, this chain's existing rotation curves are replaced.";
  const unavailable = document.createElement("p"); unavailable.textContent = "Pause playback and finish the current operation before baking.";
  const progress = document.createElement("progress"); progress.max = 1; progress.value = 0; progress.hidden = true; progress.setAttribute("aria-label", "IK bake progress");
  const status = document.createElement("p"); status.className = "bake-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const bake = button("Bake IK to FK", () => { void runBake(); });
  const cancelButton = button("Cancel", cancel);
  const curves = button("View joint curves", () => { if (!running && options.available() && selectedHandleId) options.onViewCurves?.(selectedHandleId); });
  const actions = document.createElement("div"); actions.className = "bake-actions"; actions.append(bake, cancelButton); if (options.onViewCurves) actions.append(curves);
  element.append(style, intro, label("IK handle", handles), settingsGroup, estimate, limitation, unavailable, actions, progress, status);

  let selectedHandleId = "", handleSignature = "", running = false, disposed = false, generation = 0;
  let controller: AbortController | undefined;
  let plannedDocument: object | undefined, planSignature = "", planValid = false;
  let planText = "", planError = false;
  function initializeRange() {
    const animation = store.getState().document.animation ?? defaultAnimation();
    start.value = String(animation.start); end.value = String(animation.end);
  }
  function clearStatus() { status.textContent = ""; status.dataset.error = "false"; }
  function report(text: string, error = false) {
    status.textContent = text; status.dataset.error = String(error); options.onStatus?.(text);
  }
  function settings(): IKBakeSettings {
    for (const input of [start, end, step]) if (!input.value.trim() || !Number.isFinite(input.valueAsNumber))
      throw Error(`${input.getAttribute("aria-label")} must be a finite number.`);
    return { start: start.valueAsNumber, end: end.valueAsNumber, step: step.valueAsNumber, preserveOutsideKeys: preserve.checked, minimizeRotation: minimize.checked };
  }
  function refresh() {
    if (disposed) return;
    const doc = store.getState().document, available = options.available();
    const records = doc.ikHandles ?? [], signature = JSON.stringify(records.map(handle => [handle.id, handle.name, handle.enabled]));
    if (!records.some(handle => handle.id === selectedHandleId)) selectedHandleId = records[0]?.id ?? "";
    if (signature !== handleSignature) {
      handleSignature = signature;
      handles.replaceChildren(...records.map(handle => new Option(`${handle.name}${handle.enabled ? "" : " · disabled"}`, handle.id)));
      if (!records.length) handles.add(new Option("No IK handles", ""));
    }
    handles.value = selectedHandleId;
    if (!running) {
      const requestedPlan = JSON.stringify([selectedHandleId, start.value, end.value, step.value, preserve.checked, minimize.checked]);
      if (plannedDocument !== doc || planSignature !== requestedPlan) {
        plannedDocument = doc; planSignature = requestedPlan; planValid = false; planError = false;
        if (!selectedHandleId) planText = "Create an IK handle, then select it here to bake its joint chain.";
        else try {
          const plan = planIKBake(doc, selectedHandleId, settings()); planValid = true;
          planText = `${plan.frames.length.toLocaleString()} samples · ${plan.chainIds.length.toLocaleString()} joints · ${plan.keysWritten.toLocaleString()} rotation keys\n${plan.resultKeyCount.toLocaleString()} total scene keys after bake`;
        } catch (error) { planText = error instanceof Error ? error.message : String(error); planError = true; }
      }
      estimate.textContent = planText; estimate.dataset.error = String(planError);
    }
    handles.disabled = running || !available || !records.length; settingsGroup.disabled = running || !available;
    bake.disabled = running || !available || !planValid;
    cancelButton.disabled = !running || !!controller?.signal.aborted;
    cancelButton.textContent = controller?.signal.aborted ? "Cancelling…" : "Cancel";
    curves.disabled = running || !available || !selectedHandleId;
    unavailable.hidden = available || running;
    progress.hidden = !running; element.setAttribute("aria-busy", String(running));
  }
  function cancel() {
    if (!running || !controller || controller.signal.aborted) return;
    controller.abort();
    if (!disposed) { report("Cancelling bake…"); refresh(); }
  }
  async function runBake() {
    if (disposed || running) return;
    if (!options.available()) { report("Pause playback and finish the current operation before baking.", true); refresh(); return; }
    let chosen: IKBakeSettings;
    const handleId = selectedHandleId;
    try { chosen = settings(); planIKBake(store.getState().document, handleId, chosen); }
    catch (error) { report(error instanceof Error ? error.message : String(error), true); refresh(); return; }
    const token = ++generation, operation = new AbortController(); controller = operation;
    let completion: { text: string; error: boolean } | undefined, lastProgress = "";
    running = true; progress.value = 0;
    try {
      options.onBusyChange?.(true); refresh(); report("Sampling saved animation…");
      const result = await bakeIKToFK(store, handleId, chosen, {
        signal: operation.signal,
        onProgress: update => {
          if (disposed || token !== generation || operation.signal.aborted) return;
          const fraction = update.total ? Math.min(1, Math.max(0, update.completed / update.total)) : 0;
          progress.value = (update.phase === "sampling" ? 0 : .5) + fraction * .5;
          const text = `${update.phase === "sampling" ? "Sampling" : "Verifying"} · ${update.completed.toLocaleString()} / ${update.total.toLocaleString()} (${Math.round(fraction * 100)}%)`;
          const signature = `${update.phase}/${Math.round(fraction * 100)}`;
          if (signature !== lastProgress) { lastProgress = signature; report(text); }
        },
      });
      completion = { text: `Baked ${result.samples.toLocaleString()} samples and ${result.keysWritten.toLocaleString()} rotation keys, frames ${result.start}–${result.end}. IK handle disabled. Undo restores the previous rig.`, error: false };
    } catch (error) {
      completion = operation.signal.aborted
        ? { text: "Bake cancelled. Scene unchanged.", error: false }
        : { text: error instanceof Error ? error.message : String(error), error: true };
    } finally {
      running = false; if (controller === operation) controller = undefined;
      // The host clears its busy notice here; publish the final result afterward.
      options.onBusyChange?.(false);
      if (!disposed) {
        refresh();
        if (token === generation && completion) report(completion.text, completion.error);
      }
    }
  }
  function resetScene() {
    generation++; controller?.abort(); selectedHandleId = ""; handleSignature = "";
    initializeRange(); step.value = "1"; preserve.checked = minimize.checked = true; clearStatus(); progress.value = 0; refresh();
  }
  for (const input of [start, end, step]) {
    let original = "";
    input.addEventListener("focus", () => { original = input.value; });
    input.addEventListener("input", () => { clearStatus(); refresh(); });
    input.addEventListener("blur", refresh);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = original; clearStatus(); input.blur(); refresh(); }
    });
  }
  handles.onchange = () => { selectedHandleId = handles.value; clearStatus(); refresh(); };
  preserve.onchange = minimize.onchange = () => { clearStatus(); refresh(); };
  element.addEventListener("keydown", event => { if (event.key === "Escape" && running) { event.preventDefault(); event.stopPropagation(); cancel(); } });
  const unsubscribe = store.subscribe(refresh);
  resetScene();
  return {
    element, refresh, resetScene, cancel,
    selectHandle(id: string) {
      if (disposed || running || !store.getState().document.ikHandles?.some(handle => handle.id === id)) return;
      selectedHandleId = id; clearStatus(); refresh();
    },
    dispose() { if (disposed) return; disposed = true; generation++; controller?.abort(); unsubscribe(); },
  };
}
