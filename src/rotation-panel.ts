import { filterEulerRotations, setRotationInterpolation, type EulerFilterMode, type RotationInterpolation } from "./rotation-curves.ts";
import type { SceneStore } from "./scene-store.ts";

type Options = { available: () => boolean; getSelection: () => string[]; onStatus?: (message: string) => void };

/** Rotation cleanup is explicit and separate from normal multi-turn authoring. */
export function createRotationPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "rotation-workflows"; element.setAttribute("aria-label", "Rotation Curves");
  const style = document.createElement("style"); style.textContent = `.rotation-workflows{height:100%;overflow:auto;box-sizing:border-box;padding:12px;background:var(--panel);color:var(--text);font-size:12px}.rotation-workflows p{line-height:1.5;color:var(--muted)}.rotation-workflows label{display:grid;gap:5px;margin:12px 0}.rotation-workflows select,.rotation-workflows button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}.rotation-workflows button{cursor:pointer;margin:0 6px 6px 0}.rotation-workflows :disabled{opacity:.45;cursor:default}.rotation-workflows :focus-visible{outline:1px solid var(--strong);outline-offset:2px}.rotation-workflows [data-error=true]{color:#ce756a}`;
  const explanation = document.createElement("p"); explanation.textContent = "Rotation curves store degrees on independent X, Y and Z channels and compose in XYZ order. Linear and Bézier interpolation retain authored turns, including 360° and 720°. Quaternion interpolation is not enabled.";
  const scope = document.createElement("select"); scope.setAttribute("aria-label", "Rotation curve scope");
  scope.add(new Option("Selected objects and joints", "selected")); scope.add(new Option("All animated objects and joints", "all"));
  const summary = document.createElement("p"); summary.setAttribute("aria-live", "polite");
  const filterMode = document.createElement("select"); filterMode.setAttribute("aria-label", "Euler filter mode");
  filterMode.add(new Option("XYZ Euler filter · matching XYZ key times", "xyz")); filterMode.add(new Option("Channel unwrap · independently keyed axes", "channels"));
  const filterHelp = document.createElement("p"); filterHelp.textContent = "Filtering chooses the nearest equivalent angles to the preceding key. XYZ also chooses the nearest equivalent Euler branch; Channel unwrap changes each axis by multiples of 360°. The first key stays unchanged. Filtering can remove intentional spins and changes motion between keys. Undo restores the original curves. SDK curves are excluded.";
  const interpolation = document.createElement("select"); interpolation.setAttribute("aria-label", "Rotation interpolation");
  interpolation.add(new Option("Bézier · existing tangent settings", "bezier")); interpolation.add(new Option("Linear · interpolate authored degrees", "linear")); interpolation.add(new Option("Stepped · hold previous rotation", "step"));
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  function report(message: string, error = false) { status.textContent = message; status.dataset.error = String(error); options.onStatus?.(message); }
  function targets() {
    const doc = store.getState().document;
    const valid = (id: string) => doc.nodes[id]?.type === "transform" || doc.joints?.some(joint => joint.id === id);
    return [...new Set(scope.value === "all" ? (doc.animation?.tracks ?? []).filter(track => track.channel.startsWith("rotation.")).map(track => track.targetId) : options.getSelection().filter(valid))];
  }
  function run(action: () => void) {
    if (!options.available()) return;
    try { if (!targets().length) throw Error("Select an object or joint with time rotation curves."); action(); }
    catch (error) { report(error instanceof Error ? error.message : String(error), true); }
    refresh();
  }
  const filter = document.createElement("button"); filter.type = "button"; filter.textContent = "Filter Euler curves";
  filter.onclick = () => run(() => { const count = filterEulerRotations(store, targets(), filterMode.value as EulerFilterMode); report(`Updated ${count} rotation key${count === 1 ? "" : "s"}.`); });
  const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Apply interpolation";
  apply.onclick = () => run(() => { setRotationInterpolation(store, targets(), interpolation.value as RotationInterpolation); report("Applied interpolation to scoped time rotation keys."); });
  function label(text: string, node: HTMLElement) { const result = document.createElement("label"); result.append(text, node); return result; }
  element.append(style, explanation, label("Scope", scope), summary, label("Continuity cleanup", filterMode), filterHelp, filter, label("Euler interpolation", interpolation), apply, status);
  function refresh() {
    const ids = targets(), doc = store.getState().document, curves = (doc.animation?.tracks ?? []).filter(track => ids.includes(track.targetId) && track.channel.startsWith("rotation."));
    summary.textContent = `${ids.length} target${ids.length === 1 ? "" : "s"} · ${curves.length} time rotation curves · ${curves.reduce((sum, track) => sum + track.keys.length, 0)} keys`;
    for (const control of [scope, filterMode, interpolation]) control.disabled = !options.available();
    filter.disabled = apply.disabled = !options.available() || !curves.some(track => track.keys.length);
  }
  scope.onchange = () => { status.textContent = ""; refresh(); };
  const unsubscribe = store.subscribe(refresh); refresh();
  return { element, refresh, dispose: unsubscribe };
}
